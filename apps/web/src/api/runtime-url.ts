const LOCAL_RUNTIME = "http://127.0.0.1:43120";

/**
 * 桌面壳（electron-migration §2.1）：页面由壳的回环 HTTP 静态服务提供，
 * `fetch` / `WebSocket` 直连 Runtime。Runtime 的端口由内核分配，只有壳知道，
 * 所以基址从 preload 桥一次性取来。
 *
 * 同步读取是必须的：本机源的地址（`api/local-runtime.ts`）是同步的 getter，第一次
 * 用到时才算，那时没有 `await` 可用。壳在窗口加载页面之前就把答案准备好了，
 * 所以这里是读一个已决定的值，不是等一次调用。
 */
export interface ShellEndpoints {
  readonly httpBase: string;
  readonly wsBase: string;
}

let cachedShell: ShellEndpoints | null | undefined;

function readShellEndpoints(): ShellEndpoints | null {
  const bridge = globalThis.window?.armadra;
  if (typeof bridge?.transport !== "object") return null;
  try {
    const endpoints = bridge.transport.endpointsSync();
    // 壳给的地址只接受回环 HTTP：壳本来就只会给这个，别的都不该出现在这条路上。
    if (!loopbackBase(endpoints.httpBase, "http:")) return null;
    return {
      httpBase: trimBase(endpoints.httpBase),
      wsBase: loopbackBase(endpoints.wsBase, "ws:")
        ? trimBase(endpoints.wsBase)
        : trimBase(endpoints.httpBase).replace(/^http/, "ws"),
    };
  } catch {
    return null;
  }
}

/** 壳给出的基址，取一次后缓存；不在壳里返回 `null`。 */
export function shellEndpoints(): ShellEndpoints | null {
  cachedShell ??= readShellEndpoints();
  return cachedShell;
}

