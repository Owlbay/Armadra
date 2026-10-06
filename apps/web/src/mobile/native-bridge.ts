import { isNativeAppPage } from "../api/runtime-url";

/**
 * 页面与原生 App（Capacitor，架构 §10）之间的那道桥。
 *
 * 原生只补网页做不到的几件事：钥匙串、证书钉扎、扫码、推送令牌、用系统浏览器
 * 打开授权页（原生 OAuth，R-56）。页面这一半
 * 在这里；原生那一半是 G3-1 的插件 `ArmadraNative`（经
 * `window.Capacitor.Plugins.ArmadraNative` 取，页面不依赖 `@capacitor/core`）。
 * 不在 Capacitor 里时 {@link nativeBridge} 是空实现：每个方法都答「没有」，
 * 调用方不必先判断环境。
 *
 * 插件的约定（参数与返回都是一个对象，Capacitor 的规矩）：
 *
 * | 方法                                  | 返回                                                 |
 * | ------------------------------------- | ---------------------------------------------------- |
 * | `getSessions()`                       | `{ sessions: StoredSession[] }`（一个连接一份，钥匙串 / Keystore） |
 * | `setSession({ session })`             | —（按 `sourceId` + `via` 写一份，同键覆盖）          |
 * | `removeSession({ sourceId, origin? })` | —（删这个源的会话；给了 `origin` 只删发往它的那份） |
 * | `getRemotes()`                        | `{ remotes: StoredRemote[] }`（远程服务的刷新令牌）  |
 * | `setRemote({ remote })`               | —（按 `serviceId` 写一份）                           |
 * | `removeRemote({ serviceId })`         | —                                                    |
 * | `peek({ origin })`                    | `{ fingerprint?, trusted, pinned }`（不带凭据取一次信任锚指纹，什么也不存） |
 * | `pin({ origin, fingerprint })`        | —（之后对该来源的 TLS 只认这个信任锚指纹；多个来源各存一份） |
 * | `scan()`                              | `{ text?: string }`（取消时没有 `text`）             |
 * | `pushRegistration()`                  | `{ registration?: { platform, transport, token?, publicKey?, unifiedpush? } }` |
 * | `pushRotated()`                       | `{ rotated: boolean }`（推送令牌或 UnifiedPush 端点换过、还没重新登记） |
 * | `ackPushRotation()`                   | —（重新登记成功之后清掉上面那个标记）                |
 * | `openExternal({ url })`               | —（系统浏览器打开；只收 https / 回环 http）          |
 *
 * 事件（`addListener`）：`pushTokenRotated`——App 开着时令牌换了（Android
 * `onNewToken`、UnifiedPush 新端点、iOS 启动时 APNs 给了新令牌）。
 */

/** 一份会话走的路：直连 Gateway，或经中继。 */
export type StoredVia = "direct" | "relayed";

/**
 * 钥匙串里的一份会话：哪个源、经哪条路、发往哪个来源（直连是 Gateway，中继是
 * 签发方），加两把密钥与访问密钥的到期时刻（不知道是 0）。一个连接一份。
 */
export interface StoredSession {
  readonly sourceId: string;
  readonly origin: string;
  readonly via: StoredVia;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAtMs: number;
}

/** 远程服务（个人中转、将来的 SaaS）的一份登录：刷新令牌只在钥匙串里。 */
export interface StoredRemote {
  readonly serviceId: string;
  readonly issuer: string;
  readonly kind: "personal" | "saas";
  readonly refreshToken: string;
  /** 个人中转的信任锚指纹；系统信任的证书与 SaaS 是空串。 */
  readonly fingerprint: string;
}

/** 取到的信任锚：`trusted` 是系统本来就信，`pinned` 是已钉且与这次取到的一致。 */
export interface PeekResult {
  readonly fingerprint: string;
  readonly trusted: boolean;
  readonly pinned: boolean;
}

