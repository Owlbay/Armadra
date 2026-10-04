import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * 桌面壳里 GitHub 与自动化两面带的 Bearer（契约 §3.2，安全审查 L9）。
 *
 * core 不再把回环上没带凭据的调用当成本机主人，所以这两面在壳里必须带票据换来
 * 的访问密钥；其余路由在桌面壳里不认凭据，照旧不带。
 */

const mocks = vi.hoisted(() => ({
  nativeShell: true,
  ticket: vi.fn(async () => "shell-ticket"),
}));

vi.mock("../host/native-session", async (original) => {
  const actual = await original<typeof import("../host/native-session")>();
  return {
    ...actual,
    isNativeShell: () => mocks.nativeShell,
    fetchNativeTicket: () => mocks.ticket(),
  };
});

const { request } = await import("./request");
const { resetIdentityCredentials } = await import("./identity");

type Call = { url: string; init: RequestInit };
let calls: Call[];
let answer: (call: Call) => { status?: number; body: unknown };

const session = (access: string, refresh: string) => ({
  hostId: "h1",
  device: { deviceId: "d1" },
  scopes: [],
  csrfToken: "",
  native: { accessToken: access, refreshToken: refresh },
});

function authorization(call: Call | undefined): string | undefined {
  return (call?.init.headers as Record<string, string> | undefined)
    ?.Authorization;
}

function path(call: Call): string {
  return new URL(call.url).pathname;
}

beforeEach(() => {
  calls = [];
  mocks.nativeShell = true;
  mocks.ticket.mockClear();
  resetIdentityCredentials();
  answer = (call) =>
    path(call).endsWith("/api/identity/pair")
      ? { body: session("A", "R") }
      : { body: { ok: true } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      const { status = 200, body } = answer(call);
      const response = {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        clone: () => response,
      };
      return response as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const schema = z.object({ ok: z.boolean() });

describe("桌面壳里要会话的两面", () => {
  it("还没有会话时先向壳要票配对，再带 Bearer 打 GitHub", async () => {
    await request("/api/github/get-credential?workspaceId=w", schema, {
      method: "POST",
      body: "{}",
    });
    expect(calls.map(path)).toEqual([
      "/api/identity/pair",
      "/api/github/get-credential",
    ]);
    expect(mocks.ticket).toHaveBeenCalledTimes(1);
    expect(authorization(calls[1])).toBe("Bearer A");
  });

  it("自动化同样带 Bearer；其余路由不带", async () => {
    await request("/api/automations/plans?workspaceId=w", schema);
    await request("/api/settings", schema);
    expect(authorization(calls[1])).toBe("Bearer A");
    expect(authorization(calls[2])).toBe(undefined);
  });

  it("访问密钥过期（401）就换一枚再发一次", async () => {
    let expired = true;
    answer = (call) => {
      const at = path(call);
      if (at.endsWith("/pair")) return { body: session("A", "R") };
      if (at.endsWith("/session/refresh")) {
        expired = false;
        return { body: session("A2", "R2") };
      }
      if (at.endsWith("/session"))
        return { status: 401, body: { code: "unauthenticated" } };
      if (at.startsWith("/api/automations/") && expired)
        return { status: 401, body: { code: "unauthenticated" } };
      return { body: { ok: true } };
    };
    await request("/api/automations/plans?workspaceId=w", schema);
    expect(calls.map(path)).toEqual([
      "/api/identity/pair",
      "/api/automations/plans",
      "/api/identity/session",
      "/api/identity/session/refresh",
      "/api/automations/plans",
    ]);
    expect(authorization(calls[4])).toBe("Bearer A2");
  });

  it("换不出新的密钥就把 401 原样交出去，不再重发", async () => {
    answer = (call) =>
      path(call).endsWith("/pair")
        ? { body: session("A", "R") }
        : { status: 401, body: { code: "unauthenticated", message: "no" } };
    mocks.ticket
      .mockResolvedValueOnce("shell-ticket")
      .mockRejectedValueOnce(new Error("壳签不出票"));
    await expect(
      request("/api/automations/plans?workspaceId=w", schema),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      calls.filter((call) => path(call) === "/api/automations/plans"),
    ).toHaveLength(1);
  });

  it("不在壳里不带 Bearer，也不去要票", async () => {
    mocks.nativeShell = false;
    await request("/api/github/get-credential?workspaceId=w", schema, {
      method: "POST",
      body: "{}",
    });
    expect(calls.map(path)).toEqual(["/api/github/get-credential"]);
    expect(authorization(calls[0])).toBe(undefined);
    expect(mocks.ticket).not.toHaveBeenCalled();
  });
});
