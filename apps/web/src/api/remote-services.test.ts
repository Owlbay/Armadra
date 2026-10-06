import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  sources: {
    remoteAdd: vi.fn(),
    remoteSession: vi.fn(),
    addDirect: vi.fn(),
    shareLinks: vi.fn(),
    shareLinkCreate: vi.fn(),
    shareLinkUrl: vi.fn(),
    shareLinkRevoke: vi.fn(),
  },
  identity: {
    cloud: {
      register: vi.fn(),
      bind: vi.fn(),
      revoke: vi.fn(),
      relayPending: vi.fn(),
      relayCleanup: vi.fn(),
    },
  },
}));
const accounts = vi.hoisted(() => ({
  issueInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
}));
// 本机邀请经契约客户端（`accounts.invitations.*`，契约 §42.3）。
vi.mock("./client", () => ({
  localClient: () => ({
    ...rpc,
    accounts: {
      invitations: {
        issue: accounts.issueInvitation,
        revoke: ({ invitationId }: { invitationId: string }) =>
          accounts.revokeInvitation(invitationId),
      },
    },
  }),
}));

import { RuntimeRequestError } from "./request";
import {
  addPersonalRelay,
  createShareLink,
  isPairLink,
  listShareLinks,
  presentedFingerprint,
  remoteFetch,
  revokeShareLink,
  shareLinkUrl,
  retryRelayCleanup,
  shareThisMachine,
  stopSharing,
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
    rpc.identity.cloud.relayPending,
    rpc.identity.cloud.relayCleanup,
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

describe("分享链接（契约 §33.9，经本机 core）", () => {
  it("列表、新建（备注空就不带）、再取整条链接、撤销都交给 core，不直连远程服务", async () => {
    rpc.sources.shareLinks.mockResolvedValue({ links: [{ linkId: "L" }] });
    await expect(listShareLinks("svc")).resolves.toEqual([{ linkId: "L" }]);
    expect(rpc.sources.shareLinks).toHaveBeenCalledWith({ serviceId: "svc" });

    rpc.sources.shareLinkCreate.mockResolvedValue({ url: "u", link: {} });
    await createShareLink({
      serviceId: "svc",
      workspaceId: "w1",
      role: "viewer",
      ttlMs: 86_400_000,
      maxUses: 1000,
      label: "  ",
    });
    expect(rpc.sources.shareLinkCreate).toHaveBeenCalledWith({
      serviceId: "svc",
      workspaceId: "w1",
      role: "viewer",
      ttlMs: 86_400_000,
      maxUses: 1000,
    });

    rpc.sources.shareLinkUrl.mockResolvedValue({ url: `${ISSUER}/j/L#S.t` });
    await expect(shareLinkUrl("svc", "L")).resolves.toBe(`${ISSUER}/j/L#S.t`);

    rpc.sources.shareLinkRevoke.mockResolvedValue({});
    await revokeShareLink("svc", "L");
    expect(rpc.sources.shareLinkRevoke).toHaveBeenCalledWith({
      serviceId: "svc",
      linkId: "L",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("停用分享与中继侧清理（契约 §31.4）", () => {
  it("撤销后读待清理：这个 issuer 欠着就答码，不欠答 null", async () => {
    rpc.identity.cloud.revoke.mockResolvedValue({});
    rpc.identity.cloud.relayPending.mockResolvedValueOnce({
      pending: [
        { issuer: "https://other.test", revokedAtMs: 1, code: "x" },
        { issuer: ISSUER, revokedAtMs: 2, code: "source_unauthorized" },
      ],
    });
    expect(await stopSharing(ISSUER)).toBe("source_unauthorized");
    expect(rpc.identity.cloud.revoke).toHaveBeenCalledWith({ issuer: ISSUER });
    rpc.identity.cloud.relayPending.mockResolvedValueOnce({ pending: [] });
    expect(await stopSharing(ISSUER)).toBeNull();
  });

  it("重试：清掉了答 null，还欠着答码", async () => {
    rpc.identity.cloud.relayCleanup
      .mockResolvedValueOnce({ pending: false, code: null })
      .mockResolvedValueOnce({ pending: true, code: "source_unreachable" });
    expect(await retryRelayCleanup(ISSUER)).toBeNull();
    expect(await retryRelayCleanup(ISSUER)).toBe("source_unreachable");
    expect(rpc.identity.cloud.relayCleanup).toHaveBeenCalledWith({
      issuer: ISSUER,
    });
  });
});
