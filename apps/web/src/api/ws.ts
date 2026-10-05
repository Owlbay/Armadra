import type { ManagedSocket, SourceSocketOptions } from "../sources";

/**
 * 控制面 WebSocket `/api/ws`（工程规范化 §3、契约 §35）：每个源一条，调用与订阅
 * 多路复用在上面，帧由 RPC 门面（`api/client.ts`）编解码。
 *
 * 这里是那条连接本身：上游的 peer 客户端只认一个 WebSocket 形状的对象
 * （`readyState`、`send`、`open` / `message` / `close` 事件），而它不知道要换票、
 * 也不知道前后台。连接由源层的 `ManagedSocket` 托管（`sources/managed-socket.ts`，
 * 经 `SourceConnection.socket`）：
 *
 *   * **换票**：本机源的 `WebSocket` 自己换票（`api/local-runtime.ts` 定地址），
 *     远程源每次（重）连前经它的 `CredentialProvider` 换票、经中继另带中继子协议；
 *     子协议报 `armadra-rpc.v1`。
 *   * **重连**：`lib/backoff.ts` 的全抖动退避，前台封顶 10 秒、后台 30 秒；`online`
 *     与回到前台跳过退避；回到前台时开着的探一次，3 秒没回就重连。
 *   * **关闭码**（契约 §35.2）：4401 续凭据立刻重连一次；4403 / 4409 / 4429 停下
 *     不再连，交给页面提示；其余按退避重连。
 *   * **心跳**：服务端发协议层 ping（浏览器自己回 pong）；页面可见时每 30 秒调
 *     一次 `system.ping`，3 秒没回就当断线，立刻重连。
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

export const PING_INTERVAL_MS = 30_000;
export const PING_TIMEOUT_MS = 3_000;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * 控制面要的那一样：在一个源上开一条托管的流（`sources/connection.ts` 的
 * `SourceConnection.socket`）。换票、中继子协议、4401 续凭据、退避、`online`
 * 与回到前台的探活都在 `ManagedSocket` 里。
 */
export interface ControlSocketOpener {
  socket(path: string, options?: SourceSocketOptions): ManagedSocket;
}

/** 测试注入的环境；缺省取全局。 */
export interface ChannelEnvironment {
  readonly visible?: () => boolean;
}

/**
 * 上游 peer 客户端要的 WebSocket 形状，架在一条 `ManagedSocket` 上：
 *
 *   * 内层断了（或被换掉）先把自己置回「连接中」再发 `close`——peer 客户端据此
 *     结束在途的调用与订阅，订阅由重试插件带 `lastEventId` 重订，那一帧等下一次
 *     `open` 才发得出去；
 *   * 4403 / 4409 / 4429（以及续不上凭据）停下：`closedWith` 记下原因，告诉页面；
 *   * 可见时每 30 秒探一次（`system.ping`），3 秒没回就丢掉这条立刻重连。
 */
export class ControlChannel extends EventTarget {
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSED = CLOSED;

  private readonly managed: ManagedSocket;
  private connected = false;
  private lastCode = 1006;
  private fatal: number | null = null;
  private ping: (() => Promise<unknown>) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private probing = false;

  constructor(
    opener: ControlSocketOpener,
    private readonly environment: ChannelEnvironment = {},
  ) {
    super();
    this.managed = opener.socket(CONTROL_PATH, {
      protocols: [CONTROL_PROTOCOL],
      // 回到前台时 `ManagedSocket` 自己探一次，3 秒没回就重连。
      ping: () => this.alive(),
      onOpen: () => {
        // 内层被 `ManagedSocket` 自己换掉时（探活失败）没有 close 回调。
        this.dropped(1006);
        this.connected = true;
        this.startHeartbeat();
        this.dispatchEvent(new Event("open"));
      },
      onMessage: (event) => {
        this.dispatchEvent(new MessageEvent("message", { data: event.data }));
      },
      onClose: (event) => {
        this.lastCode = event.code;
        if (FATAL_CLOSE_CODES.has(event.code)) {
          this.stop(event.code);
          return;
        }
        this.dropped(event.code);
      },
      onStateChange: (state) => {
        if (state === "open") return;
        this.dropped(this.lastCode);
        // 4403 由 `onClose` 停下；这里剩下的是 4401 续不上凭据。
        if (state === "unauthorized" && this.fatal === null) {
          this.stop(
            this.lastCode === CLOSE_EXPIRED ? CLOSE_EXPIRED : CLOSE_REVOKED,
          );
        }
      },
    });
  }

  /** 上游 peer 客户端看的状态：连接中（含等待重连）、开着、停了。 */
  get readyState(): number {
    if (this.fatal !== null) return CLOSED;
    const state = this.managed.state;
    if (state === "closed" || state === "unauthorized") return CLOSED;
    return this.connected ? OPEN : CONNECTING;
  }

  /** 停下的原因（4403 / 4409 / 4429，或续不上凭据的 4401）；还在连的是 `null`。 */
  get closedWith(): number | null {
    return this.fatal;
  }

  /** 心跳用的那次往返（`system.ping`），由 RPC 门面装上。 */
  setPing(ping: () => Promise<unknown>): void {
    this.ping = ping;
  }

  send(data: string): void {
    if (!this.connected || !this.managed.send(data)) {
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    }
  }

  /** 不再用了（测试、换源）：断开且不再重连。 */
  close(): void {
    this.stopHeartbeat();
    this.dropped(CLOSE_NORMAL);
    this.managed.close();
  }

  /** 探一次：`system.ping` 在 {@link PING_TIMEOUT_MS} 内没回就丢掉这条立刻重连。 */
  async probe(): Promise<boolean> {
    if (!this.connected || this.probing) return true;
    this.probing = true;
    try {
      if (await this.alive()) return true;
      if (this.connected) {
        // 半开的连接（睡眠、断了的隧道）：等浏览器自己发现可能要几十秒。
        this.dropped(1006);
        this.managed.reconnect();
      }
      return false;
    } finally {
      this.probing = false;
    }
  }

  /** `system.ping` 在 3 秒内回了。 */
  private async alive(): Promise<boolean> {
    const ping = this.ping;
    if (ping === null) return true;
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
      return false;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private visible(): boolean {
    if (this.environment.visible) return this.environment.visible();
    return (
      typeof document === "undefined" || document.visibilityState !== "hidden"
    );
  }

  /** 内层没了：先置回「连接中」，再告诉 peer 客户端。只发一次。 */
  private dropped(code: number): void {
    if (!this.connected) return;
    this.connected = false;
    this.stopHeartbeat();
    this.dispatchEvent(new CloseEvent("close", { code }));
  }

  private stop(code: number): void {
    if (this.fatal !== null) return;
    this.fatal = code;
    this.stopHeartbeat();
    this.managed.close();
    this.connected = false;
    this.dispatchEvent(new CloseEvent("close", { code }));
    for (const listener of [...fatalListeners]) listener(code);
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

type FatalListener = (code: number) => void;
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

const channels = new WeakMap<ControlSocketOpener, ControlChannel>();

/** 这个源的控制面连接，第一次用时才连。停下（致命关闭）的不复用。 */
export function controlChannel(
  connection: ControlSocketOpener,
): ControlChannel {
  let channel = channels.get(connection);
  if (channel === undefined || channel.closedWith !== null) {
    channel = new ControlChannel(connection);
    channels.set(connection, channel);
  }
  return channel;
}

/** 测试用：丢掉某个源的控制面连接。 */
export function resetControlChannel(connection: ControlSocketOpener): void {
  channels.get(connection)?.close();
  channels.delete(connection);
}
