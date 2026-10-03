import type { BackendKind } from "./backend";
import type { EnvPairs } from "./environment";

/**
 * 管理器两个起会话入口的请求形状（`TerminalManager.spawn` / `revive`），单独
 * 一个文件只为让 `manager.ts` 不超过仓库的单文件上限；`manager.ts` 原样再导出。
 */

export interface SpawnRequest {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell?: string | undefined;
  readonly command?: string | undefined;
  readonly args?: readonly string[];
  readonly kind?: string;
  readonly ownerNodeId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly env?: EnvPairs;
  /**
   * `ssh: { hostId }` — this session runs `ssh …` instead of a shell.
   *
   * It travels as an extra field on the spec rather than as a decision here:
   * the manager does not know what an SSH host is, and the backend decorator
   * that does (`ssh/backend.ts`) rewrites the command from the *stored* host.
   * A spec without it passes through every backend untouched, which is what
   * lets one decorated backend serve every terminal.
   */
  readonly sshHostId?: string | undefined;
  /**
   * The backend to create this session with; the effective one when absent.
   * Only `acp` is ever named (`core/acp`): a node driven over ACP is the same
   * row in the same table, created by a different backend.
   */
  readonly backend?: BackendKind | undefined;
}

/** {@link TerminalManager.revive} 的选项。 */
export interface ReviveOptions {
  /** 不止休眠的行：任何已经结束的行都可以在原地起下一代。 */
  readonly ended?: boolean;
  /** 下一代用哪个后端；缺省是这一行原来的（ACP 仍是 ACP）。 */
  readonly backend?: BackendKind;
  /** 下一代跑的程序；`null` = 只起 shell。缺省沿用行上的。 */
  readonly command?: string | null;
}
