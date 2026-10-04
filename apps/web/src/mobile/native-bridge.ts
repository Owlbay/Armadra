import { isNativeAppPage } from "../api/runtime-url";

/**
 * 页面与原生 App（Capacitor，架构 §10）之间的那道桥。
 *
 * 原生只补网页做不到的四件事：钥匙串、证书钉扎、扫码、推送令牌。页面这一半
 * 在这里；原生那一半是 G3-1 的插件 `ArmadraNative`（经
 * `window.Capacitor.Plugins.ArmadraNative` 取，页面不依赖 `@capacitor/core`）。
 * 不在 Capacitor 里时 {@link nativeBridge} 是空实现：每个方法都答「没有」，
 * 调用方不必先判断环境。
 *
 * 插件的约定（参数与返回都是一个对象，Capacitor 的规矩）：
 *
 * | 方法                                  | 返回                                                 |
 * | ------------------------------------- | ---------------------------------------------------- |
 * | `getSession()`                        | `{ session?: { origin, accessToken, refreshToken } }` |
 * | `setSession({ session })`             | —（写钥匙串 / Keystore）                             |
 * | `clearSession()`                      | —                                                    |
 * | `pin({ origin, fingerprint })`        | —（之后对该来源的 TLS 只认这个信任锚指纹）           |
 * | `scan()`                              | `{ text?: string }`（取消时没有 `text`）             |
 * | `pushRegistration()`                  | `{ registration?: { platform, transport, token, publicKey? } }` |
 */

