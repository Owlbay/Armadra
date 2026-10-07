import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IdentityRequestError,
  IdentityTransportError,
  resetIdentityCredentials,
} from "./identity";
import {
  browserDeviceName,
  disableMfa,
  listIdentityDevices,
  listSessions,
  oauthProviders,
  revokeIdentityDevice,
  completePasswordReset,
  exportAudit,
  hasPasswordResetFragment,
  openPasswordReset,
  parseOAuthFragment,
  passkeyLabel,
  passwordResetLink,
  readAudit,
  renamePasskey,
  signInWithPassword,
  takeOAuthFragment,
  takePasswordResetToken,
} from "./security";

const SESSION = {
  hostId: "h",
  device: { deviceId: "d", principalId: "p" },
  scopes: [],
  csrfToken: "c".repeat(43),
};

function reply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetIdentityCredentials();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("两步登录", () => {
  it("口令对了而有 TOTP：答中间票，不记会话", async () => {
    const fetch = vi.fn(async () =>
      reply(200, {
        mfaRequired: true,
        challengeId: "ch",
        expiresAtMs: 5,
        methods: ["totp", "recovery"],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const answer = await signInWithPassword("acct", "pw");
    expect(answer).toMatchObject({
      kind: "mfa",
      challenge: { challengeId: "ch" },
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      principalId: "acct",
      password: "pw",
    });
  });

  it("会话答案带出 mfaEnrollmentRequired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(200, { ...SESSION, mfaEnrollmentRequired: true }),
      ),
    );
    const answer = await signInWithPassword("acct", "pw");
    expect(answer).toMatchObject({
      kind: "session",
      mfaEnrollmentRequired: true,
      session: { hostId: "h" },
    });
  });

  it("429 带出 Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(
          429,
          { code: "account_locked", message: "" },
          { "retry-after": "61" },
        ),
      ),
    );
    const failure = await signInWithPassword("a", "b").catch((error) => error);
    expect(failure).toBeInstanceOf(IdentityRequestError);
    expect((failure as IdentityRequestError).retryAfterSeconds).toBe(61);
  });
});

describe("OAuth 回调片段", () => {
  it("认得五种结果，带出拒绝码与中间票", () => {
    expect(parseOAuthFragment("#oauth=mfa&challengeId=x1")).toEqual({
      result: "mfa",
      code: "",
      challengeId: "x1",
    });
    expect(parseOAuthFragment("#oauth=error&code=oauth_denied")).toMatchObject({
      result: "error",
      code: "oauth_denied",
    });
    expect(parseOAuthFragment("#oauth=whatever")).toBeNull();
    expect(parseOAuthFragment("#pair=abc")).toBeNull();
  });

  it("取走即抹掉地址栏", () => {
    window.history.replaceState(null, "", "#oauth=bound");
    expect(takeOAuthFragment()?.result).toBe("bound");
    expect(window.location.hash).toBe("");
    expect(takeOAuthFragment()).toBeNull();
  });
});

describe("审计查询", () => {
  it("筛选是 security.audit.list 的入参，动作可重复；导出仍取 REST 的文本", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        reply(200, { json: { entries: [], nextBeforeId: 0 } }),
      )
      .mockResolvedValueOnce(reply(200, "id,time\r\n"));
    vi.stubGlobal("fetch", fetch);
    const query = {
      principalId: "p1",
      action: ["identity.login", "share"],
      sinceMs: 10,
      beforeId: 7,
      limit: 50,
    };
    await readAudit(query);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/rpc/security/audit/list");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ json: query });
    expect(await exportAudit({ sinceMs: 10 })).toBe("id,time\r\n");
    expect(String(fetch.mock.calls[1]?.[0])).toContain(
      "/api/identity/audit/export?sinceMs=10",
    );
  });
});