/** 原生推送注册：交给 `PUT /api/push/devices`（契约 §19.2）。 */
export interface NativePushRegistration {
  readonly platform: "ios" | "android";
  readonly transport: "direct" | "relay";
  /** APNs / FCM 令牌或中继令牌；只有 UnifiedPush 端点的 Android 可以没有。 */
  readonly token?: string;
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
  getSessions(): Promise<StoredSession[]>;
  setSession(session: StoredSession): Promise<void>;
  removeSession(sourceId: string, origin?: string): Promise<void>;
  getRemotes(): Promise<StoredRemote[]>;
  setRemote(remote: StoredRemote): Promise<void>;
  removeRemote(serviceId: string): Promise<void>;
  /** 不带凭据取一次信任锚指纹；取不到（连不上、没有信任锚）是 `null`。 */
  peek(origin: string): Promise<PeekResult | null>;
  pin(origin: string, fingerprint: string): Promise<void>;
  scan(): Promise<string | null>;
  pushRegistration(): Promise<NativePushRegistration | null>;
  /** 推送令牌换过、还没重新登记。 */
  pushRotated(): Promise<boolean>;
  /** 重新登记成功：清掉「换过」的标记。 */
  ackPushRotation(): Promise<void>;
  /** App 开着时令牌换了；返回取消订阅。 */
  onPushRotated(listener: () => void): () => void;
  /** 用系统浏览器打开；打不开（没有插件方法、地址不对）是 `false`。 */
  openExternal(url: string): Promise<boolean>;
}

interface PluginListenerHandle {
  remove(): Promise<void> | void;
}

interface ArmadraNativePlugin {
  getSessions?(): Promise<unknown>;
  setSession?(options: { session: StoredSession }): Promise<unknown>;
  removeSession?(options: {
    sourceId: string;
    origin?: string;
  }): Promise<unknown>;
  getRemotes?(): Promise<unknown>;
  setRemote?(options: { remote: StoredRemote }): Promise<unknown>;
  removeRemote?(options: { serviceId: string }): Promise<unknown>;
  peek?(options: { origin: string }): Promise<unknown>;
  pin?(options: { origin: string; fingerprint: string }): Promise<unknown>;
  scan?(): Promise<unknown>;
  pushRegistration?(): Promise<unknown>;
  pushRotated?(): Promise<unknown>;
  ackPushRotation?(): Promise<unknown>;
  openExternal?(options: { url: string }): Promise<unknown>;
  addListener?(
    event: string,
    listener: () => void,
  ): Promise<PluginListenerHandle> | PluginListenerHandle;
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

const SOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function storedSession(value: unknown): StoredSession | null {
  if (!value || typeof value !== "object") return null;
  const { sourceId, origin, via, accessToken, refreshToken, expiresAtMs } =
    value as Record<string, unknown>;
  if (
    typeof sourceId !== "string" ||
    !SOURCE_ID.test(sourceId) ||
    typeof origin !== "string" ||
    (via !== "direct" && via !== "relayed") ||
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    !SESSION_TOKEN.test(accessToken) ||
    !SESSION_TOKEN.test(refreshToken)
  )
    return null;
  return {
    sourceId,
    origin,
    via,
    accessToken,
    refreshToken,
    expiresAtMs:
      typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs)
        ? expiresAtMs
        : 0,
  };
}

function storedRemote(value: unknown): StoredRemote | null {
  if (!value || typeof value !== "object") return null;
  const { serviceId, issuer, kind, refreshToken, fingerprint } =
    value as Record<string, unknown>;
  if (
    typeof serviceId !== "string" ||
    !SOURCE_ID.test(serviceId) ||
    typeof issuer !== "string" ||
    (kind !== "personal" && kind !== "saas") ||
    typeof refreshToken !== "string" ||
    refreshToken === "" ||
    refreshToken.length > 4096 ||
    typeof fingerprint !== "string" ||
    (fingerprint !== "" && !FINGERPRINT.test(fingerprint))
  )
    return null;
  return { serviceId, issuer, kind, refreshToken, fingerprint };
}

function listOf<T>(
  value: unknown,
  key: string,
  parse: (item: unknown) => T | null,
): T[] {
  const list = (value as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const parsed = parse(item);
    return parsed === null ? [] : [parsed];
  });
}

function peekResult(value: unknown): PeekResult | null {
  if (!value || typeof value !== "object") return null;
  const { fingerprint, trusted, pinned } = value as Record<string, unknown>;
  if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint))
    return null;
  return { fingerprint, trusted: trusted === true, pinned: pinned === true };
}

/**
 * UnifiedPush 端点：https，回环上的 http 只给测试；不带用户名口令与片段（与
 * core 登记时的规矩一致，契约 §27.2）。
 */
export function unifiedPushEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    return null;
  if (url.username || url.password || url.hash) return null;
  return value;
}

