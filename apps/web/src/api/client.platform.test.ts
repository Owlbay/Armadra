import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsApi } from "./credentials";
import { gatewayApi } from "./gateway";
import { mailConfigured, mailInvitation, mailPasswordReset } from "./mail";
import { pushApi } from "./push";
import { reportFrom, defaultTransport } from "../diagnostics/report";
import { RuntimeRequestError } from "./request";
import { setCurrentSourceResolver } from "./source";

/**
 * push、mail、credentials、gateway、diagnostics 五个域的页面一侧（契约 §43.4–§43.8）：
 * 都发 `POST /api/rpc/<域>/<动词>`，体是 `{ json: { … } }`，答案过页面自己的 schema。
 * 配对短码换票是匿名面，不在这里（它只经旧路径，不走 RPC 客户端）。凭据的值
 * 只出现在新建与改值的请求体里，任何答案与错误里都没有。
 */

type Call = { url: string; init: RequestInit };
let calls: Call[];

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stub(respond: (call: Call) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        url: input instanceof Request ? input.url : String(input),
        init: init ?? {},
      };
      calls.push(call);
      return respond(call);
    }),
  );
}

const ok = (json: unknown) => stub(() => answer(200, { json }));
const sent = (index = 0): unknown =>
  JSON.parse(String(calls[index]?.init.body ?? "null"));
const procedure = (index = 0): string | undefined =>
  calls[index]?.url.split("/api/rpc/")[1];

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCurrentSourceResolver(null);
});

const device = {
  deviceId: "d1",
  platform: "web",
  transport: "webpush",
  appVersion: "",
  locale: "en",
  encrypted: true,
  createdAt: "2026-10-06T00:00:00.000Z",
  current: true,
};

describe("push", () => {
  it("配置、设备、登记、偏好、撤销、测试各是一条 procedure", async () => {
    ok({
      webpush: { enabled: true, publicKey: "BPk" },
      native: { transport: "log", status: "notConfigured", platforms: [] },
    });
    await expect(pushApi.config()).resolves.toMatchObject({
      webpush: { publicKey: "BPk" },
    });
    ok({ devices: [device] });
    await expect(pushApi.devices()).resolves.toMatchObject({
      devices: [{ deviceId: "d1" }],
    });
    ok({ device });
    const registration = {
      platform: "ios",
      transport: "direct",
      token: "tok",
      locale: "zh-CN",
    };
    await pushApi.register(registration);
    await pushApi.setKinds("d1", ["approval"]);
    ok({ revoked: true });
    await expect(pushApi.revoke("d1")).resolves.toEqual({ revoked: true });
    ok({ queued: true, id: "n1" });
    await expect(pushApi.test()).resolves.toEqual({ queued: true, id: "n1" });
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "push/config",
      "push/devices",
      "push/register",
      "push/setKinds",
      "push/revoke",
      "push/test",
    ]);
    expect(sent(2)).toEqual({ json: registration });
    expect(sent(3)).toEqual({ json: { deviceId: "d1", kinds: ["approval"] } });
    expect(sent(4)).toEqual({ json: { deviceId: "d1" } });
  });

  it("别人的设备与不存在的设备同样是 404，抛的是 RuntimeRequestError", async () => {
    stub(() =>
      answer(404, {
        code: "not_found",
        message: "没有这台推送设备",
        requestId: "r",
      }),
    );
    const failure = await pushApi
      .revoke("nope")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeRequestError);
    expect((failure as RuntimeRequestError).status).toBe(404);
  });
});

describe("mail", () => {
  it("发邀请与重置链接各是一条 procedure，令牌只在请求体里", async () => {
    ok({ sent: true });
    await mailInvitation({
      invitationId: "i1",
      token: "i1.TOKEN",
      to: "a@example.com",
      locale: "zh",
    });
    await mailPasswordReset({
      principalId: "p1",
      token: "p1.TOKEN",
      to: "b@example.com",
    });
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "mail/sendInvitation",
      "mail/sendPasswordReset",
    ]);
    expect(sent(0)).toEqual({
      json: {
        invitationId: "i1",
        token: "i1.TOKEN",
        to: "a@example.com",
        locale: "zh",
      },
    });
  });

  it("配没配：服务器壳才问；旧 core 答 404、问不到都算没配", async () => {
    expect(await mailConfigured(false)).toBe(false);
    expect(calls).toEqual([]);
    ok({ configured: true, from: "noreply@example.com" });
    expect(await mailConfigured(true)).toBe(true);
    expect(procedure()).toBe("mail/status");
    stub(() =>
      answer(404, { code: "not_found", message: "x", requestId: "r" }),
    );
    expect(await mailConfigured(true)).toBe(false);
    stub(() => answer(500, { code: "internal", message: "x", requestId: "r" }));
    await expect(mailConfigured(true)).rejects.toBeInstanceOf(
      RuntimeRequestError,
    );
  });

  it("限流 429 带 details.retryAfterSeconds", async () => {
    stub(() =>
      answer(429, {
        code: "rate_limited",
        message: "发得太频繁，稍后再试",
        requestId: "r",
        details: { retryAfterSeconds: 40 },
      }),
    );
    const failure = await mailInvitation({
      invitationId: "i1",
      token: "i1.T",
      to: "a@example.com",
    }).catch((error: unknown) => error);
    expect((failure as RuntimeRequestError).status).toBe(429);
    expect((failure as RuntimeRequestError).code).toBe("rate_limited");
  });
});