describe("会话内的动作经 procedure（契约 §42）", () => {
  const procedureCall = (fetch: ReturnType<typeof vi.fn>, index = 0) => {
    const [url, init] = fetch.mock.calls[index] as [string, RequestInit];
    return {
      path: new URL(url).pathname,
      body: JSON.parse(String(init.body)) as { json?: unknown },
    };
  };

  it("设备：列与撤销走 identity.devices.*，签名不变", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        reply(200, {
          json: {
            devices: [
              {
                deviceId: "d1",
                principalId: "p1",
                name: "笔记本",
                role: "owner",
                epoch: 2,
                createdAtMs: 1,
                revokedAtMs: 0,
              },
            ],
            nextId: "d1",
            hasMore: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        reply(200, { json: { deviceId: "d1", revoked: true } }),
      );
    vi.stubGlobal("fetch", fetch);
    const page = await listIdentityDevices("d0", 20);
    expect(page.devices[0]?.name).toBe("笔记本");
    expect(procedureCall(fetch)).toEqual({
      path: "/api/rpc/identity/devices/list",
      body: { json: { limit: 20, afterId: "d0" } },
    });
    await revokeIdentityDevice("d1", 2);
    expect(procedureCall(fetch, 1)).toEqual({
      path: "/api/rpc/identity/devices/revoke",
      body: { json: { deviceId: "d1", expectedRevision: 2 } },
    });
  });

  it("拒绝换回身份面的错误：状态、码、原话，锁定的等待秒数", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(429, {
          code: "account_locked",
          message: "Account is temporarily locked",
          requestId: "r1",
          details: { retryAfterSeconds: 42 },
        }),
      ),
    );
    const failure = await disableMfa("123456").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdentityRequestError);
    expect(failure).toMatchObject({
      status: 429,
      code: "account_locked",
      message: "Account is temporarily locked",
      retryAfterSeconds: 42,
    });
  });

  it("连不上：传输错误，与「core 拒绝了」分开", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection refused");
      }),
    );
    await expect(listSessions()).rejects.toBeInstanceOf(IdentityTransportError);
  });

  it("登录页的匿名提供方表仍走 REST，会话内的走 procedure", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes("/api/rpc/")
        ? reply(200, { json: { configured: false, providers: [] } })
        : reply(200, { configured: false, providers: [] }),
    );
    vi.stubGlobal("fetch", fetch);
    await oauthProviders();
    await oauthProviders(false);
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/identity/oauth/providers",
      "/api/rpc/security/oauth/providers",
    ]);
  });
});

describe("设备与通行密钥的名字", () => {
  const mac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  it("浏览器 · 系统", () => {
    expect(browserDeviceName(mac)).toBe("Armadra · Chrome");
    expect(passkeyLabel(mac)).toBe("Chrome · macOS");
    expect(
      passkeyLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari · iOS");
  });
});

describe("口令重置链接（契约 §25）", () => {
  const TOKEN = `${"a".repeat(32)}.${"B".repeat(42)}w`;

  it("打开与设新口令都是匿名请求，令牌只在路径里", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        reply(200, { displayName: "Margaret", expiresAtMs: 99 }),
      )
      .mockResolvedValueOnce(
        reply(200, { principalId: "p1", revokedSessions: 2 }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await openPasswordReset(TOKEN)).toEqual({
      displayName: "Margaret",
      expiresAtMs: 99,
    });
    expect(await completePasswordReset(TOKEN, "new passphrase!")).toEqual({
      principalId: "p1",
      revokedSessions: 2,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1] as [string, RequestInit];
    expect(new URL(url, "http://x").pathname).toBe(
      `/api/identity/password-reset/${TOKEN}`,
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      password: "new passphrase!",
    });
  });

  it("认不出的令牌：稳定码 password_reset_invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(404, {
          code: "password_reset_invalid",
          message: "Password reset link is invalid or expired",
        }),
      ),
    );
    await expect(openPasswordReset(TOKEN)).rejects.toMatchObject({
      status: 404,
      code: "password_reset_invalid",
    });
  });

  it("链接在片段里；取走即抹掉地址栏", () => {
    expect(passwordResetLink(TOKEN, "https://armadra.example")).toBe(
      `https://armadra.example/#reset=${TOKEN}`,
    );
    window.history.replaceState(null, "", `#reset=${TOKEN}`);
    expect(hasPasswordResetFragment()).toBe(true);
    expect(takePasswordResetToken()).toBe(TOKEN);
    expect(window.location.hash).toBe("");
    expect(takePasswordResetToken()).toBe("");
    window.history.replaceState(null, "", "#invite=abc");
    expect(hasPasswordResetFragment()).toBe(false);
  });
});

describe("passkey 改名", () => {
  it("security.passkeys.rename 带新名字，答回改后的名字", async () => {
    const fetch = vi.fn(async () =>
      reply(200, { json: { credentialId: "k1", label: "工作用" } }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await renamePasskey("k1", "工作用")).toBe("工作用");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/rpc/security/passkeys/rename");
    expect(JSON.parse(String(init.body))).toEqual({
      json: { credentialId: "k1", label: "工作用" },
    });
  });
});
