import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  sources: {
    remoteAdd: vi.fn(),
    remoteSession: vi.fn(),
    addDirect: vi.fn(),
  },
  identity: {
    cloud: { register: vi.fn(), bind: vi.fn(), revoke: vi.fn() },
  },
}));
const accounts = vi.hoisted(() => ({
  issueInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
}));
vi.mock("./client", () => ({ localClient: () => rpc }));
// 本机邀请经源的 `request()`：按路径交给两个替身。
vi.mock("./request", async (original) => ({
  ...(await original<typeof import("./request")>()),
  request: (path: string, _schema: unknown, init: RequestInit) =>
    init.method === "DELETE"
      ? accounts.revokeInvitation(path.split("/").pop())
      : accounts.issueInvitation(JSON.parse(init.body as string)),
}));

import { RuntimeRequestError } from "./request";
import {
  addPersonalRelay,
  createShareLink,
  isPairLink,
  presentedFingerprint,
  remoteFetch,
  revokeShareLink,
  shareLinkUrl,
  shareThisMachine,
} from "./remote-services";
import { z } from "zod";

const FP = "ab".repeat(32);
const ISSUER = "https://relay.test:8102";

let fetch: ReturnType<typeof vi.fn>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  rpc.sources.remoteSession.mockResolvedValue({
    accessToken: "remote-access",
    accessExpiresAtMs: Date.now() + 60_000,
    issuer: `${ISSUER}/`,
    capabilities: [],
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const spy of [
    rpc.sources.remoteAdd,
    rpc.sources.remoteSession,
    rpc.sources.addDirect,
    rpc.identity.cloud.register,
    rpc.identity.cloud.bind,
    rpc.identity.cloud.revoke,
    accounts.issueInvitation,
    accounts.revokeInvitation,
  ])
    spy.mockReset();
});

describe("首次指纹（契约 §33.6）", () => {
  it("fingerprint_mismatch 带指纹 → 转成核对；带着指纹重调就成功", async () => {
    rpc.sources.remoteAdd.mockRejectedValueOnce(
      new RuntimeRequestError(400, "x", "fingerprint_mismatch", {
        code: "fingerprint_mismatch",
        details: { fingerprint: FP },
      }),
    );
    const first = await addPersonalRelay({
      issuer: ` ${ISSUER} `,
      account: "dev",
      password: "pw",
    });
    expect(first).toEqual({ kind: "confirm", fingerprint: FP });
    expect(rpc.sources.remoteAdd).toHaveBeenLastCalledWith({
      kind: "personal",
      issuer: ISSUER,
      account: "dev",
      password: "pw",
    });
    rpc.sources.remoteAdd.mockResolvedValueOnce({ remote: {}, next: "ready" });
    const second = await addPersonalRelay({
      issuer: ISSUER,
      account: "dev",
      password: "pw",
      fingerprint: FP,
    });
    expect(second.kind).toBe("done");
    expect(rpc.sources.remoteAdd.mock.calls[1]![0]).toMatchObject({
      fingerprint: FP,
    });
  });

  it("指纹不符但没给对端指纹（真不一致）：原样抛", async () => {
    const refusal = new RuntimeRequestError(400, "x", "fingerprint_mismatch", {
      code: "fingerprint_mismatch",
    });
    expect(presentedFingerprint(refusal)).toBeNull();
    rpc.sources.remoteAdd.mockRejectedValueOnce(refusal);
    await expect(
      addPersonalRelay({ issuer: ISSUER, account: "a", password: "b" }),
    ).rejects.toBe(refusal);
  });

  it("配对链接与地址分得清", () => {
    expect(isPairLink("https://gw.test:8443/#pair=abc&fp=x")).toBe(true);
    expect(isPairLink("armadra://pair?host=a&ticket=b")).toBe(true);
    expect(isPairLink("https://gw.test:8443")).toBe(false);
  });
});

