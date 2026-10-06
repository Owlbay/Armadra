import { localRuntime } from "../../api/local-runtime";
import { isNativeAppPage } from "../../api/runtime-url";
import { isDesktop } from "../../platform";
import { useCurrentSource } from "../../sources/context";
import { hostedRelay } from "../../sources/hosted";
import type { SourceKind, Via } from "../../sources/types";

/**
 * 设置作用的那台 core 在不在眼前这台设备上。
 *
 * 不新造概念，全从已有的源描述推出来：
 *
 * - 页面的本机源本身就在别处：中继托管的页面（`sources/hosted.ts`）、原生 App
 *   （连接页记下的 Gateway 或中继）、经 Gateway / 服务器壳打开的网页（同源
 *   HTTPS）。这时 `via` 是页面到达本机源的那条路，`relayIssuer` / 直连就是
 *   页面正在走的隧道——停用或删掉它等于自断。
 * - 当前源是挂载的远程源（`descriptor.kind !== "local"`）：`api/*` 的请求发往
 *   它（`currentSource()`），设置页读写的就是那台机器。
 *
 * 桌面窗口里的本机源永远在本机；开发服务器（回环 HTTP）也算本机。
 */
export interface RemoteAccess {
  /** 设置作用的 core 不在眼前这台设备上。 */
  readonly remote: boolean;
  /** 页面到达本机源的那条路；本机源就在这台设备上是 `null`。 */
  readonly via: Exclude<Via, "local"> | null;
  /** 页面正经它到达本机源的中继（签发方来源）；不经中继是 `null`。 */
  readonly relayIssuer: string | null;
  /** 当前源的 id（远程源时是那台的 `sourceId`）。 */
  readonly currentSourceId: string;
}

/** 推断用到的事实；测试直接造。 */
export interface AccessFacts {
  readonly desktop: boolean;
  /** 中继托管页面的签发方；别的页面是 `null`。 */
  readonly hostedIssuer: string | null;
  readonly nativeApp: boolean;
  /** 页面由带 HTTPS 的 core 同源托管（Gateway、服务器壳）。 */
  readonly viaServerShell: boolean;
  /** 本机源的地址。 */
  readonly localHttpBase: string;
  readonly currentKind: SourceKind;
  readonly currentSourceId: string;
}

function originOf(base: string): string | null {
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/** 本机源经中继时地址是 `<中继>/s/<源>`（`relayBaseUrl`）。 */
function relayedBase(base: string): boolean {
  try {
    return /^\/s\/[^/]+/.test(new URL(base).pathname);
  } catch {
    return false;
  }
}

/** 页面本身到达本机源的那条路（与当前源无关）。 */
function pageRoute(
  facts: AccessFacts,
): Pick<RemoteAccess, "via" | "relayIssuer"> {
  if (facts.desktop) return { via: null, relayIssuer: null };
  if (facts.hostedIssuer !== null)
    return {
      via: "relayed",
      relayIssuer: originOf(facts.hostedIssuer) ?? facts.hostedIssuer,
    };
  if (facts.nativeApp) {
    return relayedBase(facts.localHttpBase)
      ? { via: "relayed", relayIssuer: originOf(facts.localHttpBase) }
      : { via: "direct", relayIssuer: null };
  }
  if (facts.viaServerShell) return { via: "direct", relayIssuer: null };
  return { via: null, relayIssuer: null };
}

export function remoteAccessOf(facts: AccessFacts): RemoteAccess {
  const route = pageRoute(facts);
  return {
    ...route,
    remote: route.via !== null || facts.currentKind !== "local",
    currentSourceId: facts.currentSourceId,
  };
}

/** 页面这一侧的事实（一次加载里不变，除了中继托管页面何时挂上）。 */
export function pageAccessFacts(): Omit<
  AccessFacts,
  "currentKind" | "currentSourceId"
> {
  const local = localRuntime();
  return {
    desktop: isDesktop(),
    hostedIssuer: hostedRelay()?.issuer ?? null,
    nativeApp: isNativeAppPage(),
    viaServerShell: local.viaServerShell,
    localHttpBase: local.httpBase,
  };
}

/** 设置页用：页面事实加上当前源（切源时跟着变）。 */
export function useRemoteAccess(): RemoteAccess {
  const current = useCurrentSource();
  return remoteAccessOf({
    ...pageAccessFacts(),
    currentKind: current.descriptor.kind,
    currentSourceId: current.descriptor.sourceId,
  });
}

/** 两个来源是不是同一个（大小写、尾斜杠、缺省端口都不算差别）。 */
export function sameOrigin(a: string, b: string | null): boolean {
  if (b === null) return false;
  const left = originOf(a);
  return left !== null && left === originOf(b);
}
