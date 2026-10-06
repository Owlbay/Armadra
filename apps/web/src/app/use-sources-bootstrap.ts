import { useEffect } from "react";

import {
  hydrateSourcesAtStartup,
  takeSettingsReopen,
} from "../sources/bootstrap";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferencesStore } from "./preferences-store";

/**
 * 页面启动时的两件小事（客户端包 §3）：
 *
 * - 挂过别的源才读本机 core 的源表，接进页面源表（零配置不发请求）；
 * - 桌面壳为放行新来源重载了页面（CSP 只在载入时生效）：回到重载前那一页设置。
 */
export function useSourcesBootstrap(): void {
  useEffect(() => {
    hydrateSourcesAtStartup();
    const section = takeSettingsReopen();
    if (section === null) return;
    usePreferencesStore.getState().setLastSettingsSection(section);
    useCanvasStore.getState().setPanel("settings", true);
  }, []);
}
