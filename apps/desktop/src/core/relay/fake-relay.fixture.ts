/**
 * 测试用：一个假的中继节点（`ws` 服务器，明文，`/t/v1`）。实现握手（验源签名）、
 * 帧、两级窗口与心跳应答；能在一条已就绪的隧道上开流，经流发真的 HTTP 请求与
 * WebSocket 升级——与真中继的边缘一样用 `http.request` / `ws` 的 `createConnection`。
 * 流控用 core 同一份 {@link TunnelDuplex}（对角色无感）。
 *
 * 只有 `*.test.ts` import 它。
 */

import { type KeyObject, randomBytes, verify } from "node:crypto";
import { once } from "node:events";
import {
  type IncomingHttpHeaders,
  type Server,
  createServer,
  request as httpRequest,
} from "node:http";
import type { AddressInfo } from "node:net";

import { PROTOCOL_VERSION } from "@armadra/platform-protocol";
import {
  type Frame,
  type GoawayReason,
  type Hello,
  LIMITS,
  type OpenPayload,
  type TunnelRejectCode,
  authSchema,
  challengeSigningInput,
  decodeFrame,
  encodeFrame,
  helloSchema,
} from "@armadra/platform-protocol/tunnel";
import { type RawData, WebSocket, WebSocketServer } from "ws";

import { CreditPool, type StreamHost, TunnelDuplex } from "./streams";

export const RELAY_NODE = "node-a";
export const CLIENT_IP = "203.0.113.7";

export interface FakeRelayOptions {
  /** 验 `auth` 的源公钥；不给就不验。 */
  sourceKey?: () => KeyObject | undefined;
  /** 下一次握手答这个拒绝码（一直生效，直到改回 `undefined`）。 */
  reject?: TunnelRejectCode;
  heartbeatMs?: number;
  streamWindow?: number;
  tunnelWindow?: number;
  maxStreams?: number;
}

function bytesOf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export interface HttpAnswer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  json<T = Record<string, unknown>>(): T;
}

/** 中继一侧的一条隧道。 */
export class FakeTunnel {
  readonly streams = new Map<number, TunnelDuplex>();
  private nextStreamId = 1;
  private sendPool: CreditPool;
  private recvUnacked = 0;
  pongs = 0;
  pings = 0;
  /** `true`：收到的 PING 不答（让 core 的心跳超时）。 */
  silent = false;
  /** `true`：流级 WINDOW 先扣下（窗口耗尽测试），`releaseWindows()` 再发。 */
  holdWindows = false;
  private held: Frame[] = [];
  /** core 发来的 DATA 字节（按流）。 */
  readonly received = new Map<number, number>();
  closeCode: number | undefined;
  readonly closed: Promise<number>;
  private readonly host: StreamHost;

