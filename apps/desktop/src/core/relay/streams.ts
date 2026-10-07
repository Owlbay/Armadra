/**
 * 隧道流（契约 §32，平台规格 core 包 §4.3）：中继发来的一条 `OPEN` 在 core 里就是
 * 一个 {@link TunnelDuplex}，交给 `admittedServer.emit("connection", duplex)`，由
 * Node 自己解析里面的 HTTP/1.1 与 WebSocket 升级——与回环监听上的请求同一条路。
 *
 * 写（core → 中继）：按 `maxDataChunk` 切块，每块同时扣「流信用」与「隧道信用」，
 * 任一不足就挂起 `_write` 的回调，直到 `WINDOW` 补回。背压经 Duplex 的写缓冲传到
 * 上游：WebSocket 的 `bufferedAmount` 含这一段，所以五条流的发送队列（A3-0 的
 * `SendQueue`）照常按它判拥塞。
 *
 * 读（中继 → core）：`DATA` 先进本地队列，`_read` 被调时才 `push`；交出去的字节
 * 累计到窗口一半时发 `WINDOW(streamId, 已消费)`，隧道级的由宿主同样补回。对端发得
 * 比授予的信用多 → `receiveData` 答 `false`，宿主发 `RST 5` 并以 4400 关隧道。
 *
 * 关闭：收 `END` → `push(null)`；本地 `end()` → 发 `END`；收 `RST` → `destroy`；
 * 本地 `destroy()` → 发 `RST`（无错误时 `clientGone`）。两端都 `END` 后从流表摘掉。
 *
 * 本类对角色无感：测试里的假中继用同一份。
 */

import { Duplex } from "node:stream";

import {
  type Frame,
  type OpenPayload,
  RST,
} from "@armadra/platform-protocol/tunnel";

export class StreamResetError extends Error {
  constructor(readonly rstCode: number) {
    super(`tunnel stream reset ${rstCode}`);
    this.name = "StreamResetError";
  }
}

/** 隧道级发送信用：所有流共享；不够时登记等待者，`add` 时挨个叫醒。 */
export class CreditPool {
  private readonly waiters = new Set<() => void>();

  constructor(public available: number) {}

  take(max: number): number {
    const granted = Math.max(0, Math.min(max, this.available));
    this.available -= granted;
    return granted;
  }

  add(credit: number): void {
    this.available += credit;
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) {
      if (this.available <= 0) {
        this.waiters.add(wake);
        continue;
      }
      wake();
    }
  }

  wait(wake: () => void): void {
    this.waiters.add(wake);
  }

  cancel(wake: () => void): void {
    this.waiters.delete(wake);
  }
}

export interface StreamHost {
  sendFrame(frame: Frame): void;
  /** 隧道级发送信用。 */
  readonly sendCredit: CreditPool;
  /** 本端交给消费者的字节数（隧道级补信用用）。 */
  consumed(bytes: number): void;
  /** 流不再需要留在流表里（两端都 END，或 RST）。可能被调多次。 */
  closed(stream: TunnelDuplex): void;
}

export interface TunnelStreamOptions {
  readonly streamWindow: number;
  readonly maxDataChunk: number;
}

/** 隧道流在 core 这一侧带的元数据（准入读它，不读请求头）。 */
export interface TunnelOrigin {
  /** 这条隧道登记到的远程服务。 */
  readonly issuer: string;
  /** 中继给的 `OPEN`：`clientOrigin` / `remoteIp` 以它为准。 */
  readonly open: OpenPayload;
}

interface PendingWrite {
  readonly chunk: Buffer;
  offset: number;
  readonly callback: (error?: Error | null) => void;
}

export class TunnelDuplex extends Duplex {
  /** 本端还能发的流信用。 */
  private sendCredit: number;
  /** 授予对端、对端还没用掉的信用。 */
  private recvRemaining: number;
  /** 已交给消费者、还没用 WINDOW 补回去的字节。 */
  private unacked = 0;
  private readonly queue: Buffer[] = [];
  private wantsRead = false;
  private pending: PendingWrite | null = null;
  private remoteEnded = false;
  private eofPushed = false;
  private localEnded = false;
  private peerReset = false;
  private released = false;

  /**
   * `net.Socket` 的几个字段：Node 的 HTTP 层与身份域按它们认来源地址与 TLS。
   * 地址是中继给的客户端地址（`OPEN.remoteIp`），不是中继自己；隧道一律是
   * TLS 上来的。
   */
  readonly remoteAddress: string | undefined;
  readonly encrypted = true;
  /** 准入用：客户端来源（`OPEN.clientOrigin`），以它为准，不信请求头。 */
  readonly armadraOrigin: string | null;
  readonly tunnel: TunnelOrigin | undefined;

