import { LifecycleState } from "../shell-core/lifecycle-state";
import { requestShutdownIfIdle } from "../core/terminal/session-host/shutdown";
import type { RuntimeProcess } from "./runtime-process";

/**
 * 关掉前台窗口不停任何服务；显式退出才停 core。
 *
 * 三段式的状态本身是纯的，住在 `shell-core/lifecycle-state.ts`。
 */

export class DesktopLifecycle {
  readonly state = new LifecycleState();
}

export interface QuitOutcome {
  readonly ok: boolean;
  /** 只有 `ok` 为 false 时有；已经是可以直接给用户看的一句话。 */
  readonly message?: string;
}

/**
 * 退出：请 core 停下，确认了才真的退出。
 *
 * 失败**不**退出。窗口回来，并把原因告诉用户——另一种做法（照退不误）等于悄悄
 * 把后台服务和用户的会话留在一个没人看过的状态里。
 */
export async function runQuitSequence(
  lifecycle: DesktopLifecycle,
  runtime: RuntimeProcess,
  afterStop?: () => Promise<unknown>,
): Promise<QuitOutcome> {
  try {
    await runtime.stop();
    // 尽力而为：失败只记一笔，不挡退出。
    if (afterStop !== undefined) await afterStop().catch(() => undefined);
  } catch (error) {
    lifecycle.state.quitFailed();
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  lifecycle.state.quitCompleted();
  return { ok: true };
}

/** 退出没走完时的那段对话框文案。 */
export function quitFailureDialog(message: string): {
  title: string;
  body: string;
} {
  return {
    title: "Armadra 退出未完成",
    body: `后台未能全部停止，应用尚未退出。请检查后台状态。\n${message}`,
  };
}

/**
 * Windows：core 停了之后请会话宿主「没有会话就走」（`shutdownIfIdle`）。
 *
 * 宿主跑在 `Armadra.exe` 上；没有会话又没人连着它本来也会在十秒后自己走，这一条
 * 让正常退出（关闭 / 托盘退出）不留那十秒，紧接着的卸载或升级就不必按进程名去结束
 * 它。有会话时宿主照旧留着。只在壳自己起了 core 时发：开发时别人的 core 还连着。
 */
export function sessionHostRelease(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  request: typeof requestShutdownIfIdle = requestShutdownIfIdle,
): (() => Promise<unknown>) | undefined {
  if (platform !== "win32") return undefined;
  return async () => {
    const outcome = await request({
      dataDir,
      client: "armadra-shell",
      timeoutMs: 3_000,
    });
    process.stderr.write(`session host on quit: ${outcome.kind}\n`);
    return outcome;
  };
}