  constructor(
    readonly ws: WebSocket,
    readonly hello: Hello,
    private readonly limits: {
      streamWindow: number;
      tunnelWindow: number;
    },
  ) {
    this.sendPool = new CreditPool(limits.tunnelWindow);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.host = {
      sendFrame: (frame) => {
        if (
          frame.type === "window" &&
          frame.streamId !== 0 &&
          self.holdWindows
        ) {
          self.held.push(frame);
          return;
        }
        self.send(frame);
      },
      get sendCredit() {
        return self.sendPool;
      },
      consumed: (bytes) => {
        self.recvUnacked += bytes;
        if (self.recvUnacked >= limits.tunnelWindow / 2) {
          self.send({ type: "window", streamId: 0, credit: self.recvUnacked });
          self.recvUnacked = 0;
        }
      },
      closed: (stream) => {
        if (self.streams.get(stream.streamId) === stream) {
          self.streams.delete(stream.streamId);
        }
      },
    };
    this.closed = new Promise((resolve) => {
      ws.on("close", (code: number) => {
        this.closeCode = code;
        for (const stream of [...this.streams.values()]) stream.receiveRst(3);
        this.streams.clear();
        resolve(code);
      });
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) this.receive(bytesOf(data));
    });
  }

  send(frame: Frame): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeFrame(frame), { binary: true });
  }

  releaseWindows(): void {
    this.holdWindows = false;
    for (const frame of this.held.splice(0)) this.send(frame);
  }

  private receive(bytes: Uint8Array): void {
    const frame = decodeFrame(bytes);
    switch (frame.type) {
      case "data": {
        this.received.set(
          frame.streamId,
          (this.received.get(frame.streamId) ?? 0) + frame.bytes.length,
        );
        const stream = this.streams.get(frame.streamId);
        if (stream === undefined) this.host.consumed(frame.bytes.length);
        else stream.receiveData(frame.bytes);
        return;
      }
      case "end":
        this.streams.get(frame.streamId)?.receiveEnd();
        return;
      case "rst":
        this.streams.get(frame.streamId)?.receiveRst(frame.code);
        return;
      case "window":
        if (frame.streamId === 0) this.sendPool.add(frame.credit);
        else this.streams.get(frame.streamId)?.receiveWindow(frame.credit);
        return;
      case "ping":
        this.pings += 1;
        if (!this.silent) this.send({ type: "pong", ts: frame.ts });
        return;
      case "pong":
        this.pongs += 1;
        return;
      default:
        return;
    }
  }

  /** 发 OPEN，答中继一侧的那条流。 */
  openStream(open: Partial<OpenPayload> = {}): TunnelDuplex {
    const streamId = this.nextStreamId;
    this.nextStreamId += 1;
    const payload: OpenPayload = {
      kind: open.kind ?? "http",
      method: open.method ?? "GET",
      path: open.path ?? "/",
      headers: open.headers ?? [["host", "relay.test"]],
      clientOrigin: open.clientOrigin === undefined ? null : open.clientOrigin,
      remoteIp: open.remoteIp ?? CLIENT_IP,
      relayNode: open.relayNode ?? RELAY_NODE,
    };
    this.send({ type: "open", streamId, open: payload });
    const stream = new TunnelDuplex(streamId, this.host, {
      streamWindow: this.limits.streamWindow,
      maxDataChunk: LIMITS.maxDataChunk,
    });
    stream.on("error", () => undefined);
    this.streams.set(streamId, stream);
    return stream;
  }

  /** 经一条新流发一个 HTTP 请求（`connection: close`，一流一个请求）。 */
  async request(input: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    /** OPEN 里的客户端来源；缺省取 `headers.origin`。 */
    clientOrigin?: string | null;
  }): Promise<HttpAnswer> {
    const method = input.method ?? "GET";
    const headers: Record<string, string> = {
      host: "relay.test",
      ...input.headers,
      connection: "close",
    };
    const clientOrigin =
      input.clientOrigin !== undefined
        ? input.clientOrigin
        : (headers.origin ?? null);
    const stream = this.openStream({
      kind: "http",
      method,
      path: input.path,
      clientOrigin,
    });
    return new Promise<HttpAnswer>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          createConnection: () => stream,
          method,
          path: input.path,
          headers,
          setHost: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body,
              json: <T>() => JSON.parse(body.toString("utf8")) as T,
            });
          });
          response.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      if (input.body !== undefined) outgoing.write(input.body);
      outgoing.end();
    });
  }

  /** 经一条新流升级 WebSocket。 */
  websocket(
    path: string,
    options: {
      protocols?: string[];
      origin?: string | null;
      clientOrigin?: string | null;
    } = {},
  ): WebSocket {
    const origin = options.origin === undefined ? null : options.origin;
    const stream = this.openStream({
      kind: "ws",
      path,
      clientOrigin:
        options.clientOrigin === undefined ? origin : options.clientOrigin,
    });
    const socket = new WebSocket(
      `ws://relay.test${path}`,
      options.protocols ?? [],
      {
        createConnection: () => stream as never,
        perMessageDeflate: false,
        ...(origin === null ? {} : { origin }),
      },
    );
    socket.on("error", () => undefined);
    return socket;
  }

  goaway(reason: GoawayReason, graceMs: number): void {
    this.send({ type: "goaway", reason, graceMs });
  }

  ping(): void {
    this.send({ type: "ping", ts: Date.now() });
  }

  close(code: number, reason = ""): void {
    this.ws.close(code, reason);
  }
}

