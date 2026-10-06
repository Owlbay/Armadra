import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { RST } from "@armadra/platform-protocol/tunnel";

import { TunnelClient } from "./client";
import {
  CLIENT_IP,
  type FakeTunnel,
  FakeTunnelRelay,
} from "./fake-relay.fixture";
import { StreamResetError, TunnelDuplex } from "./streams";

/**
 * 隧道流（契约 §32，平台规格 core 包 §4.3）：经假中继发真的 HTTP 请求与
 * WebSocket 升级到一个 `http.Server`（core 用的就是 `emit("connection")` 这条路），
 * 两级窗口耗尽时停发、`WINDOW` 来了再发，流数满了 `RST refused`，隧道断了流随之
 * 结束。
 */

let relay: FakeTunnelRelay;
let server: Server;
let client: TunnelClient;
let tunnel: FakeTunnel;
let seen: { remote: string | undefined; encrypted: unknown; origin: unknown }[];
const sockets = new Set<Socket>();
let serverSockets: import("ws").WebSocket[] = [];

async function setup(options: { maxStreams?: number } = {}): Promise<void> {
  relay = await FakeTunnelRelay.start({ heartbeatMs: 60_000, ...options });
  seen = [];
  serverSockets = [];
  server = createServer((request, response) => {
    seen.push({
      remote: request.socket.remoteAddress,
      encrypted: (request.socket as { encrypted?: unknown }).encrypted,
      origin: (request.socket as { armadraOrigin?: unknown }).armadraOrigin,
    });
    const url = new URL(request.url ?? "/", "http://core");
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/echo") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      request.pipe(response);
      return;
    }
    if (url.pathname === "/chunked") {
      response.writeHead(200, { "content-type": "text/plain" });
      let index = 0;
      const timer = setInterval(() => {
        response.write(`part-${index};`);
        index += 1;
        if (index === 5) {
          clearInterval(timer);
          response.end();
        }
      }, 5);
      return;
    }
    if (url.pathname === "/big") {
      const total = Number(url.searchParams.get("bytes") ?? 0);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(total),
      });
      response.end(Buffer.alloc(total, 7));
      return;
    }
    if (url.pathname === "/hold") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("held");
      return;
    }
    response.writeHead(404).end();
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on(
    "upgrade",
    (request: IncomingMessage, socket: Socket, head: Buffer) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        serverSockets.push(ws);
        ws.on("message", (data, isBinary) =>
          ws.send(data, { binary: isBinary }),
        );
      });
    },
  );
  client = new TunnelClient({
    issuer: "https://relay.test",
    sourceId: () => "0123456789abcdef0123456789abcdef",
    coreVersion: "0.0.0-test",
    directory: {
      pick: async () => ({ url: relay.url, tunnelToken: "tunnel-token" }),
      rotate: () => undefined,
      invalidate: () => undefined,
    },
    signBytes: async () => new Uint8Array(64),
    listener: server,
    ca: async () => undefined,
    allowInsecure: () => true,
    backoff: () => 20,
  });
  client.start();
  tunnel = await relay.nextTunnel(0);
}

afterEach(async () => {
  client?.stop();
  for (const socket of sockets) socket.destroy();
  await relay?.close();
});

describe("隧道流：HTTP 与 WebSocket", () => {
  beforeEach(async () => {
    await setup();
  });

  it("GET 经隧道到 http.Server，来源地址是 OPEN 的 remoteIp、按 TLS 计", async () => {
    const answer = await tunnel.request({
      path: "/health",
      headers: { origin: "https://app.test" },
    });
    expect(answer.status).toBe(200);
    expect(answer.json()).toEqual({ ok: true });
    expect(seen[0]).toEqual({
      remote: CLIENT_IP,
      encrypted: true,
      origin: "https://app.test",
    });
    expect(client.status().state).toBe("ready");
  });

  it("POST 带体（跨多个 DATA 块）原样回来", async () => {
    const body = Buffer.alloc(300_000);
    for (let index = 0; index < body.length; index += 1) {
      body[index] = (index * 31 + 7) & 0xff;
    }
    const answer = await tunnel.request({
      method: "POST",
      path: "/echo",
      headers: { "content-length": String(body.length) },
      body,
    });
    expect(answer.status).toBe(200);
    expect(answer.body.equals(body)).toBe(true);
  });

  it("chunked 响应逐块到达", async () => {
    const answer = await tunnel.request({ path: "/chunked" });
    expect(answer.body.toString()).toBe("part-0;part-1;part-2;part-3;part-4;");
  });

  it("WebSocket 升级后回显文本与二进制", async () => {
    const socket = tunnel.websocket("/ws");
    await once(socket, "open");
    socket.send("hello");
    const [text] = (await once(socket, "message")) as [Buffer];
    expect(text.toString()).toBe("hello");
    socket.send(Buffer.from([1, 2, 3]));
    const [binary] = (await once(socket, "message")) as [Buffer];
    expect([...binary]).toEqual([1, 2, 3]);
    socket.close();
  });

  it("流窗口耗尽时停发，WINDOW 来了续发，整份一字节不少", async () => {
    tunnel.holdWindows = true;
    const pending = tunnel.request({ path: "/big?bytes=1048576" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const streamId = [...tunnel.received.keys()].at(-1) as number;
    // 只发了一个流窗口（256 KiB）就停下等 WINDOW。
    expect(tunnel.received.get(streamId)).toBe(262_144);
    tunnel.releaseWindows();
    const answer = await pending;
    expect(answer.body.length).toBe(1_048_576);
  });

  it("WebSocket 的 bufferedAmount 含隧道里没发出去的字节（发送队列据此判拥塞）", async () => {
    const socket = tunnel.websocket("/ws");
    await once(socket, "open");
    const server = serverSockets[0]!;
    tunnel.holdWindows = true;
    server.send(Buffer.alloc(1_048_576, 1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 流窗口 256 KiB 之外的那部分卡在隧道流的写缓冲里。
    expect(server.bufferedAmount).toBeGreaterThan(700_000);
    tunnel.releaseWindows();
    const [message] = (await once(socket, "message")) as [Buffer];
    expect(message.length).toBe(1_048_576);
    expect(server.bufferedAmount).toBe(0);
    socket.close();
  });

  it("隧道断了：这条隧道上的流随之结束，状态进退避", async () => {
    const stream = tunnel.openStream({ path: "/hold" });
    stream.write("GET /hold HTTP/1.1\r\nhost: relay.test\r\n\r\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets.size).toBe(1);
    tunnel.close(4492, "shutdown");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets.size).toBe(0);
    // 退避 20 ms 之后重连上第二条。
    await relay.nextTunnel(1);
    expect(client.status().state).toBe("ready");
  });
});

describe("隧道流：流数上限", () => {
  it("超过 maxStreams 的 OPEN 答 RST refused", async () => {
    await setup({ maxStreams: 1 });
    const first = tunnel.openStream({ path: "/hold" });
    first.write("GET /hold HTTP/1.1\r\nhost: relay.test\r\n\r\n");
    const second = tunnel.openStream({ path: "/hold" });
    await new Promise((resolve) => second.once("close", resolve));
    const error = second.errored;
    expect(error).toBeInstanceOf(StreamResetError);
    expect((error as StreamResetError).rstCode).toBe(RST.refused);
    expect(first.destroyed).toBe(false);
    expect(first).toBeInstanceOf(TunnelDuplex);
  });
});
