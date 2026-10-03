import { createHash } from "node:crypto";
import {
  AutomationOutcome,
  type AutomationReceipt,
  type AutomationRun,
  type AutomationTarget,
} from "./types";

import { checkRendered, resolveParams } from "../workflow/draft";
import { workspaceOfBoard } from "../workflow/engine";
import { workflowDomain } from "../workflow/registry";
import { runById, templateById } from "../workflow/store";
import { DomainError } from "../workspaces/support";
import { ScheduleError, invalid, workflowParams } from "./plan";
import type { TargetStatus } from "./contracts";

/**
 * 自动化目标 `WORKFLOW_RUN`（补全架构 §5.4「再运行与定时」、契约 §15.6）。
 *
 * 到点不往任何终端里写：调工作流服务起一次运行，与页面上按「运行」是同一条
 * 路（同样的参数校验、同样在动画布之前拒绝）。misfire、并发与授权复核全部沿用
 * 调度内核——这里只回答三件事：
 *
 *   * **探测**：模板还在、还是冻结的那一版、画布还在这个工作空间里 → `ready`；
 *     否则 `unsupported`（计划因此跳过，连续几次后标「需要处理」）。没有工作流
 *     域就是 `unknown`，等下一拍。
 *   * **投递**：运行的 id 由这次投递的操作标识推出来（{@link workflowRunId}），
 *     所以重试、超时之后的复核都能认出「这次已经起过了」，不会起第二次。
 *   * **收据**：运行在跑 → `RUNNING`，结束 → `SUCCEEDED` / `FAILED` /
 *     `CANCELLED`。闸门因此从起跑占到运行结束：`FORBID` 的计划不会在上一次运行
 *     还没完时再起一次。
 */

