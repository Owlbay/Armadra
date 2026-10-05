import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus";
import type { CorePlatform } from "../platform";
import { CoreServer, DEFAULT_MAX_PAYLOAD_BYTES } from "./server";

/**
 * 每条流都有 `ws` 层心跳（工程规范化 §3.3）与单帧上限。这里用一个只有两条流的
 * core 服务器量：一条缺省上限，一条声明了更大的上限。
 */

/** Two real rows of the route table; the router refuses any other path. */
const SMALL = "/api/workspaces/{workspaceId}/events";
const LARGE = "/api/terminals/{sessionId}/ws";
const SMALL_URL = "/api/workspaces/w1/events";
const LARGE_URL = "/api/terminals/t1/ws";

const log = { error() {}, warn() {}, info() {}, debug() {} };
const servers: CoreServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function start(heartbeatMs: number) {
  const server = new CoreServer({
    platform: { log } as unknown as CorePlatform,
    bus: new EventBus(),
    version: "test",
    heartbeatMs,
  });
  servers.push(server);
  const received: number[] = [];
  for (const [path, maxPayload] of [
    [SMALL, undefined],
    [LARGE, 4 * 1024 * 1024],
  ] as const) {
    server.router.handle("GET", path, () => ({ status: 200, body: {} }));
    server.stream(
      path,
      (connection) => {
        connection.on("message", (data: Buffer) =>
          received.push(data.byteLength),
        );
      },
      undefined,
      maxPayload === undefined ? {} : { maxPayload },
    );
  }
  const listener = server.createListener();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const { port } = listener.address() as AddressInfo;
  const connect = async (
    path: string,
    options: { autoPong?: boolean } = {},
  ) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      origin: `http://127.0.0.1:${port}`,
      ...options,
    });
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    return client;
  };
  return { connect, received };
}

function closeOf(client: WebSocket): Promise<number> {
  return new Promise((resolve) =>
    client.once("close", (code) => resolve(code)),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("stream heartbeat", () => {
  it("terminates a client that stops answering pings", async () => {
    const { connect } = await start(40);
    const silent = await connect(SMALL_URL, { autoPong: false });
    let pings = 0;
    silent.on("ping", () => {
      pings += 1;
    });
    const started = Date.now();
    // Terminated, not closed: no close frame, so the client sees 1006.
    expect(await closeOf(silent)).toBe(1006);
    expect(pings).toBe(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps a client that answers", async () => {
    const { connect } = await start(40);
    const lively = await connect(SMALL_URL);
    let pings = 0;
    lively.on("ping", () => {
      pings += 1;
    });
    await sleep(400);
    expect(pings).toBeGreaterThanOrEqual(4);
    expect(lively.readyState).toBe(WebSocket.OPEN);
    lively.close();
  });
});

describe("stream frame ceiling", () => {
  it("closes with 1009 over the default ceiling, and honours a stream's own", async () => {
    const { connect, received } = await start(0);
    const small = await connect(SMALL_URL);
    const smallClosed = closeOf(small);
    small.send(Buffer.alloc(DEFAULT_MAX_PAYLOAD_BYTES + 1));
    expect(await smallClosed).toBe(1009);

    const large = await connect(LARGE_URL);
    large.send(Buffer.alloc(2 * 1024 * 1024));
    for (let tries = 0; tries < 100 && received.length === 0; tries += 1) {
      await sleep(10);
    }
    expect(received).toEqual([2 * 1024 * 1024]);
    expect(large.readyState).toBe(WebSocket.OPEN);
    large.close();
  });
});
