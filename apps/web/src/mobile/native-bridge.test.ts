import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bearerFetch,
  installNativeTransport,
  isNativeApp,
  nativeBridge,
  ticketedWebSocket,
  WS_TICKET_PROTOCOL,
} from "./native-bridge";

const SECRET = "a".repeat(43);
const OTHER = "b".repeat(43);
const FP = "0".repeat(64);
const ORIGIN = "https://192.168.1.8:8443";

/** 让页面看起来在 Capacitor 原生壳里，插件是给的这个。 */
function inApp(plugin: Record<string, unknown> | undefined) {
  vi.stubGlobal("location", new URL("capacitor://localhost/"));
  vi.stubGlobal("Capacitor", {
    isNativePlatform: () => true,
    Plugins: plugin ? { ArmadraNative: plugin } : {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("不在原生 App 里时是空实现", () => {
  it("每个方法都答「没有」，不报错", async () => {
    const bridge = nativeBridge();
    expect(bridge.available).toBe(false);
    expect(bridge.canScan).toBe(false);
    expect(isNativeApp()).toBe(false);
    await expect(bridge.loadSession()).resolves.toBeNull();
    await expect(bridge.scan()).resolves.toBeNull();
    await expect(bridge.pushRegistration()).resolves.toBeNull();
    await expect(bridge.pin(ORIGIN, FP)).resolves.toBeUndefined();
    expect(
      installNativeTransport({
        origin: ORIGIN,
        authorization: () => SECRET,
        wsTicket: async () => "t",
        refresh: async () => true,
      }),
    ).toBe(false);
  });

  it("浏览器停在 https://localhost 上也不算 App", () => {
    vi.stubGlobal("location", new URL("https://localhost/"));
    vi.stubGlobal("Capacitor", { isNativePlatform: () => false });
    expect(isNativeApp()).toBe(false);
  });
});

describe("原生插件", () => {
  it("钥匙串里的会话要形状对才用", async () => {
    const plugin = {
      getSession: vi.fn(async () => ({
        session: { origin: ORIGIN, accessToken: SECRET, refreshToken: OTHER },
      })),
      setSession: vi.fn(async () => undefined),
      clearSession: vi.fn(async () => undefined),
    };
    inApp(plugin);
    const bridge = nativeBridge();
    expect(bridge.available).toBe(true);
    await expect(bridge.loadSession()).resolves.toEqual({
      origin: ORIGIN,
      accessToken: SECRET,
      refreshToken: OTHER,
    });
    plugin.getSession.mockResolvedValueOnce({
      session: { origin: ORIGIN, accessToken: "short", refreshToken: OTHER },
    });
    await expect(bridge.loadSession()).resolves.toBeNull();
    plugin.getSession.mockRejectedValueOnce(new Error("locked"));
    await expect(bridge.loadSession()).resolves.toBeNull();
    await bridge.saveSession({
      origin: ORIGIN,
      accessToken: SECRET,
      refreshToken: OTHER,
    });
    expect(plugin.setSession).toHaveBeenCalledWith({
      session: { origin: ORIGIN, accessToken: SECRET, refreshToken: OTHER },
    });
  });

  it("钉扎失败要抛：钉不上就不能连", async () => {
    const pin = vi.fn(async () => undefined);
    inApp({ pin });
    const bridge = nativeBridge();
    await bridge.pin(ORIGIN, FP);
    expect(pin).toHaveBeenCalledWith({ origin: ORIGIN, fingerprint: FP });
    await expect(bridge.pin(ORIGIN, "nothex")).rejects.toThrow();
    pin.mockRejectedValueOnce(new Error("no"));
    await expect(bridge.pin(ORIGIN, FP)).rejects.toThrow();
    inApp({});
    await expect(nativeBridge().pin(ORIGIN, FP)).rejects.toThrow();
  });

  it("扫码：取消是 null", async () => {
    const scan = vi.fn(async () => ({ text: "armadra://pair?x" }));
    inApp({ scan });
    const bridge = nativeBridge();
    expect(bridge.canScan).toBe(true);
    await expect(bridge.scan()).resolves.toBe("armadra://pair?x");
    scan.mockResolvedValueOnce({} as never);
    await expect(bridge.scan()).resolves.toBeNull();
  });

  it("推送注册：中继必须带公钥", async () => {
    const pushRegistration = vi.fn(
      async (): Promise<unknown> => ({
        registration: { platform: "ios", transport: "direct", token: "tok" },
      }),
    );
    inApp({ pushRegistration });
    const bridge = nativeBridge();
    await expect(bridge.pushRegistration()).resolves.toEqual({
      platform: "ios",
      transport: "direct",
      token: "tok",
    });
    pushRegistration.mockResolvedValueOnce({
      registration: { platform: "android", transport: "relay", token: "tok" },
    });
    await expect(bridge.pushRegistration()).resolves.toBeNull();
    pushRegistration.mockResolvedValueOnce({
      registration: {
        platform: "android",
        transport: "relay",
        token: "tok",
        publicKey: "AbC-_9",
      },
    });
    await expect(bridge.pushRegistration()).resolves.toMatchObject({
      publicKey: "AbC-_9",
    });
  });
});

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
