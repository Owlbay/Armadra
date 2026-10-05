import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Source } from "./source";
import {
  BACKGROUND_CAP_MS,
  CONTROL_PROTOCOL,
  ControlChannel,
  FOREGROUND_CAP_MS,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  closeMessageKey,
  onControlClosed,
} from "./ws";

/** 一条假的内层 socket：测试替 core 开、关、发帧。 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly protocols: string | string[],
  ) {
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
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

let renew: ReturnType<typeof vi.fn>;
let visibility: DocumentVisibilityState;
let documentTarget: EventTarget;
let windowTarget: EventTarget;
let channel: ControlChannel | null = null;

function source(): Source {
  return {
    sourceId: "test",
    httpBase: "http://core.test",
    wsBase: "http://core.test",
    credentials: {
      mode: "bearer",
      access: async () => "token",
      renew: renew as unknown as Source["credentials"]["renew"],
      csrf: async () => null,
      renewCsrf: async () => null,
    },
    fetch: globalThis.fetch,
    // 经源的 WebSocket：Bearer 模式下它先换一张票再连（`api/source.ts`）。
    WebSocket: FakeSocket as unknown as typeof WebSocket,
  };
}

function open(): ControlChannel {
  const environment = {
    document: Object.defineProperty(documentTarget, "visibilityState", {
      get: () => visibility,
      configurable: true,
    }) as unknown as Document,
    window: windowTarget as unknown as Window,
    random: () => 0.5,
  };
  channel = new ControlChannel(source(), environment);
  return channel;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  renew = vi.fn(async () => true);
  visibility = "visible";
  documentTarget = new EventTarget();
  windowTarget = new EventTarget();
});

afterEach(() => {
  channel?.close();
  channel = null;
  vi.useRealTimers();
});

describe("ControlChannel", () => {
  it("经源的 WebSocket 连 /api/ws，子协议 armadra-rpc.v1；帧原样转出", () => {
    const control = open();
    const socket = latest();
    expect(socket.url).toBe("ws://core.test/api/ws");
    expect(socket.protocols).toBe(CONTROL_PROTOCOL);
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

  it("断了先回到「连接中」再发 close，按全抖动退避重连（每次重新换票）", () => {
    const control = open();
    latest().open();
    const states: number[] = [];
    control.addEventListener("close", () => states.push(control.readyState));
    latest().drop();
    expect(states).toEqual([0]);
    expect(() => control.send("x")).toThrow();
    // 抖动取一半：第 0 次等 250 ms，第 1 次 500 ms。
    vi.advanceTimersByTime(249);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    latest().drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
    // 连上过就归零。
    latest().open();
    latest().drop();
    vi.advanceTimersByTime(250);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("退避封顶：前台 10 秒，后台 30 秒", () => {
    open();
    for (let index = 0; index < 8; index += 1) {
      latest().drop();
      vi.advanceTimersByTime(FOREGROUND_CAP_MS);
    }
    const before = FakeSocket.instances.length;
    latest().drop();
    vi.advanceTimersByTime(FOREGROUND_CAP_MS / 2);
    expect(FakeSocket.instances).toHaveLength(before + 1);
    visibility = "hidden";
    latest().drop();
    vi.advanceTimersByTime(FOREGROUND_CAP_MS / 2);
    expect(FakeSocket.instances).toHaveLength(before + 1);
    vi.advanceTimersByTime(BACKGROUND_CAP_MS / 2 - FOREGROUND_CAP_MS / 2);
    expect(FakeSocket.instances).toHaveLength(before + 2);
  });

  it("4403 / 4409 / 4429 停下不再连，并告诉页面", () => {
    for (const code of [4403, 4409, 4429]) {
      const seen = vi.fn();
      const off = onControlClosed(seen);
      const control = open();
      latest().open();
      latest().drop(code);
      expect(control.readyState).toBe(3);
      expect(control.closedWith).toBe(code);
      expect(seen).toHaveBeenCalledWith(code, expect.anything());
      const count = FakeSocket.instances.length;
      vi.advanceTimersByTime(60_000);
      expect(FakeSocket.instances).toHaveLength(count);
      off();
    }
  });

  it("4401：先续凭据，再立刻换票重连一次；紧接着再来一次就退避", async () => {
    open();
    latest().open();
    latest().drop(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(2);
    latest().open();
    latest().drop(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("等退避时回到前台或网络恢复：跳过退避立刻连", () => {
    open();
    for (let index = 0; index < 4; index += 1) {
      latest().drop();
      vi.advanceTimersByTime(FOREGROUND_CAP_MS);
    }
    visibility = "hidden";
    latest().drop();
    const count = FakeSocket.instances.length;
    visibility = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSocket.instances).toHaveLength(count + 1);
    latest().drop();
    windowTarget.dispatchEvent(new Event("online"));
    expect(FakeSocket.instances).toHaveLength(count + 2);
  });

  it("回到前台时探一次：3 秒没回音就断开重连，不等退避", async () => {
    const control = open();
    latest().open();
    let answer: (() => void) | null = null;
    control.setPing(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    visibility = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(answer).not.toBeNull();
    const first = latest();
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS - 1);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.closed).toBe(true);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("可见时每 30 秒探一次；隐藏时不探", async () => {
    const control = open();
    latest().open();
    const ping = vi.fn(async () => ({}));
    control.setPing(ping);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(ping).toHaveBeenCalledTimes(1);
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("关闭码都有文案键", () => {
    for (const code of [1000, 1001, 4400, 4401, 4403, 4409, 4413, 4429]) {
      expect(closeMessageKey(code)).toMatch(/^connection\.closed\./);
    }
    expect(closeMessageKey(1006)).toBeUndefined();
  });
});
