import { AutomationRunState, type AutomationTarget } from "./types";

/**
 * 调度内核发的事件（契约 §27.3）的两条判定：哪些结局算「没有跑成」，以及深链
 * 指向哪个节点。事件本身由 `engine.ts` 在提交之后发。
 */

/**
 * 「没有跑成」的那些结局（契约 §27.3 的 `schedule.failed`）：执行方说失败了，
 * 目标不在 / 不支持 / 换了代数而跳过，或者等到 TTL 都没等到目标。并发上限、
 * 错过的槽位按策略跳过、暂停与改配置的取消是**按设计**不跑，不叫人。
 */
export function failedOutcome(
  state: AutomationRunState,
  reason: string,
): boolean {
  if (state === AutomationRunState.FAILED) return true;
  if (state === AutomationRunState.SKIPPED) {
    return (
      reason === "TARGET_OFFLINE" ||
      reason === "TARGET_UNSUPPORTED" ||
      reason === "STALE_GENERATION"
    );
  }
  return state === AutomationRunState.EXPIRED && reason === "WAITING_EXPIRED";
}

/** 深链指向的节点：Agent 与命令目标的节点；工作流目标没有（空串不带）。 */
export function targetNode(target: AutomationTarget | undefined): {
  nodeId?: string;
} {
  const nodeId = target?.nodeId ?? "";
  return nodeId === "" ? {} : { nodeId };
}