/** 测试与壳重载后重置。 */
export function resetShellEndpoints(): void {
  cachedShell = undefined;
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

function loopbackBase(base: string, protocol: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  return (
    url.protocol === protocol &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    !url.username &&
    !url.password
  );
}

/* ------------------------------ 原生 App 的来源 ----------------------------- */

/**
 * 原生 App（Capacitor）里页面打在包里：iOS 是 `capacitor://localhost`，Android
 * 是 `https://localhost`（架构 §7「原生 App 的准入」）。页面来源推不出 core 在
 * 哪，所以连接页配对成功后把 Gateway 的来源记下来，之后每次启动从这里读。
 *
 * 来源不是凭据（凭据在钥匙串里，见 `mobile/native-bridge.ts`），放 localStorage
 * 足够；但只有原生 App 的页面认它——桌面窗口与经 Gateway 打开的网页各有自己的
 * 答案，一个残留的值不该改变它们连到哪。
 */
const SAVED_ORIGIN_KEY = "armadra.runtimeOrigin";

const NATIVE_APP_PAGES = new Set([
  "capacitor://localhost",
  "https://localhost",
]);

/** 页面是不是原生 App 打在包里的那一份：来源对得上，而且 Capacitor 说自己是原生。 */
export function isNativeAppPage(
  pageUrl: string = globalThis.location?.href ?? "",
): boolean {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  if (!NATIVE_APP_PAGES.has(`${url.protocol}//${url.host}`)) return false;
  const capacitor = (
    globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor;
  try {
    return capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/** 规范成 `https://host[:port]`；不是干净的 HTTPS 来源一律 `null`。 */
export function gatewayOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    return null;
  return url.origin;
}

/** 连接页记下的 Gateway 来源；没有或认不出是 `null`。 */
export function savedRuntimeOrigin(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(SAVED_ORIGIN_KEY);
    return value ? gatewayOrigin(value) : null;
  } catch {
    return null;
  }
}

export function saveRuntimeOrigin(origin: string): void {
  const clean = gatewayOrigin(origin);
  if (clean === null) throw new Error("not an https origin");
  globalThis.localStorage?.setItem(SAVED_ORIGIN_KEY, clean);
}

export function forgetRuntimeOrigin(): void {
  try {
    globalThis.localStorage?.removeItem(SAVED_ORIGIN_KEY);
  } catch {
    /* 存储不可用时本来也没有记下什么。 */
  }
}

/** An explicit relative/empty URL opts a web deployment into its own origin. */
export function resolveRuntimeUrl(
  configured: string | undefined,
  pageUrl: string,
): string {
  const shell = shellEndpoints();
  // 显式配置永远优先：桌面开发模式靠它连外部 Runtime。
  if (configured === undefined) {
    // 原生 App：只认连接页记下的来源。Android 的页面来源 `https://localhost`
    // 长得像服务器壳，但那是包里的文件，不是 core。
    if (isNativeAppPage(pageUrl)) return savedRuntimeOrigin() ?? LOCAL_RUNTIME;
    return (
      // 壳先问：它拉起的 Runtime 端口是内核分配的，页面地址推不出来，而且开发
      // 模式下页面来源是 Vite，回环默认端口多半是别人的 Runtime。
      shell?.httpBase ?? serverShellOrigin(pageUrl) ?? LOCAL_RUNTIME
    );
  }
  // Vite 开发服务器发现 Runtime 后会把这个值定义成 `""`，让浏览器标签页走同源
  // 代理。壳里的页面不该走那条弯路：壳知道内核分配的端口，打包版也从不经代理，
  // 而且代理在连接关闭时会往主进程日志里刷 EPIPE。非空的显式地址仍然最优先。
  if (configured.trim() === "" && shell) return shell.httpBase;
  const url = new URL(configured.trim() || "/", pageUrl);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "VITE_RUNTIME_URL must be an HTTP(S) base URL without credentials, a query or a fragment",
    );
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * 服务器壳托管这份前端时的 core 基址（typescript-core R6）。
 *
 * `apps/server` 在一个 HTTPS 来源上同时托管页面与 `/api/**`，此时同源就是唯一
 * 能用的地址，不需要 `VITE_RUNTIME_URL`。
 *
 * 判据是页面协议：开发服务器与 `armadra.sh run web` 都是回环 HTTP，服务器壳
 * 只在明确配置的 HTTPS 来源上提供页面；而 HTTPS 页面本来也无法访问
 * `http://127.0.0.1`（混合内容会被浏览器拦掉），所以这里不存在更好的猜测。
 */
export function serverShellOrigin(pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return url.origin;
}

/**
 * 这份页面是不是由服务器壳托管。
 *
 * 只有这种模式下页面拿的是 Cookie 会话，写请求才要带双提交的 CSRF 头；桌面壳
 * 走的是票据换 Bearer 的原生传输，凭据只在页面内存里。
 */
export function isServerShellServed(
  configured: string | undefined,
  pageUrl: string,
): boolean {
  const origin = serverShellOrigin(pageUrl);
  return origin !== null && resolveRuntimeUrl(configured, pageUrl) === origin;
}

/**
 * 这个基址是不是桌面壳给的。
 *
 * 壳给的是真实的回环 HTTP 端点，所以判据就是「和壳报的 `httpBase` 相同」。
 */
export function isShellTransport(base: string): boolean {
  const shell = shellEndpoints();
  return shell !== null && trimBase(base) === shell.httpBase;
}

/** Keep a reverse-proxy prefix for terminal and workspace event sockets. */
export function runtimeSocketUrl(base: string, path: string): string {
  const url = new URL(
    `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`,
  );
  url.protocol =
    url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  return url.href;
}

/**
 * 终端与事件 WebSocket 的基址。
 *
 * 壳给的 `httpBase` 是真实的回环 HTTP 端点，WebSocket 基址由壳一并给出，所以
 * 这里没有网络往返——不再有自定义协议，也就不再有回环转发端口要问。
 * 浏览器 / 开发模式下 Runtime 的 HTTP 端口就是它的 WebSocket 端口，`base`
 * 本身即是答案；壳里配了外部 Runtime 时也走这一条。
 */
export function resolveSocketBase(base: string): string {
  return isShellTransport(base) ? shellEndpoints()!.wsBase : base;
}
