import { backoffDelay } from "@/lib/backoff";

import { runtimeSocketUrl } from "./runtime-url";
import type { Source } from "./source";

/**
 * 控制面 WebSocket `/api/ws`（工程规范化 §3、契约 §35）：每个源一条，调用与订阅
 * 多路复用在上面，帧由 RPC 门面（`api/client.ts`）编解码。
 *
 * 这里是那条连接本身，一个**会自己重连**的 socket：上游的 peer 客户端只认一个
 * WebSocket 形状的对象（`readyState`、`send`、`open` / `message` / `close` 事件），
 * 而它不知道要换票、也不知道前后台。所以：
 *
 *   * **换票**：每次（重）连都经源的 `WebSocket`（Bearer 模式先换一张一次性票，
 *     `api/source.ts`），子协议报 `armadra-rpc.v1`。
 *   * **重连**：`lib/backoff.ts` 的全抖动退避，前台封顶 10 秒、后台 30 秒，连上过
 *     就归零。内层 socket 断了先把自己置回「连接中」再发 `close`——peer 客户端据此
 *     结束在途的调用与订阅，订阅由重试插件带 `lastEventId` 重订，重订的那一帧
 *     等到下一次 `open` 才发出去。
 *   * **关闭码**（契约 §35.2）：4401 先续凭据再立刻重连一次；4403 / 4409 / 4429
 *     停下不再连，交给页面提示；其余按退避重连。
 *   * **心跳**：服务端发协议层 ping（浏览器自己回 pong）；页面可见时每 30 秒调
 *     一次 `system.ping`，3 秒没回就当断线，立刻重连。
 *   * **前后台**：回到前台立刻探一次（没连着就跳过退避直接连）；`online` 同理。
 */

export const CONTROL_PATH = "/api/ws";
export const CONTROL_PROTOCOL = "armadra-rpc.v1";

/** 契约 §35.2 的关闭码。 */
export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_BAD_FRAME = 4400;
export const CLOSE_EXPIRED = 4401;
export const CLOSE_REVOKED = 4403;
export const CLOSE_PROTOCOL = 4409;
export const CLOSE_TOO_LARGE = 4413;
export const CLOSE_LIMIT = 4429;

/** 关闭码 → 文案键（`i18n/connection.ts`）。 */
export const CLOSE_MESSAGE_KEYS: Readonly<Record<number, string>> = {
  [CLOSE_NORMAL]: "connection.closed.normal",
  [CLOSE_GOING_AWAY]: "connection.closed.goingAway",
  [CLOSE_BAD_FRAME]: "connection.closed.badFrame",
  [CLOSE_EXPIRED]: "connection.closed.expired",
  [CLOSE_REVOKED]: "connection.closed.revoked",
  [CLOSE_PROTOCOL]: "connection.closed.protocol",
  [CLOSE_TOO_LARGE]: "connection.closed.tooLarge",
  [CLOSE_LIMIT]: "connection.closed.limit",
};

/** 停下不再重连的关闭码：重连只会撞上同一堵墙。 */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CLOSE_REVOKED,
  CLOSE_PROTOCOL,
  CLOSE_LIMIT,
]);

export const RECONNECT_BASE_MS = 500;
export const FOREGROUND_CAP_MS = 10_000;
export const BACKGROUND_CAP_MS = 30_000;
export const PING_INTERVAL_MS = 30_000;
export const PING_TIMEOUT_MS = 3_000;
/** 两次 4401 隔得比这近，第二次就不再跳过退避（续了凭据也没用）。 */
const EXPIRED_RETRY_WINDOW_MS = 5_000;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** 测试注入的环境；缺省取全局。 */
export interface ChannelEnvironment {
  readonly document?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  readonly window?: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly random?: () => number;
  readonly now?: () => number;
}

export class ControlChannel extends EventTarget {
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSED = CLOSED;

  private state: number = CONNECTING;
  private socket: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private lastExpired = -Infinity;
  private fatal: number | null = null;
  private ping: (() => Promise<unknown>) | null = null;
  private readonly detach: () => void;

  constructor(
    private readonly source: Source,
    private readonly environment: ChannelEnvironment = {},
  ) {
    super();
    const doc =
      environment.document ??
      (typeof document === "undefined" ? undefined : document);
    const win =
      environment.window ??
      (typeof window === "undefined" ? undefined : window);
    const onVisible = () => {
      if (this.visible()) this.wake();
    };
    const onOnline = () => this.wake();
    doc?.addEventListener("visibilitychange", onVisible);
    win?.addEventListener("online", onOnline);
    this.detach = () => {
      doc?.removeEventListener("visibilitychange", onVisible);
      win?.removeEventListener("online", onOnline);
    };
    this.connect();
  }

  /** 上游 peer 客户端看的状态：连接中（含等待重连）、开着、停了。 */
  get readyState(): number {
    return this.state;
  }

  /** 停下的原因（4403 / 4409 / 4429）；还在连的是 `null`。 */
  get closedWith(): number | null {
    return this.fatal;
  }

  /** 心跳用的那次往返（`system.ping`），由 RPC 门面装上。 */
  setPing(ping: () => Promise<unknown>): void {
    this.ping = ping;
  }