function pushRegistration(value: unknown): NativePushRegistration | null {
  if (!value || typeof value !== "object") return null;
  const registration = (value as { registration?: unknown }).registration;
  if (!registration || typeof registration !== "object") return null;
  const { platform, transport, token, publicKey, unifiedpush } =
    registration as Record<string, unknown>;
  if (platform !== "ios" && platform !== "android") return null;
  if (transport !== "direct" && transport !== "relay") return null;
  if (
    token !== undefined &&
    (typeof token !== "string" || token === "" || token.length > 4096)
  )
    return null;
  if (
    publicKey !== undefined &&
    (typeof publicKey !== "string" || !BASE64URL.test(publicKey))
  )
    return null;
  if (transport === "relay" && publicKey === undefined) return null;
  let endpoint: string | null = null;
  if (unifiedpush !== undefined) {
    // 只有 Android，而且必须带公钥：分发器只该见到密文。
    endpoint = unifiedPushEndpoint(
      (unifiedpush as { endpoint?: unknown } | null)?.endpoint,
    );
    if (endpoint === null || platform !== "android" || publicKey === undefined)
      return null;
  }
  if (token === undefined && endpoint === null) return null;
  return {
    platform,
    transport,
    ...(typeof token === "string" ? { token } : {}),
    ...(typeof publicKey === "string" ? { publicKey } : {}),
    ...(endpoint === null ? {} : { unifiedpush: { endpoint } }),
  };
}

/** 交给系统浏览器的地址：https，或回环上的 http（开发与 dev-stack）。 */
export function externalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

const WEB_BRIDGE: NativeBridge = {
  available: false,
  canScan: false,
  getSessions: () => Promise.resolve([]),
  setSession: () => Promise.resolve(),
  removeSession: () => Promise.resolve(),
  getRemotes: () => Promise.resolve([]),
  setRemote: () => Promise.resolve(),
  removeRemote: () => Promise.resolve(),
  peek: () => Promise.resolve(null),
  pin: () => Promise.resolve(),
  scan: () => Promise.resolve(null),
  pushRegistration: () => Promise.resolve(null),
  pushRotated: () => Promise.resolve(false),
  ackPushRotation: () => Promise.resolve(),
  onPushRotated: () => () => undefined,
  openExternal: () => Promise.resolve(false),
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
    getSessions: () =>
      quiet(
        native.getSessions && (() => native.getSessions!()),
        (value) => listOf(value, "sessions", storedSession),
        [],
      ),
    setSession: (session) =>
      quiet(
        native.setSession && (() => native.setSession!({ session })),
        () => undefined,
        undefined,
      ),
    removeSession: (sourceId, origin) =>
      quiet(
        native.removeSession &&
          (() =>
            native.removeSession!({
              sourceId,
              ...(origin === undefined ? {} : { origin }),
            })),
        () => undefined,
        undefined,
      ),
    getRemotes: () =>
      quiet(
        native.getRemotes && (() => native.getRemotes!()),
        (value) => listOf(value, "remotes", storedRemote),
        [],
      ),
    setRemote: (remote) =>
      quiet(
        native.setRemote && (() => native.setRemote!({ remote })),
        () => undefined,
        undefined,
      ),
    removeRemote: (serviceId) =>
      quiet(
        native.removeRemote && (() => native.removeRemote!({ serviceId })),
        () => undefined,
        undefined,
      ),
    peek: (origin) =>
      quiet(native.peek && (() => native.peek!({ origin })), peekResult, null),
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
    pushRotated: () =>
      quiet(
        native.pushRotated && (() => native.pushRotated!()),
        (value) => (value as { rotated?: unknown } | null)?.rotated === true,
        false,
      ),
    ackPushRotation: () =>
      quiet(
        native.ackPushRotation && (() => native.ackPushRotation!()),
        () => undefined,
        undefined,
      ),
    onPushRotated(listener) {
      if (typeof native.addListener !== "function") return () => undefined;
      let handle: PluginListenerHandle | null = null;
      let removed = false;
      void Promise.resolve(native.addListener("pushTokenRotated", listener))
        .then((found) => {
          handle = found;
          if (removed) void handle.remove();
        })
        .catch(() => undefined);
      return () => {
        removed = true;
        if (handle) void handle.remove();
      };
    },
    openExternal: (url) =>
      externalUrl(url)
        ? quiet(
            native.openExternal && (() => native.openExternal!({ url })),
            () => true,
            false,
          )
        : Promise.resolve(false),
  };
}

/** 在不在原生 App 里（插件也在）。 */
export function isNativeApp(): boolean {
  return plugin() !== null;
}
