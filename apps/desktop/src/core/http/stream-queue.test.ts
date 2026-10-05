import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DRAIN_POLL_MS,
  OPEN,
  SendQueue,
  type SendQueueOptions,
  type SendTarget,
} from "./stream-queue";

/**
 * A socket whose backlog the test sets by hand. `hold` keeps every write's
 * callback until `release`, the way a real socket keeps it until the bytes
 * reach the kernel.
 */
function fakeSocket(options: { hold?: boolean } = {}) {
  const sent: (string | Uint8Array)[] = [];
  const pending: ((error?: Error) => void)[] = [];
  const socket = {
    bufferedAmount: 0,
    readyState: OPEN,
    send(data: string | Uint8Array, written: (error?: Error) => void) {
      sent.push(data);
      if (options.hold === true) pending.push(written);
      else written();
    },
  } satisfies SendTarget;
  return {
    socket,
    sent,
    release() {
      while (pending.length > 0) (pending.shift() as () => void)();
    },
  };
}

const KIB = 1024;

function queue(
  target: SendTarget,
  overrides: Partial<SendQueueOptions> & Pick<SendQueueOptions, "policy">,
) {
  return new SendQueue(target, {
    maxFrames: 4,
    highWaterBytes: 64 * KIB,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SendQueue", () => {
  it("writes straight through while the socket keeps up", () => {
    const fake = fakeSocket();
    const sendQueue = queue(fake.socket, { policy: "pause" });
    for (let index = 0; index < 100; index += 1) {
      expect(sendQueue.push(`frame-${index}`)).toBe(true);
    }
    expect(fake.sent).toHaveLength(100);
    expect(sendQueue.queuedFrames).toBe(0);
    expect(sendQueue.paused).toBe(false);
  });

  describe("drop-oldest", () => {
    it("bounds the backlog and drops from the front, keeping the connection", () => {
      const fake = fakeSocket();
      const onDrop = vi.fn();
      const sendQueue = queue(fake.socket, { policy: "drop-oldest", onDrop });
      fake.socket.bufferedAmount = 128 * KIB;
      for (let index = 0; index < 10; index += 1) sendQueue.push(`f${index}`);
      // The first write went out before the backlog was measured; the rest
      // queued, and only the newest four survive.
      expect(fake.sent).toEqual(["f0"]);
      expect(sendQueue.queuedFrames).toBe(4);
      expect(sendQueue.dropped).toBe(5);
      expect(onDrop).toHaveBeenCalledTimes(5);

      fake.socket.bufferedAmount = 0;
      vi.advanceTimersByTime(DRAIN_POLL_MS);
      expect(fake.sent).toEqual(["f0", "f6", "f7", "f8", "f9"]);
      expect(sendQueue.queuedFrames).toBe(0);
    });

    it("counts unanswered writes as backlog when the socket reports none", () => {
      const fake = fakeSocket({ hold: true });
      const sendQueue = queue(fake.socket, {
        policy: "drop-oldest",
        highWaterBytes: 10,
      });
      sendQueue.push("0123456789");
      sendQueue.push("a");
      sendQueue.push("b");
      expect(fake.sent).toEqual(["0123456789"]);
      expect(sendQueue.queuedFrames).toBe(2);
      // The write callback is the drain signal.
      fake.release();
      expect(fake.sent).toEqual(["0123456789", "a", "b"]);
    });
  });

  describe("coalesce", () => {
    it("keeps only the newest unit of a key, and sends a unit's frames together", () => {
      const fake = fakeSocket();
      const sendQueue = queue(fake.socket, { policy: "coalesce" });
      fake.socket.bufferedAmount = 128 * KIB;
      sendQueue.push("hello");
      sendQueue.push(["header-1", Buffer.from("jpeg-1")], "node");
      sendQueue.push(["header-2", Buffer.from("jpeg-2")], "node");
      sendQueue.push(["header-3", Buffer.from("jpeg-3")], "node");
      expect(sendQueue.queuedFrames).toBe(1);
      expect(sendQueue.dropped).toBe(2);

      fake.socket.bufferedAmount = 0;
      vi.advanceTimersByTime(DRAIN_POLL_MS);
      expect(fake.sent.map(String)).toEqual(["hello", "header-3", "jpeg-3"]);
    });

    it("drops stale keyed units before unkeyed ones when it is full", () => {
      const fake = fakeSocket();
      const sendQueue = queue(fake.socket, {
        policy: "coalesce",
        maxFrames: 2,
      });
      fake.socket.bufferedAmount = 128 * KIB;
      sendQueue.push("first");
      sendQueue.push("frame-a", "a");
      sendQueue.push("hello");
      sendQueue.push("frame-b", "b");
      fake.socket.bufferedAmount = 0;
      vi.advanceTimersByTime(DRAIN_POLL_MS);
      expect(fake.sent).toEqual(["first", "hello", "frame-b"]);
    });
  });

  describe("pause", () => {
    it("pauses the producer at the high-water mark and resumes below the low one", () => {
      const fake = fakeSocket();
      const onPause = vi.fn();
      const onResume = vi.fn();
      const sendQueue = queue(fake.socket, {
        policy: "pause",
        highWaterBytes: 4 * 1024 * KIB,
        onPause,
        onResume,
      });
      sendQueue.push("a");
      fake.socket.bufferedAmount = 5 * 1024 * KIB;
      sendQueue.push("b");
      expect(onPause).toHaveBeenCalledTimes(1);
      expect(sendQueue.paused).toBe(true);
      // Frames already on their way are queued, not dropped.
      sendQueue.push("c");
      sendQueue.push("d");
      expect(fake.sent).toEqual(["a", "b"]);

      // Between the two marks: still paused (hysteresis).
      fake.socket.bufferedAmount = 3 * 1024 * KIB;
      vi.advanceTimersByTime(DRAIN_POLL_MS * 5);
      expect(onResume).not.toHaveBeenCalled();
      expect(fake.sent).toEqual(["a", "b"]);

      fake.socket.bufferedAmount = 0;
      vi.advanceTimersByTime(DRAIN_POLL_MS);
      expect(fake.sent).toEqual(["a", "b", "c", "d"]);
      expect(onResume).toHaveBeenCalledTimes(1);
      expect(sendQueue.paused).toBe(false);
      expect(sendQueue.dropped).toBe(0);
    });

    it("refuses rather than drops once the queue is full", () => {
      const fake = fakeSocket();
      const onOverflow = vi.fn();
      const sendQueue = queue(fake.socket, {
        policy: "pause",
        maxFrames: 2,
        onOverflow,
      });
      fake.socket.bufferedAmount = 128 * KIB;
      expect(sendQueue.push("a")).toBe(true);
      expect(sendQueue.push("b")).toBe(true);
      expect(sendQueue.push("c")).toBe(true);
      expect(sendQueue.push("d")).toBe(false);
      expect(onOverflow).toHaveBeenCalledTimes(1);
      expect(sendQueue.dropped).toBe(0);
      expect(sendQueue.queuedBytes).toBe(2);
    });
  });

  it("close empties the queue and refuses later pushes", () => {
    const fake = fakeSocket();
    const onResume = vi.fn();
    const sendQueue = queue(fake.socket, { policy: "pause", onResume });
    fake.socket.bufferedAmount = 128 * KIB;
    sendQueue.push("a");
    sendQueue.push("b");
    sendQueue.close();
    expect(sendQueue.queuedFrames).toBe(0);
    expect(sendQueue.push("c")).toBe(false);
    fake.socket.bufferedAmount = 0;
    vi.advanceTimersByTime(DRAIN_POLL_MS * 2);
    expect(fake.sent).toEqual(["a"]);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("refuses a socket that is not open", () => {
    const fake = fakeSocket();
    fake.socket.readyState = 2;
    const sendQueue = queue(fake.socket, { policy: "drop-oldest" });
    expect(sendQueue.push("a")).toBe(false);
    expect(fake.sent).toEqual([]);
  });

  it("ignores a second callback for the same write", () => {
    const calls: (() => void)[] = [];
    const target: SendTarget = {
      bufferedAmount: 0,
      readyState: OPEN,
      send(_data, written) {
        calls.push(written);
      },
    };
    const sendQueue = new SendQueue(target, {
      policy: "pause",
      maxFrames: 4,
      highWaterBytes: 4,
    });
    sendQueue.push("abcd");
    sendQueue.push("efgh");
    expect(calls).toHaveLength(1);
    calls[0]?.();
    calls[0]?.();
    // One release, one more write — not two.
    expect(calls).toHaveLength(2);
    expect(sendQueue.paused).toBe(true);
  });
});
