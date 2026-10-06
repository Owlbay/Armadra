import { Agent, request } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus";
import type { CorePlatform } from "../platform";
import { CoreServer } from "./server";
import { HTTP_TIMEOUTS } from "./timeouts";

const log = { error() {}, warn() {}, info() {}, debug() {} };
let server: CoreServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function listening() {
  server = new CoreServer({
    platform: { log } as unknown as CorePlatform,
    bus: new EventBus(),
    version: "test",
  });
  server.router.handle("POST", "/api/terminals", () => ({
    status: 200,
    body: { ok: true },
  }));
  const listener = server.createListener();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  return listener;
}

describe("core 监听的超时", () => {
  it("空闲 keep-alive 75 秒，请求头超时略大于它，整条请求 5 分钟", async () => {
    const listener = await listening();
    expect(listener.keepAliveTimeout).toBe(75_000);
    expect(listener.headersTimeout).toBe(76_000);
    expect(listener.requestTimeout).toBe(300_000);
    expect(HTTP_TIMEOUTS.headersTimeoutMs).toBeGreaterThan(
      HTTP_TIMEOUTS.keepAliveTimeoutMs,
    );
    expect(HTTP_TIMEOUTS.requestTimeoutMs).toBeGreaterThanOrEqual(
      HTTP_TIMEOUTS.headersTimeoutMs,
    );
  });

  it("空闲 6 秒后同一条 keep-alive 连接还在，POST 照样成功（Node 缺省 5 秒会先关）", async () => {
    const listener = await listening();
    const { port } = listener.address() as AddressInfo;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const sockets = new Set<Socket>();
    let closedByServer = false;
    const post = () =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: "/api/terminals",
            method: "POST",
            agent,
            headers: {
              "content-type": "application/json",
              origin: `http://127.0.0.1:${port}`,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("socket", (socket: Socket) => {
          if (sockets.has(socket)) return;
          sockets.add(socket);
          socket.once("close", () => (closedByServer = true));
        });
        req.on("error", reject);
        req.end("{}");
      });
    try {
      expect(await post()).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect(closedByServer).toBe(false);
      expect(await post()).toBe(200);
      expect(sockets.size).toBe(1);
    } finally {
      agent.destroy();
    }
  }, 15_000);
});