/** 钥匙串里的一份会话：哪个 Gateway，加两把密钥。 */
export interface StoredSession {
  readonly origin: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** 原生推送注册：交给 `PUT /api/push/devices`（契约 §19.2）。 */
export interface NativePushRegistration {
  readonly platform: "ios" | "android";
  readonly transport: "direct" | "relay";
  readonly token: string;
  /** 设备的 X25519 公钥（base64url）；中继与 UnifiedPush 必需。 */
  readonly publicKey?: string;
  /** Android：用户自己的 UnifiedPush 分发器给的端点（契约 §27.2）。 */
  readonly unifiedpush?: { readonly endpoint: string };
}

export interface NativeBridge {
  /** 真在原生 App 里，且插件在。 */
  readonly available: boolean;
  /** 原生 App 能扫码（相机）。 */
  readonly canScan: boolean;
  loadSession(): Promise<StoredSession | null>;
  saveSession(session: StoredSession): Promise<void>;
  clearSession(): Promise<void>;
  pin(origin: string, fingerprint: string): Promise<void>;
  scan(): Promise<string | null>;
  pushRegistration(): Promise<NativePushRegistration | null>;
}

interface ArmadraNativePlugin {
  getSession?(): Promise<unknown>;
  setSession?(options: { session: StoredSession }): Promise<unknown>;
  clearSession?(): Promise<unknown>;
  pin?(options: { origin: string; fingerprint: string }): Promise<unknown>;
  scan?(): Promise<unknown>;
  pushRegistration?(): Promise<unknown>;
}

/** 会话密钥：`<32 位十六进制标识>.<43 位 base64url>`（core `identity/tokens.ts::parseToken`）。 */
const SESSION_TOKEN = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function plugin(): ArmadraNativePlugin | null {
  if (!isNativeAppPage()) return null;
  const found = (
    globalThis as {
      Capacitor?: { Plugins?: { ArmadraNative?: ArmadraNativePlugin } };
    }
  ).Capacitor?.Plugins?.ArmadraNative;
  return found && typeof found === "object" ? found : null;
}

function storedSession(value: unknown): StoredSession | null {
  if (!value || typeof value !== "object") return null;
  const session = (value as { session?: unknown }).session;
  if (!session || typeof session !== "object") return null;
  const { origin, accessToken, refreshToken } = session as Record<
    string,
    unknown
  >;
  if (
    typeof origin !== "string" ||
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    !SESSION_TOKEN.test(accessToken) ||
    !SESSION_TOKEN.test(refreshToken)
  )
    return null;
  return { origin, accessToken, refreshToken };
}

function pushRegistration(value: unknown): NativePushRegistration | null {
  if (!value || typeof value !== "object") return null;
  const registration = (value as { registration?: unknown }).registration;
  if (!registration || typeof registration !== "object") return null;
  const { platform, transport, token, publicKey } = registration as Record<
    string,
    unknown
  >;
  if (platform !== "ios" && platform !== "android") return null;
  if (transport !== "direct" && transport !== "relay") return null;
  if (typeof token !== "string" || token === "" || token.length > 4096)
    return null;
  if (
    publicKey !== undefined &&
    (typeof publicKey !== "string" || !BASE64URL.test(publicKey))
  )
    return null;
  if (transport === "relay" && publicKey === undefined) return null;
  return {
    platform,
    transport,
    token,
    ...(typeof publicKey === "string" ? { publicKey } : {}),
  };
}

const WEB_BRIDGE: NativeBridge = {
  available: false,
  canScan: false,
  loadSession: () => Promise.resolve(null),
  saveSession: () => Promise.resolve(),
  clearSession: () => Promise.resolve(),
  pin: () => Promise.resolve(),
  scan: () => Promise.resolve(null),
  pushRegistration: () => Promise.resolve(null),
};

/**
 * 当前环境的桥。原生插件的失败一律压成「没有」（`null` / 无操作），只有钉扎
 * 例外：钉不上就不能继续连，抛出去让连接页报错。
 */
export function nativeBridge(): NativeBridge {
  const native = plugin();
  if (native === null) return WEB_BRIDGE;
  const quiet = async <T>(
    run: (() => Promise<unknown>) | undefined,
    map: (value: unknown) => T,
    fallback: T,
  ): Promise<T> => {
    if (run === undefined) return fallback;
    try {
      return map(await run());
    } catch {
      return fallback;
    }
  };
  return {
    available: true,
    canScan: typeof native.scan === "function",
    loadSession: () =>
      quiet(
        native.getSession && (() => native.getSession!()),
        storedSession,
        null,
      ),
    saveSession: (session) =>
      quiet(
        native.setSession && (() => native.setSession!({ session })),
        () => undefined,
        undefined,
      ),
    clearSession: () =>
      quiet(
        native.clearSession && (() => native.clearSession!()),
        () => undefined,
        undefined,
      ),
    async pin(origin, fingerprint) {
      if (!FINGERPRINT.test(fingerprint)) throw new Error("bad fingerprint");
      if (native.pin === undefined) throw new Error("pinning unavailable");
      await native.pin({ origin, fingerprint });
    },
    scan: () =>
      quiet(
        native.scan && (() => native.scan!()),
        (value) => {
          const text = (value as { text?: unknown } | null)?.text;
          return typeof text === "string" && text !== "" ? text : null;
        },
        null,
      ),
    pushRegistration: () =>
      quiet(
        native.pushRegistration && (() => native.pushRegistration!()),
        pushRegistration,
        null,
      ),
  };
}

/** 在不在原生 App 里（插件也在）。 */
export function isNativeApp(): boolean {
  return plugin() !== null;
}

/* --------------------------------- 传输 ---------------------------------- */

/** 原生 App 升级 WebSocket 时的子协议前缀（core `gateway/admission.ts`）。 */
export const WS_TICKET_PROTOCOL = "armadra-ticket.";

export interface NativeTransport {
  /** 已保存的 Gateway 来源；只改写发往它的请求。 */
  readonly origin: string;
  /** 当前的访问密钥；没有是空串。 */
  authorization(): string;
  /** 换一张 30 秒的一次性 WebSocket 票。 */
  wsTicket(): Promise<string>;
  /** 访问密钥过期时轮转一次；成功返回 `true`。 */
  refresh(): Promise<boolean>;
}

function sameOrigin(target: string, origin: string): boolean {
  try {
    const url = new URL(target);
    const scheme = url.protocol === "wss:" ? "https:" : url.protocol;
    return `${scheme}//${url.host}` === origin;
  } catch {
    return false;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** 身份面自己管 Bearer（刷新用刷新密钥），不替它加、也不替它重试。 */
function identityPath(target: string): boolean {
  try {
    return new URL(target).pathname.startsWith("/api/identity/");
  } catch {
    return false;
  }
}

/**
 * 包一层 `fetch`：发往 Gateway 的请求补上 `Authorization: Bearer`，401 时轮转
 * 一次再发（请求体是字符串或没有时才重发，流式的体发不了第二次）。
 *
 * 只改写发往已保存来源的请求；调用方自己带了 `Authorization` 的原样放过。
 */
export function bearerFetch(
  base: typeof fetch,
  transport: NativeTransport,
): typeof fetch {
  return async (input, init) => {
    const target = requestUrl(input);
    if (!sameOrigin(target, transport.origin)) return base(input, init);
    const build = () => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const token = transport.authorization();
      if (!headers.has("authorization") && token)
        headers.set("authorization", `Bearer ${token}`);
      return { ...init, headers, credentials: "omit" as const };
    };
    const response = await base(input, build());
    const replayable =
      init?.body === undefined ||
      init.body === null ||
      typeof init.body === "string";
    if (
      response.status !== 401 ||
      identityPath(target) ||
      !replayable ||
      new Headers(init?.headers).has("authorization")
    )
      return response;
    if (!(await transport.refresh().catch(() => false))) return response;
    return base(input, build());
  };
}

type SocketCtor = typeof WebSocket;

/**
 * 原生 App 的 WebSocket：浏览器的 WS 带不了头，升级前先换一张一次性票，经
 * `Sec-WebSocket-Protocol: armadra-ticket.<票>` 升级（架构 §7）。
 *
 * 换票是异步的，而 `new WebSocket()` 是同步的，所以这里是一个「先 CONNECTING、
 * 拿到票再真连」的外壳，事件与属性都转给里面那条真连接。发往别处的连接原样
 * 交给原生实现。
 */
export function ticketedWebSocket(
  Base: SocketCtor,
  transport: Pick<NativeTransport, "origin" | "wsTicket">,
): SocketCtor {
  class TicketedWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readonly url: string;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;

    private inner: WebSocket | null = null;
    private state = 0;
    private type: BinaryType = "blob";

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this.url = new URL(url).href;
      const offered =
        protocols === undefined
          ? []
          : Array.isArray(protocols)
            ? protocols
            : [protocols];
      void transport.wsTicket().then(
        (ticket) => {
          if (this.state === 3) return;
          const inner = new Base(this.url, [
            ...offered,
            `${WS_TICKET_PROTOCOL}${ticket}`,
          ]);
          inner.binaryType = this.type;
          this.inner = inner;
          for (const name of ["open", "message", "error", "close"] as const) {
            inner.addEventListener(name, (event) => this.relay(name, event));
          }
          if (this.state === 2) inner.close();
        },
        () => {
          if (this.state === 3) return;
          this.relay("error", new Event("error"));
          this.relay(
            "close",
            new CloseEvent("close", { code: 1006, wasClean: false }),
          );
        },
      );
    }

    private relay(name: "open" | "message" | "error" | "close", event: Event) {
      if (name === "close") this.state = 3;
      const copy =
        name === "message"
          ? new MessageEvent("message", {
              data: (event as MessageEvent).data,
            })
          : name === "close"
            ? new CloseEvent("close", {
                code: (event as CloseEvent).code,
                reason: (event as CloseEvent).reason,
                wasClean: (event as CloseEvent).wasClean,
              })
            : new Event(name);
      const handler = this[`on${name}`] as ((event: Event) => void) | null;
      handler?.call(this, copy);
      this.dispatchEvent(copy);
    }

    get readyState(): number {
      return this.inner?.readyState ?? this.state;
    }

    get binaryType(): BinaryType {
      return this.inner?.binaryType ?? this.type;
    }

    set binaryType(value: BinaryType) {
      this.type = value;
      if (this.inner) this.inner.binaryType = value;
    }

    get bufferedAmount(): number {
      return this.inner?.bufferedAmount ?? 0;
    }

    get protocol(): string {
      const chosen = this.inner?.protocol ?? "";
      // 票是一次性的门票，不是调用方协商的协议。
      return chosen.startsWith(WS_TICKET_PROTOCOL) ? "" : chosen;
    }

    get extensions(): string {
      return this.inner?.extensions ?? "";
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.inner === null || this.inner.readyState !== 1)
        throw new DOMException("WebSocket is not open", "InvalidStateError");
      this.inner.send(data);
    }