  send(data: string): void {
    if (this.state !== OPEN || this.socket === null) {
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    }
    this.socket.send(data);
  }

  /** 不再用了（测试、换源）：断开且不再重连。 */
  close(): void {
    this.stop(CLOSE_NORMAL, false);
  }

  /**
   * 回到前台 / 网络恢复：没连着就跳过退避立刻连；连着就探一次，3 秒没回音
   * 视为断线、立刻重连。
   */
  wake(): void {
    if (this.fatal !== null) return;
    if (this.state === OPEN) {
      void this.probe();
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.connect();
    }
  }

  /** 探一次：`system.ping` 在 {@link PING_TIMEOUT_MS} 内没回就重连。 */
  async probe(): Promise<boolean> {
    const ping = this.ping;
    const socket = this.socket;
    if (ping === null || socket === null || this.probing) return true;
    this.probing = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ping(),
        new Promise((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("ping timeout")),
            PING_TIMEOUT_MS,
          );
        }),
      ]);
      return true;
    } catch {
      // 半开的连接（睡眠、断了的隧道）：等浏览器自己发现可能要几十秒。
      if (this.socket === socket) this.drop(socket, 1006, true);
      return false;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.probing = false;
    }
  }

  private visible(): boolean {
    const doc =
      this.environment.document ??
      (typeof document === "undefined" ? undefined : document);
    return doc === undefined || doc.visibilityState !== "hidden";
  }

  private connect(): void {
    if (this.fatal !== null) return;
    this.state = CONNECTING;
    const Socket = this.source.WebSocket;
    let socket: WebSocket;
    try {
      socket = new Socket(
        runtimeSocketUrl(this.source.wsBase, CONTROL_PATH),
        CONTROL_PROTOCOL,
      );
    } catch {
      this.schedule();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.state = OPEN;
      this.attempt = 0;
      this.startHeartbeat();
      this.dispatchEvent(new Event("open"));
    };
    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.dispatchEvent(new MessageEvent("message", { data: event.data }));
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.drop(socket, event.code, false);
    };
    // `onerror` 之后一定还有 `onclose`；重连只挂在 close 上。
    socket.onerror = () => {};
  }

  /** 内层 socket 没了：决定停下、立刻重连还是退避。 */
  private drop(socket: WebSocket, code: number, now: boolean): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (socket.readyState === CONNECTING || socket.readyState === OPEN) {
      try {
        socket.close();
      } catch {
        // 已经在关。
      }
    }
    this.socket = null;
    this.stopHeartbeat();
    if (FATAL_CLOSE_CODES.has(code)) {
      this.stop(code, true);
      return;
    }
    // 先置回「连接中」再发 close：peer 客户端结束在途的调用，订阅的重订等下一
    // 次 open 再发。
    this.state = CONNECTING;
    this.dispatchEvent(new CloseEvent("close", { code }));
    const clock = this.environment.now ?? Date.now;
    if (code === CLOSE_EXPIRED) {
      const at = clock();
      const fresh = at - this.lastExpired > EXPIRED_RETRY_WINDOW_MS;
      this.lastExpired = at;
      if (fresh) {
        // 令牌到期：续了凭据立刻换票重连一次，不退避。
        void this.source.credentials
          .renew(null)
          .catch(() => false)
          .then(() => {
            if (this.socket === null && this.timer === null) this.connect();
          });
        return;
      }
    }
    if (now) {
      this.connect();
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.fatal !== null || this.timer !== null) return;
    const delay = backoffDelay(this.attempt, {
      baseMs: RECONNECT_BASE_MS,
      capMs: this.visible() ? FOREGROUND_CAP_MS : BACKGROUND_CAP_MS,
      random: this.environment.random,
    });
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private stop(code: number, announce: boolean): void {
    this.fatal = code;
    this.state = CLOSED;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // 已经在关。
      }
    }
    this.detach();
    this.dispatchEvent(new CloseEvent("close", { code }));
    if (announce) {
      for (const listener of [...fatalListeners]) listener(code, this.source);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.visible()) void this.probe();
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

type FatalListener = (code: number, source: Source) => void;
const fatalListeners = new Set<FatalListener>();

/** 控制面因 4403 / 4409 / 4429 停下（页面据此提示）。 */
export function onControlClosed(listener: FatalListener): () => void {
  fatalListeners.add(listener);
  return () => {
    fatalListeners.delete(listener);
  };
}

/** 关闭码的文案键；表里没有的答 `undefined`。 */
export function closeMessageKey(code: number): string | undefined {
  return CLOSE_MESSAGE_KEYS[code];
}

const channels = new WeakMap<Source, ControlChannel>();

/** 这个源的控制面连接，第一次用时才连。停下（致命关闭）的不复用。 */
export function controlChannel(source: Source): ControlChannel {
  let channel = channels.get(source);
  if (channel === undefined || channel.closedWith !== null) {
    channel = new ControlChannel(source);
    channels.set(source, channel);
  }
  return channel;
}

/** 测试用：丢掉某个源的连接。 */
export function resetControlChannel(source: Source): void {
  channels.get(source)?.close();
  channels.delete(source);
}
