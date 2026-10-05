import type { WebSocket } from "ws";

/**
 * 五条 WebSocket 流共用的发送队列（平台规格 core 包 §3）。
 *
 * `ws.send` 只是把帧塞进 socket 自己的缓冲区就返回，`bufferedAmount` 可以无限
 * 涨：一个跟不上的客户端（慢网、后台标签、隧道里一条窗口被吃满的流）会让 core
 * 替它攒下任意多的字节。这里把「发不出去时怎么办」收成一处，按流的语义选一种：
 *
 *   * `drop-oldest`：事件流。有界队列满了丢最旧的一帧，连接不断（与原来
 *     `events/stream.ts` 自己那份队列同一个语义），丢了多少记进 `dropped`。
 *   * `coalesce`：浏览器画面。同一个 `key` 只留最新的一份——过时的画面没人要。
 *   * `pause`：终端、实时协同、语言会话。一帧都不能丢，所以拥塞时调
 *     `onPause` 让生产者停（暂停读 PTY / 停止广播 / 暂停读 LSP 的 stdout），
 *     缓冲降到低水位再 `onResume`。生产者停下之前已经在路上的帧照常排队；
 *     队列还是满了（生产者不听话或停不下来）就 `onOverflow`，由流决定关连接，
 *     而不是悄悄丢帧或无界地攒。
 *
 * 拥塞的度量是 `max(socket.bufferedAmount, 已交给 send 而回调还没回来的字节)`。
 * 前者是 `ws` 的真实缓冲；后者让只认「写完回调」的对端（测试里的假 socket、
 * 事件流的 `EventSink`）也有同一个信号。超过 `highWaterBytes` 进入拥塞，之后的
 * 帧排队；降到 `lowWaterBytes`（缺省高水位的一半）以下才再往外写、解除拥塞。
 */

/**
 * 不是字节的一个单元：控制面的订阅（`http/rpc.ts`）排的是还没编码的值，由上游
 * 自己编码。`bytes` 是它大约多大，只用来记账。
 */
export class QueuedValue {
  constructor(
    readonly value: unknown,
    readonly bytes: number,
  ) {}
}

/** 队列里的一帧。 */
export type Frame = string | Uint8Array | QueuedValue;

/** 队列认的对端：`ws` 的 `WebSocket` 经 {@link wsTarget} 包一层就是它。 */
export interface SendTarget {
  send(data: Frame, written: (error?: Error) => void): void;
  readonly bufferedAmount: number;
  readonly readyState: number;
}

export type SendPolicy = "drop-oldest" | "coalesce" | "pause";

export interface SendQueueOptions {
  /** 队列里最多排多少个单元（一个单元是一次 `push` 的帧，可以是几帧一组）。 */
  readonly maxFrames: number;
  /** 缓冲超过它即视为拥塞。 */
  readonly highWaterBytes: number;
  /** 拥塞解除的水位，缺省 `highWaterBytes / 2`。 */
  readonly lowWaterBytes?: number;
  readonly policy: SendPolicy;
  /** 丢了几个单元（`drop-oldest` 与 `coalesce`）。 */
  readonly onDrop?: (dropped: number) => void;
  /** `pause`：拥塞，生产者该停了。 */
  readonly onPause?: () => void;
  /** `pause`：缓冲降到低水位且队列排空，生产者可以继续。 */
  readonly onResume?: () => void;
  /** `pause`：队列满了还在 push；这一单元没被接受。 */
  readonly onOverflow?: () => void;
}

/** `WebSocket.OPEN`；不从 `ws` 取值，测试的假对端也用同一个数。 */
export const OPEN = 1;

/** 拥塞但没有写在路上（缓冲是别人的帧，比如 ping）时，隔多久再看一次水位。 */
export const DRAIN_POLL_MS = 20;

/** 拥塞关流用的关闭码：`pause` 队列溢出，客户端按退避重连即可。 */
export const CLOSE_BACKPRESSURE = 1013;

interface Unit {
  readonly frames: readonly Frame[];
  readonly bytes: number;
  readonly key: string | undefined;
}

function sizeOf(frame: Frame): number {
  if (typeof frame === "string") return Buffer.byteLength(frame);
  return frame instanceof QueuedValue ? frame.bytes : frame.byteLength;
}

export class SendQueue {
  private readonly target: SendTarget;
  private readonly options: SendQueueOptions;
  private readonly lowWater: number;
  private readonly queue: Unit[] = [];
  private inFlightBytes = 0;
  private congested = false;
  private pausedNow = false;
  private closed = false;
  private poll: NodeJS.Timeout | undefined;
  private droppedUnits = 0;

  constructor(target: SendTarget, options: SendQueueOptions) {
    this.target = target;
    this.options = options;
    this.lowWater =
      options.lowWaterBytes ?? Math.floor(options.highWaterBytes / 2);
  }