export class FakeTunnelRelay {
  readonly hellos: Hello[] = [];
  readonly tunnels: FakeTunnel[] = [];
  /** 每次升级（含没握完手的）。 */
  connections = 0;
  private waiters: {
    after: number;
    resolve: (tunnel: FakeTunnel) => void;
  }[] = [];
  private constructor(
    private readonly server: Server,
    private readonly wss: WebSocketServer,
    readonly url: string,
    readonly options: FakeRelayOptions,
  ) {}

  static async start(options: FakeRelayOptions = {}): Promise<FakeTunnelRelay> {
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: LIMITS.maxFrameBytes + 16,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const relay = new FakeTunnelRelay(
      server,
      wss,
      `ws://127.0.0.1:${port}/t/v1`,
      options,
    );
    server.on("upgrade", (request, socket, head) => {
      if (new URL(request.url ?? "/", "http://x").pathname !== "/t/v1") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => relay.accept(ws));
    });
    return relay;
  }

  /** 等下一条就绪的隧道（已经有比 `after` 多的就立即答）。 */
  nextTunnel(after = this.tunnels.length): Promise<FakeTunnel> {
    const ready = this.tunnels[after];
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => {
      this.waiters.push({ after, resolve });
    });
  }

  private accept(ws: WebSocket): void {
    this.connections += 1;
    let hello: Hello | undefined;
    const nonce2 = randomBytes(16).toString("base64url");
    ws.on("error", () => undefined);
    const onText = (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        ws.close(4400, "binary before ready");
        return;
      }
      const message = JSON.parse(bytesOf(data).toString("utf8")) as unknown;
      if (hello === undefined) {
        const parsed = helloSchema.safeParse(message);
        if (!parsed.success) {
          ws.close(4400, "bad_hello");
          return;
        }
        hello = parsed.data;
        this.hellos.push(hello);
        const reject = this.options.reject;
        if (reject !== undefined) {
          ws.send(
            JSON.stringify({ type: "reject", code: reject, message: reject }),
          );
          ws.close(reject === "protocol_unsupported" ? 4409 : 4490, reject);
          return;
        }
        ws.send(
          JSON.stringify({ type: "challenge", nonce2, relayNode: RELAY_NODE }),
        );
        return;
      }
      const auth = authSchema.safeParse(message);
      if (!auth.success) {
        ws.close(4400, "bad_auth");
        return;
      }
      const key = this.options.sourceKey?.();
      if (key !== undefined) {
        const valid = verify(
          null,
          challengeSigningInput({
            sourceId: hello.sourceId,
            nonce: hello.nonce,
            nonce2,
            relayNode: RELAY_NODE,
          }),
          key,
          Buffer.from(auth.data.sig, "base64url"),
        );
        if (!valid) {
          ws.send(
            JSON.stringify({
              type: "reject",
              code: "signature_invalid",
              message: "signature invalid",
            }),
          );
          ws.close(4490, "signature_invalid");
          return;
        }
      }
      const limits = {
        maxStreams: this.options.maxStreams ?? LIMITS.maxStreams,
        streamWindow: this.options.streamWindow ?? LIMITS.streamWindow,
        tunnelWindow: this.options.tunnelWindow ?? LIMITS.tunnelWindow,
        maxFrameBytes: LIMITS.maxFrameBytes,
      };
      ws.off("message", onText);
      const tunnel = new FakeTunnel(ws, hello, limits);
      this.tunnels.push(tunnel);
      ws.send(
        JSON.stringify({
          type: "ready",
          tunnelId: randomBytes(16).toString("hex"),
          limits,
          heartbeatMs: this.options.heartbeatMs ?? LIMITS.heartbeatMs,
          protocol: PROTOCOL_VERSION,
        }),
      );
      const waiting = this.waiters.splice(0);
      for (const waiter of waiting) {
        const found = this.tunnels[waiter.after];
        if (found !== undefined) waiter.resolve(found);
        else this.waiters.push(waiter);
      }
    };
    ws.on("message", onText);
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