describe("credentials", () => {
  const entry = {
    ref: "r1",
    providerId: "claude",
    kind: "oauth-token",
    label: "Work",
    isSet: true,
  };

  it("四个动作各是一条 procedure；值只出现在新建与改值的请求体里，答案里没有", async () => {
    ok({ backend: "keychain", available: true, kinds: [], entries: [entry] });
    await expect(credentialsApi.list()).resolves.toMatchObject({
      entries: [{ ref: "r1", isSet: true }],
    });
    ok(entry);
    await credentialsApi.create({
      providerId: "claude",
      kind: "oauth-token",
      label: "Work",
      value: "SECRET-VALUE",
    });
    await credentialsApi.update("r1", { value: "NEXT-SECRET" });
    ok(undefined);
    await credentialsApi.remove("r1");
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "credentials/list",
      "credentials/create",
      "credentials/update",
      "credentials/remove",
    ]);
    expect(sent(1)).toEqual({
      json: {
        providerId: "claude",
        kind: "oauth-token",
        label: "Work",
        value: "SECRET-VALUE",
      },
    });
    expect(sent(2)).toEqual({ json: { ref: "r1", value: "NEXT-SECRET" } });
    expect(sent(3)).toEqual({ json: { ref: "r1" } });
  });

  it("空的值在页面这一层就拦下，不发请求", async () => {
    ok(entry);
    await expect(
      credentialsApi.create({
        providerId: "claude",
        kind: "oauth-token",
        label: "Work",
        value: "",
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("拒绝的码原样带回，错误里没有值", async () => {
    stub(() =>
      answer(409, {
        code: "credential_backend_insecure",
        message: "The secret store on this host is a plain file",
        requestId: "r",
      }),
    );
    const failure = await credentialsApi
      .create({
        providerId: "claude",
        kind: "oauth-token",
        label: "Work",
        value: "SECRET-VALUE",
      })
      .catch((error: unknown) => error);
    expect((failure as RuntimeRequestError).code).toBe(
      "credential_backend_insecure",
    );
    expect(String((failure as Error).message)).not.toContain("SECRET-VALUE");
  });
});

describe("gateway", () => {
  const status = {
    enabled: false,
    running: false,
    managedBy: "settings",
    listen: "private",
    port: 0,
    publicOrigin: "",
    address: null,
    origin: null,
    origins: [],
    tls: {
      source: "localCa",
      certFile: "",
      keyFile: "",
      acmeEmail: "",
      fingerprint: null,
      subject: null,
      names: [],
      notAfter: null,
      caAvailable: false,
    },
    error: null,
  };

  it("状态、改配置、铸票各是一条 procedure", async () => {
    ok(status);
    await expect(gatewayApi.status()).resolves.toMatchObject({
      running: false,
    });
    await gatewayApi.configure({ enabled: true });
    ok({
      origin: "https://192.168.1.20:8443",
      ticket: "t",
      fingerprint: "f",
      expiresAt: "2026-10-06T00:02:00.000Z",
      webUrl: "https://192.168.1.20:8443/#pair=t&fp=f",
      deepLink: "armadra://pair?host=h&ticket=t&fp=f",
    });
    await gatewayApi.pair("https://192.168.1.20:8443");
    await gatewayApi.pair();
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "gateway/status",
      "gateway/configure",
      "gateway/pair",
      "gateway/pair",
    ]);
    expect(sent(1)).toEqual({ json: { enabled: true } });
    expect(sent(2)).toEqual({ json: { origin: "https://192.168.1.20:8443" } });
    expect(sent(3)).toEqual({ json: {} });
  });

  it("成员 403，壳托管时改配置 409 gateway_managed_by_shell", async () => {
    stub(() =>
      answer(403, { code: "forbidden", message: "x", requestId: "r" }),
    );
    const forbidden = await gatewayApi
      .status()
      .catch((error: unknown) => error);
    expect((forbidden as RuntimeRequestError).status).toBe(403);
    stub(() =>
      answer(409, {
        code: "gateway_managed_by_shell",
        message: "x",
        requestId: "r",
      }),
    );
    const managed = await gatewayApi
      .configure({ enabled: false })
      .catch((error: unknown) => error);
    expect((managed as RuntimeRequestError).code).toBe(
      "gateway_managed_by_shell",
    );
  });
});

describe("diagnostics", () => {
  it("问收不收与上报各是一条 procedure（浏览器没有桌面桥时）", async () => {
    ok({ enabled: true });
    const transport = defaultTransport();
    await expect(transport.enabled()).resolves.toBe(true);
    ok({ accepted: true });
    const report = reportFrom("error", new TypeError("boom"));
    await transport.send(report!);
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "diagnostics/clientErrorStatus",
      "diagnostics/reportClientError",
    ]);
    expect(sent(1)).toMatchObject({
      json: { kind: "error", name: "TypeError", message: "boom" },
    });
  });
});
