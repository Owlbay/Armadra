import { type BrowserWindow, ShareMenu } from "electron";

import {
  nativeShareAvailable,
  shareRequest,
} from "../shell-core/share-request";

/**
 * `app:share`：在主窗口上弹系统分享菜单（macOS 的 `ShareMenu`）。
 *
 * 请求先过 `shell-core/share-request.ts` 收窄；平台没有分享菜单、请求不像样或
 * 没有窗口时答 `{ shared: false }`，页面退回复制——这里从不拒绝，分享不成不该
 * 变成页面上的一个错误。菜单弹出即答 `true`，人选了哪一项、取没取消壳不知道。
 */
export function shareUrl(
  value: unknown,
  window: BrowserWindow | null,
  platform: string = process.platform,
): { shared: boolean } {
  const request = shareRequest(value);
  if (request === null || window === null || !nativeShareAvailable(platform))
    return { shared: false };
  try {
    new ShareMenu({ urls: [request.url] }).popup({ window });
    return { shared: true };
  } catch {
    return { shared: false };
  }
}
