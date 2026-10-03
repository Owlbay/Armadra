import {
  currentAccessToken,
  fetchWsTicket,
  hasPairingFragment,
  refreshIdentity,
  restoreNativeCredentials,
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
    }
  | {
      readonly kind: "connect";
      readonly mode: "web";
      readonly origin: string;
    };

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
 *  - **原生 App**：先装 Bearer 传输；没有记下的 Gateway、或钥匙串里没有它的
 *    会话 → 连接页。
 *  - **手机浏览器**：经 Gateway 打开、窄屏、地址栏带着 `#pair=` → 连接页。票
 *    留在地址栏里直到点「连接」：CA 引导的最后一步是「回到这一页刷新」，刷新
 *    之后还得配得上。宽屏照旧由设置页「后台服务」那一页配对。
 */
export async function prepareEntry(): Promise<Entry> {
  if (isNativeApp()) {
    const origin = savedRuntimeOrigin();
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
  if (RUNTIME_VIA_SERVER_SHELL && isCompactLayout() && hasPairingFragment()) {
    return {
      kind: "connect",
      mode: "web",
      origin: RUNTIME_URL,
    };
  }
  return { kind: "app" };
}
