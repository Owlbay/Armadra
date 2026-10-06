/**
 * 系统分享面板（`app:share`）收什么。
 *
 * 页面把一条分享链接交给壳，壳弹系统的分享菜单。和 `openExternal` 一样是页面
 * 让特权进程替它做事，所以先在这里把形状收窄：只收 http / https 的地址（分享
 * 链接本身就是这种），带 `#` 片段原样保留——秘密就在片段里，分享出去的正是整条
 * 链接；标题只用来给菜单看，截短。认不出的一律 `null`，壳答 `{ shared: false }`，
 * 页面退回复制。
 */

export interface ShareRequest {
  readonly title: string;
  readonly url: string;
}

const MAX_URL = 4096;
const MAX_TITLE = 256;

/** PURE. 页面交来的 `{ title, url }`；不像样的答 `null`。 */
export function shareRequest(value: unknown): ShareRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const { title, url } = value as { title?: unknown; url?: unknown };
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL)
    return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return {
    title: typeof title === "string" ? title.slice(0, MAX_TITLE) : "",
    url,
  };
}

/** PURE. 这个平台有没有系统分享菜单（Electron `ShareMenu` 只在 macOS）。 */
export function nativeShareAvailable(platform: string): boolean {
  return platform === "darwin";
}
