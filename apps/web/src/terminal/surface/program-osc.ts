import type { IDisposable, IParser } from "@xterm/xterm";

/**
 * 程序状态的序列在页面这一侧只吞不答（契约 §53）。
 *
 * 状态由 core 从程序输出里读（离屏、表面没挂上时也一样），`OSC 7501 ; ?`
 * 的回应也由 core 写；页面再答一次，程序就会收到两份。OSC 9 只认 `9;4`
 * 进度，其余子命令（桌面通知）照旧交给后面的处理器。
 */
export function registerProgramOsc(
  parser: Pick<IParser, "registerOscHandler">,
): IDisposable {
  const status = parser.registerOscHandler(7501, () => true);
  const progress = parser.registerOscHandler(9, isProgress);
  return {
    dispose() {
      status.dispose();
      progress.dispose();
    },
  };
}

/** `OSC 9 ; 4 ; …` 的正文（xterm 交来的是 `9;` 之后的部分）。 */
export function isProgress(data: string): boolean {
  return data === "4" || data.startsWith("4;");
}
