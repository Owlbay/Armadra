import { afterEach, describe, expect, it, vi } from "vitest";

import { IdentityRequestError, resetIdentityCredentials } from "./identity";
import {
  browserDeviceName,
  exportAudit,
  parseOAuthFragment,
  passkeyLabel,
  readAudit,
  signInWithPassword,
  takeOAuthFragment,
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
  it("筛选拼进查询串，动作可重复；导出取文本", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { entries: [], nextBeforeId: 0 }))
      .mockResolvedValueOnce(reply(200, "id,time\r\n"));
    vi.stubGlobal("fetch", fetch);
    await readAudit({
      principalId: "p1",
      action: ["identity.login", "share"],
      sinceMs: 10,
      beforeId: 7,
      limit: 50,
    });
    const url = new URL(String(fetch.mock.calls[0]?.[0]), "http://x");
    expect(url.pathname).toBe("/api/identity/audit");
    expect(url.searchParams.getAll("action")).toEqual([
      "identity.login",
      "share",
    ]);
    expect(url.searchParams.get("principalId")).toBe("p1");
    expect(url.searchParams.get("sinceMs")).toBe("10");
    expect(url.searchParams.get("beforeId")).toBe("7");
    expect(await exportAudit({ sinceMs: 10 })).toBe("id,time\r\n");
    expect(String(fetch.mock.calls[1]?.[0])).toContain(
      "/api/identity/audit/export?sinceMs=10",
    );
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