/** 一次投递对应的那次工作流运行的 id：同一个操作标识永远是同一个 id。 */
export function workflowRunId(operationId: string): string {
  const hex = createHash("sha256")
    .update(`armadra-schedule-workflow\u0000${operationId}`)
    .digest("hex");
  // UUID 的样子（版本位 8 = 自定义），路由与日志里与别的运行 id 看起来一样。
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * 定义计划时核一遍（`ScheduleService.define`）：模板在、版本对、画布属于这个
 * 工作空间、参数按模板成立。版本 0 表示「现在这一版」，在这里冻结成具体的数。
 */
export function checkWorkflowTarget(
  workspaceId: string,
  target: AutomationTarget,
  payload: Uint8Array,
): void {
  const domain = workflowDomain();
  const workflow = target.workflowRun;
  if (domain === undefined) {
    throw new ScheduleError("unsupported", "这台 core 没有工作流域");
  }
  if (workflow === undefined) throw invalid("工作流目标必须指明模板");
  const database = domain.service.database;
  const template = templateById(database, workflow.templateId);
  if (template === undefined) {
    throw new ScheduleError("notFound", "找不到这个工作流模板");
  }
  if (workflow.templateVersion === 0) {
    workflow.templateVersion = template.version;
  }
  if (workflow.templateVersion !== template.version) {
    throw new ScheduleError("conflict", "模板已经改过，按新版本重新保存计划");
  }
  if (workspaceOfBoard(database, workflow.boardId) !== workspaceId) {
    throw new ScheduleError("notFound", "这个工作空间里没有这块画布");
  }
  try {
    checkRendered(
      template.template,
      resolveParams(template.template, workflowParams(payload)),
    );
  } catch (error) {
    if (error instanceof DomainError) throw invalid(error.message);
    throw error;
  }
}

/** 探测：只读库，不起任何东西。 */
export function workflowTargetStatus(
  workspaceId: string,
  target: AutomationTarget,
): TargetStatus {
  const domain = workflowDomain();
  const workflow = target.workflowRun;
  if (domain === undefined) return { state: "unknown", generation: 0 };
  if (workflow === undefined) return { state: "unsupported", generation: 0 };
  const database = domain.service.database;
  const template = templateById(database, workflow.templateId);
  if (
    template === undefined ||
    template.version !== workflow.templateVersion ||
    (workspaceId !== "" &&
      workspaceOfBoard(database, workflow.boardId) !== workspaceId)
  ) {
    return { state: "unsupported", generation: 0 };
  }
  return { state: "ready", generation: 0 };
}

/** 运行的状态 → 收据的结果与理由码。 */
function outcomeOf(status: string): {
  readonly outcome: AutomationOutcome;
  readonly reason: string;
} {
  switch (status) {
    case "succeeded":
      return {
        outcome: AutomationOutcome.SUCCEEDED,
        reason: "WORKFLOW_SUCCEEDED",
      };
    case "failed":
      return { outcome: AutomationOutcome.FAILED, reason: "WORKFLOW_FAILED" };
    case "cancelled":
      return {
        outcome: AutomationOutcome.CANCELLED,
        reason: "WORKFLOW_CANCELLED",
      };
    case "waiting":
      return { outcome: AutomationOutcome.RUNNING, reason: "WORKFLOW_WAITING" };
    default:
      return { outcome: AutomationOutcome.RUNNING, reason: "WORKFLOW_RUNNING" };
  }
}

/** 起跑被拒的码 → 收据理由码（`[A-Z0-9_]{0,64}`）。 */
function rejectionReason(error: unknown): string {
  const code = error instanceof DomainError ? error.code : "start_failed";
  return `WORKFLOW_${code.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`.slice(
    0,
    64,
  );
}

export type Receipt = (
  outcome: AutomationOutcome,
  reasonCode: string,
  sequence: number,
) => AutomationReceipt;

/**
 * 起这一次运行。已经起过（重试、超时后的复核）就不再起，按它现在的状态出收据。
 *
 * 起跑当场被拒（缺参数、权限模式不支持、画布没了……）时画布一点没动，记
 * `FAILED` 加拒绝码：这不是「结果不明」，也不值得重试——同一份冻结的定义再跑
 * 一遍会得到同一个拒绝。
 */
export async function startWorkflowRun(
  run: AutomationRun,
  target: AutomationTarget,
  payload: Uint8Array,
  receipt: Receipt,
): Promise<AutomationReceipt> {
  const domain = workflowDomain();
  const workflow = target.workflowRun;
  if (domain === undefined || workflow === undefined) {
    return receipt(AutomationOutcome.NOT_DISPATCHED, "NO_WORKFLOW_DOMAIN", 1);
  }
  const runId = workflowRunId(run.operationId);
  const existing = runById(domain.service.database, runId);
  if (existing !== undefined) {
    const { outcome, reason } = outcomeOf(existing.status);
    return receipt(outcome, reason, 1);
  }
  const template = templateById(domain.service.database, workflow.templateId);
  if (template === undefined || template.version !== workflow.templateVersion) {
    return receipt(AutomationOutcome.NOT_DISPATCHED, "TARGET_UNSUPPORTED", 1);
  }
  try {
    const started = await domain.engine.startRun({
      template,
      params: workflowParams(payload),
      boardId: workflow.boardId,
      runId,
    });
    const { outcome, reason } = outcomeOf(started.status);
    return receipt(outcome, reason, 1);
  } catch (error) {
    // 起跑之后才抛的（节点已经建了）：运行行在库里，按它出收据。
    const after = runById(domain.service.database, runId);
    if (after !== undefined) {
      const { outcome, reason } = outcomeOf(after.status);
      return receipt(outcome, reason, 1);
    }
    return receipt(AutomationOutcome.FAILED, rejectionReason(error), 1);
  }
}

/**
 * 复核：这次投递起的那次运行现在怎么样了。状态变了就出一张序号更大的收据
 * （内核据此把自动化运行推到 `RUNNING` / 终止态），没变就交回存着的那张。
 */
export function lookupWorkflowRun(
  run: AutomationRun,
  stored: AutomationReceipt | undefined,
  receipt: Receipt,
): AutomationReceipt | undefined {
  const domain = workflowDomain();
  if (domain === undefined) return stored;
  const current = runById(
    domain.service.database,
    workflowRunId(run.operationId),
  );
  if (current === undefined) return stored;
  const { outcome, reason } = outcomeOf(current.status);
  if (
    stored !== undefined &&
    stored.outcome === outcome &&
    stored.reasonCode === reason
  ) {
    return stored;
  }
  const sequence = Math.max(Number(stored?.sequence ?? 0n), 0) + 1;
  return receipt(outcome, reason, sequence);
}
