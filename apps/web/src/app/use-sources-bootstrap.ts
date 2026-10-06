import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  hydrateSourcesAtStartup,
  takeSettingsReopen,
} from "../sources/bootstrap";
import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import { isDesktop } from "../platform";
import { createDesktopCloudAuth } from "../sources/credentials";
import { hostedRelay } from "../sources/hosted";
import { type SourceRegistry, sourceRegistry } from "../sources/registry";
import { attachRemoteStreams } from "../sources/remote-stream";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferencesStore } from "./preferences-store";

/**
 * 页面启动时的两件小事（客户端包 §3）：
 *
 * - 挂过别的源才读本机 core 的源表，接进页面源表（零配置不发请求）；
 * - 经中继挂上的源各远程服务一条 `me.stream`（主机上线叫醒、撤销失权，客户端包
 *   §5）；源表里没有这类源时一条也不开。远程服务会话经本机 core 换。中继托管的
 *   页面自己管它那一条（`sources/hosted.ts`），这里不接；
 * - 桌面壳为放行新来源重载了页面（CSP 只在载入时生效）：回到重载前那一页设置。
 */
export function useSourcesBootstrap(): void {
  useEffect(() => {
    hydrateSourcesAtStartup();
    const section = takeSettingsReopen();
    if (section !== null) {
      usePreferencesStore.getState().setLastSettingsSection(section);
      useCanvasStore.getState().setPanel("settings", true);
    }
    // 背后有本机 core 的页面（桌面壳、服务器壳）才接；设置页中途挂上的源也跟着开。
    if ((!isDesktop() && !RUNTIME_VIA_SERVER_SHELL) || hostedRelay() !== null)
      return;
    return attachRemoteStreams(sourceRegistry(), {
      auth: createDesktopCloudAuth(),
    });
  }, []);
}

/**
 * 换当前源时清掉不带源前缀的查询（A1-2 留下的一项）：设置、用量、账号、
 * Agent 列表这类查询不带工作空间 id，键里也就没有 `["src", sourceId]`；当前
 * 源一换，它们缓存的是上一个源的答案。带源前缀的（`["src", …]`）各归各的源，
 * 留着——切回来不必重取。
 */
export function dropUnscopedQueries(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== "src" });
}

export function useSourceSwitchCacheReset(
  registry: () => SourceRegistry = sourceRegistry,
): void {
  const client = useQueryClient();
  useEffect(() => {
    const table = registry();
    let current = table.current().descriptor.sourceId;
    return table.subscribe(() => {
      const next = table.current().descriptor.sourceId;
      if (next === current) return;
      current = next;
      dropUnscopedQueries(client);
    });
  }, [client, registry]);
}
