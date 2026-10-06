import {
  currentAccessToken,
  fetchWsTicket,
  hasPairingFragment,
  refreshIdentity,
  restoreNativeCredentials,
  resumeIdentity,
  setNativeConnection,
} from "../api/identity";
import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import { savedRuntimeOrigin, setNativeRuntimeBase } from "../api/runtime-url";
import { installLocalTransport, localSource } from "../api/source";
import { isDesktop } from "../platform";
import { isCompactLayout } from "../platform/layout";
import { isNativeShell } from "../host/native-session";
import {
  detectRelayHost,
  startHostedRelay,
  underRelayAppPath,
} from "../sources/hosted";
import { mountSiblingSources } from "../sources/mounts";
import { enterRoute, ticketWithRefresh } from "../sources/route-entry";
import type { SourceDescriptor } from "../sources/types";
import type { ConnectFailure } from "./ConnectScreen";
import { activeConnection, loadConnections } from "./connections";
import { mobileCredentialProvider } from "./credentials";
import { isNativeApp } from "./native-bridge";
import {
  completeNativeOAuth,
  isNativeOAuthLink,
  oauthFragment,
} from "./native-oauth";

/** 入口画什么：画布本体、连接页、中继托管页面的登录、分享链接的落地页，或者原生 OAuth 登录的第二步。 */
export type Entry =
  | { readonly kind: "app" }
  | {
      /** 个人中转托管的这张页面（`/app/`）：中继账号登录、挑主机（`sources/hosted.ts`）。 */
      readonly kind: "relay";
      readonly issuer: string;
    }
  | {
      /**
       * 远程服务托管的页面打开在 `/j/<linkId>`（分享链接，客户端包 §6.1）：落地页，
       * 加入后就地进画布（会话只在内存，不能重载）。
       */
      readonly kind: "join";
      readonly linkId: string;
    }
  | {
      /**
       * App 里没有会话时经原生 OAuth 登录、走到了第二因素（契约 §18.5 的
       * `mfa`）：整页第二步，带着中间票接 `mfa/verify`，传输已装好。
       */
      readonly kind: "mfa";
      readonly origin: string;
      readonly challengeId: string;
    }
  | {
      readonly kind: "connect";
      readonly mode: "native";
      /** 上次记下的来源（会话失效时回到这里）。 */
      readonly origin?: string;
      /**
       * 原生收到的 `armadra://pair` 深链：连接页输入框的初值，人点「连接」才配；
       * `armadra://join` 分享深链：`join` 为真，连接页收到就直接挂载。
       */
      readonly link?: string;
      readonly join?: boolean;
      /** 连接表里的连接（没有凭据）；选中的那个连不上时带着失败原因回到这里。 */
      readonly connections?: readonly SourceDescriptor[];
      readonly activeId?: string;
      readonly failure?: ConnectFailure;
      /** 从画布里点「连接」进来管理连接，不是启动时没得选。 */
      readonly manage?: boolean;
    }
  | {
      readonly kind: "connect";
      readonly mode: "web";
      readonly origin: string;
      /**
       * `ticket`：扫码打开、地址栏带着 `#pair=`，只差「连接」；`code`：手输地址
       * 打开、还没有会话，先是配对码（契约 §24）。
       */
      readonly via: "ticket" | "code";
    };

const LINK_FRAGMENT = /^#link=(.+)$/;

/**
 * 原生 App 收到 `armadra://pair?…`（配对）或 `armadra://oauth?…`（原生 OAuth 的
 * 回调，R-56）深链时把它写进 `#link=` 再重载（入口在挂载前就定了）。取走即从
 * 地址栏抹掉；认不出是 `null`。
 */
