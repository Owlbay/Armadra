import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManagedSocket, type SocketEnvironment } from "../sources";
import {
  CONTROL_PROTOCOL,
  ControlChannel,
  type ControlSocketOpener,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  closeMessageKey,
  onControlClosed,
} from "./ws";

/** 一条假的内层 socket：测试替 core 开、关、发帧。 */
class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType: BinaryType = "blob";
  sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    super();
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  drop(code = 1006) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

const latest = () => FakeSocket.instances.at(-1) as FakeSocket;
const settle = () => vi.advanceTimersByTimeAsync(0);

let visible: boolean;
let environment: SocketEnvironment & { fire(type: string): void };
let renew: ReturnType<typeof vi.fn>;
let channel: ControlChannel | null = null;

function fakeEnvironment(): SocketEnvironment & { fire(type: string): void } {
  const target = new EventTarget();
  return {
    addEventListener: (type, listener) =>
      target.addEventListener(type, listener),
    removeEventListener: (type, listener) =>
      target.removeEventListener(type, listener),
    visible: () => visible,
    fire: (type) => target.dispatchEvent(new Event(type)),
  };
}

/** 一个源的连接：和 `sources/connection.ts` 一样把流交给 `ManagedSocket`。 */
const opener: ControlSocketOpener = {
  socket: (path, options = {}) =>
    new ManagedSocket({
      ...options,
      url: () => `ws://core.test${path}`,
      ticket: async () => null,
      renew: renew as unknown as () => Promise<boolean>,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      environment,
    }),
};

async function open(): Promise<ControlChannel> {
  channel = new ControlChannel(opener, { visible: () => visible });
  await settle();
  return channel;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  FakeSocket.instances = [];
  visible = true;
  environment = fakeEnvironment();
  renew = vi.fn(async () => true);
});

afterEach(() => {
  channel?.close();
  channel = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ControlChannel", () => {
  it("经源的托管流连 /api/ws，子协议 armadra-rpc.v1；帧原样转出", async () => {
    const control = await open();
    const socket = latest();
    expect(socket.url).toBe("ws://core.test/api/ws");
    expect(socket.protocols).toEqual([CONTROL_PROTOCOL]);
    expect(control.readyState).toBe(0);
    const opened = vi.fn();
    const received = vi.fn();
    control.addEventListener("open", opened);
    control.addEventListener("message", (event) =>
      received((event as MessageEvent).data),
    );
    socket.open();
    socket.receive('{"i":"1"}');
    expect(control.readyState).toBe(1);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith('{"i":"1"}');
    control.send("frame");
    expect(socket.sent).toEqual(["frame"]);
  });

  it("断了先回到「连接中」再发 close，退避之后重连并再发 open", async () => {
    const control = await open();
    latest().open();
    const states: number[] = [];
    control.addEventListener("close", () => states.push(control.readyState));
    const reopened = vi.fn();
    control.addEventListener("open", reopened);
    latest().drop();
    expect(states).toEqual([0]);
    expect(() => control.send("x")).toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.instances).toHaveLength(2);
    latest().open();
    expect(reopened).toHaveBeenCalledTimes(1);
    expect(control.readyState).toBe(1);
  });

  it("4403 / 4409 / 4429 停下不再连，并告诉页面", async () => {
    for (const code of [4403, 4409, 4429]) {
      const seen = vi.fn();
      const off = onControlClosed(seen);
      const control = await open();
      latest().open();
      latest().drop(code);
      await settle();
      expect(control.readyState).toBe(3);
      expect(control.closedWith).toBe(code);
      expect(seen).toHaveBeenCalledWith(code);
      const count = FakeSocket.instances.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.instances).toHaveLength(count);
      off();
    }
  });

  it("4401：续凭据后立刻重连；续不上就停下", async () => {
    const control = await open();
    latest().open();
    latest().drop(4401);
    await settle();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(2);
    latest().open();
    renew.mockResolvedValue(false);
    latest().drop(4401);
    await settle();
    // `ManagedSocket` 连续第二次 4401 就是续不上。
    expect(control.closedWith).toBe(4401);
    expect(control.readyState).toBe(3);
  });

  it("可见时每 30 秒探一次：3 秒没回音就丢掉这条立刻重连", async () => {
    const control = await open();
    latest().open();
    const ping = vi.fn(() => new Promise<void>(() => undefined));
    control.setPing(ping);
    const closed = vi.fn();
    control.addEventListener("close", closed);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(ping).toHaveBeenCalledTimes(1);
    const first = latest();
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(first.closed).toBe(true);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("探活答了一个错误也算活着：不重连", async () => {
    const control = await open();
    latest().open();
    control.setPing(async () => {
      throw Object.assign(new Error("forbidden"), { code: "forbidden" });
    });
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + PING_TIMEOUT_MS);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(control.readyState).toBe(1);
  });

  it("隐藏时不探", async () => {
    const control = await open();
    latest().open();
    const ping = vi.fn(async () => ({}));
    control.setPing(ping);
    visible = false;
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
    expect(ping).not.toHaveBeenCalled();
  });

  it("回到前台：托管流探活失败换掉内层时，peer 客户端也先收到 close", async () => {
    const control = await open();
    latest().open();
    control.setPing(() => new Promise<void>(() => undefined));
    const events: string[] = [];
    control.addEventListener("close", () => events.push("close"));
    control.addEventListener("open", () => events.push("open"));
    environment.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
    latest().open();
    expect(events).toEqual(["close", "open"]);
  });

  it("关闭码都有文案键", () => {
    for (const code of [1000, 1001, 4400, 4401, 4403, 4409, 4413, 4429]) {
      expect(closeMessageKey(code)).toMatch(/^connection\.closed\./);
    }
    expect(closeMessageKey(1006)).toBeUndefined();
  });
});
