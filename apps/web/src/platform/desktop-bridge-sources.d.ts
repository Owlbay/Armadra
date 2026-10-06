/**
 * `window.armadra.sources` — 页面改了源表（远程服务、挂载的源）之后告诉桌面壳：
 * 壳自己经 core 重读源表，更新 CSP 的 `connect-src` 与证书钉扎，答这张页面要不要
 * 重载才放行新来源（`apps/desktop/src/main/remote-trust.ts`）。
 */
interface ArmadraBridge {
  readonly sources?: {
    changed(): Promise<{ readonly reload: boolean }>;
  };
}
