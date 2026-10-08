import { useEffect } from "react";

import { isJoinLink } from "@armadra/shared";

import { hasInvitationFragment } from "../api/accounts";
import { hasPairingFragment } from "../api/identity";
import { hasOAuthFragment } from "../api/security";
import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import { isNativeApp } from "../mobile/native-bridge";
import { isDesktop } from "../platform";
import { offerJoinLink } from "../sources/join-intent";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferencesStore } from "./preferences-store";

const JOIN_FRAGMENT = /^#join=(.+)$/;
/** 设置里「远程访问」那一页的 id（`RemoteServicesPage.REMOTE_SECTION`；那一页是懒加载的，这里不引它）。 */
const REMOTE_SECTION = "remoteAccess";

/**
 * 分享链接的片段 `#join=<链接>`（链接整条 URL 编码）：取走即从地址栏抹掉，认不出
 * 是 `null`。链接带着秘密，不留在地址栏与历史里。
 */
export function takeJoinFragment(): string | null {
  const location = globalThis.location;
  const found = JOIN_FRAGMENT.exec(location?.hash ?? "");
  if (!found) return null;
  try {
    globalThis.history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}`,
    );
  } catch {
    /* 抹不掉不影响加入。 */
  }
  let link: string;
  try {
    link = decodeURIComponent(found[1]!);
  } catch {
    return null;
  }
  return isJoinLink(link) ? link : null;
}

function openRemoteWith(link: string): void {
  offerJoinLink(link);
  usePreferencesStore.getState().setLastSettingsSection(REMOTE_SECTION);
  useCanvasStore.getState().setPanel("settings", true);
}

/**
 * 服务器壳的两种链接落在页面根的片段上：邀请 `#invite=<令牌>` 打开到「账号与
 * 共享」，兑换对话框在那一页取走令牌；配对 `#pair=<票>` 打开到「本机服务」，
 * 那一页检查连接后取走票完成配对。OAuth 回调 `#oauth=…`（契约 §18.5）打开到
 * 「安全」，那一页取走结果（登录、第二步、已绑定或错误）。只看一次，片段由
 * 那几页抹掉。
 *
 * 原生 App 只认 `#oauth=`：原生 OAuth 收尾后入口把结果写成同一种片段（R-56）。
 *
 * 分享链接（客户端包 §6.2）：桌面壳与服务器壳的页面认 `#join=<链接>`，桌面壳另外
 * 收 `armadra://join` 深链（启动时那一条与之后每一条）——都打开到「远程访问」并
 * 预填「通过链接加入」，人点「加入」才挂载。
 *
 * 必须挂在浮层闸门之外（`Overlays.tsx`）：设置对话框只在打开之后才挂载，把
 * 这段判断放进对话框里，等于链接打开后什么都不会发生。
 */
export function useLinkFragments(
  serverShell = RUNTIME_VIA_SERVER_SHELL,
  nativeApp = isNativeApp(),
  desktop = isDesktop(),
): void {
  useEffect(() => {
    if (!serverShell && !desktop) return;
    const link = takeJoinFragment();
    if (link !== null) openRemoteWith(link);
    if (!desktop) return;
    const bridge = globalThis.window?.armadra?.sources;
    const offer = (url: unknown) => {
      if (typeof url === "string" && isJoinLink(url)) openRemoteWith(url);
    };
    void bridge
      ?.takeJoinLink?.()
      .then(offer)
      .catch(() => undefined);
    return bridge?.onJoinLink?.(offer);
  }, [serverShell, desktop]);

  useEffect(() => {
    if (!serverShell && !nativeApp) return;
    const section = !serverShell
      ? hasOAuthFragment()
        ? "security"
        : undefined
      : hasInvitationFragment()
        ? "accounts"
        : hasPairingFragment()
          ? "service"
          : hasOAuthFragment()
            ? "security"
            : undefined;
    if (section === undefined) return;
    usePreferencesStore.getState().setLastSettingsSection(section);
    useCanvasStore.getState().setPanel("settings", true);
  }, [serverShell, nativeApp]);
}
