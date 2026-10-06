/**
 * 页面的 Content-Security-Policy：桌面壳与 Gateway（服务器壳、桌面对外服务）
 * 共用的那一份。
 *
 * The Rust shell got one from its packaged configuration and Electron gives the
 * page none at all, so it has to be stated here or the new shell would be a
 * quiet loosening of a rule nobody removed on purpose.
 *
 * What changed with the loopback HTTP origin: `connect-src` no longer names a
 * custom scheme (`armadra:`), because there is no longer a protocol handler to
 * forward through — the page talks to the Runtime and the Host as ordinary
 * HTTP services. Their ports are kernel-assigned, so the grant is by host
 * rather than by number, which is exactly as tight as a loopback port can be
 * described in CSP: `http://127.0.0.1:*` reaches nothing that is not already
 * on this machine and reachable by any local process anyway.
 *
 * `frame-src http: https:` stays for now: browser nodes still render the old
 * compatibility iframe until W3 replaces them with `<webview>` guests.
 */

/** Sources the page may open HTTP and WebSocket connections to. */
const CONNECT = [
  "'self'",
  "http://127.0.0.1:*",
  "http://localhost:*",
  "ws://127.0.0.1:*",
  "ws://localhost:*",
];

/** 追加的连接授权只收这一种形状：协议 + 主机 + 可选端口，无通配、无路径。 */
const CONNECT_GRANT =
  /^(https|wss):\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$/i;

/**
 * One policy, with a single development-only grant.
 *
 * Vite's dev server injects the React refresh preamble as an INLINE `<script>`
 * in `index.html`; under `default-src 'self'` that script is refused, the
 * preamble never runs, and every component module then throws
 * "@vitejs/plugin-react can't detect preamble" — the window opens with an
 * empty `#root` and no overlay. So `devServer: true` (the `electron-vite dev`
 * flow, never a build served from disk) adds `'unsafe-inline'` to scripts
 * only. The shipped build has no inline script and keeps the strict policy;
 * the static server never asks for the grant.
 */
export function contentSecurityPolicy(
  options: {
    devServer?: boolean;
    /**
     * 桌面壳按源表追加的来源（`https://host[:port]` / `wss://host[:port]`，
     * `shell-core/csp.ts` 的 `sourceConnectGrants`）。不是这个形状的一律丢掉：
     * 一个带空格或分号的值就能往策略里塞一条新指令。
     */
    connect?: readonly string[];
  } = {},
): string {
  const extra = (options.connect ?? []).filter(
    (grant) => CONNECT_GRANT.test(grant) && !CONNECT.includes(grant),
  );
  return [
    "default-src 'self'",
    ...(options.devServer ? ["script-src 'self' 'unsafe-inline'"] : []),
    `connect-src ${[...CONNECT, ...new Set(extra)].join(" ")}`,
    // Tailwind and the shadcn components set inline custom properties.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    // 编辑器节点的音视频预览：字节经 `file-download` 取回，页面自己以声明的
    // MIME 类型包成 blob 再交给 <video> / <audio>。
    "media-src 'self' blob:",
    // Browser nodes (W3 replaces this with <webview>). `blob:` is the editor's
    // PDF preview: a blob the page itself built with type `application/pdf`,
    // which the engine hands to its PDF viewer rather than parsing as HTML.
    "frame-src http: https: blob:",
    // Nothing on this page is ever framed by anything.
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * 页面的 Content-Security-Policy，与桌面壳**同一个来源**。
 *
 * 策略本体是上面的 {@link contentSecurityPolicy}（桌面壳的 `shell-core/csp.ts`
 * 原样再导出它，core 不能反过来 import 壳）。Gateway 只做一件事——把其中的
 * 回环授权摘掉。
 *
 * 为什么必须摘：桌面壳的页面和 core 都在回环上，`connect-src` 里那几条
 * `http://127.0.0.1:*` 就是页面访问 core 的授权。服务器壳的页面和 core 在
 * **同一个 HTTPS 来源**上，`'self'` 已经覆盖了 `https` 与 `wss` 两种连接；继续
 * 带着回环授权，等于允许这张页面去连**观看者那台设备**上的任意本地端口，而那
 * 是一台服务器壳从来不该代表页面碰的机器。
 *
 * 其余每一条（`default-src`、`style-src`、`frame-ancestors 'none'`、
 * `object-src 'none'`、`base-uri`、`form-action`）逐字继承，所以桌面壳那边收紧
 * 了什么，这边自动跟着收紧——单测盯的就是这条继承关系。
 */

/** 摘掉的授权：回环的 http / ws 字面量。 */
const LOOPBACK = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\*)?$/;

export function serverContentSecurityPolicy(): string {
  return contentSecurityPolicy()
    .split("; ")
    .map((directive) => {
      const tokens = directive.split(" ");
      const kept = tokens.filter(
        (token, index) => index === 0 || !LOOPBACK.test(token),
      );
      return kept.join(" ");
    })
    .join("; ");
}

/**
 * 原生 App（Capacitor）里那张页面的 CSP：页面打在包里，来源是
 * `capacitor://localhost` / `https://localhost`，要跨源连**用户配的那台**
 * Gateway——地址在配对之前不知道，所以连接与图片按协议放行 `https:` / `wss:`
 * （证书由原生层钉扎，架构 §7）。回环授权同样摘掉：手机上的回环端口不是
 * Armadra。其余每一条逐字继承桌面壳那一份。`frame-ancestors` 在 `<meta>` 里
 * 不生效，留着无害。原生壳（`apps/mobile`）把它写进包里页面的 `<meta>`。
 */
const NATIVE_APP_GRANTS: Readonly<Record<string, readonly string[]>> = {
  "connect-src": ["https:", "wss:"],
  "img-src": ["https:"],
  "media-src": ["https:"],
};

export function nativeAppContentSecurityPolicy(): string {
  return serverContentSecurityPolicy()
    .split("; ")
    .map((directive) => {
      const name = directive.split(" ")[0] as string;
      const extra = NATIVE_APP_GRANTS[name];
      return extra === undefined
        ? directive
        : `${directive} ${extra.join(" ")}`;
    })
    .join("; ");
}

/** Gateway 只在 TLS 上服务：一年的 HSTS 是这类部署的下限。 */
export const TRANSPORT_SECURITY = "max-age=31536000";

/**
 * Gateway 上每一个响应都带的头（静态产物另有 {@link serverContentSecurityPolicy}，
 * 在 `web-root.ts`）。
 */
export const GATEWAY_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": TRANSPORT_SECURITY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/**
 * `/api/**` 与 `/health` 的答案再多三条：
 *
 *   * `content-security-policy: … sandbox`：接口答的从来不是要渲染的页面，但
 *     有几条把用户数据原样回出去（画布资产里的 SVG）。同源导航到那样一个地址
 *     时，`sandbox` 把它放进不透明来源、`default-src 'none'` 不让脚本跑——
 *     否则一张带脚本的 SVG 就能借看它的人的 Cookie 会话调接口；
 *   * `cache-control: no-store` 是缺省：会话、CSRF、原生密钥都在答案里。答案
 *     自己写了缓存策略（资产按内容寻址，永久缓存）时以它为准；
 *   * `x-frame-options: DENY`：给不认 `frame-ancestors` 的老内核。
 */
export const GATEWAY_API_HEADERS: Readonly<Record<string, string>> = {
  ...GATEWAY_RESPONSE_HEADERS,
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};
