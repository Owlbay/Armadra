import {
  session,
  type Certificate,
  type OnHeadersReceivedListenerDetails,
} from "electron";

import {
  EMPTY_TRUST,
  type RemoteTrust,
  pinnedChainTrusted,
  addsOrigins,
  trustFromSourceTable,
} from "../shell-core/remote-trust";
import { sourceConnectGrants } from "../shell-core/csp";
import {
  rewriteRelayRequest,
  rewriteRelayResponse,
} from "../shell-core/relay-origin";

/**
 * 壳对远程服务与挂载的源的信任（`shell-core/remote-trust.ts`）：从 core 的源表
 * 读来，喂给两处——页面 CSP 的 `connect-src`（`window.ts`）与主会话的证书校验。
 *
 * 读表的时机只有两个：起窗口之前一次，和页面说「源表变了」之后（IPC
 * `app:sources-changed`，不带数据——壳问 core，不信页面）。零配置时表里只有本机
 * 一行，什么也不放行、什么也不钉。
 */

let trust: RemoteTrust = EMPTY_TRUST;
/** 当前页面文档载入时用的那份：CSP 只在载入时生效，变了就得重载。 */
let loaded: RemoteTrust = EMPTY_TRUST;

export type CoreFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** CSP 追加的连接授权；`window.ts` 在每次载入页面文档时取。 */
export function connectGrants(): string[] {
  loaded = trust;
  return sourceConnectGrants(trust.origins);
}

/**
 * 重读源表。答 `reload`：页面现在这份 CSP 是否已经过时（新加的来源要重载
 * 页面才放行）。读不到（core 没起来、会话失败）保持原样、不要求重载。
 */
export async function refreshRemoteTrust(
  fetchCore: CoreFetch,
  timeoutMs = 3_000,
): Promise<{ reload: boolean }> {
  try {
    const response = await fetchCore("/api/sources", {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { reload: false };
    trust = trustFromSourceTable(await response.json());
  } catch {
    return { reload: false };
  }
  return { reload: addsOrigins(trust, loaded) };
}

function pemChain(certificate: Certificate): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let next: Certificate | undefined = certificate;
  while (next !== undefined && next.data !== "" && !seen.has(next.data)) {
    seen.add(next.data);
    chain.push(next.data);
    next = next.issuerCert;
  }
  return chain;
}

/**
 * 主会话的证书校验：系统信任的照旧（`-3` 交回 Chromium 的判断）；系统不信任、
 * 但链按源表的指纹钉扎可信的放行（`0`）。浏览器节点用自己的 partition，不受
 * 这里影响。
 */
export function installCertificatePinning(): void {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.errorCode === 0) {
      callback(-3);
      return;
    }
    const trusted = pinnedChainTrusted(
      request.hostname,
      pemChain(request.certificate),
      trust.pins,
    );
    callback(trusted ? 0 : -3);
  });
}

/**
 * 经中继访问挂载的源（`shell-core/relay-origin.ts`）：发往源表里中继主机的请求
 * （含预检与 WebSocket 升级）`Origin` 换成桌面的原生来源，记下页面来源；名单
 * 每次现读，源表变了（`refreshRemoteTrust`）就跟着变。浏览器节点用自己的
 * partition，不受影响。
 */
const pageOrigins = new Map<number, string>();

export function installRelayOriginRewrite(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["https://*/*", "wss://*/*"] },
    (details, callback) => {
      const rewritten = rewriteRelayRequest(
        details.url,
        details.requestHeaders,
        trust.relayOrigins,
      );
      if (rewritten === null) {
        callback({});
        return;
      }
      pageOrigins.set(details.id, rewritten.pageOrigin);
      callback({ requestHeaders: rewritten.headers });
    },
  );
}

/**
 * 改写过 `Origin` 的那些请求的响应：CORS 的允许来源回显页面的真实来源。别的
 * 响应答 `undefined`（交给 `window.ts` 照旧处理）。
 */
export function relayResponseHeaders(
  details: Pick<OnHeadersReceivedListenerDetails, "id" | "responseHeaders">,
): Record<string, string[]> | undefined {
  const pageOrigin = pageOrigins.get(details.id);
  if (pageOrigin === undefined) return undefined;
  pageOrigins.delete(details.id);
  const next = rewriteRelayResponse(details.responseHeaders ?? {}, pageOrigin);
  return next === null
    ? undefined
    : (Object.fromEntries(
        Object.entries(next).map(([name, value]) => [name, [value].flat()]),
      ) as Record<string, string[]>);
}