  constructor(
    readonly streamId: number,
    private readonly host: StreamHost,
    private readonly options: TunnelStreamOptions,
    tunnel?: TunnelOrigin,
  ) {
    super({
      allowHalfOpen: true,
      readableHighWaterMark: options.streamWindow,
      writableHighWaterMark: options.streamWindow,
    });
    this.sendCredit = options.streamWindow;
    this.recvRemaining = options.streamWindow;
    this.tunnel = tunnel;
    this.remoteAddress = tunnel?.open.remoteIp;
    this.armadraOrigin = tunnel?.open.clientOrigin ?? null;
  }

  /* ---------------------------- 来自对端的帧 ---------------------------- */

  /** 收到 DATA；超出授予的信用答 `false`（流控违规）。 */
  receiveData(bytes: Uint8Array): boolean {
    if (bytes.length > this.recvRemaining) return false;
    this.recvRemaining -= bytes.length;
    if (this.remoteEnded || this.destroyed) {
      // 已经结束或本地已销毁：丢弃，但隧道级信用照样还回去。
      this.host.consumed(bytes.length);
      return true;
    }
    this.queue.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    this.drain();
    return true;
  }

  receiveEnd(): void {
    if (this.remoteEnded) return;
    this.remoteEnded = true;
    this.drain();
    this.maybeRelease();
  }

  receiveRst(code: number): void {
    this.peerReset = true;
    this.destroy(new StreamResetError(code));
  }

  receiveWindow(credit: number): void {
    this.sendCredit += credit;
    this.pump();
  }

  /* -------------------------------- 读 -------------------------------- */

  override _read(): void {
    this.wantsRead = true;
    this.drain();
  }

  private drain(): void {
    while (this.wantsRead && this.queue.length > 0) {
      const chunk = this.queue.shift() as Buffer;
      this.acknowledge(chunk.length);
      if (!this.push(chunk)) this.wantsRead = false;
    }
    if (this.queue.length === 0 && this.remoteEnded && !this.eofPushed) {
      this.eofPushed = true;
      this.push(null);
    }
  }

  private acknowledge(bytes: number): void {
    this.host.consumed(bytes);
    if (this.remoteEnded) return;
    this.unacked += bytes;
    if (this.unacked >= this.options.streamWindow / 2) {
      const credit = this.unacked;
      this.unacked = 0;
      this.recvRemaining += credit;
      this.host.sendFrame({ type: "window", streamId: this.streamId, credit });
    }
  }

  /* -------------------------------- 写 -------------------------------- */

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.pending = { chunk, offset: 0, callback };
    this.pump();
  }

  private readonly pump = (): void => {
    const pending = this.pending;
    if (pending === null || this.destroyed) return;
    while (pending.offset < pending.chunk.length) {
      const want = Math.min(
        pending.chunk.length - pending.offset,
        this.options.maxDataChunk,
        this.sendCredit,
      );
      if (want <= 0) return; // 等这条流的 WINDOW
      const granted = this.host.sendCredit.take(want);
      if (granted === 0) {
        this.host.sendCredit.wait(this.pump);
        return;
      }
      this.sendCredit -= granted;
      this.host.sendFrame({
        type: "data",
        streamId: this.streamId,
        bytes: pending.chunk.subarray(pending.offset, pending.offset + granted),
      });
      pending.offset += granted;
    }
    this.pending = null;
    pending.callback();
  };

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.peerReset) {
      this.localEnded = true;
      this.host.sendFrame({ type: "end", streamId: this.streamId });
    }
    callback();
    this.maybeRelease();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.host.sendCredit.cancel(this.pump);
    this.pending = null;
    if (!this.peerReset && !(this.localEnded && this.remoteEnded)) {
      const code =
        error instanceof StreamResetError
          ? error.rstCode
          : error
            ? RST.internal
            : RST.clientGone;
      this.host.sendFrame({ type: "rst", streamId: this.streamId, code });
    }
    // 队列里还没交出去的字节也要把隧道级信用还回去。
    const dropped = this.queue.reduce((sum, chunk) => sum + chunk.length, 0);
    this.queue.length = 0;
    if (dropped > 0) this.host.consumed(dropped);
    this.release();
    callback(error);
  }

  private maybeRelease(): void {
    if (this.localEnded && this.remoteEnded) this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.host.closed(this);
  }

  /* -------------------------- net.Socket 兼容 -------------------------- */

  // `http.Server.emit("connection")` 与 `ws` 会调这些；隧道流没有 TCP 选项可设。
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  setTimeout(_ms: number, callback?: () => void): this {
    if (callback !== undefined) this.once("timeout", callback);
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}
