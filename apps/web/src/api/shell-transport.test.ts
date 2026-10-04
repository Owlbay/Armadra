import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * 桌面壳的请求层（契约 §3.2，安全审查 L9）。
 *
 * core 不再放行回环上没带凭据的请求，所以壳里的页面每一个发往 core 的请求都
 * 带票据换来的 Bearer、每一条流都先换票：还没有会话先向壳要票配对，401 时
 * 复核、刷新或重新要票，只重发一次。
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

const { request, RUNTIME_URL } = await import("./request");
const { resetIdentityCredentials } = await import("./identity");
const { installShellTransport } = await import("./shell-transport");
const { WS_TICKET_PROTOCOL } = await import("../mobile/native-bridge");

type Call = { url: string; init: RequestInit | undefined };
let calls: Call[];
let answer: (call: Call) => { status?: number; body: unknown };

const session = (access: string, refresh: string) => ({
  hostId: "h1",
  device: { deviceId: "d1" },
  scopes: [],
  csrfToken: "",
  expiresAtUnixMs: Date.now() + 15 * 60 * 1000,
  native: { accessToken: access, refreshToken: refresh },
});

function authorization(call: Call | undefined): string | null {
  return new Headers(call?.init?.headers).get("authorization");
}

function path(call: Call): string {
  return new URL(call.url).pathname;
}

class FakeSocket extends EventTarget {
  static made: FakeSocket[] = [];
  readyState = 0;
  binaryType: BinaryType = "blob";
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    super();
    FakeSocket.made.push(this);
  }
  close() {
    this.readyState = 3;
  }
}

beforeEach(() => {
  calls = [];
  FakeSocket.made = [];
  mocks.nativeShell = true;
  mocks.ticket.mockClear();
  resetIdentityCredentials();
  answer = (call) => {
    const at = path(call);
    if (at.endsWith("/api/identity/pair")) return { body: session("A", "R") };
    if (at.endsWith("/api/identity/ws-ticket"))
      return { body: { ticket: "T1", expiresAt: "2030-01-01T00:00:00Z" } };
    return { body: { ok: true } };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), init };
      calls.push(call);
      const { status = 200, body } = answer(call);
      const response = {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: async () => body,
        clone: () => response,
      };
      return response as unknown as Response;
    }),
  );
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetIdentityCredentials();
});

const schema = z.object({ ok: z.boolean() });

describe("桌面壳的请求层", () => {
  it("不在壳里什么也不装", () => {
    mocks.nativeShell = false;
    const before = globalThis.fetch;
    expect(installShellTransport()).toBe(false);
    expect(globalThis.fetch).toBe(before);
  });

  it("还没有会话时先向壳要票配对，再给每一条 /api/ 带 Bearer", async () => {
    expect(installShellTransport()).toBe(true);
    await request("/api/settings", schema);
    await request("/api/github/get-credential?workspaceId=w", schema, {
      method: "POST",
      body: "{}",
    });
    expect(calls.map(path)).toEqual([
      "/api/identity/pair",
      "/api/settings",
      "/api/github/get-credential",
    ]);
    expect(mocks.ticket).toHaveBeenCalledTimes(1);
    expect(authorization(calls[1])).toBe("Bearer A");
    expect(authorization(calls[2])).toBe("Bearer A");
  });

  it("裸 fetch（不经 request）同样带上", async () => {
    installShellTransport();
    await fetch(`${RUNTIME_URL}/api/terminals/backend`);
    expect(authorization(calls.at(-1))).toBe("Bearer A");
  });

  it("发往别处的请求原样放过，不配对", async () => {
    installShellTransport();
    await fetch("https://example.invalid/x");
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.invalid/x",
    ]);
    expect(authorization(calls[0])).toBe(null);
    expect(mocks.ticket).not.toHaveBeenCalled();
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
      if (at === "/api/settings" && expired)
        return { status: 401, body: { code: "unauthenticated" } };
      return { body: { ok: true } };
    };
    installShellTransport();
    await request("/api/settings", schema);
    expect(calls.map(path)).toEqual([
      "/api/identity/pair",
      "/api/settings",
      "/api/identity/session",
      "/api/identity/session/refresh",
      "/api/settings",
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
    installShellTransport();
    await expect(request("/api/settings", schema)).rejects.toMatchObject({
      status: 401,
    });
    expect(calls.filter((call) => path(call) === "/api/settings")).toHaveLength(
      1,
    );
  });

  it("流先换一张一次性票，经子协议升级", async () => {
    installShellTransport();
    const socketBase = RUNTIME_URL.replace(/^http/, "ws");
    new WebSocket(`${socketBase}/api/workspaces/w/events`);
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1));
    const ticket = calls.find(
      (call) => path(call) === "/api/identity/ws-ticket",
    );
    expect(authorization(ticket)).toBe("Bearer A");
    expect(FakeSocket.made[0]?.protocols).toEqual([`${WS_TICKET_PROTOCOL}T1`]);
  });

  it("发往别处的流不换票", () => {
    installShellTransport();
    new WebSocket("ws://example.invalid/socket");
    expect(FakeSocket.made).toHaveLength(1);
    expect(FakeSocket.made[0]?.protocols).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
