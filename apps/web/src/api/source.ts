import {
  type BearerTransport,
  bearerFetch,
  ticketedWebSocket,
} from "../sources/transport";
import { ensureCsrf, replaceRejectedCsrf } from "./identity";
import { localRuntime } from "./local-runtime";
import { RELAY_TOKEN_HEADER, sameOrigin } from "../sources/transport";

/**
 * 一个源：一台 core 的地址，加上发往它时要带的凭据（工程规范化 §2.3.4）。
 *
 * 本机源是 {@link localSource}；挂载的远程源（`sources/connection.ts`）按同一个
 * 形状各有一份。凭据跟着源走，而不是装在全局的 `fetch` / `WebSocket` 上：同一个
 * 页面连两台 core 时，两套凭据不会互相改写。
 *
 * 类型与本机源从 `api/client.ts`（RPC 门面）再导出一次；这个文件不碰
 * `@orpc/*`，所以 `request.ts`、`assets.ts` 这些绕开 RPC 的发送点也能直接用它。
 */
export interface SourceCredentials {
  /**
   * `bearer`：桌面壳与原生 App，请求头带访问密钥、流先换票；`cookie`：服务器壳
   * 托管的页面，同源 Cookie，写方法带 CSRF；`none`：开发时的裸 core。
   */
  readonly mode: "bearer" | "cookie" | "none";
  /** 当前的访问密钥（没有会话时先配对）；不是 Bearer 模式答 `null`。 */
  access(): Promise<string | null>;
  /** 被拒的那一枚换一枚；换出来了答 `true`。 */
  renew(rejected: string | null): Promise<boolean>;
  /** Cookie 模式的 CSRF 令牌；别的模式答 `null`。 */
  csrf(): Promise<string | null>;
  /** CSRF 被拒（403）之后换一枚；换不出来答 `null`。 */
  renewCsrf(rejected: string): Promise<string | null>;
}

export interface Source {
  readonly sourceId: string;
  /** `http(s)://host:port`，不带尾斜杠。 */
  readonly httpBase: string;
  /** `ws(s)://host:port`。 */
  readonly wsBase: string;
  readonly credentials: SourceCredentials;
  /**
   * 发往这个源的 `fetch`：发往它自己来源的请求带上凭据（401 时换一枚、只重发
   * 一次），发往别处的原样放过。
   */
  readonly fetch: typeof fetch;
  /** 发往这个源的流：Bearer 模式先换一张一次性票，经子协议升级。 */
  readonly WebSocket: typeof WebSocket;
  /**
   * 眼下经中继到达（`httpBase` 是中继上的源地址）。浏览器直接取的地址（媒体票，
   * 契约 §37.4）还要再换一张中继的票。缺省不是。
   */
  readonly relayed?: () => boolean;
}

/**
 * 本机源的 Bearer 传输：桌面壳（`api/shell-transport.ts`）与原生 App
 * （`mobile/entry.ts`）各装一次；没装（浏览器）是 `null`。它只属于本机源，
 * 远程源的凭据在各自的连接里。
 */
let transport: BearerTransport | null = null;

/** 每个原生 `WebSocket` 构造器包一次（测试会换掉全局的那个）。 */
let ticketed = new WeakMap<typeof WebSocket, typeof WebSocket>();

const base: typeof fetch = (input, init) => globalThis.fetch(input, init);

const bearerCredentials = (current: BearerTransport): SourceCredentials => ({
  mode: "bearer",
  async access() {
    await current.prepare?.();
    return current.authorization() || null;
  },
  renew: (rejected) => current.refresh(rejected ?? undefined),
  csrf: async () => null,
  renewCsrf: async () => null,
});

const cookieCredentials: SourceCredentials = {
  mode: "cookie",
  access: async () => null,
  renew: async () => false,
  csrf: async () => (await ensureCsrf()) || null,
  renewCsrf: async (rejected) => (await replaceRejectedCsrf(rejected)) || null,
};

const noCredentials: SourceCredentials = {
  mode: "none",
  access: async () => null,
  renew: async () => false,
  csrf: async () => null,
  renewCsrf: async () => null,
};

/** 本机源的标识（源表里不可删的那一行）。 */
export const LOCAL_SOURCE_ID = "local";

/**
 * 页面所在的这台 core：桌面壳是壳报的回环端口，服务器壳托管的页面是同源，
 * 原生 App 是连接页记下的 Gateway（`api/local-runtime.ts` 的 `localRuntime`）。
 *
 * 地址是第一次用到时才算的，不在模块求值时定。
 */