  /**
   * 交一个单元出去。数组是一组必须挨着发、一起留或一起丢的帧（画面的头帧
   * 与 JPEG）。`coalesce` 时同 `key` 的旧单元被替换。返回这一单元是否被接受：
   * 关了、socket 不在 OPEN、或 `pause` 队列已满时为 `false`。
   */
  push(frame: Frame | readonly Frame[], key?: string): boolean {
    if (this.closed || this.target.readyState !== OPEN) return false;
    const frames: readonly Frame[] =
      typeof frame === "string" ||
      frame instanceof Uint8Array ||
      frame instanceof QueuedValue
        ? [frame]
        : frame;
    if (frames.length === 0) return true;
    let bytes = 0;
    for (const item of frames) bytes += sizeOf(item);
    const unit: Unit = { frames, bytes, key };
    if (!this.congested && this.queue.length === 0) {
      this.write(unit);
      this.checkCongestion();
      return true;
    }
    return this.enqueue(unit);
  }

  /** 生产者此刻是否被要求停着（只对 `pause` 有意义）。 */
  get paused(): boolean {
    return this.pausedNow;
  }

  /** 排着没发的单元数。 */
  get queuedFrames(): number {
    return this.queue.length;
  }

  /** 排着没发的字节数。 */
  get queuedBytes(): number {
    let total = 0;
    for (const unit of this.queue) total += unit.bytes;
    return total;
  }

  /** 至今丢掉的单元数。 */
  get dropped(): number {
    return this.droppedUnits;
  }

  /**
   * 清空并停下。不调 `onResume`：关掉的连接没有生产者要恢复，流自己的收尾
   * （detach、会话关闭）负责放开它暂停过的东西。
   */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
    if (this.poll !== undefined) clearTimeout(this.poll);
    this.poll = undefined;
  }

  /* ------------------------------------------------------------------------ */

  private level(): number {
    return Math.max(this.target.bufferedAmount, this.inFlightBytes);
  }

  private enqueue(unit: Unit): boolean {
    const { policy, maxFrames } = this.options;
    if (policy === "pause") {
      if (this.queue.length >= maxFrames) {
        this.options.onOverflow?.();
        return false;
      }
      this.queue.push(unit);
      this.schedule();
      return true;
    }
    let dropped = 0;
    if (policy === "coalesce" && unit.key !== undefined) {
      const index = this.queue.findIndex((queued) => queued.key === unit.key);
      if (index >= 0) {
        this.queue.splice(index, 1);
        dropped += 1;
      }
    }
    this.queue.push(unit);
    while (this.queue.length > maxFrames) {
      // 合并时先丢带 key 的（过时的画面），不带 key 的（hello、错误）尽量留。
      const victim =
        policy === "coalesce"
          ? Math.max(
              0,
              this.queue.findIndex((queued) => queued.key !== undefined),
            )
          : 0;
      this.queue.splice(victim, 1);
      dropped += 1;
    }
    if (dropped > 0) {
      this.droppedUnits += dropped;
      this.options.onDrop?.(dropped);
    }
    this.schedule();
    return true;
  }

  private write(unit: Unit): void {
    for (const frame of unit.frames) {
      const bytes = sizeOf(frame);
      this.inFlightBytes += bytes;
      let settled = false;
      const written = () => {
        // 一个对一帧回调两次的对端不能让记账变成负数。
        if (settled) return;
        settled = true;
        this.inFlightBytes -= bytes;
        this.drain();
      };
      try {
        this.target.send(frame, written);
      } catch {
        // 写不出去的 socket 正在走，`close` 会到；这一帧的账照样结清。
        written();
      }
    }
  }

  private checkCongestion(): void {
    if (this.congested || this.level() < this.options.highWaterBytes) return;
    this.congested = true;
    if (this.options.policy === "pause" && !this.pausedNow) {
      this.pausedNow = true;
      this.options.onPause?.();
    }
    this.schedule();
  }

  /** 拥塞期间没有写在路上时，回调不会来，只能定时再看水位。 */
  private schedule(): void {
    if (this.closed || this.poll !== undefined || this.inFlightBytes > 0)
      return;
    this.poll = setTimeout(() => {
      this.poll = undefined;
      this.drain();
    }, DRAIN_POLL_MS);
    this.poll.unref?.();
  }

  private drain(): void {
    if (this.closed) return;
    if (this.congested || this.queue.length > 0) {
      if (this.level() > this.lowWater) {
        this.schedule();
        return;
      }
      while (
        this.queue.length > 0 &&
        this.level() < this.options.highWaterBytes
      ) {
        if (this.target.readyState !== OPEN) {
          this.close();
          return;
        }
        this.write(this.queue.shift() as Unit);
      }
      if (this.queue.length > 0 || this.level() > this.lowWater) {
        this.congested = true;
        this.schedule();
        return;
      }
      this.congested = false;
    }
    if (this.pausedNow) {
      this.pausedNow = false;
      this.options.onResume?.();
    }
  }
}

/**
 * 把一条 `ws` 连接包成 {@link SendTarget}。`binary` 不给时由 `ws` 按数据类型
 * 选（字符串文本帧、Buffer 二进制帧）；终端要用 Buffer 发文本帧，给 `false`。
 */
export function wsTarget(
  socket: WebSocket,
  options: { readonly binary?: boolean } = {},
): SendTarget {
  const sendOptions =
    options.binary === undefined ? undefined : { binary: options.binary };
  return {
    send(frame, written) {
      const data = frame as string | Uint8Array;
      if (sendOptions === undefined) socket.send(data, written);
      else socket.send(data, sendOptions, written);
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    get readyState() {
      return socket.readyState;
    },
  };
}
