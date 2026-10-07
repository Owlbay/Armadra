import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { DRAIN_POLL_MS } from "../http/stream-queue";
import type { Attachment } from "./backend";
import type { TerminalManager } from "./manager";
import {
  FLUSH_BYTES,
  SEND_HIGH_WATER_BYTES,
  SEND_MAX_FRAMES,
  serveTerminalSocket,
} from "./socket";

/**
 * 终端流的背压（平台规格 core 包 §3.3）：socket 积压超过 4 MiB 时暂停读 PTY，
 * 降下来再恢复；暂停期间路上的帧排队，不丢；对端完全不读、队列满了就以 1013
 * 关流，而不是丢一帧或无界地攒。
 */

const MIB = 1024 * 1024;

function harness() {
  const sent: Record<string, unknown>[] = [];
  const closes: number[] = [];
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let data: ((chunk: Buffer) => void) | undefined;
  const pause = vi.fn();
  const resume = vi.fn();
  const attachment: Attachment = {
    attachmentId: 1,
    generation: 1,
    onData: (listener) => {
      data = listener;
    },
    onExit: () => {},
    pause,
    resume,
  };
  const manager = {
    attach: async () => ({
      attachment,
      record: { kind: "tmux" },
      snapshot: undefined,
      size: { cols: 80, rows: 24 },
    }),
    acknowledgedInput: () => 0,
    generation: () => 1,
    noteOutput: () => {},
    detached: async () => {},
  } as unknown as TerminalManager;
  const connection = {
    readyState: 1,
    bufferedAmount: 0,
    send: (payload: Buffer, _options: unknown, written: () => void) => {
      sent.push(
        JSON.parse(payload.toString("utf8")) as Record<string, unknown>,
      );
      written();
    },
    close: (code: number) => {
      closes.push(code);
      connection.readyState = 3;
      handlers.get("close")?.();
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    },
  };
  const served = serveTerminalSocket(connection as unknown as WebSocket, {
    manager,
    sessionId: "s1",
    writer: "",
  });
  return {
    sent,
    closes,
    pause,
    resume,
    connection,
    served,
    /** One PTY read big enough to be flushed at once. */
    output: (fill: string) => data?.(Buffer.from(fill.repeat(FLUSH_BYTES))),
    outputs: () => sent.filter((frame) => frame.type === "output"),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("terminal backpressure", () => {
  it("pauses the PTY while the socket is 5 MiB behind and resumes once it drains", async () => {
    const socket = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent[0]?.type).toBe("hello");

    socket.connection.bufferedAmount = 5 * MIB;
    socket.output("a");
    expect(socket.pause).toHaveBeenCalledTimes(1);
    expect(socket.resume).not.toHaveBeenCalled();
    // What was already on its way when the pause landed queues behind it.
    socket.output("b");
    socket.output("c");
    expect(socket.outputs()).toHaveLength(1);

    // Still above the low-water mark: still paused.
    socket.connection.bufferedAmount = SEND_HIGH_WATER_BYTES / 2 + 1;
    await vi.advanceTimersByTimeAsync(DRAIN_POLL_MS * 5);
    expect(socket.resume).not.toHaveBeenCalled();

    socket.connection.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(DRAIN_POLL_MS);
    expect(socket.resume).toHaveBeenCalledTimes(1);
    // Nothing lost, nothing reordered.
    expect(
      socket.outputs().map((frame) => (frame.data as string).slice(0, 1)),
    ).toEqual(["a", "b", "c"]);
    socket.connection.close(1000);
    await socket.served;
  });

  it("closes with 1013 when a peer stops reading altogether", async () => {
    const socket = harness();
    await vi.advanceTimersByTimeAsync(0);
    socket.connection.bufferedAmount = 5 * MIB;
    for (let index = 0; index <= SEND_MAX_FRAMES + 1; index += 1) {
      socket.output("x");
    }
    expect(socket.closes).toEqual([1013]);
    // The socket is gone: its pause is released rather than left on the PTY.
    expect(socket.resume).toHaveBeenCalledTimes(1);
    await socket.served;
  });
});
