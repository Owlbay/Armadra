import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type HostedSessionStore,
  currentAccessToken,
  refreshIdentity,
  resetIdentityCredentials,
  resumeIdentity,
  setHostedSession,
} from "./identity";

/**
 * 中继托管的页面（客户端包 §5）：身份面走 Bearer，会话从内存保管处读回；刷新
 * 带上会话的 CSRF 密钥（core 在 Bearer 模式下也核对它），轮换后写回保管处；
 * 刷新也不行时经远程服务重登一次。
 */

const CSRF_A = "a".repeat(43);
const CSRF_B = "b".repeat(43);

const session = (access: string, refresh: string, csrf: string) => ({
  hostId: "h",
  device: { deviceId: "d" },
  scopes: [],
  expiresAtUnixMs: 0,
  csrfToken: csrf,
  native: { accessToken: access, refreshToken: refresh },
});

function store(initial: {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  csrfToken?: string;
}) {
  let current: typeof initial | undefined = initial;
  const saved: unknown[] = [];
  const value: HostedSessionStore & { saved: unknown[] } = {
    saved,
    load: async () => current,
    save(next) {
      saved.push(next);
      current = next;
    },
    clear: vi.fn(() => {
      current = undefined;
    }),
    recover: vi.fn(async () => false),
  };
  return value;
}

afterEach(() => {
  setHostedSession(null);
  resetIdentityCredentials();
  vi.unstubAllGlobals();
});

describe("中继托管页面的身份面", () => {
  it("会话从保管处读回，Bearer 发出；刷新带 CSRF，轮换结果写回", async () => {
    const vault = store({
      accessToken: "core-a",
      refreshToken: "core-r",
      expiresAtMs: 0,
      csrfToken: CSRF_A,
    });
    setHostedSession(vault);
    const seen: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, headers: new Headers(init.headers) });
        const body = url.endsWith("/session/refresh")
          ? session("core-a2", "core-r2", CSRF_B)
          : session("core-a", "core-r", CSRF_A);
        return new Response(JSON.stringify(body));
      }),
    );
    await resumeIdentity();
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer core-a");
    expect(seen[0]?.headers.get("x-armadra-csrf")).toBeNull();

    await refreshIdentity();
    const refresh = seen.find((call) => call.url.endsWith("/session/refresh"))!;
    expect(refresh.headers.get("authorization")).toBe("Bearer core-r");
    expect(refresh.headers.get("x-armadra-csrf")).toBe(CSRF_A);
    expect(currentAccessToken()).toBe("core-a2");
    expect(vault.saved.at(-1)).toMatchObject({
      accessToken: "core-a2",
      refreshToken: "core-r2",
      csrfToken: CSRF_B,
    });
  });

  it("会话与刷新都被拒：经远程服务重登一次；还不行就清掉保管处、答没有会话", async () => {
    const vault = store({
      accessToken: "dead",
      refreshToken: "dead-r",
      expiresAtMs: 0,
    });
    setHostedSession(vault);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "unauthenticated" }), {
            status: 401,
          }),
      ),
    );
    expect(await resumeIdentity()).toBeNull();
    expect(vault.recover).toHaveBeenCalledTimes(1);
    expect(vault.clear).toHaveBeenCalled();
  });
});
