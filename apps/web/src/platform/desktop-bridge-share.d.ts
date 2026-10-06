/**
 * `window.armadra.share` — 分享链接交给桌面壳的系统分享菜单（`app:share`，
 * `apps/desktop/src/main/share.ts`）。`available` 是这个平台有没有菜单（目前只有
 * macOS）；`url` 答 `{ shared: false }` 时页面退回复制。
 */
interface ArmadraBridge {
  readonly share?: {
    readonly available: boolean;
    url(request: {
      title: string;
      url: string;
    }): Promise<{ readonly shared: boolean }>;
  };
}
