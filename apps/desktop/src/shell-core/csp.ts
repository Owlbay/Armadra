/**
 * The page's Content-Security-Policy. The policy itself lives in the core
 * (`core/gateway/csp.ts`) because the gateway serves the same page and the core
 * may not import a shell; the desktop shell re-exports it unchanged.
 */
export { contentSecurityPolicy } from "../core/gateway/csp";

/** Whether a URL is one the CSP above is meant to cover. */
export function isPageUrl(url: string, pageOrigin: string): boolean {
  return url === pageOrigin || url.startsWith(`${pageOrigin}/`);
}

/**
 * 源表里的来源 → `connect-src` 追加的授权（客户端包 §3、平台设计 §5.4）。
 *
 * 只放行这台 core 记住的远程服务与挂载的源：每个 `https://host[:port]` 给一条
 * `https:` 与一条 `wss:`（中继与别的 core 的流都走 WebSocket）。回环的明文来源
 * 已在基础策略里，不重复；`http:` 的非回环地址 core 本来就不收，这里也不收。
 * 结果按字典序、去重：同一张源表永远是同一条策略，比较「变没变」只比字符串。
 */
export function sourceConnectGrants(origins: readonly string[]): string[] {
  const grants = new Set<string>();
  for (const value of origins) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    grants.add(`https://${url.host}`);
    grants.add(`wss://${url.host}`);
  }
  return [...grants].sort();
}
