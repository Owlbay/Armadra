import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_CAP_MS,
  CLOSE_EXPIRED,
  CLOSE_FORBIDDEN,
  CLOSE_SOURCE_OFFLINE,
  ManagedSocket,
  type ManagedSocketOptions,
  PING_TIMEOUT_MS,
  type SocketEnvironment,
} from "./managed-socket";
import { RELAY_PROTOCOL, WS_TICKET_PROTOCOL } from "./transport";

class FakeSocket extends EventTarget {
  static made: FakeSocket[] = [];
  readyState = 0;
  binaryType: BinaryType = "blob";
  sent: unknown[] = [];
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    super();
    FakeSocket.made.push(this);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  drop(code: number) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
  close() {
    this.readyState = 3;
  }
}

function environment() {
  const listeners = new Map<string, Set<() => void>>();
  let visible = true;
  const env: SocketEnvironment & {
    fire(type: "online" | "visibilitychange"): void;
    setVisible(next: boolean): void;
  } = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    visible: () => visible,
    fire(type) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    setVisible(next) {
      visible = next;
    },
  };
  return env;
}

let env: ReturnType<typeof environment>;
const last = () => FakeSocket.made.at(-1)!;
const flush = () => vi.advanceTimersByTimeAsync(0);

function make(overrides: Partial<ManagedSocketOptions> = {}) {
  let tickets = 0;
  const options: ManagedSocketOptions = {
    url: () => "wss://core.example/api/ws",
    ticket: async () => `T${++tickets}`,
    renew: vi.fn(async () => true),
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    environment: env,
    backoff: { baseMs: 1000, capMs: 10_000, random: () => 1 },
    ...overrides,
  };
  return { socket: new ManagedSocket(options), options };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.made = [];
  env = environment();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ManagedSocket", () => {
  it("连之前先换票，经中继时另带中继子协议", async () => {
    const { socket } = make({
      protocols: ["armadra-rpc.v1"],
      relayToken: () => "RT",
    });
    expect(socket.state).toBe("connecting");
    await flush();
    expect(last().protocols).toEqual([
      "armadra-rpc.v1",
      `${WS_TICKET_PROTOCOL}T1`,
      `${RELAY_PROTOCOL}RT`,
    ]);
    last().open();
    expect(socket.state).toBe("open");
    expect(socket.send("x")).toBe(true);
    expect(last().sent).toEqual(["x"]);
  });

  it("不用票的源（ticket 答 null）不带票子协议", async () => {
    make({ ticket: async () => null });
    await flush();
    expect(last().protocols).toBeUndefined();
  });

  it("普通断线按退避重连，连上后归零；每次重连换新票", async () => {
    const { socket } = make();
    await flush();
    last().open();
    last().drop(1006);
    expect(socket.state).toBe("backoff");
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.made).toHaveLength(2);
    expect(last().protocols).toEqual([`${WS_TICKET_PROTOCOL}T2`]);
    last().drop(1006);
    // 第二次等 2 秒（指数上升）。
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.made).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.made).toHaveLength(3);
    last().open();
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.made).toHaveLength(4);
  });

  it("后台时退避封顶放宽到 30 秒", async () => {
    const { socket } = make({
      backoff: { baseMs: 10_000, capMs: 10_000, random: () => 1 },
    });
    await flush();
    env.setVisible(false);
    last().drop(1006);
    expect(socket.state).toBe("backoff");
    await vi.advanceTimersByTimeAsync(BACKGROUND_CAP_MS - 1);
    expect(FakeSocket.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it("online 事件跳过退避立刻连", async () => {
    const { socket } = make();
    await flush();
    last().drop(1006);
    expect(socket.state).toBe("backoff");
    env.fire("online");
    await flush();
    expect(FakeSocket.made).toHaveLength(2);
    expect(socket.state).toBe("connecting");
  });

  it("回到前台：退避中的立刻连", async () => {
    make();
    await flush();
    last().drop(1006);
    env.fire("visibilitychange");
    await flush();
    expect(FakeSocket.made).toHaveLength(2);
  });

  it("回到前台：开着的探一次活，3 秒没回就重连", async () => {
    let answer: (alive: boolean) => void = () => undefined;
    const ping = vi.fn(() => new Promise<boolean>((done) => (answer = done)));
    const { socket } = make({ ping });
    await flush();
    last().open();
    env.fire("visibilitychange");
    expect(ping).toHaveBeenCalledTimes(1);
    answer(true);
    await flush();
    expect(FakeSocket.made).toHaveLength(1);

    env.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    expect(FakeSocket.made).toHaveLength(2);
    expect(socket.state).toBe("connecting");
    // 迟到的回答不再起作用。
    answer(false);
    await flush();
    expect(FakeSocket.made).toHaveLength(2);
  });

  it("4401：续一次凭据、立刻换票重连；连续两次就是 unauthorized", async () => {
    const renew = vi.fn(async () => true);
    const { socket } = make({ renew });
    await flush();
    last().drop(CLOSE_EXPIRED);
    await flush();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(FakeSocket.made).toHaveLength(2);
    expect(last().protocols).toEqual([`${WS_TICKET_PROTOCOL}T2`]);
    last().drop(CLOSE_EXPIRED);
    await flush();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(socket.state).toBe("unauthorized");
  });

  it("4401 而续不上：unauthorized，不再连", async () => {
    const { socket } = make({ renew: async () => false });
    await flush();
    last().drop(CLOSE_EXPIRED);
    await flush();
    expect(socket.state).toBe("unauthorized");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it("4403：失权，不再连", async () => {
    const states: string[] = [];
    const { socket } = make({ onStateChange: (state) => states.push(state) });
    await flush();
    last().open();
    last().drop(CLOSE_FORBIDDEN);
    await flush();
    expect(socket.state).toBe("unauthorized");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(1);
    expect(states).toEqual(["open", "unauthorized"]);
  });

  it("4404：等源上线，wake 之后立刻连", async () => {
    const { socket } = make();
    await flush();
    last().drop(CLOSE_SOURCE_OFFLINE);
    await flush();
    expect(socket.state).toBe("waiting");
    env.fire("online");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(1);
    socket.wake();
    await flush();
    expect(FakeSocket.made).toHaveLength(2);
  });

  it("换不到票按退避重试", async () => {
    let fail = true;
    const { socket } = make({
      ticket: async () => {
        if (fail) throw new Error("401");
        return "T";
      },
    });
    await flush();
    expect(socket.state).toBe("backoff");
    expect(FakeSocket.made).toHaveLength(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it("close() 之后不再连，也不再听环境事件", async () => {
    const { socket } = make();
    await flush();
    socket.close();
    expect(socket.state).toBe("closed");
    last().drop(1006);
    env.fire("online");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it("reconnect()：调用方认定开着的这条死了，换一张票立刻再连；没开着时不动", async () => {
    const { socket } = make();
    await flush();
    socket.reconnect();
    await flush();
    expect(FakeSocket.made).toHaveLength(1);
    last().open();
    const dead = last();
    socket.reconnect();
    await flush();
    expect(FakeSocket.made).toHaveLength(2);
    expect(dead.readyState).toBe(3);
    expect(last().protocols).toEqual([`${WS_TICKET_PROTOCOL}T2`]);
  });
});
