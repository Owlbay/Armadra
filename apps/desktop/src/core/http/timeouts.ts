import type { Server } from "node:http";

/**
 * 监听的超时。空闲 keep-alive 连接要比客户端的连接池活得久：Node 缺省 5 秒就关，
 * WebKit（iPad / iOS 的 WKWebView）复用一条刚被服务端关掉的连接发 POST 时不重试，
 * 直接报加载失败；Chromium 会重试，所以只在 iOS 上偶发。75 秒与常见反向代理一致；
 * 请求头超时略大于它，否则空闲连接上新请求的头可能先被判超时。整条请求（头加体）
 * 的接收上限保持 Node 缺省的 5 分钟，升级后的 WebSocket 不受它管。
 */
export const HTTP_TIMEOUTS = {
  keepAliveTimeoutMs: 75_000,
  headersTimeoutMs: 76_000,
  requestTimeoutMs: 300_000,
} as const;

/** 把 {@link HTTP_TIMEOUTS} 套到一台 `http(s).Server` 上（`https.Server` 继承它）。 */
export function applyHttpTimeouts<T extends Server>(server: T): T {
  server.keepAliveTimeout = HTTP_TIMEOUTS.keepAliveTimeoutMs;
  server.headersTimeout = HTTP_TIMEOUTS.headersTimeoutMs;
  server.requestTimeout = HTTP_TIMEOUTS.requestTimeoutMs;
  return server;
}