export const localSource: Source = {
  sourceId: LOCAL_SOURCE_ID,
  get httpBase() {
    return localRuntime().httpBase;
  },
  get wsBase() {
    return localRuntime().wsBase;
  },
  get credentials() {
    if (transport !== null) return bearerCredentials(transport);
    return localRuntime().viaServerShell ? cookieCredentials : noCredentials;
  },
  fetch: (input, init) =>
    transport === null
      ? base(input, init)
      : bearerFetch(base, transport)(input, init),
  // 中继托管的页面（`sources/route-entry.ts`）把经中继的那台源装成本机源，
  // 传输上带着中继令牌头：媒体票还要再换一张中继的（§37.4）。
  relayed: () => transport?.extraHeaders?.()[RELAY_TOKEN_HEADER] !== undefined,
  get WebSocket() {
    const native = globalThis.WebSocket;
    if (transport === null) return native;
    let wrapped = ticketed.get(native);
    if (wrapped === undefined) {
      const current = transport;
      wrapped = ticketedWebSocket(native, current);
      ticketed.set(native, wrapped);
    }
    return wrapped;
  },
};

/**
 * 给本机源装上 Bearer 传输（桌面壳 `api/shell-transport.ts`、原生 App
 * `mobile/entry.ts`）。全局的 `fetch` 与 `WebSocket` 不被改写：发往 core 的
 * 每个点都经一个源。
 */
export function installLocalTransport(next: BearerTransport | null): void {
  transport = next;
  ticketed = new WeakMap();
}

/* --------------------------------- 当前源 --------------------------------- */

let resolveCurrent: () => Source = () => localSource;

/**
 * 当前源：省略了源的 `api/*` 调用发往它。源表（`sources/registry.ts`）装好
 * 之前、或没有选中别的源时是本机。
 */
export function currentSource(): Source {
  return resolveCurrent();
}

/** 源表把「当前源」接到自己身上；传 `null` 退回本机。 */
export function setCurrentSourceResolver(next: (() => Source) | null): void {
  resolveCurrent = next ?? (() => localSource);
}

/* -------------------------------- 已知的源 -------------------------------- */

const mounted = new Set<Source>();

/**
 * 记下一个挂载的源（`sources/registry.ts` 在加入源表时调），返回撤销函数。
 * 只有绕开 `request()` 的发送点按地址找源时用它：`<img>` 取图、下载。
 */
export function registerSource(source: Source): () => void {
  mounted.add(source);
  return () => {
    mounted.delete(source);
  };
}

/** 本机源在前，然后是挂载的源。 */
export function knownSources(): readonly Source[] {
  return [localSource, ...mounted];
}

/**
 * 按标识找源（本机与挂载的源）；不认识的标识落到当前源——调用方给的是此刻
 * 上下文里的源（`sources/scope.ts` 的 `activeSourceId()`），找不到说明它已经
 * 被移除，发往当前源与加源之前的行为相同。
 */
export function sourceById(sourceId: string): Source {
  return (
    knownSources().find((source) => source.sourceId === sourceId) ??
    currentSource()
  );
}

/**
 * 这个地址发往哪个源；都不是答 `null`。
 *
 * 先比 HTTP 来源，再比源地址的路径前缀：同一个个人中转上的几个源来源相同
 * （`https://<中继>/s/<源 A>`、`…/s/<源 B>`），只按来源比会把 B 的请求交给 A
 * 的凭据（中继答 `relay_source_mismatch`）。几个都对得上时取前缀最长的那个。
 */
export function sourceForUrl(
  url: string,
  sources: readonly Source[] = knownSources(),
): Source | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  let best: Source | null = null;
  let bestLength = -1;
  for (const source of sources) {
    let base: URL;
    try {
      base = new URL(source.httpBase);
    } catch {
      continue;
    }
    if (!sameOrigin(url, base.origin)) continue;
    const prefix = base.pathname.replace(/\/+$/, "");
    if (prefix !== "" && path !== prefix && !path.startsWith(`${prefix}/`))
      continue;
    if (prefix.length > bestLength) {
      best = source;
      bestLength = prefix.length;
    }
  }
  return best;
}

function targetUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * 按地址发往它所属的源（带那个源的凭据）；不属于任何已知源的原样发。给手里
 * 已经是一个完整地址的发送点用：`<img>` 取图、下载、媒体预览、栅格化取图。
 */
export const routedFetch: typeof fetch = (input, init) => {
  const source = sourceForUrl(targetUrl(input));
  return source === null
    ? globalThis.fetch(input, init)
    : source.fetch(input, init);
};

/**
 * 按地址开一条流：发往哪个源就用哪个源的 `WebSocket`（Bearer 先换票）；
 * 认不出的交给当前源（它对别处的地址原样放过）。
 */
export function openSourceSocket(
  url: string,
  protocols?: string | string[],
): WebSocket {
  const source = sourceForUrl(url) ?? currentSource();
  return new source.WebSocket(url, protocols);
}
