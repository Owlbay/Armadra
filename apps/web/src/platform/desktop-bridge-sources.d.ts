/**
 * `window.armadra.sources` — 页面改了源表（远程服务、挂载的源）之后告诉桌面壳：
 * 壳自己经 core 重读源表，更新 CSP 的 `connect-src` 与证书钉扎，答这张页面要不要
 * 重载才放行新来源（`apps/desktop/src/main/remote-trust.ts`）。另外转交壳收到的
 * 分享深链。
 */
interface ArmadraBridge {
  readonly sources?: {
    changed(): Promise<{ readonly reload: boolean }>;
    /**
     * 壳收到的 `armadra://join` 分享深链（客户端包 §6.2）：启动参数里带来的那一条
     * 只取一次；之后每来一条推一次。壳只转交认得出的 `armadra://join?…`。
     */
    takeJoinLink?(): Promise<string | null>;
    onJoinLink?(listener: (url: string) => void): () => void;
  };
}