    close(code?: number, reason?: string): void {
      if (this.inner) {
        this.inner.close(code, reason);
        return;
      }
      if (this.state >= 2) return;
      // 票还没回来：标记为关闭中，票回来时立刻关掉，不再打开。
      this.state = 2;
      queueMicrotask(() =>
        this.relay(
          "close",
          new CloseEvent("close", { code: code ?? 1000, wasClean: true }),
        ),
      );
    }
  }

  return new Proxy(Base, {
    construct(target, args: [string | URL, (string | string[])?]) {
      return sameOrigin(String(args[0]), transport.origin)
        ? new TicketedWebSocket(...args)
        : new target(...args);
    },
  });
}

/**
 * 原生 App 启动时装一次：之后页面里所有 `fetch` / `new WebSocket()` 发往
 * Gateway 的都带着设备凭据，调用点不用知道自己在 App 里。不在 App 里什么也
 * 不做。
 */
export function installNativeTransport(transport: NativeTransport): boolean {
  if (!isNativeApp()) return false;
  const scope = globalThis as {
    fetch: typeof fetch;
    WebSocket: SocketCtor;
  };
  scope.fetch = bearerFetch(scope.fetch.bind(globalThis), transport);
  scope.WebSocket = ticketedWebSocket(scope.WebSocket, transport);
  return true;
}
