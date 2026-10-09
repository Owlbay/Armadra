import { type ArmadraClient, clientFor } from "../api/client";
import { RuntimeRequestError } from "../api/request";
import { runtimeSocketUrl } from "../api/runtime-url";
import {
  type Source,
  type SourceCredentials,
  localSource,
} from "../api/source";
import {
  ManagedSocket,
  type ManagedSocketOptions,
  type ManagedSocketState,
  type SocketEnvironment,
  browserEnvironment,
} from "./managed-socket";
import { type ProbeOptions, pickRoute, probeDirect } from "./routing";
import {
  type BearerTransport,
  RELAY_PROTOCOL,
  RELAY_TOKEN_HEADER,
  bearerFetch,
  ticketedWebSocket,
} from "./transport";
import {
  type CredentialProvider,
  type HelloInfo,
  SOURCE_ERROR,
  type SourceAccess,
  type SourceDescriptor,
  SourceError,
  type SourceFailure,
  type SourceStatus,
  type Via,
  failureOf,
} from "./types";

/**
 * 一个源的连接（客户端包 §1.2–§1.3）：地址、凭据、RPC 客户端、状态与流。
 *
 * `source` 是 E1 的 `Source` 形状（`api/source.ts`）：`request()`、
 * `createClient()`、`api/sockets.ts` 的地址都认它，所以 `api/*` 发往哪个源只看
 * 传进来的是哪一个。
 */
export interface SourceConnection {
  readonly descriptor: SourceDescriptor;
  readonly status: SourceStatus;
  /** 状态或 hello 变了时通知（`useSyncExternalStore` 用）。 */
  subscribe(listener: () => void): () => void;
  readonly source: Source;
  readonly client: ArmadraClient;
  /** 连上之后的 `system.hello`；本机源不主动问（零配置不多发请求），是 `null`。 */
  readonly hello: HelloInfo | null;
  /** 过渡期的 REST 残留：带这个源的凭据发一次，答原样的 `Response`。 */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** 开一条托管的流（五条数据面流与控制面都可以）。 */
  socket(path: string, options?: SourceSocketOptions): ManagedSocket;
  connect(): Promise<void>;
  disconnect(): void;
  /** 凭据被拒之后续一次；续不上状态变 `unauthorized` 并抛。 */
  renew(): Promise<void>;
  /**
   * 远程服务说这个源不能再用了（`me.stream` 的 `sourceRevoked` /
   * `accessRevoked`）：关掉流、丢掉访问，状态 `unauthorized` 带上原因。之后
   * 只有人重新挂载（或显式 `connect()`）才再连。
   */
  revoke(failure: SourceFailure): void;
}

/** `socket()` 的选项：`ManagedSocket` 的回调与协商协议，地址与凭据由连接给。 */
export type SourceSocketOptions = Omit<
  ManagedSocketOptions,
  "url" | "ticket" | "relayToken" | "renew"
>;

type Listener = () => void;

class Status {
  private value: SourceStatus;
  private readonly listeners = new Set<Listener>();

  constructor(initial: SourceStatus) {
    this.value = initial;
  }

  get current(): SourceStatus {
    return this.value;
  }

  set(
    state: SourceStatus["state"],
    via: Via | null,
    lastError: SourceFailure | null,
    now: number,
  ): void {
    const previous = this.value;
    if (
      previous.state === state &&
      previous.via === via &&
      previous.lastError?.code === lastError?.code
    )
      return;
    this.value = {
      state,
      via,
      since: previous.state === state ? previous.since : now,
      lastError,
    };
    this.notify();
  }

  notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* 一个订阅者出错不拖垮别的。 */
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/* --------------------------------- 本机源 --------------------------------- */

export const LOCAL_DESCRIPTOR: SourceDescriptor = {
  sourceId: localSource.sourceId,
  kind: "local",
  label: "",
  baseUrl: "",
  relayOrigin: "",
  cloudIssuer: "",
  fingerprint: "",
  orderIndex: 0,
};

/**
 * 本机源的连接：一创建就是 `ready`（经 `local`），`connect()` 不发请求——
 * 零配置时页面的行为与没有源层时逐字相同。凭据就是本机源上装的那套
 * （桌面壳与原生 App 的 Bearer、服务器壳的 Cookie）。
 */
export function createLocalConnection(
  options: {
    source?: Source;
    now?: () => number;
    /**
     * 本机源的名字：手机与中继托管的页面把选中的那台主机装成本机源，侧栏用它
     * 的名字而不是「本机」。桌面与服务器壳留空。
     */
    label?: string;
  } = {},
): SourceConnection {
  const source = options.source ?? localSource;
  const now = options.now ?? Date.now;
  const status = new Status({
    state: "ready",
    via: "local",
    since: now(),
    lastError: null,
  });
  const sockets = new Set<ManagedSocket>();
  return {
    descriptor: {
      ...LOCAL_DESCRIPTOR,
      sourceId: source.sourceId,
      label: options.label ?? "",
    },
    get status() {
      return status.current;
    },
    subscribe: (listener) => status.subscribe(listener),
    source,
    get client() {
      return clientFor(source);
    },
    hello: null,
    request: (path, init) => source.fetch(`${source.httpBase}${path}`, init),
    socket(path, socketOptions = {}) {
      const socket = new ManagedSocket({
        ...socketOptions,
        // 本机源的 `WebSocket` 自己换票（桌面壳与原生 App），这里不另取。
        WebSocket: socketOptions.WebSocket ?? source.WebSocket,
        url: () => runtimeSocketUrl(source.wsBase, path),
        ticket: async () => null,
        renew: () => renewCredentials(source.credentials),
        onStateChange: (state) => {
          if (state === "closed") sockets.delete(socket);
          socketOptions.onStateChange?.(state);
        },
      });
      sockets.add(socket);
      return socket;
    },
    // 不发请求；只叫醒在等、在退避的流（中继托管的页面：主机重新上线）。
    connect: async () => {
      for (const socket of sockets) socket.wake();
    },
    disconnect() {
      for (const socket of [...sockets]) socket.close();
      sockets.clear();
    },
    async renew() {
      if (!(await renewCredentials(source.credentials)))
        throw new SourceError(SOURCE_ERROR.unauthorized);
    },
    // 本机源不经远程服务，没有可撤销的。
    revoke: () => undefined,
  };
}

async function renewCredentials(
  credentials: SourceCredentials,
): Promise<boolean> {
  if (credentials.mode !== "bearer") return false;
  const used = await credentials.access().catch(() => null);
  return credentials.renew(used).catch(() => false);
}

/* --------------------------------- 远程源 --------------------------------- */

export interface RemoteConnectionOptions {
  readonly provider: CredentialProvider;
  /** 底层 `fetch`（测试注入）；缺省全局那个。 */
  readonly fetch?: typeof fetch;
  /** 底层 `WebSocket`（测试注入）；缺省全局那个。 */
  readonly WebSocket?: typeof WebSocket;
  /** 选路的直连探测（超时、`fetch`）。 */
  readonly probe?: ProbeOptions;
  /** 问 hello；缺省经这个源的 RPC 客户端 `system.hello`。 */
  readonly hello?: (client: ArmadraClient) => Promise<HelloInfo>;
  readonly now?: () => number;
  /**
   * `online` 与可见性（重新探直连用）；缺省浏览器的 `window` / `document`，
   * `null` = 不听。
   */
  readonly environment?: SocketEnvironment | null;
}

/** 经中继时两次重新探直连之间至少隔这么久（流在退避里会反复触发）。 */
export const REPROBE_INTERVAL_MS = 5_000;

function originOf(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return "";
  }
}

function socketOriginOf(base: string): string {
  try {
    const url = new URL(base);
    const scheme =
      url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
    return `${scheme}//${url.host}`;
  } catch {
    return "";
  }
}

function unauthorizedFailure(error: unknown): boolean {
  return (
    error instanceof RuntimeRequestError &&
    (error.status === 401 || error.status === 403)
  );
}

