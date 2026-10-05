import { type BackoffOptions, createBackoff } from "../lib/backoff";
import { RELAY_PROTOCOL, WS_TICKET_PROTOCOL } from "./transport";

/**
 * 一条托管的流：换票、退避、关闭码语义、`online` 与可见性（客户端包 §1.3）。
 *
 * - 每次（重）连之前先取票（`armadra-ticket.<票>`），经中继时再带
 *   `armadra-relay.<令牌>`；
 * - 关闭码：4401 → 续一次凭据、立刻换票重连（连续两次就是 `unauthorized`）；
 *   4403 → `unauthorized`，不再连；4404 → `waiting`（源不在线），等
 *   {@link ManagedSocket.wake}；调用方 `close()` → `closed`；其它 → 全抖动退避
 *   （`lib/backoff`，前台封顶 10 秒、后台 30 秒）；
 * - `online` 事件跳过退避立刻连；页面回到前台时退避中的立刻连，开着的发一次
 *   `ping`，3 秒没回就当它死了、重连。
 *
 * 环境（`WebSocket`、计时器、`window` / `document` 事件）都可注入，测试不碰
 * 真网络。
 */

export const CLOSE_EXPIRED = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_SOURCE_OFFLINE = 4404;

export const FOREGROUND_BACKOFF: BackoffOptions = {
  baseMs: 500,
  capMs: 10_000,
};
export const BACKGROUND_CAP_MS = 30_000;
export const PING_TIMEOUT_MS = 3_000;

export type ManagedSocketState =
  | "connecting"
  | "open"
  | "backoff"
  | "waiting"
  | "unauthorized"
  | "closed";

/** 页面环境：`online` 与可见性。 */
export interface SocketEnvironment {
  addEventListener(
    type: "online" | "visibilitychange",
    listener: () => void,
  ): void;
  removeEventListener(
    type: "online" | "visibilitychange",
    listener: () => void,
  ): void;
  visible(): boolean;
}

export interface ManagedSocketOptions {
  /** 每次连之前现取地址（源的 `wsBase` 可能换过路）。 */
  url(): string;
  /** 调用方协商的子协议（例如控制面的 `armadra-rpc.v1`）。 */
  protocols?: readonly string[];
  /** 取一张一次性票；`null` = 这个源不用票（Cookie 会话、开发时的裸 core）。 */
  ticket(): Promise<string | null>;
  /** 经中继时的中继令牌；没有是 `null`。 */
  relayToken?(): string | null;
  /** 4401 时续一次凭据；续不上答 `false`。 */
  renew(): Promise<boolean>;
  /** 回到前台时探一次活；`true` = 还活着。缺省不探。 */
  ping?(socket: WebSocket): Promise<boolean>;
  binaryType?: BinaryType;
  onOpen?(socket: WebSocket): void;
  onMessage?(event: MessageEvent): void;
  onClose?(event: CloseEvent): void;
  onStateChange?(state: ManagedSocketState): void;
  WebSocket?: typeof WebSocket;
  environment?: SocketEnvironment | null;
  backoff?: BackoffOptions;
  backgroundCapMs?: number;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

function browserEnvironment(): SocketEnvironment | null {
  if (typeof window === "undefined" || typeof document === "undefined")
    return null;
  return {
    addEventListener(type, listener) {
      if (type === "online") window.addEventListener(type, listener);
      else document.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      if (type === "online") window.removeEventListener(type, listener);
      else document.removeEventListener(type, listener);
    },
    visible: () => document.visibilityState !== "hidden",
  };
}

export class ManagedSocket {
  private socket: WebSocket | null = null;
  private current: ManagedSocketState = "connecting";
  private timer: unknown = null;
  private renewedOnce = false;
  private generation = 0;
  private readonly backoff;
  private readonly environment: SocketEnvironment | null;
  private readonly schedule: (run: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly options: ManagedSocketOptions) {
    this.backoff = createBackoff(options.backoff ?? FOREGROUND_BACKOFF);
    this.environment =
      options.environment === undefined
        ? browserEnvironment()
        : options.environment;
    this.schedule =
      options.setTimeout ?? ((run, ms) => globalThis.setTimeout(run, ms));
    this.cancel =
      options.clearTimeout ??
      ((handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.environment?.addEventListener("online", this.handleOnline);
    this.environment?.addEventListener("visibilitychange", this.handleVisible);
    void this.open();
  }

  get state(): ManagedSocketState {
    return this.current;
  }

  /** 当前那条真连接（开着时）。 */
  get raw(): WebSocket | null {
    return this.socket;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): boolean {
    if (this.current !== "open" || this.socket === null) return false;
    this.socket.send(data);
    return true;
  }

  /** 源上线了（远程服务推 `sourceOnline`）或人点了重连：立刻再连一次。 */
  wake(): void {
    if (
      this.current === "closed" ||
      this.current === "open" ||
      this.current === "connecting"
    )
      return;
    this.renewedOnce = false;
    this.backoff.reset();
    this.reconnectNow();
  }

  /** 调用方不要它了：关掉，不再连。 */
  close(code = 1000, reason = ""): void {
    if (this.current === "closed") return;
    this.setState("closed");
    this.clearTimer();
    this.generation += 1;
    this.environment?.removeEventListener("online", this.handleOnline);
    this.environment?.removeEventListener(
      "visibilitychange",
      this.handleVisible,
    );
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(code, reason);
    } catch {
      /* 已经关了。 */
    }
  }

  /** 读一次当前状态（`await` 之后 TS 收窄不到别处改过的字段）。 */
  private isClosed(): boolean {
    return this.current === "closed";
  }

  private setState(next: ManagedSocketState): void {
    if (next === this.current) return;
    this.current = next;
    this.options.onStateChange?.(next);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  private reconnectNow(): void {
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    this.generation += 1;
    try {
      socket?.close();
    } catch {
      /* 已经关了。 */
    }
    void this.open();
  }

  private async open(): Promise<void> {
    if (this.current === "closed") return;
    const generation = ++this.generation;
    this.setState("connecting");
    let ticket: string | null;
    try {
      ticket = await this.options.ticket();
    } catch {
      if (generation === this.generation) this.retryLater();
      return;
    }
    if (generation !== this.generation || this.isClosed()) return;
    const protocols = [...(this.options.protocols ?? [])];
    if (ticket !== null) protocols.push(`${WS_TICKET_PROTOCOL}${ticket}`);
    const relay = this.options.relayToken?.() ?? null;
    if (relay !== null && relay !== "")
      protocols.push(`${RELAY_PROTOCOL}${relay}`);
    const Socket = this.options.WebSocket ?? globalThis.WebSocket;
    let socket: WebSocket;
    try {
      socket = new Socket(
        this.options.url(),
        protocols.length > 0 ? protocols : undefined,
      );
    } catch {
      this.retryLater();
      return;
    }
    if (this.options.binaryType) socket.binaryType = this.options.binaryType;
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (generation !== this.generation) return;
      this.backoff.reset();
      this.renewedOnce = false;
      this.setState("open");
      this.options.onOpen?.(socket);
    });
    socket.addEventListener("message", (event) => {
      if (generation !== this.generation) return;
      this.options.onMessage?.(event as MessageEvent);
    });
    socket.addEventListener("close", (event) => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.options.onClose?.(event as CloseEvent);
      void this.afterClose((event as CloseEvent).code);
    });
  }

