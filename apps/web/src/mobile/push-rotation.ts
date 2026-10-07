import * as React from "react";

import { usePreferencesStore } from "../app/preferences-store";
import { pushApi } from "../api/push";
import { nativeBridge, type NativeBridge } from "./native-bridge";

/**
 * 推送令牌轮换后主动重新登记（R-54）。
 *
 * core 只认登记时交的那一张令牌（契约 §19.2）：FCM 换了令牌（`onNewToken`）、
 * UnifiedPush 分发器给了新端点、APNs 在启动时给了不同的令牌，原生都记一个
 * 「换过」的标记并发 `pushTokenRotated`。这台设备开过推送的，页面在启动时与
 * 收到事件时向插件要一份新的登记，`PUT /api/push/devices`，成功后清标记。
 * 没开过推送的不动：开不开是人在推送提示里决定的。
 */

const REGISTERED_KEY = "armadra.push.native";

/** 开推送成功时记一笔（`PushPermission.enablePush`）。 */
export function markNativePushRegistered(): void {
  try {
    globalThis.localStorage?.setItem(REGISTERED_KEY, "1");
  } catch {
    /* 记不下：令牌换了之后要等人再开一次。 */
  }
}

function registered(): boolean {
  try {
    return globalThis.localStorage?.getItem(REGISTERED_KEY) === "1";
  } catch {
    return false;
  }
}

let running: Promise<boolean> | null = null;

/**
 * 换过就重新登记一次；返回是否登记了。并发的几次（启动检查与事件同时到）
 * 合成一次。失败不清标记，下次启动再试。
 */
export function reregisterIfRotated(
  locale: "zh-CN" | "en",
  bridge: NativeBridge = nativeBridge(),
): Promise<boolean> {
  running ??= (async () => {
    if (!bridge.available || !registered()) return false;
    if (!(await bridge.pushRotated())) return false;
    const registration = await bridge.pushRegistration();
    if (registration === null) return false;
    try {
      await pushApi.register({ ...registration, locale });
    } catch {
      return false;
    }
    await bridge.ackPushRotation();
    return true;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** 登录后的画布里挂一次：启动时查一次，之后听原生的事件。 */
export function usePushRotation(): void {
  const locale = usePreferencesStore((state) => state.locale);
  const localeRef = React.useRef(locale);
  localeRef.current = locale;
  React.useEffect(() => {
    const bridge = nativeBridge();
    if (!bridge.available) return;
    const check = () => void reregisterIfRotated(localeRef.current, bridge);
    check();
    return bridge.onPushRotated(check);
  }, []);
}
