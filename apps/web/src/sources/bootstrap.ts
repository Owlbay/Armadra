import type { ClientSource } from "@armadra/shared";

import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import { isDesktop } from "../platform";
import {
  type SourceRegistry,
  loadSourcesFromLocalCore,
  sourceRegistry,
} from "./registry";
import type { SourceDescriptor } from "./types";

/**
 * 页面启动时要不要读本机 core 的源表（客户端包 §1.3、§3）。
 *
 * 零配置（没挂任何别的源）时启动不多发一个请求（平台设计 §17.6）。所以「有没
 * 有挂过源」记在本地：设置 → 远程服务每次读到源表就记一次；记着「有」的页面
 * 启动时才 `hydrate(loadSourcesFromLocalCore)`。记错了的代价只是一次多余的
 * 请求或者晚一步出现在侧栏——打开设置页就纠正。
 *
 * 只在桌面壳与服务器壳的页面上：手机没有本机 core 的源表（A1-5 另有来源）。
 */

const MOUNTED_KEY = "armadra.sources.mounted";
const REOPEN_KEY = "armadra.settings.reopen";

function local(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** 源表的一行 → 页面源表的描述（凭据不在里面，换票经本机 core）。 */
export function descriptorOf(source: ClientSource): SourceDescriptor {
  return {
    sourceId: source.sourceId,
    kind: source.kind,
    label: source.label,
    // 旧版 core（§61 之前）没有 `defaultLabel`。
    ...(typeof source.defaultLabel === "string"
      ? { defaultLabel: source.defaultLabel }
      : {}),
    baseUrl: source.baseUrl,
    relayOrigin: source.relayOrigin,
    cloudIssuer: source.cloudIssuer,
    fingerprint: source.fingerprint,
    orderIndex: source.orderIndex,
    // 旧版 core（§55 之前）的答案里没有 `routes`：由镜像字段推出。
    ...(source.routes === undefined ? {} : { routes: source.routes }),
  };
}

/**
 * 设置页读到的源表交给页面源表：记下「有没有挂过源」，换上这一批（不再发
 * 请求）。与启动时读的是同一批（本机以外的全部行）；断开了凭据的那些连不上，
 * 状态是「需要登录」。
 */
export function applySourceTable(
  sources: readonly ClientSource[],
  registry: SourceRegistry = sourceRegistry(),
): Promise<void> {
  const mounted = sources.filter((source) => source.kind !== "local");
  try {
    if (mounted.length > 0) local()?.setItem(MOUNTED_KEY, "1");
    else local()?.removeItem(MOUNTED_KEY);
  } catch {
    /* 存不下只是下次启动不自动连。 */
  }
  return registry.hydrate(async () => mounted.map(descriptorOf));
}

/** 启动：记着挂过源才读本机 core 的源表；零配置什么也不做。 */
export function hydrateSourcesAtStartup(
  registry: () => SourceRegistry = sourceRegistry,
): boolean {
  if (!isDesktop() && !RUNTIME_VIA_SERVER_SHELL) return false;
  if (local()?.getItem(MOUNTED_KEY) !== "1") return false;
  void registry().hydrate(async () =>
    (await loadSourcesFromLocalCore()).filter(
      (descriptor) => descriptor.kind !== "local",
    ),
  );
  return true;
}

/**
 * 桌面壳说新来源要重载页面才放行（CSP）：记下回到哪一页，再重载。
 */
export function reloadIntoSettings(section: string): void {
  try {
    session()?.setItem(REOPEN_KEY, section);
  } catch {
    /* 记不下就停在画布上，重新打开设置即可。 */
  }
  globalThis.location?.reload();
}

/** 重载之后取走「回到设置的哪一页」（只取一次）。 */
export function takeSettingsReopen(): string | null {
  const store = session();
  const section = store?.getItem(REOPEN_KEY) ?? null;
  if (section !== null) store?.removeItem(REOPEN_KEY);
  return section;
}
