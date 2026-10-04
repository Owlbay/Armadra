import type { WorkflowScheduleBridge } from "../schedule/workflow-target";
import type { WorkflowEngine } from "./engine";
import type { WorkflowService } from "./service";

/**
 * 装配好的那个工作流域。
 *
 * 单独一个模块、只 import 类型：`workflow-propose` 在协作域里，而工作流域要借
 * 协作域投递，直接从 `index.ts` 取会绕成一个环（`dependencies/registry.ts` 同理）。
 */
export interface WorkflowDomain {
  readonly engine: WorkflowEngine;
  readonly service: WorkflowService;
  stop(): Promise<void>;
}

let current: WorkflowDomain | undefined;

export function setWorkflowDomain(domain: WorkflowDomain | undefined): void {
  current = domain;
}

export function workflowDomain(): WorkflowDomain | undefined {
  return current;
}

let schedules: WorkflowScheduleBridge | undefined;

/**
 * 调度域装配时登记的那座桥：改模板之后列出冻结的计划、把计划升到新版本
 * （契约 §15.6）。没有调度域时是 `undefined`，模板照改，只是没有计划可列。
 */
export function setWorkflowScheduleBridge(
  bridge: WorkflowScheduleBridge | undefined,
): void {
  schedules = bridge;
}

export function workflowScheduleBridge(): WorkflowScheduleBridge | undefined {
  return schedules;
}
