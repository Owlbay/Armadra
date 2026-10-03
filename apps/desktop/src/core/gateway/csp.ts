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
  options: { devServer?: boolean } = {},
): string {
  return [
    "default-src 'self'",
    ...(options.devServer ? ["script-src 'self' 'unsafe-inline'"] : []),
    `connect-src ${CONNECT.join(" ")}`,
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