describe("直接调远程服务", () => {
  it("带 Bearer、不带 Cookie；错误改写成按 code 取文案的 RuntimeRequestError", async () => {
    fetch.mockResolvedValueOnce(json(200, { ok: true }));
    await remoteFetch(
      { issuer: ISSUER, accessToken: "T" },
      "/v1/x",
      z.object({ ok: z.boolean() }),
    );
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${ISSUER}/v1/x`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer T");
    expect(init.credentials).toBe("omit");

    fetch.mockResolvedValueOnce(
      json(403, { code: "source_access_denied", message: "no" }),
    );
    const failure = await remoteFetch(
      { issuer: ISSUER, accessToken: "T" },
      "/v1/x",
      z.unknown(),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeRequestError);
    expect((failure as RuntimeRequestError).code).toBe("source_access_denied");

    fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const down = await remoteFetch(
      { issuer: ISSUER, accessToken: "T" },
      "/v1/x",
      z.unknown(),
    ).catch((error: unknown) => error);
    expect((down as RuntimeRequestError).code).toBe("source_unreachable");
  });
});

describe("分享本机", () => {
  it("注册令牌 → 本机登记（issuer 用远程服务行的）→ 断言 → bind", async () => {
    fetch
      .mockResolvedValueOnce(
        json(200, {
          registrationToken: "reg-1",
          expiresAtMs: 1,
          issuer: ISSUER,
        }),
      )
      .mockResolvedValueOnce(json(200, { assertion: "jws-1" }));
    rpc.identity.cloud.register.mockResolvedValue({ sourceId: "src-1" });
    rpc.identity.cloud.bind.mockResolvedValue({ bound: true });
    await shareThisMachine({
      serviceId: "svc",
      issuer: ISSUER,
      label: " mac ",
    });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      `${ISSUER}/v1/sources/registration-tokens`,
    );
    expect(rpc.identity.cloud.register).toHaveBeenCalledWith({
      issuer: ISSUER,
      registrationToken: "reg-1",
      label: "mac",
    });
    expect(String(fetch.mock.calls[1]![0])).toBe(
      `${ISSUER}/v1/sources/src-1/assertion`,
    );
    expect(rpc.identity.cloud.bind).toHaveBeenCalledWith({
      assertion: "jws-1",
    });
  });

  it("已经绑定过（conflict）不算失败", async () => {
    fetch
      .mockResolvedValueOnce(
        json(200, { registrationToken: "r", expiresAtMs: 1 }),
      )
      .mockResolvedValueOnce(json(200, { assertion: "a" }));
    rpc.identity.cloud.register.mockResolvedValue({ sourceId: "s" });
    rpc.identity.cloud.bind.mockRejectedValue(
      new RuntimeRequestError(409, "", "conflict"),
    );
    await expect(
      shareThisMachine({ serviceId: "svc", issuer: ISSUER, label: "" }),
    ).resolves.toEqual({ sourceId: "s" });
  });
});

describe("分享链接", () => {
  it("<url>#<secret>.<邀请令牌>；saas 没有 secret 只带邀请令牌", () => {
    expect(shareLinkUrl(`${ISSUER}/j/L`, "S", "inv.tok")).toBe(
      `${ISSUER}/j/L#S.inv.tok`,
    );
    expect(shareLinkUrl(`${ISSUER}/j/L`, "", "inv.tok")).toBe(
      `${ISSUER}/j/L#inv.tok`,
    );
  });

  it("本机签邀请 → 远程服务建链接；链接没建成就撤掉邀请", async () => {
    accounts.issueInvitation.mockResolvedValue({
      invitationId: "inv",
      token: "inv.secret",
      expiresAtMs: 2_000,
      role: "viewer",
    });
    fetch.mockResolvedValueOnce(
      json(200, {
        linkId: "L",
        url: `${ISSUER}/j/L`,
        secret: "S",
        expiresAtMs: 3_000,
      }),
    );
    const link = await createShareLink({
      serviceId: "svc",
      sourceId: "src",
      workspaceId: "w1",
      role: "viewer",
      ttlMs: 86_400_000,
      label: "Project",
    });
    expect(accounts.issueInvitation).toHaveBeenCalledWith({
      role: "viewer",
      targetWorkspaceId: "w1",
      ttlMs: 86_400_000,
    });
    const body = JSON.parse(
      (fetch.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).toEqual({
      kind: "source_invite",
      sourceId: "src",
      invitationId: "inv",
      label: "Project",
      role: "viewer",
      expiresAtMs: 2_000,
    });
    expect(link).toEqual({
      linkId: "L",
      invitationId: "inv",
      url: `${ISSUER}/j/L#S.inv.secret`,
      expiresAtMs: 2_000,
    });

    accounts.revokeInvitation.mockResolvedValue(undefined);
    fetch.mockResolvedValueOnce(
      json(400, { code: "bad_request", message: "x" }),
    );
    await expect(
      createShareLink({
        serviceId: "svc",
        sourceId: "src",
        workspaceId: "w1",
        role: "viewer",
        ttlMs: 1,
        label: "",
      }),
    ).rejects.toBeInstanceOf(RuntimeRequestError);
    expect(accounts.revokeInvitation).toHaveBeenCalledWith("inv");
  });

  it("停用：远程服务撤链接，本机邀请一并作废", async () => {
    fetch.mockResolvedValueOnce(json(200, {}));
    accounts.revokeInvitation.mockResolvedValue(undefined);
    await revokeShareLink({
      serviceId: "svc",
      linkId: "L",
      invitationId: "inv",
    });
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${ISSUER}/v1/links/L`);
    expect(init.method).toBe("DELETE");
    expect(accounts.revokeInvitation).toHaveBeenCalledWith("inv");
  });
});
