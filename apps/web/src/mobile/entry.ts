import {
  currentAccessToken,
  fetchWsTicket,
  hasPairingFragment,
  refreshIdentity,
  restoreNativeCredentials,
  resumeIdentity,
} from "../api/identity";
import { RUNTIME_URL, RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import { savedRuntimeOrigin } from "../api/runtime-url";
import { isCompactLayout } from "../platform/layout";
import { installNativeTransport, isNativeApp } from "./native-bridge";

/** 入口画什么：画布本体，或者连接页。 */
export type Entry =
  | { readonly kind: "app" }
  | {
      readonly kind: "connect";
      readonly mode: "native";
      /** 上次记下的来源（会话失效时回到这里）。 */
      readonly origin?: string;
      /** 原生收到的 `armadra://pair` 深链：连接页输入框的初值，人点「连接」才配。 */
      readonly link?: string;
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
 * 原生 App 收到 `armadra://pair?…` 深链时把它写进 `#link=` 再重载（入口在挂载前
 * 就定了）。取走即从地址栏抹掉；认不出是 `null`。
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
    return link.startsWith("armadra://pair?") ? link : null;
  } catch {
    return null;
  }
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

/**
 * 挂载之前决定入口（`main.tsx`）。桌面窗口与普通网页一个分支都不进，直接是
 * 画布——不发请求、不等任何东西。
 *
 *  - **原生 App**：带着配对深链（`#link=`）→ 连接页，链接预填；否则先装 Bearer
 *    传输，没有记下的 Gateway、或钥匙串里没有它的会话 → 连接页。
 *  - **手机浏览器**：经 Gateway 打开、窄屏、地址栏带着 `#pair=` → 连接页。票
 *    留在地址栏里直到点「连接」：CA 引导的最后一步是「回到这一页刷新」，刷新
 *    之后还得配得上。没带票又没有会话 → 连接页的配对码（契约 §24）。宽屏照旧
 *    由设置页「后台服务」那一页配对。
 */
export async function prepareEntry(): Promise<Entry> {
  if (isNativeApp()) {
    const origin = savedRuntimeOrigin();
    const link = takeLinkFragment();
    if (link !== null)
      return {
        kind: "connect",
        mode: "native",
        ...(origin === null ? {} : { origin }),
        link,
      };
    if (origin === null) return { kind: "connect", mode: "native" };
    installNativeTransport({
      origin,
      authorization: currentAccessToken,
      wsTicket: fetchWsTicket,
      refresh: refreshOnce,
    });
    return (await restoreNativeCredentials())
      ? { kind: "app" }
      : { kind: "connect", mode: "native", origin };
  }
  if (!RUNTIME_VIA_SERVER_SHELL || !isCompactLayout()) return { kind: "app" };
  if (hasPairingFragment()) {
    return { kind: "connect", mode: "web", origin: RUNTIME_URL, via: "ticket" };
  }
  // 手输地址打开的：有会话照常进画布；没有就先给配对码，连接页上留一个
  // 「账号登录」给有账号的人。问不到（离线、core 旧）按有会话处理，不挡路。
  const session = await resumeIdentity().catch(() => undefined);
  return session === null
    ? { kind: "connect", mode: "web", origin: RUNTIME_URL, via: "code" }
    : { kind: "app" };
}
