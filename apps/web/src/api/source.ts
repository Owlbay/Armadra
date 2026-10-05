import {
  type NativeTransport,
  bearerFetch,
  ticketedWebSocket,
} from "../mobile/native-bridge";
import { ensureCsrf, replaceRejectedCsrf } from "./identity";
import { RUNTIME_URL, RUNTIME_VIA_SERVER_SHELL } from "./request";
import { resolveSocketBase } from "./runtime-url";

/**
 * 一个源：一台 core 的地址，加上发往它时要带的凭据（工程规范化 §2.3.4）。
 *
 * 今天只有本机这一个（{@link localSource}）；多源挂载（A1-1）按同一个形状给
 * 每个源一份。凭据跟着源走，而不是装在全局的 `fetch` / `WebSocket` 上：同一个
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
}

/** 桌面壳装进来的那套 Bearer 传输；没装（浏览器、原生 App）是 `null`。 */
let transport: NativeTransport | null = null;

/** 每个原生 `WebSocket` 构造器包一次（测试会换掉全局的那个）。 */
let ticketed = new WeakMap<typeof WebSocket, typeof WebSocket>();

const base: typeof fetch = (input, init) => globalThis.fetch(input, init);

const bearerCredentials = (current: NativeTransport): SourceCredentials => ({
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

/**
 * 页面所在的这台 core。
 *
 * 地址与模式是现取的：`RUNTIME_URL` 在 `request.ts` 里按页面地址算一次，而这个
 * 文件与它互相引用，所以这里不在模块求值时读它。
 */
export const localSource: Source = {
  sourceId: "local",
  get httpBase() {
    return RUNTIME_URL;
  },
  get wsBase() {
    return resolveSocketBase(RUNTIME_URL);
  },
  get credentials() {
    if (transport !== null) return bearerCredentials(transport);
    return RUNTIME_VIA_SERVER_SHELL ? cookieCredentials : noCredentials;
  },
  fetch: (input, init) =>
    transport === null
      ? base(input, init)
      : bearerFetch(base, transport)(input, init),
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
 * 给本机源装上 Bearer 传输（桌面壳，`api/shell-transport.ts`）。全局的 `fetch`
 * 与 `WebSocket` 不再被改写：发往 core 的每个点都经 {@link localSource}。
 */
export function installLocalTransport(next: NativeTransport | null): void {
  transport = next;
  ticketed = new WeakMap();
}