  private async afterClose(code: number): Promise<void> {
    if (this.current === "closed") return;
    if (code === CLOSE_FORBIDDEN) {
      this.setState("unauthorized");
      return;
    }
    if (code === CLOSE_SOURCE_OFFLINE) {
      this.setState("waiting");
      return;
    }
    if (code === CLOSE_EXPIRED) {
      if (this.renewedOnce) {
        this.setState("unauthorized");
        return;
      }
      this.renewedOnce = true;
      this.setState("connecting");
      const generation = this.generation;
      const renewed = await this.options.renew().catch(() => false);
      if (generation !== this.generation || this.isClosed()) return;
      if (!renewed) {
        this.setState("unauthorized");
        return;
      }
      void this.open();
      return;
    }
    this.retryLater();
  }

  private retryLater(): void {
    if (this.current === "closed") return;
    this.setState("backoff");
    const visible = this.environment?.visible() ?? true;
    let delay = this.backoff.next();
    if (!visible) {
      const cap = this.options.backgroundCapMs ?? BACKGROUND_CAP_MS;
      // 后台时封顶放宽到 30 秒：同一轮抖动按比例放大，不再频繁唤醒。
      const foregroundCap = (this.options.backoff ?? FOREGROUND_BACKOFF).capMs;
      delay = Math.min(cap, Math.round((delay * cap) / foregroundCap));
    }
    this.clearTimer();
    const generation = this.generation;
    this.timer = this.schedule(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      void this.open();
    }, delay);
  }

  private readonly handleOnline = (): void => {
    if (this.current === "backoff") {
      this.backoff.reset();
      this.reconnectNow();
    }
  };

  private readonly handleVisible = (): void => {
    if (!(this.environment?.visible() ?? true)) return;
    if (this.current === "backoff") {
      this.reconnectNow();
      return;
    }
    const socket = this.socket;
    const ping = this.options.ping;
    if (this.current !== "open" || socket === null || ping === undefined)
      return;
    const generation = this.generation;
    let settled = false;
    const deadline = this.schedule(() => {
      if (settled || generation !== this.generation) return;
      settled = true;
      this.reconnectNow();
    }, PING_TIMEOUT_MS);
    void ping(socket).then(
      (alive) => {
        if (settled) return;
        settled = true;
        this.cancel(deadline);
        if (!alive && generation === this.generation) this.reconnectNow();
      },
      () => {
        if (settled) return;
        settled = true;
        this.cancel(deadline);
        if (generation === this.generation) this.reconnectNow();
      },
    );
  };
}
