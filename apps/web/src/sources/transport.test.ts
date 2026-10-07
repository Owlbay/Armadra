import { describe, expect, it, vi } from "vitest";

import {
  RELAY_PROTOCOL,
  RELAY_TOKEN_HEADER,
  WS_TICKET_PROTOCOL,
  bearerFetch,
  ticketedWebSocket,
} from "./transport";

const SECRET = `${"0".repeat(32)}.${"a".repeat(43)}`;
const OTHER = `${"1".repeat(32)}.${"b".repeat(43)}`;
const ORIGIN = "https://192.168.1.8:8443";

describe("Bearer fetch", () => {
  function base(statuses: number[]) {
    return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(null, { status: statuses.shift() ?? 200 });
    });
  }

  it("只给发往 Gateway 的请求补 Bearer，不带 Cookie", async () => {
    const inner = base([200, 200]);
    const wrapped = bearerFetch(inner as unknown as typeof fetch, {
      origin: ORIGIN,
      authorization: () => SECRET,
      wsTicket: async () => "",
      refresh: async () => true,
    });
    await wrapped(`${ORIGIN}/api/workspaces`);
    const init = inner.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Bearer ${SECRET}`,
    );
    expect(init.credentials).toBe("omit");
    await wrapped("https://elsewhere.example/x");
    expect(inner.mock.calls[1]![1]).toBeUndefined();
  });

  it("401 时轮转一次再发；身份面与自带凭据的请求不碰", async () => {
    let token = SECRET;
    const refresh = vi.fn(async () => {
      token = OTHER;
      return true;
    });
    const inner = base([401, 200, 401, 401]);
    const wrapped = bearerFetch(inner as unknown as typeof fetch, {
      origin: ORIGIN,
      authorization: () => token,
      wsTicket: async () => "",
      refresh,
    });
    const answer = await wrapped(`${ORIGIN}/api/boards`, {
      method: "POST",
      body: "{}",
    });
    expect(answer.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      new Headers(inner.mock.calls[1]![1]!.headers).get("authorization"),
    ).toBe(`Bearer ${OTHER}`);
    const identity = await wrapped(`${ORIGIN}/api/identity/session`);
    expect(identity.status).toBe(401);
    const own = await wrapped(`${ORIGIN}/api/x`, {
      headers: { authorization: "Bearer mine" },
    });
    expect(own.status).toBe(401);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("具名的 401（两步验证的码不对）不重发：重发只会再记一次失败", async () => {
    const refresh = vi.fn(async () => true);
    const answers = [
      { code: "mfa_invalid_code", message: "x" },
      { code: "unauthenticated", message: "y" },
      { code: "ok" },
    ];
    const inner = vi.fn(
      async () =>
        new Response(JSON.stringify(answers.shift()), {
          status: answers.length === 0 ? 200 : 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const wrapped = bearerFetch(inner as unknown as typeof fetch, {
      origin: ORIGIN,
      authorization: () => SECRET,
      wsTicket: async () => "",
      refresh,
    });
    const named = await wrapped(`${ORIGIN}/api/rpc/security/mfa/disable`, {
      method: "POST",
      body: "{}",
    });
    expect(named.status).toBe(401);
    expect(((await named.json()) as { code: string }).code).toBe(
      "mfa_invalid_code",
    );
    expect(refresh).not.toHaveBeenCalled();
    // 会话不认了：换一枚再发一次。
    const expired = await wrapped(`${ORIGIN}/api/rpc/identity/session`, {
      method: "POST",
      body: "{}",
    });
    expect(expired.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(3);
  });
});

/** 一个假的原生 WebSocket：记下 url 与协议，手动触发事件。 */
class FakeSocket extends EventTarget {
  static last: FakeSocket | null = null;
  static count = 0;
  readyState = 0;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  protocol = "";
  extensions = "";
  sent: unknown[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    super();
    FakeSocket.last = this;
    FakeSocket.count += 1;
  }
  open(protocol = "") {
    this.readyState = 1;
    this.protocol = protocol;
    this.dispatchEvent(new Event("open"));
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  }
}

describe("带票的 WebSocket", () => {
  const flush = () => new Promise((done) => setTimeout(done, 0));

  it("先换票，再以子协议升级；事件与属性转给调用方", async () => {
    FakeSocket.last = null;
    const Socket = ticketedWebSocket(
      FakeSocket as unknown as typeof WebSocket,
      {
        origin: ORIGIN,
        wsTicket: async () => "TICKET",
      },
    );
    const socket = new Socket("wss://192.168.1.8:8443/api/terminals/t/ws");
    socket.binaryType = "arraybuffer";
    const opened = vi.fn();
    const messages: unknown[] = [];
    socket.onopen = opened;
    socket.addEventListener("message", (event) =>
      messages.push((event as MessageEvent).data),
    );
    expect(socket.readyState).toBe(0);
    expect(() => socket.send("early")).toThrow();
    await flush();
    const inner = FakeSocket.last!;
    expect(inner.protocols).toEqual([`${WS_TICKET_PROTOCOL}TICKET`]);
    expect(inner.binaryType).toBe("arraybuffer");
    inner.open(`${WS_TICKET_PROTOCOL}TICKET`);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(1);
    expect(socket.protocol).toBe("");
    inner.dispatchEvent(new MessageEvent("message", { data: "hi" }));
    expect(messages).toEqual(["hi"]);
    socket.send("x");
    expect(inner.sent).toEqual(["x"]);
  });

  it("发往别处的连接不换票", () => {
    FakeSocket.last = null;
    const wsTicket = vi.fn(async () => "T");
    const Socket = ticketedWebSocket(
      FakeSocket as unknown as typeof WebSocket,
      {
        origin: ORIGIN,
        wsTicket,
      },
    );
    const socket = new Socket("ws://127.0.0.1:1/x");
    expect(socket).toBeInstanceOf(FakeSocket);
    expect(wsTicket).not.toHaveBeenCalled();
  });

  it("换不到票：报 error 与 close，不连", async () => {
    FakeSocket.count = 0;
    const Socket = ticketedWebSocket(
      FakeSocket as unknown as typeof WebSocket,
      {
        origin: ORIGIN,
        wsTicket: async () => {
          throw new Error("401");
        },
      },
    );
    const socket = new Socket(`${ORIGIN.replace("https", "wss")}/x`);
    const closed = vi.fn();
    socket.addEventListener("error", () => closed("error"));
    socket.onclose = () => closed("close");
    await flush();
    expect(closed.mock.calls.map((call) => call[0])).toEqual([
      "error",
      "close",
    ]);
    expect(socket.readyState).toBe(3);
    expect(FakeSocket.count).toBe(0);
  });

  it("票回来之前就关了：不再打开", async () => {
    FakeSocket.count = 0;
    let give: (ticket: string) => void = () => undefined;
    const Socket = ticketedWebSocket(
      FakeSocket as unknown as typeof WebSocket,
      {
        origin: ORIGIN,
        wsTicket: () => new Promise((done) => (give = done)),
      },
    );
    const socket = new Socket(`${ORIGIN.replace("https", "wss")}/x`);
    const onclose = vi.fn();
    socket.onclose = onclose;
    socket.close();
    await flush();
    expect(onclose).toHaveBeenCalledTimes(1);
    give("late");
    await flush();
    expect(FakeSocket.count).toBe(0);
  });
});

describe("经中继的源", () => {
  const flush = () => new Promise((done) => setTimeout(done, 0));

  it("HTTP 带中继令牌头，调用方自带的不覆盖", async () => {
    const inner = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    const wrapped = bearerFetch(inner as unknown as typeof fetch, {
      origin: ORIGIN,
      authorization: () => SECRET,
      wsTicket: async () => "",
      refresh: async () => true,
      extraHeaders: () => ({ [RELAY_TOKEN_HEADER]: "RT" }),
    });
    await wrapped(`${ORIGIN}/api/workspaces`);
    await wrapped(`${ORIGIN}/api/identity/session`);
    await wrapped(`${ORIGIN}/api/x`, {
      headers: { [RELAY_TOKEN_HEADER]: "own" },
    });
    const sent = inner.mock.calls.map((call) =>
      new Headers(call[1]!.headers).get(RELAY_TOKEN_HEADER),
    );
    expect(sent).toEqual(["RT", "RT", "own"]);
  });

  it("WebSocket 在票之后另带中继子协议，对调用方不可见", async () => {
    FakeSocket.last = null;
    const Socket = ticketedWebSocket(
      FakeSocket as unknown as typeof WebSocket,
      {
        origin: ORIGIN,
        wsTicket: async () => "T",
        extraProtocols: () => [`${RELAY_PROTOCOL}RT`],
      },
    );
    const socket = new Socket(`${ORIGIN.replace("https", "wss")}/api/ws`, [
      "armadra-rpc.v1",
    ]);
    await flush();
    const inner = FakeSocket.last!;
    expect(inner.protocols).toEqual([
      "armadra-rpc.v1",
      `${WS_TICKET_PROTOCOL}T`,
      `${RELAY_PROTOCOL}RT`,
    ]);
    inner.open(`${RELAY_PROTOCOL}RT`);
    expect(socket.protocol).toBe("");
  });
});
