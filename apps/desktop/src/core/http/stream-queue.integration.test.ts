import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus";
import { WorkspaceEventStream } from "../events/stream";
import type { CorePlatform } from "../platform";
import { CoreServer } from "./server";
import { SendQueue, wsTarget } from "./stream-queue";

/**
 * 慢客户端，真的 socket（平台规格 core 包 §3.4）：客户端停止读它的 TCP 连接，
 * core 这一侧在用户态攒下的字节（`bufferedAmount` + 队列）必须有界；`pause`
 * 的流一帧不丢、顺序不变，`drop-oldest` 的流丢旧留新、连接不断。
 */

const log = { error() {}, warn() {}, info() {}, debug() {} };
const servers: CoreServer[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  for (const server of servers.splice(0)) await server.close();
});

async function listen(
  path: string,
  open: (
    connection: WebSocket,
    params: Readonly<Record<string, string>>,
  ) => void,
) {
  const server = new CoreServer({
    platform: { log } as unknown as CorePlatform,
    bus: new EventBus(),
    version: "test",
    heartbeatMs: 0,
  });
  servers.push(server);
  server.router.handle("GET", path, () => ({ status: 200, body: {} }));
  server.stream(path, open);
  const listener = server.createListener();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const { port } = listener.address() as AddressInfo;
  return async (url: string) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}${url}`, {
      origin: `http://127.0.0.1:${port}`,
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    return client;
  };
}

/** The client's TCP socket: pausing it is a client that stopped reading. */
function tcp(client: WebSocket): Socket {
  return (client as unknown as { _socket: Socket })._socket;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a slow client over a real socket", () => {
  it("pause: the producer stops, the backlog stays bounded, and nothing is lost", async () => {
    const FRAME = 64 * 1024;
    const HIGH = 512 * 1024;
    const MAX_FRAMES = 16;
    const TOTAL = 1_024; // 64 MiB if nothing held it back
    let produced = 0;
    let peak = 0;
    let pauses = 0;
    const connect = await listen(
      "/api/terminals/{sessionId}/ws",
      (connection) => {
        let paused = false;
        const queue: SendQueue = new SendQueue(
          wsTarget(connection, { binary: false }),
          {
            policy: "pause",
            maxFrames: MAX_FRAMES,
            highWaterBytes: HIGH,
            onPause: () => {
              paused = true;
              pauses += 1;
            },
            onResume: () => {
              paused = false;
              setImmediate(produce);
            },
            onOverflow: () => connection.close(1013, "backpressure"),
          },
        );
        // A producer that obeys the pause the way a paused PTY does: it may
        // still deliver what was already in flight (here: one more frame).
        const produce = (): void => {
          while (produced < TOTAL && !paused) {
            const header = String(produced).padStart(8, "0");
            queue.push(Buffer.from(header + "x".repeat(FRAME - 8)));
            produced += 1;
            peak = Math.max(
              peak,
              connection.bufferedAmount + queue.queuedBytes,
            );
          }
        };
        connection.on("close", () => queue.close());
        setImmediate(produce);
      },
    );
    const client = await connect("/api/terminals/t1/ws");
    const received: number[] = [];
    client.on("message", (data: Buffer) => {
      received.push(Number(data.subarray(0, 8).toString()));
    });
    tcp(client).pause();
    await sleep(400);
    const producedWhileStuck = produced;
    // The kernel's socket buffers take some; the core's own share is bounded
    // by the mark plus what was in flight when the pause landed.
    expect(producedWhileStuck).toBeLessThan(TOTAL / 4);
    expect(pauses).toBeGreaterThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(HIGH + 2 * FRAME);

    tcp(client).resume();
    for (let tries = 0; tries < 400 && received.length < TOTAL; tries += 1) {
      await sleep(25);
    }
    expect(received).toHaveLength(TOTAL);
    expect(received.every((value, index) => value === index)).toBe(true);
    expect(peak).toBeLessThanOrEqual(HIGH + 2 * FRAME);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it("coalesce with settled: an encoder that waits for its ack stalls with the client", async () => {
    // The browser screencast: Chromium encodes the next frame only after the
    // last one is acknowledged, and the ack waits for `settled`.
    const FRAME = 256 * 1024;
    let encoded = 0;
    let stop = false;
    const connect = await listen(
      "/api/workspaces/{workspaceId}/browser/{nodeId}/stream",
      (connection) => {
        const queue = new SendQueue(wsTarget(connection), {
          policy: "coalesce",
          maxFrames: 4,
          highWaterBytes: 2 * 1024 * 1024,
        });
        const encode = (): void => {
          if (stop) return;
          encoded += 1;
          const header = JSON.stringify({ type: "frame", seq: encoded });
          queue.push([header, Buffer.alloc(FRAME, 1)], "node", () =>
            setImmediate(encode),
          );
        };
        connection.on("close", () => {
          stop = true;
          queue.close();
        });
        setImmediate(encode);
      },
    );
    const client = await connect("/api/workspaces/w/browser/n/stream");
    let received = 0;
    client.on("message", (_data: Buffer, isBinary: boolean) => {
      if (isBinary) received += 1;
    });
    await sleep(100);
    tcp(client).pause();
    await sleep(100);
    const stuckAt = encoded;
    await sleep(400);
    // Nobody is reading, so nothing more is encoded once the socket stalls.
    expect(encoded - stuckAt).toBeLessThanOrEqual(1);
    tcp(client).resume();
    for (let tries = 0; tries < 200 && encoded <= stuckAt + 1; tries += 1) {
      await sleep(25);
    }
    expect(encoded).toBeGreaterThan(stuckAt + 1);
    expect(received).toBeGreaterThan(0);
    stop = true;
  });

  it("drop-oldest: the event stream keeps the newest frames and the connection", async () => {
    const stream = new WorkspaceEventStream();
    let release: (() => void) | undefined;
    const connect = await listen(
      "/api/workspaces/{workspaceId}/events",
      (connection, params) => {
        release = stream.attachSocket(params.workspaceId ?? "", connection);
        connection.on("close", () => release?.());
      },
    );
    const client = await connect("/api/workspaces/w1/events");
    const received: string[] = [];
    client.on("message", (data: Buffer) => {
      received.push(
        (JSON.parse(data.toString("utf8")) as { boardId: string }).boardId,
      );
    });
    tcp(client).pause();
    await sleep(50);
    const TOTAL = 40_000;
    const padding = "p".repeat(512);
    for (let index = 0; index < TOTAL; index += 1) {
      stream.publish("w1", {
        type: "board.changed",
        boardId: `b-${index}-${padding}`,
        updatedAt: "2026-10-06T00:00:00+00:00",
      });
    }
    const [dropped] = stream.droppedFrames("w1");
    expect(dropped).toBeGreaterThan(0);

    tcp(client).resume();
    const last = `b-${TOTAL - 1}-${padding}`;
    for (let tries = 0; tries < 400 && received.at(-1) !== last; tries += 1) {
      await sleep(25);
    }
    expect(received.at(-1)).toBe(last);
    expect(received.length + (dropped ?? 0)).toBe(TOTAL);
    expect(stream.subscriberCount("w1")).toBe(1);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });
});
