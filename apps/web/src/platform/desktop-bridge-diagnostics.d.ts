/**
 * `window.armadra.diagnostics` — 页面的一条 JS 错误交给桌面壳主进程（G5-19，
 * 契约 §30，`apps/desktop/src/preload/index.ts`）。主进程再判开关、限流、剥离，
 * 答 `{ accepted }`，从不拒绝。
 */
interface ArmadraBridge {
  readonly diagnostics?: {
    report(report: {
      readonly kind: "error" | "rejection";
      readonly name: string;
      readonly message: string;
      readonly stack: string;
    }): Promise<{ readonly accepted: boolean }>;
  };
}