/**
 * 一个远程源的连接（`direct` / `relayed` / `hosted`）。
 *
 * - `connect()`：选路（`routing.ts`）→ 拿访问 → `system.hello` → `sourceId`
 *   对得上才 `ready`，否则 `source_mismatch`。失败不抛，状态里说清楚——源表
 *   hydrate 时一个远程源连不上不该挡住别的源。
 * - 401：`fetch` 续一次再重放（`bearerFetch` 按源实例化）；续期先用凭据来源的
 *   `refresh`，经中继的再忘掉缓存重取一次（远程服务重取断言）；再失败
 *   `unauthorized`。
 * - 流：`socket()` 每次（重）连前换票，经中继时带中继子协议；4403 →
 *   `unauthorized`，4404 → `waitingForSource`，再次 `connect()` 成功时叫醒
 *   （远程服务 `me.stream` 推 `sourceOnline` 时由 `remote-stream.ts` 调）。
 *   取访问时中继答源不在线（`source_offline`）同样是 `waitingForSource`。
 * - D27：已经走中继的连接，在流重连、`online`、页面回到前台时重新探一次直连；
 *   通了就换到直连，开着的流按新地址重连。
 */
export function createRemoteConnection(
  descriptor: SourceDescriptor,
  options: RemoteConnectionOptions,
): SourceConnection {
  const { provider } = options;
  const now = options.now ?? Date.now;
  const id = descriptor.sourceId;
  const status = new Status({
    state: "idle",
    via: null,
    since: now(),
    lastError: null,
  });
  const sockets = new Set<ManagedSocket>();
  let access: SourceAccess | null = null;
  let via: Via | null = null;
  /** 同一类路里走的是哪一条（§55）；凭据来源自己选的是 `undefined`。 */
  let origin: string | undefined;
  let hello: HelloInfo | null = null;
  let connecting: Promise<void> | null = null;
  let renewing: Promise<boolean> | null = null;
  let epoch = 0;
  let probing: Promise<void> | null = null;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  const environment =
    options.environment === undefined
      ? browserEnvironment()
      : options.environment;
  let listening = false;

  const baseFetch: typeof fetch = (input, init) =>
    (options.fetch ?? globalThis.fetch)(input, init);
  const httpBase = () =>
    access?.httpBase ?? (descriptor.baseUrl || descriptor.relayOrigin);
  const wsBase = () => access?.wsBase ?? httpBase().replace(/^http/, "ws");
  const relayToken = () =>
    via === "relayed" ? (access?.relayToken ?? null) : null;

  const setStatus = (
    state: SourceStatus["state"],
    lastError: SourceFailure | null = null,
  ) => status.set(state, via, lastError, now());

  /** 选路选中的那一条（凭据来源自己选的不传）。 */
  const onRoute = (): [] | [string] => (origin === undefined ? [] : [origin]);

  /** 拿到一份访问：已有就用，没有就选路（不改状态，`connect` 负责状态）。 */
  const ensureAccess = async (): Promise<SourceAccess> => {
    if (access !== null) return access;
    const route = await pickRoute(descriptor, provider, options.probe);
    access = route.access;
    via = route.via;
    origin = route.origin;
    return access;
  };

  /** 续一次：`refresh`，经中继的再重取一次；续不上 `unauthorized`。 */
  const renewAccess = (): Promise<boolean> => {
    renewing ??= (async () => {
      const route = via;
      if (route === null || route === "local") return false;
      try {
        access = await provider.refresh(id, route, ...onRoute());
        return true;
      } catch (first) {
        if (route === "relayed") {
          provider.invalidate(id);
          try {
            access = await provider.getAccess(id, "relayed", ...onRoute());
            return true;
          } catch (second) {
            setStatus(
              "unauthorized",
              failureOf(second, SOURCE_ERROR.unauthorized),
            );
            return false;
          }
        }
        setStatus("unauthorized", failureOf(first, SOURCE_ERROR.unauthorized));
        return false;
      }
    })().finally(() => {
      renewing = null;
    });
    return renewing;
  };

  const transport: BearerTransport = {
    get origin() {
      return originOf(httpBase());
    },
    get socketOrigin() {
      return socketOriginOf(wsBase());
    },
    authorization: () => access?.accessToken ?? "",
    prepare: async () => {
      await ensureAccess();
    },
    wsTicket: () => fetchTicket(),
    refresh: () => renewAccess(),
    extraHeaders: (): Record<string, string> => {
      const token = relayToken();
      return token === null ? {} : { [RELAY_TOKEN_HEADER]: token };
    },
    extraProtocols: () => {
      const token = relayToken();
      return token === null ? [] : [`${RELAY_PROTOCOL}${token}`];
    },
  };

  const sourceFetch = bearerFetch(baseFetch, transport);

  /** 换一张一次性 WS 票（`POST /api/identity/ws-ticket`）；401 续一次再换。 */
  async function fetchTicket(): Promise<string> {
    await ensureAccess();
    const send = () =>
      sourceFetch(`${httpBase()}/api/identity/ws-ticket`, {
        method: "POST",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
    let response = await send();
    if (response.status === 401 && (await renewAccess()))
      response = await send();
    if (!response.ok)
      throw new SourceError(
        response.status === 401 || response.status === 403
          ? SOURCE_ERROR.unauthorized
          : SOURCE_ERROR.unreachable,
        `ws-ticket ${response.status}`,
      );
    const body = (await response.json()) as { ticket?: unknown };
    if (typeof body.ticket !== "string" || body.ticket === "")
      throw new SourceError(SOURCE_ERROR.unreachable, "ws-ticket");
    return body.ticket;
  }

  let ticketed = new WeakMap<typeof WebSocket, typeof WebSocket>();

  const credentials: SourceCredentials = {
    mode: "bearer",
    async access() {
      return (await ensureAccess()).accessToken;
    },
    async renew(rejected) {
      if (
        access !== null &&
        rejected !== null &&
        access.accessToken !== rejected
      )
        return true;
      return renewAccess();
    },
    csrf: async () => null,
    renewCsrf: async () => null,
  };

  const source: Source = {
    sourceId: id,
    get httpBase() {
      return httpBase();
    },
    get wsBase() {
      return wsBase();
    },
    credentials,
    fetch: sourceFetch,
    relayed: () => via === "relayed",
    get WebSocket() {
      const native = options.WebSocket ?? globalThis.WebSocket;
      let wrapped = ticketed.get(native);
      if (wrapped === undefined) {
        wrapped = ticketedWebSocket(native, transport);
        ticketed.set(native, wrapped);
      }
      return wrapped;
    },
  };

  const client = clientFor(source);
  const askHello = options.hello ?? ((rpc) => rpc.system.hello({}));

  const connection: SourceConnection = {
    descriptor,
    get status() {
      return status.current;
    },
    subscribe: (listener) => status.subscribe(listener),
    source,
    client,
    get hello() {
      return hello;
    },
    request: (path, init) => sourceFetch(`${httpBase()}${path}`, init),
    socket(path, socketOptions = {}) {
      const socket = new ManagedSocket({
        ...socketOptions,
        WebSocket: socketOptions.WebSocket ?? options.WebSocket,
        url: () => runtimeSocketUrl(wsBase(), path),
        ticket: () => fetchTicket(),
        relayToken,
        renew: () => renewAccess(),
        onStateChange: (state: ManagedSocketState) => {
          if (state === "closed") sockets.delete(socket);
          if (state === "unauthorized")
            setStatus("unauthorized", {
              code: SOURCE_ERROR.unauthorized,
              message: "",
            });
          if (state === "waiting")
            setStatus("waitingForSource", {
              code: SOURCE_ERROR.offline,
              message: "",
            });
          // 流断了在退避：经中继的趁这时再看一眼直连通没通（D27）。
          if (state === "backoff") void reprobe();
          socketOptions.onStateChange?.(state);
        },
      });
      sockets.add(socket);
      return socket;
    },
    connect() {
      listen();
      if (status.current.state === "ready") return Promise.resolve();
      return establish();
    },
    disconnect() {
      epoch += 1;
      unlisten();
      for (const socket of [...sockets]) socket.close();
      sockets.clear();
      access = null;
      hello = null;
      ticketed = new WeakMap();
      provider.invalidate(id);
      via = null;
      origin = undefined;
      setStatus("idle");
    },
    async renew() {
      if (!(await renewAccess()))
        throw new SourceError(SOURCE_ERROR.unauthorized);
    },
    revoke(failure) {
      epoch += 1;
      unlisten();
      for (const socket of [...sockets]) socket.close();
      sockets.clear();
      access = null;
      hello = null;
      ticketed = new WeakMap();
      provider.invalidate(id);
      setStatus("unauthorized", failure);
    },
  };

  /**
   * 选路 → 取访问 → hello → 核对。`connect()` 与换路共用；结束后叫醒（换了路
   * 就重连）这个源的流。
   */
  function establish(): Promise<void> {
    connecting ??= (async () => {
      const mine = ++epoch;
      const before = via;
      setStatus("connecting", status.current.lastError);
      // 重新走一遍选路（D27：重连与回到前台时再探直连）。
      access = null;
      via = null;
      origin = undefined;
      try {
        await ensureAccess();
      } catch (error) {
        if (mine !== epoch) return;
        const failure = failureOf(error, SOURCE_ERROR.unreachable);
        // 中继说源不在线：等它上线（`me.stream` 的 `sourceOnline` 叫醒）。
        setStatus(
          failure.code === SOURCE_ERROR.offline
            ? "waitingForSource"
            : failure.code === SOURCE_ERROR.unauthorized ||
                failure.code === SOURCE_ERROR.revoked ||
                failure.code === SOURCE_ERROR.accessRevoked
              ? "unauthorized"
              : "offline",
          failure,
        );
        return;
      }
      let answer: HelloInfo;
      try {
        answer = await askHello(client);
      } catch (error) {
        if (mine !== epoch) return;
        const failure = failureOf(error, SOURCE_ERROR.unreachable);
        setStatus(
          unauthorizedFailure(error) ||
            failure.code === SOURCE_ERROR.unauthorized
            ? "unauthorized"
            : failure.code === SOURCE_ERROR.offline ||
                (error instanceof RuntimeRequestError && error.status === 503)
              ? "waitingForSource"
              : "offline",
          failure,
        );
        return;
      }
      if (mine !== epoch) return;
      if (answer.sourceId !== id) {
        // 连上的不是这台：不信它，丢掉这份访问。
        access = null;
        provider.invalidate(id);
        setStatus("offline", {
          code: SOURCE_ERROR.mismatch,
          message: answer.sourceId,
        });
        return;
      }
      hello = answer;
      setStatus("ready");
      const moved = before !== null && before !== via;
      for (const socket of sockets) {
        if (moved) socket.reroute();
        else socket.wake();
      }
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  /**
   * 经中继的连接再探一次直连（D27）：通了就换到直连（先拿到直连的访问再换，
   * 换的那一刻之前的请求照旧走中继），开着的流按新地址重连。离线、等源上线的
   * 连接顺手再连一次（`online` 之后网络可能回来了）。两次之间至少隔
   * {@link REPROBE_INTERVAL_MS}。
   */
  function reprobe(): Promise<void> {
    if (probing !== null || now() - lastProbeAt < REPROBE_INTERVAL_MS)
      return Promise.resolve();
    const state = status.current.state;
    if (state === "offline" || state === "waitingForSource") {
      lastProbeAt = now();
      if (connecting === null) void establish();
      return Promise.resolve();
    }
    if (state !== "ready" || via !== "relayed" || descriptor.baseUrl === "")
      return Promise.resolve();
    lastProbeAt = now();
    const mine = epoch;
    probing = (async () => {
      if (!(await probeDirect(descriptor.baseUrl, id, options.probe))) return;
      if (mine !== epoch || via !== "relayed") return;
      let next: SourceAccess;
      try {
        next = await provider.getAccess(id, "direct");
      } catch {
        return;
      }
      if (mine !== epoch || via !== "relayed") return;
      access = next;
      via = "direct";
      origin = undefined;
      setStatus("ready");
      for (const socket of sockets) socket.reroute();
    })().finally(() => {
      probing = null;
    });
    return probing;
  }

  function onOnline(): void {
    void reprobe();
  }

  function onVisible(): void {
    if (environment?.visible() ?? true) void reprobe();
  }

  function listen(): void {
    if (listening || environment === null) return;
    listening = true;
    environment.addEventListener("online", onOnline);
    environment.addEventListener("visibilitychange", onVisible);
  }

  function unlisten(): void {
    if (!listening || environment === null) return;
    listening = false;
    environment.removeEventListener("online", onOnline);
    environment.removeEventListener("visibilitychange", onVisible);
  }

  return connection;
}
