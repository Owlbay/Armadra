/**
 * 一条出站隧道（契约 §32，平台规格 core 包 §4.2）：连中继、握手、帧循环、心跳、
 * GOAWAY、退避重连与节点轮换。帧格式与握手消息以协议包 `./tunnel` 为准。
 *
 * ```text
 * disabled ─start()─▶ connecting ─ws open─▶ authenticating ─ready─▶ ready ─GOAWAY─▶ draining
 *                         │ 失败 / 关闭 ─────────────────────────────────────────────▶ backoff ─定时─▶ connecting
 * ```
 *
 * 旁路保证：`start()` 不等任何网络，失败只进状态（`lastError`）与退避；隧道断开时
 * 只是这条隧道上的流以 `RST sourceGone` 结束，Node 的 HTTP 层自己收拾这些连接。
 * 终端、Agent、画布都不依赖连接存活，本机回环上的一切不受影响。
 *
 * 拒绝码：`protocol_unsupported` 停下且不再重连（直到 core 重启或重新登记）；
 * `source_revoked` 交给登记一侧撤销本机登记；`tunnel_token_*` 丢掉缓存的令牌；
 * 其余退避重来。中继发 `GOAWAY` 时不退避，立即换节点再连，旧隧道等流自然结束
 * 或 `graceMs` 到了再关。
 */

import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";

import { PROTOCOL_VERSION } from "@armadra/platform-protocol";
import type { TunnelStatus } from "@armadra/platform-protocol/core-api";
import {
  CLOSE,
  type Frame,
  FrameError,
  type GoawayReason,
  LIMITS,
  RST,
  TUNNEL_PATH,
  challengeSchema,
  challengeSigningInput,
  decodeFrame,
  encodeFrame,
  readySchema,
  rejectSchema,
} from "@armadra/platform-protocol/tunnel";
import { type RawData, WebSocket } from "ws";

import { RelayError } from "./nodes";
import { CreditPool, type StreamHost, TunnelDuplex } from "./streams";

export type TunnelState = TunnelStatus["state"];

export interface TunnelErrorInfo {
  readonly code: string;
  readonly message: string;
}

/** 退避：`min(60 s, 1 s × 2^attempt) × (0.5 + random)`。 */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 16));
  return Math.round(base * (0.5 + random()));
}

/** 节点地址 → 隧道地址：没写路径就补 `/t/v1`。 */
export function tunnelUrl(node: string): URL {
  const url = new URL(node);
  if (url.pathname === "" || url.pathname === "/") url.pathname = TUNNEL_PATH;
  return url;
}

export interface NodePicker {
  pick(): Promise<{ readonly url: string; readonly tunnelToken: string }>;
  rotate(): void;
  invalidate(): void;
}

export interface TunnelClientOptions {
  readonly issuer: string;
  readonly sourceId: () => string;
  readonly coreVersion: string;
  readonly directory: NodePicker;
  /** 握手 `auth`：源私钥签那几行字节。 */
  readonly signBytes: (data: Uint8Array) => Promise<Uint8Array>;
  /** 隧道流交给它（`CoreServer.createListener({ admitted: true, gate })`）。 */
  readonly listener: { emit(event: "connection", socket: Duplex): boolean };
  /** `wss://` 节点钉扎用的 CA（远程服务的指纹）；`undefined` = 系统信任。 */
  readonly ca: (url: URL) => Promise<string | undefined>;
  /** `ARMADRA_RELAY_ALLOW_INSECURE=1`：放行 `ws://`（探针）。 */
  readonly allowInsecure: () => boolean;
  /** 状态变了（含流数）。 */
  readonly onStatus?: (status: TunnelStatus, previous: TunnelState) => void;
  /** 中继说这台机器的登记已被撤销。 */
  readonly onRevoked?: () => void;
  readonly log?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  /** 测试用：退避时长与时钟。 */
  readonly backoff?: (attempt: number) => number;
  readonly now?: () => number;
  readonly handshakeTimeoutMs?: number;
}

function errorInfo(error: unknown): TunnelErrorInfo {
  if (error instanceof RelayError) {
    return { code: error.code, message: error.message };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code;
    if (code === "fingerprint_mismatch") {
      return { code, message: "中继证书与钉扎的指纹不一致" };
    }
  }
  return { code: "relay_unreachable", message: "连不上中继" };
}

