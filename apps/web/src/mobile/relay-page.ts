import {
  adoptRelayPageSession,
  currentAccessToken,
  fetchWsTicket,
  refreshIdentity,
} from "../api/identity";
import { resetLocalRuntime } from "../api/local-runtime";
import { setRelayPageBase } from "../api/runtime-url";
import { installLocalTransport } from "../api/source";
import { RELAY_PROTOCOL, RELAY_TOKEN_HEADER } from "../sources/transport";
import {
  type CloudAccept,
  type CloudDevice,
  type CloudOptions,
  type CoreCloudSession,
  browserDevice,
  cloudAssertion,
  cloudRefresh,
} from "./cloud-client";
import { ticketWithRefresh } from "./entry";

/** 中继令牌没说寿命时按这么久算（个人中转是 1 小时）。 */
const RELAY_TOKEN_FALLBACK_MS = 50 * 60_000;
/** 令牌离到期不到这么久就先换。 */
const RENEW_LEAD_MS = 60_000;

export interface RelayPageJoin {
  readonly issuer: string;
  readonly accepted: CloudAccept;
  readonly core: CoreCloudSession;
}

export interface RelayPageDeps {
  readonly now?: () => number;
  readonly cloud?: CloudOptions;
  readonly device?: CloudDevice;
}

/**
 * 远程服务托管的页面（`<issuer>/j/<linkId>`，客户端包 §6.1）加入成功之后：
 * 把本机源指到经中继的那台 core（`relayBaseUrl`），会话与中继令牌只在内存。
 *
 * - 访问令牌：快到期或被拒（401）时经中继 `session/refresh` 轮转（身份面）。
 * - 中继令牌（1 小时）：快到期时用访客的远程服务会话换新——`auth.refresh`
 *   旋转访客刷新令牌，再 `sources.assertion` 取一枚新的中继令牌。
 * - 流：先换票，子协议另带 `armadra-relay.<令牌>`。
 *
 * 页面其余部分不知道自己在经中继——与原生 App 选中一条经中继的连接是同一种
 * 装法（`mobile/entry.ts`）。刷新标签页就丢了会话（D15），从链接重新加入。
 */
export function enterRelayPage(
  join: RelayPageJoin,
  deps: RelayPageDeps = {},
): void {
  const now = deps.now ?? Date.now;
  const device = deps.device ?? browserDevice();
  const { accepted, issuer } = join;
  setRelayPageBase(accepted.relayBaseUrl);
  resetLocalRuntime();
  adoptRelayPageSession({
    accessToken: join.core.native.accessToken,
    refreshToken: join.core.native.refreshToken,
    expiresAtMs: join.core.expiresAtUnixMs,
  });

  let relayToken = accepted.relayToken;
  let relayExpiresAtMs =
    accepted.relayTokenExpiresAtMs > 0
      ? accepted.relayTokenExpiresAtMs
      : now() + RELAY_TOKEN_FALLBACK_MS;
  let guestRefresh = accepted.guestSession.refreshToken ?? "";

  let renewingRelay: Promise<void> | null = null;
  const renewRelay = (): Promise<void> => {
    renewingRelay ??= (async () => {
      if (guestRefresh === "") return;
      const session = await cloudRefresh(issuer, guestRefresh, deps.cloud);
      guestRefresh = session.refreshToken ?? guestRefresh;
      const next = await cloudAssertion(
        issuer,
        session.accessToken,
        accepted.sourceId,
        device,
        deps.cloud,
      );
      relayToken = next.relayToken;
      relayExpiresAtMs =
        next.relayTokenExpiresAtMs > 0
          ? next.relayTokenExpiresAtMs
          : now() + RELAY_TOKEN_FALLBACK_MS;
    })()
      .catch(() => undefined)
      .finally(() => {
        renewingRelay = null;
      });
    return renewingRelay;
  };

  let refreshing: Promise<boolean> | null = null;
  /** 几条并发的 401 只轮转一次：刷新令牌是一次性的。 */
  const refresh = (): Promise<boolean> => {
    refreshing ??= refreshIdentity()
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  installLocalTransport({
    origin: new URL(accepted.relayBaseUrl).origin,
    authorization: currentAccessToken,
    prepare: async () => {
      if (relayExpiresAtMs - now() < RENEW_LEAD_MS) await renewRelay();
    },
    wsTicket: async () => {
      if (relayExpiresAtMs - now() < RENEW_LEAD_MS) await renewRelay();
      return ticketWithRefresh(fetchWsTicket, refresh);
    },
    refresh,
    extraHeaders: () => ({ [RELAY_TOKEN_HEADER]: relayToken }),
    extraProtocols: () => [`${RELAY_PROTOCOL}${relayToken}`],
  });
}