export function takeLinkFragment(): string | null {
  const location = globalThis.location;
  const found = LINK_FRAGMENT.exec(location?.hash ?? "");
  if (!found) return null;
  try {
    globalThis.history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}`,
    );
  } catch {
    /* 抹不掉不影响连接。 */
  }
  try {
    const link = decodeURIComponent(found[1]!);
    return link.startsWith("armadra://pair?") ||
      link.startsWith("armadra://join?") ||
      isNativeOAuthLink(link)
      ? link
      : null;
  } catch {
    return null;
  }
}

const JOIN_PATH = /^\/j\/([A-Za-z0-9_-]{8,128})\/?$/;

/**
 * 这一页是不是远程服务托管的分享链接落地页（`<issuer>/j/<linkId>`）：只在普通
 * 浏览器里（桌面窗口与原生 App 的页面路径不会是它）。答链接标识或 `null`。
 */
export function joinPageLinkId(
  location: Pick<Location, "pathname"> | undefined = globalThis.location,
): string | null {
  if (isNativeApp() || isDesktop()) return null;
  return JOIN_PATH.exec(location?.pathname ?? "")?.[1] ?? null;
}

let refreshing: Promise<boolean> | null = null;

/** 几条并发的 401 只轮转一次：刷新密钥是一次性的，第二次轮转一定失败。 */
function refreshOnce(): Promise<boolean> {
  refreshing ??= refreshIdentity()
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export { ticketWithRefresh };

/**
 * 原生 App 的本机源就是记下的那台 Gateway：凭据装在本机源上（`api/source.ts`），
 * 不改写全局的 `fetch` / `WebSocket`——发往 core 的每个点都经一个源。
 */
function installTransport(origin: string): void {
  installLocalTransport({
    origin,
    authorization: currentAccessToken,
    wsTicket: () => ticketWithRefresh(fetchWsTicket, refreshOnce),
    refresh: refreshOnce,
  });
}

/**
 * 原生 OAuth 的深链回来了（R-56）：装好传输、读回钥匙串里的会话，再收尾。
 * 结果写成 `#oauth=…` 片段交给「安全」那一页（`use-link-fragments` 打开它）。
 * 收尾之后有会话（原来就有，或者这次登录拿到的）进画布；没有会话而走到了
 * 第二因素，就在这里接着做第二步（中间票不进地址栏）；其余回连接页。
 */
async function finishNativeOAuth(
  origin: string | null,
  link: string,
): Promise<Entry> {
  if (origin === null) return { kind: "connect", mode: "native" };
  installTransport(origin);
  const restored = await restoreNativeCredentials();
  const outcome = await completeNativeOAuth(link);
  // 没有会话就没有画布、也没有「安全」页去接 `#oauth=mfa`：第二步在入口里做。
  if (!restored && outcome.result === "mfa" && outcome.challengeId !== "")
    return { kind: "mfa", origin, challengeId: outcome.challengeId };
  try {
    const location = globalThis.location;
    globalThis.history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}${oauthFragment(outcome)}`,
    );
  } catch {
    /* 写不进地址栏：结果看不到，但登录本身不受影响。 */
  }
  const signedIn =
    outcome.result === "signedIn" || outcome.result === "signedUp";
  return restored || signedIn
    ? { kind: "app" }
    : { kind: "connect", mode: "native", origin };
}

/** 选路或取访问失败 → 连接页的原因。 */
function routeFailure(error: unknown): ConnectFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "source_offline") return "offline";
  if (code === "source_unauthorized") return "expired";
  return "unreachable";
}

/**
 * 进一个连接：选路（直连优先，D27）→ 取访问（钥匙串里这个源的会话，必要时
 * 轮换或经远程服务重取断言）→ 把这一路的地址与凭据装给本机源
 * （`sources/route-entry.ts`，与中继托管的页面同一份）。本机源就是选中的那个
 * 连接；表里其余的连接作为远程源同时挂进页面源表（`sources/mounts.ts`），侧栏
 * 按源分组，点一行即切当前源。
 */
async function enterConnection(descriptor: SourceDescriptor): Promise<Entry> {
  const connections = loadConnections();
  try {
    await enterRoute({
      descriptor,
      provider: mobileCredentialProvider(),
      useRoute(route) {
        setNativeConnection(
          descriptor.sourceId,
          route.via === "relayed" ? "relayed" : "direct",
        );
        setNativeRuntimeBase(route.access.httpBase);
      },
      restore: restoreNativeCredentials,
    });
  } catch (error) {
    return {
      kind: "connect",
      mode: "native",
      connections,
      activeId: descriptor.sourceId,
      failure: routeFailure(error),
      ...(descriptor.baseUrl === "" ? {} : { origin: descriptor.baseUrl }),
    };
  }
  if (await restoreNativeCredentials()) {
    // 其余的连接一起挂上（各自在后台连，连不上只是侧栏里那一组灰着）；只有
    // 这一个连接时什么也不做，与单源时一样。
    const provider = mobileCredentialProvider();
    mountSiblingSources({
      primary: descriptor,
      siblings: connections,
      provider,
      cloudAuth: provider.cloudAuth,
    });
    return { kind: "app" };
  }
  return {
    kind: "connect",
    mode: "native",
    connections,
    activeId: descriptor.sourceId,
    failure: "expired",
    ...(descriptor.baseUrl === "" ? {} : { origin: descriptor.baseUrl }),
  };
}

/**
 * 挂载之前决定入口（`main.tsx`）。桌面窗口与普通网页一个分支都不进，直接是
 * 画布——不发请求、不等任何东西。
 *
 *  - **分享链接落地页**：远程服务托管的页面打开在 `/j/<linkId>` → 落地页。
 *
 *  - **原生 App**：带着配对深链（`#link=`）→ 连接页，链接预填；否则先装 Bearer
 *    传输，没有记下的 Gateway、或钥匙串里没有它的会话 → 连接页。
 *  - **手机浏览器**：经 Gateway 打开、窄屏、地址栏带着 `#pair=` → 连接页。票
 *    留在地址栏里直到点「连接」：CA 引导的最后一步是「回到这一页刷新」，刷新
 *    之后还得配得上。没带票又没有会话 → 连接页的配对码（契约 §24）。宽屏照旧
 *    由设置页「后台服务」那一页配对。
 */
export async function prepareEntry(): Promise<Entry> {
  const joinLinkId = joinPageLinkId();
  if (joinLinkId !== null) return { kind: "join", linkId: joinLinkId };
  if (isNativeApp()) {
    const origin = savedRuntimeOrigin();
    const link = takeLinkFragment();
    if (link !== null && isNativeOAuthLink(link))
      return finishNativeOAuth(origin, link);
    const connections = loadConnections();
    const active = activeConnection();
    const known = {
      ...(connections.length === 0 ? {} : { connections }),
      ...(active === null ? {} : { activeId: active.sourceId }),
    };
    if (link !== null)
      return {
        kind: "connect",
        mode: "native",
        ...(origin === null ? {} : { origin }),
        ...known,
        link,
        ...(link.startsWith("armadra://join?") ? { join: true } : {}),
      };
    // 从画布里点「连接」进来：回连接页管理（切换、添加、移除）。
    if (globalThis.location?.hash === "#connections") {
      history.replaceState(null, "", location.pathname + location.search);
      return { kind: "connect", mode: "native", manage: true, ...known };
    }
    if (active !== null) return enterConnection(active);
    if (origin === null) return { kind: "connect", mode: "native" };
    installTransport(origin);
    return (await restoreNativeCredentials())
      ? { kind: "app" }
      : { kind: "connect", mode: "native", origin };
  }
  // 个人中转托管的页面：背后没有本机 core，先登录中继、挑一台主机。只在
  // `/app/` 路径下才问一次同源的平台信息，别的页面一个请求也不多发。
  if (
    !isNativeShell() &&
    underRelayAppPath(globalThis.location?.pathname ?? "")
  ) {
    const host = await detectRelayHost();
    if (host !== null) {
      startHostedRelay(host);
      return { kind: "relay", issuer: host.issuer };
    }
  }
  if (!RUNTIME_VIA_SERVER_SHELL || !isCompactLayout()) return { kind: "app" };
  if (hasPairingFragment()) {
    return {
      kind: "connect",
      mode: "web",
      origin: localSource.httpBase,
      via: "ticket",
    };
  }
  // 手输地址打开的：有会话照常进画布；没有就先给配对码，连接页上留一个
  // 「账号登录」给有账号的人。问不到（离线、core 旧）按有会话处理，不挡路。
  const session = await resumeIdentity().catch(() => undefined);
  return session === null
    ? {
        kind: "connect",
        mode: "web",
        origin: localSource.httpBase,
        via: "code",
      }
    : { kind: "app" };
}
