import {
  IdentityRequestError,
  currentAccessToken,
  fetchWsTicket,
} from "../api/identity";
import { resetLocalRuntime } from "../api/local-runtime";
import { installLocalTransport } from "../api/source";
import { type Route, pickRoute } from "./routing";
import { RELAY_PROTOCOL, RELAY_TOKEN_HEADER } from "./transport";
import type {
  CredentialProvider,
  SourceAccess,
  SourceDescriptor,
} from "./types";

/**
 * 把一个远程源装成页面的本机源（手机与中继托管的页面共用，客户端包 §4、§5）。
 *
 * 选路（直连优先，D27）→ 取访问 → 把这一路的地址与凭据装给本机源：页面其余
 * 部分（身份面、`api/*`、五条流）不知道自己在直连还是经中继。经中继时每个请求
 * 带 `armadra-relay-token`、每条流多带 `armadra-relay.<令牌>`。访问令牌与中继
 * 令牌到期前、回到前台时提前续；续的时候凭据来源可能经远程服务重取断言。
 *
 * 会话（访问 / 刷新令牌）由身份面持有，从保管处读回（`restore`）：手机是钥匙串，
 * 中继托管的页面是内存。
 */

/**
 * 换一张 WS 票；访问密钥过期（401）时轮转一次再换。长连接在访问密钥到期时被
 * core 以 4401 关掉（契约 §17.4），重连要先换票——不刷新就一直换不到。
 */
export async function ticketWithRefresh(
  fetchTicket: () => Promise<string>,
  refresh: () => Promise<boolean>,
): Promise<string> {
  try {
    return await fetchTicket();
  } catch (error) {
    if (
      !(error instanceof IdentityRequestError && error.status === 401) ||
      !(await refresh())
    )
      throw error;
    return fetchTicket();
  }
}

function originOf(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return base;
  }
}

/** 访问令牌（与中继令牌）离到期不到这么久就先换，免得请求在路上过期。 */
export const RENEW_LEAD_MS = 60_000;
export const RENEW_RETRY_MS = 30_000;

export interface EnterRouteOptions {
  readonly descriptor: SourceDescriptor;
  readonly provider: CredentialProvider;
  /** 选好了路、装传输之前：记下这一路（身份面的保管处键、本机源地址）。 */
  readonly useRoute: (route: Route) => void;
  /** 把保管处里这一路的会话读回身份面；读到答 `true`。 */
  readonly restore: () => Promise<boolean>;
  /** 每次续上（或续不上）之后。 */
  readonly onRenewed?: (access: SourceAccess | null) => void;
}

export interface EnteredRoute {
  readonly route: Route;
  /** 立刻续一次（凭据被拒、源重新上线）；续上答 `true`。 */
  renew(): Promise<boolean>;
  /** 卸掉定时器与可见性监听（传输留着，页面换源靠重载）。 */
  dispose(): void;
}

/**
 * 进一个源。选路失败抛（调用方按 `code` 显示原因）；装好之后由 `restore` 判断
 * 有没有会话。
 */
export async function enterRoute(
  options: EnterRouteOptions,
): Promise<EnteredRoute> {
  const { descriptor, provider } = options;
  const route = await pickRoute(descriptor, provider);
  const relayed = route.via === "relayed";
  const via = relayed ? "relayed" : "direct";
  options.useRoute(route);
  resetLocalRuntime();

  let access: SourceAccess = route.access;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const scheduleRenewal = () => {
    clearTimeout(renewal);
    if (disposed || access.expiresAtMs <= 0) return;
    renewal = setTimeout(
      () => void renewActive(),
      Math.max(access.expiresAtMs - Date.now() - RENEW_LEAD_MS, RENEW_RETRY_MS),
    );
  };
  let renewing: Promise<boolean> | null = null;
  /** 几条并发的 401 只续一次：刷新密钥是一次性的。 */
  const renewActive = (): Promise<boolean> => {
    renewing ??= provider
      .refresh(
        descriptor.sourceId,
        via,
        ...(route.origin === undefined ? [] : [route.origin]),
      )
      .then(async (next) => {
        access = next;
        scheduleRenewal();
        const restored = await options.restore();
        options.onRenewed?.(next);
        return restored;
      })
      .catch(() => {
        scheduleRenewal();
        options.onRenewed?.(null);
        return false;
      })
      .finally(() => {
        renewing = null;
      });
    return renewing;
  };
  const stale = () =>
    access.expiresAtMs > 0 &&
    access.expiresAtMs - Date.now() < RENEW_LEAD_MS / 2;
  installLocalTransport({
    origin: originOf(access.httpBase),
    authorization: currentAccessToken,
    prepare: async () => {
      if (stale()) await renewActive();
    },
    wsTicket: () => ticketWithRefresh(fetchWsTicket, renewActive),
    refresh: renewActive,
    ...(relayed
      ? {
          extraHeaders: (): Record<string, string> =>
            access.relayToken === undefined
              ? {}
              : { [RELAY_TOKEN_HEADER]: access.relayToken },
          extraProtocols: () =>
            access.relayToken === undefined
              ? []
              : [`${RELAY_PROTOCOL}${access.relayToken}`],
        }
      : {}),
  });
  scheduleRenewal();
  // 回到前台：后台里定时器可能被挂起，令牌已经过期了。
  const onVisible = () => {
    if (globalThis.document?.visibilityState === "visible" && stale())
      void renewActive();
  };
  globalThis.document?.addEventListener?.("visibilitychange", onVisible);
  return {
    route,
    renew: renewActive,
    dispose() {
      disposed = true;
      clearTimeout(renewal);
      globalThis.document?.removeEventListener?.("visibilitychange", onVisible);
    },
  };
}