export class TunnelClient {
  private running = false;
  private attempt = 0;
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private current: TunnelConnection | undefined;
  private readonly draining = new Set<TunnelConnection>();
  private state: TunnelState = "disabled";
  private node: string | null = null;
  private since: number | null = null;
  private lastError: TunnelErrorInfo | null = null;
  private readonly now: () => number;

  constructor(private readonly options: TunnelClientOptions) {
    this.now = options.now ?? Date.now;
  }

  get issuer(): string {
    return this.options.issuer;
  }

  /** 起隧道；不等、不抛。已经在跑就什么都不做。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    void this.connect();
  }

  /** 停：关掉所有连接（流以 `RST sourceGone` 结束），状态回到 `disabled`。 */
  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const current = this.current;
    this.current = undefined;
    current?.close(CLOSE.normal, "stopped");
    for (const connection of [...this.draining]) {
      connection.close(CLOSE.normal, "stopped");
    }
    this.draining.clear();
    this.setState("disabled", null);
  }

  get active(): boolean {
    return this.running;
  }

  status(): TunnelStatus {
    let streams = this.current?.streamCount ?? 0;
    for (const connection of this.draining) streams += connection.streamCount;
    return {
      state: this.state,
      node: this.node,
      since: this.since,
      streams,
      lastError: this.lastError === null ? null : { ...this.lastError },
    };
  }

  /* ------------------------------ 连接一次 ------------------------------ */

  private stale(generation: number): boolean {
    return !this.running || generation !== this.generation;
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    this.timer = undefined;
    this.setState("connecting", this.node);
    let picked: { url: string; tunnelToken: string };
    try {
      picked = await this.options.directory.pick();
    } catch (error) {
      if (this.stale(generation)) return;
      this.failed(errorInfo(error));
      return;
    }
    if (this.stale(generation)) return;
    let url: URL;
    try {
      url = tunnelUrl(picked.url);
    } catch {
      this.options.directory.rotate();
      this.failed({ code: "relay_unreachable", message: "节点地址不合法" });
      return;
    }
    const insecure = url.protocol === "ws:";
    if (
      (url.protocol !== "wss:" && !insecure) ||
      (insecure && !this.options.allowInsecure())
    ) {
      this.options.directory.rotate();
      this.failed({ code: "insecure_node", message: "中继节点不是 wss://" });
      return;
    }
    let ca: string | undefined;
    if (!insecure) {
      try {
        ca = await this.options.ca(url);
      } catch (error) {
        if (this.stale(generation)) return;
        this.options.directory.rotate();
        this.failed(errorInfo(error));
        return;
      }
      if (this.stale(generation)) return;
    }
    const connection = new TunnelConnection(
      {
        issuer: this.options.issuer,
        sourceId: this.options.sourceId(),
        coreVersion: this.options.coreVersion,
        tunnelToken: picked.tunnelToken,
        signBytes: this.options.signBytes,
        listener: this.options.listener,
        handshakeTimeoutMs:
          this.options.handshakeTimeoutMs ?? LIMITS.handshakeTimeoutMs,
      },
      {
        authenticating: () => {
          if (this.current === connection) {
            this.setState("authenticating", this.node);
          }
        },
        ready: (relayNode) => {
          if (this.current !== connection) return;
          this.attempt = 0;
          this.lastError = null;
          this.setState("ready", relayNode);
          this.options.log?.info("中继隧道已就绪", {
            issuer: this.options.issuer,
            node: relayNode,
          });
        },
        rejected: (code) => this.rejected(connection, code),
        goaway: (reason) => this.goaway(connection, reason),
        streams: () => this.emit(this.state),
        closed: (info) => this.closed(connection, info),
      },
    );
    this.current = connection;
    this.setState("connecting", url.host);
    connection.open(url, ca);
  }

  private rejected(connection: TunnelConnection, code: string): void {
    if (this.current !== connection) return;
    if (code === "tunnel_token_invalid" || code === "tunnel_token_expired") {
      this.options.directory.invalidate();
    }
    if (code === "protocol_unsupported" || code === "source_revoked") {
      // 不再重连：前者等 core 升级或重新登记，后者由登记一侧撤销。
      this.halt(connection.error ?? { code, message: code });
      if (code === "source_revoked") this.revoked();
    }
  }

  private goaway(connection: TunnelConnection, reason: GoawayReason): void {
    if (this.current !== connection) return;
    this.current = undefined;
    this.draining.add(connection);
    this.options.log?.info("中继要求换隧道", {
      issuer: this.options.issuer,
      reason,
    });
    this.setState("draining", this.node);
    // 不退避：立即换节点再连；旧隧道排空后自己关。
    this.options.directory.rotate();
    void this.connect();
  }

  private closed(
    connection: TunnelConnection,
    info: { code: number; error: TunnelErrorInfo | undefined; ready: boolean },
  ): void {
    if (this.draining.delete(connection)) {
      this.emit(this.state);
      return;
    }
    if (this.current !== connection) return;
    this.current = undefined;
    if (!this.running) return;
    if (!info.ready) this.options.directory.rotate();
    this.failed(
      info.error ?? {
        code: "relay_closed",
        message: `中继关闭了隧道（${info.code}）`,
      },
    );
  }

  /** 失败一次：记错误，`source_revoked` 交给登记一侧，其余退避重来。 */
  private failed(error: TunnelErrorInfo): void {
    if (!this.running) return;
    this.lastError = error;
    if (error.code === "source_revoked") {
      this.halt(error);
      this.revoked();
      return;
    }
    const delay = (this.options.backoff ?? backoffDelay)(this.attempt);
    this.attempt += 1;
    this.options.log?.warn("中继隧道未连上，稍后重试", {
      issuer: this.options.issuer,
      code: error.code,
      delayMs: delay,
    });
    this.setState("backoff", this.node);
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (this.stale(generation)) return;
      void this.connect();
    }, delay);
    this.timer.unref();
  }

  private halt(error: TunnelErrorInfo): void {
    this.running = false;
    this.generation += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.lastError = error;
    const current = this.current;
    this.current = undefined;
    current?.close(CLOSE.normal, "halted");
    this.setState("disabled", null);
  }

  private revoked(): void {
    try {
      this.options.onRevoked?.();
    } catch (error) {
      this.options.log?.warn("撤销本机登记失败", {
        issuer: this.options.issuer,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private setState(state: TunnelState, node: string | null): void {
    const previous = this.state;
    if (previous !== state) this.since = this.now();
    this.state = state;
    this.node = node;
    this.emit(previous);
  }

  private emit(previous: TunnelState): void {
    try {
      this.options.onStatus?.(this.status(), previous);
    } catch {
      // 状态的订阅者失败不影响隧道。
    }
  }
}

/* ------------------------------ 一条连接 ------------------------------ */

interface ConnectionDeps {
  readonly issuer: string;
  readonly sourceId: string;
  readonly coreVersion: string;
  readonly tunnelToken: string;
  readonly signBytes: (data: Uint8Array) => Promise<Uint8Array>;
  readonly listener: { emit(event: "connection", socket: Duplex): boolean };
  readonly handshakeTimeoutMs: number;
}

interface ConnectionEvents {
  authenticating(): void;
  ready(relayNode: string): void;
  rejected(code: string): void;
  goaway(reason: GoawayReason): void;
  streams(): void;
  closed(info: {
    code: number;
    error: TunnelErrorInfo | undefined;
    ready: boolean;
  }): void;
}

type Phase = "handshake" | "ready" | "draining" | "closed";

function bytesOf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** 一条 WebSocket 上的隧道：握手、流表、两级窗口、心跳。 */
class TunnelConnection {
  private ws: WebSocket | undefined;
  private phase: Phase = "handshake";
  private everReady = false;
  private readonly streams = new Map<number, TunnelDuplex>();
  private sendPool = new CreditPool(0);
  private recvRemaining = 0;
  private recvUnacked = 0;
  private tunnelWindow: number = LIMITS.tunnelWindow;
  private streamWindow: number = LIMITS.streamWindow;
  private maxStreams: number = LIMITS.maxStreams;
  private missed = 0;
  private heartbeat: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  private readonly nonce = randomBytes(16).toString("base64url");
  error: TunnelErrorInfo | undefined;
  private readonly host: StreamHost;

  constructor(
    private readonly deps: ConnectionDeps,
    private readonly events: ConnectionEvents,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.host = {
      sendFrame: (frame) => this.send(frame),
      // 每次就绪换新的信用池：读当前那个。
      get sendCredit() {
        return self.sendPool;
      },
      consumed: (bytes) => this.consumed(bytes),
      closed: (stream) => this.release(stream),
    };
  }

  get streamCount(): number {
    return this.streams.size;
  }

  open(url: URL, ca: string | undefined): void {
    const ws = new WebSocket(url, {
      perMessageDeflate: false,
      maxPayload: LIMITS.maxFrameBytes + 16,
      handshakeTimeout: this.deps.handshakeTimeoutMs,
      ...(ca === undefined ? {} : { ca }),
    });
    this.ws = ws;
    this.handshakeTimer = setTimeout(() => {
      this.error ??= { code: "handshake_timeout", message: "隧道握手超时" };
      ws.terminate();
    }, this.deps.handshakeTimeoutMs);
    this.handshakeTimer.unref();
    ws.on("open", () => {
      this.sendText({
        type: "hello",
        protocol: {
          major: PROTOCOL_VERSION.major,
          minor: PROTOCOL_VERSION.minor,
        },
        sourceId: this.deps.sourceId,
        coreVersion: this.deps.coreVersion,
        capabilities: [],
        tunnelToken: this.deps.tunnelToken,
        nonce: this.nonce,
      });
      this.events.authenticating();
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) this.receive(bytesOf(data));
      else void this.onText(bytesOf(data).toString("utf8"));
    });
    ws.on("close", (code: number) => this.finish(code));
    ws.on("error", (error: Error & { code?: string }) => {
      const tls =
        typeof error.code === "string" &&
        (error.code.startsWith("ERR_TLS") ||
          error.code.includes("CERT") ||
          error.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
          error.code === "SELF_SIGNED_CERT_IN_CHAIN");
      this.error ??= tls
        ? {
            code: "fingerprint_mismatch",
            message: "中继证书没有由钉扎的信任锚签发",
          }
        : { code: "relay_unreachable", message: "连不上中继" };
    });
  }

  /** 正常关闭：发关闭帧，流以 `RST sourceGone` 结束。 */
  close(code: number, reason: string): void {
    if (this.phase === "closed") return;
    const ws = this.ws;
    this.finish(code);
    if (ws === undefined) return;
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws.close(code, reason);
  }

  /* ------------------------------ 握手 ------------------------------ */

  private async onText(text: string): Promise<void> {
    if (this.phase !== "handshake") {
      this.protocolError("ready 之后收到文本帧");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.protocolError("握手消息不是 JSON");
      return;
    }
    const challenge = challengeSchema.safeParse(message);
    if (challenge.success) {
      let signature: Uint8Array;
      try {
        signature = await this.deps.signBytes(
          challengeSigningInput({
            sourceId: this.deps.sourceId,
            nonce: this.nonce,
            nonce2: challenge.data.nonce2,
            relayNode: challenge.data.relayNode,
          }),
        );
      } catch {
        this.error = {
          code: "source_key_unavailable",
          message: "源私钥不可用",
        };
        this.close(CLOSE.normal, "source_key_unavailable");
        return;
      }
      if (this.phase !== "handshake") return;
      this.relayNode = challenge.data.relayNode;
      this.sendText({
        type: "auth",
        sig: Buffer.from(signature).toString("base64url"),
      });
      return;
    }
    const ready = readySchema.safeParse(message);
    if (ready.success) {
      if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer);
      const { limits, heartbeatMs } = ready.data;
      this.tunnelWindow = limits.tunnelWindow;
      this.streamWindow = limits.streamWindow;
      this.maxStreams = limits.maxStreams;
      this.sendPool = new CreditPool(limits.tunnelWindow);
      this.recvRemaining = limits.tunnelWindow;
      this.recvUnacked = 0;
      this.phase = "ready";
      this.everReady = true;
      this.heartbeat = setInterval(() => this.tick(), heartbeatMs);
      this.heartbeat.unref();
      this.events.ready(this.relayNode ?? "");
      return;
    }
    const reject = rejectSchema.safeParse(message);
    if (reject.success) {
      this.error = { code: reject.data.code, message: reject.data.message };
      this.events.rejected(reject.data.code);
      return;
    }
    this.protocolError("看不懂的握手消息");
  }

  private relayNode: string | undefined;

  private sendText(message: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  /* ------------------------------- 帧 ------------------------------- */

  private receive(bytes: Uint8Array): void {
    if (this.phase === "closed") return;
    if (this.phase === "handshake") {
      this.protocolError("ready 之前收到二进制帧");
      return;
    }
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      this.error = { code: "tunnel_protocol_error", message: "隧道帧格式错误" };
      this.close(
        error instanceof FrameError && error.code === "frame_too_large"
          ? CLOSE.frameTooLarge
          : CLOSE.badFrame,
        "bad_frame",
      );
      return;
    }
    switch (frame.type) {
      case "open":
        this.accept(frame.streamId, frame.open);
        return;
      case "data": {
        const length = frame.bytes.length;
        if (length > this.recvRemaining) {
          this.flowViolation(frame.streamId);
          return;
        }
        this.recvRemaining -= length;
        const stream = this.streams.get(frame.streamId);
        if (stream === undefined) {
          this.consumed(length);
          return;
        }
        if (!stream.receiveData(frame.bytes))
          this.flowViolation(frame.streamId);
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
        this.send({ type: "pong", ts: frame.ts });
        return;
      case "pong":
        this.missed = 0;
        return;
      case "goaway":
        if (this.phase !== "ready") return;
        this.phase = "draining";
        this.graceTimer = setTimeout(
          () => this.close(CLOSE.normal, "goaway_grace"),
          Math.max(0, frame.graceMs),
        );
        this.graceTimer.unref();
        this.events.goaway(frame.reason);
        this.closeIfDrained();
        return;
    }
  }

  private accept(
    streamId: number,
    open: Extract<Frame, { type: "open" }>["open"],
  ): void {
    if (this.streams.has(streamId)) {
      this.send({ type: "rst", streamId, code: RST.protocol });
      return;
    }
    if (this.phase !== "ready" || this.streams.size >= this.maxStreams) {
      this.send({ type: "rst", streamId, code: RST.refused });
      return;
    }
    const stream = new TunnelDuplex(
      streamId,
      this.host,
      { streamWindow: this.streamWindow, maxDataChunk: LIMITS.maxDataChunk },
      { issuer: this.deps.issuer, open },
    );
    // 错误由 HTTP 层处理；这里只防止未处理的 error 事件。
    stream.on("error", () => undefined);
    this.streams.set(streamId, stream);
    this.events.streams();
    this.deps.listener.emit("connection", stream);
  }

  private send(frame: Frame): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.phase === "closed" || this.phase === "handshake") return;
    this.ws.send(encodeFrame(frame), { binary: true });
  }

  private consumed(bytes: number): void {
    this.recvUnacked += bytes;
    if (this.recvUnacked >= this.tunnelWindow / 2) {
      const credit = this.recvUnacked;
      this.recvUnacked = 0;
      this.recvRemaining += credit;
      this.send({ type: "window", streamId: 0, credit });
    }
  }

  private flowViolation(streamId: number): void {
    this.send({ type: "rst", streamId, code: RST.flowControl });
    this.error = { code: "tunnel_protocol_error", message: "中继超发了窗口" };
    this.close(CLOSE.badFrame, "flow_control");
  }

  private protocolError(message: string): void {
    this.error = { code: "tunnel_protocol_error", message };
    this.close(CLOSE.badFrame, "bad_frame");
  }

  private release(stream: TunnelDuplex): void {
    if (this.streams.get(stream.streamId) === stream) {
      this.streams.delete(stream.streamId);
      this.events.streams();
    }
    this.closeIfDrained();
  }

  private closeIfDrained(): void {
    if (this.phase === "draining" && this.streams.size === 0) {
      this.close(CLOSE.normal, "drained");
    }
  }

  private tick(): void {
    if (this.phase === "closed") return;
    if (this.missed >= LIMITS.heartbeatMisses) {
      this.error = { code: "heartbeat_timeout", message: "中继心跳超时" };
      this.ws?.terminate();
      return;
    }
    this.missed += 1;
    this.send({ type: "ping", ts: Date.now() });
  }

  private finish(code: number): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer);
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer);
    for (const stream of [...this.streams.values()]) {
      stream.receiveRst(RST.sourceGone);
    }
    this.streams.clear();
    this.events.closed({ code, error: this.error, ready: this.everReady });
  }
}
