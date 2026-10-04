import { describe, expect, it, vi } from "vitest";
import { CoreSession } from "./core-session";

/**
 * 主进程（托盘）打 core 时带的会话（契约 §3.2，安全审查 L9）：先要票配对，
 * 带 Bearer 与来源；401 时先刷新、刷新不认再重新配对，只重发一次。
 */

const BASE = "http://127.0.0.1:5123";

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function harness(
  answer: (call: Call, index: number) => { status?: number; body?: unknown },
) {
  const calls: Call[] = [];
  const load = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      };
      calls.push(call);
      const { status = 200, body = {} } = answer(call, calls.length - 1);
      return new Response(JSON.stringify(body), { status });
    },
  );
  const ticket = vi.fn(async () => "T");
  const session = new CoreSession({
    base: async () => BASE,
    ticket,
    fetch: load as unknown as typeof fetch,
  });
  return { calls, ticket, session };
}

const keys = (access: string, refresh: string) => ({
  native: { accessToken: access, refreshToken: refresh },
});

const path = (call: Call) => new URL(call.url).pathname;

describe("CoreSession", () => {
  it("先要票配对，之后的请求带 Bearer 与来源，不再配对", async () => {
    const { calls, ticket, session } = harness((call) =>
      path(call) === "/api/identity/pair"
        ? { body: keys("A", "R") }
        : { body: { ok: true } },
    );
    expect((await session.fetch("/api/usage")).status).toBe(200);
    expect((await session.fetch("/api/settings")).status).toBe(200);
    expect(calls.map(path)).toEqual([
      "/api/identity/pair",
      "/api/usage",
      "/api/settings",
    ]);
    expect(ticket).toHaveBeenCalledWith(BASE);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ ticket: "T" });
    expect(calls[0]?.headers.origin).toBe(BASE);
    expect(calls[1]?.headers).toMatchObject({
      origin: BASE,
      authorization: "Bearer A",
    });
  });

  it("401 时先用刷新密钥换一枚，再发一次", async () => {
    let expired = true;
    const { calls, session } = harness((call) => {
      const at = path(call);
      if (at === "/api/identity/pair") return { body: keys("A", "R") };
      if (at === "/api/identity/session/refresh") {
        expired = false;
        return { body: keys("A2", "R2") };
      }
      return expired ? { status: 401 } : { body: { ok: true } };
    });
    expect((await session.fetch("/api/gateway")).status).toBe(200);
    expect(calls.map(path)).toEqual([
      "/api/identity/pair",
      "/api/gateway",
      "/api/identity/session/refresh",
      "/api/gateway",
    ]);
    expect(calls[2]?.headers.authorization).toBe("Bearer R");
    expect(calls[3]?.headers.authorization).toBe("Bearer A2");
  });

  it("刷新也不认就重新配对；还是 401 就原样交出去", async () => {
    const { calls, ticket, session } = harness((call) => {
      const at = path(call);
      if (at === "/api/identity/pair") return { body: keys("A", "R") };
      return { status: 401 };
    });
    expect((await session.fetch("/api/usage")).status).toBe(401);
    expect(calls.map(path)).toEqual([
      "/api/identity/pair",
      "/api/usage",
      "/api/identity/session/refresh",
      "/api/identity/pair",
      "/api/usage",
    ]);
    expect(ticket).toHaveBeenCalledTimes(2);
  });

  it("签不出票时抛出，调用方按没读到处理", async () => {
    const { session, ticket } = harness(() => ({ body: {} }));
    ticket.mockRejectedValueOnce(new Error("no channel"));
    await expect(session.fetch("/api/usage")).rejects.toThrow();
  });
});
