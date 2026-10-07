import type {
  AutomationPlan,
  AutomationPlanConfig,
  AutomationReceipt,
  AutomationRun,
  AutomationTarget,
} from "./types";

import type { ScheduleStore } from "./store";

/**
 * 调度内核与外界之间的那几个契约。
 *
 * 分出来是因为它们是**两个方向的边界**：内核向下要一个投递方和一个授权方，向上
 * 交出两种快照。把它们和内核写在一个文件里，读的人要先翻过一千行才知道内核到底
 * 依赖什么。
 */

/** 调用方的稳定身份。**永远不要**把浏览器的访问/刷新密钥放进这两个字段。 */
export interface Authorization {
  readonly principalId: string;
  readonly authorizationId: string;
}

export type TargetState =
  | "unknown"
  | "ready"
  | "busy"
  | "offline"
  | "unsupported";

export interface TargetStatus {
  readonly state: TargetState;
  readonly generation: number;
  /**
   * `busy` 的具体理由，进运行的 `reasonCode`。缺席时内核记 `TARGET_NOT_IDLE`；
   * 画面门退回时是 `TARGET_NOT_AT_PROMPT`（契约 §22）。
   */
  readonly reason?: string;
}

/** 一次探测允许做什么。 */
export interface ProbeOptions {
  /**
   * 这是运行的目标探测：run 已认领、授权刚复查过。只有这一处可以按计划的
   * `LAUNCH_FROZEN` 冷启动一个 Agent（自动化设计 §4.2）；激活时的探测与写入前
   * 的复核都不起进程。
   */
  readonly coldStart?: boolean;
}

/**
 * 投递方。实现必须尊重超时；`lookup` 的「不知道」包括日志本身读不到，
 * 而「没投递」必须有肯定的、持久的证据。
 */
export interface Dispatcher {
  supports(
    target: AutomationTarget,
    options?: ProbeOptions,
  ): Promise<TargetStatus>;
  dispatch(run: AutomationRun): Promise<AutomationReceipt | undefined>;
  /** 拿整个运行而不只是操作标识：哪本日志记着这张收据是目标的性质。 */
  lookup(run: AutomationRun): Promise<AutomationReceipt | undefined>;
}

/** 投递时重新核一次授权。核的是当初记下来的那份，不是一个活会话。 */
export interface Authorizer {
  verify(
    authorization: Authorization,
    config: AutomationPlanConfig,
  ): Promise<void>;
}

export interface EngineOptions {
  readonly store: ScheduleStore;
  readonly dispatcher: Dispatcher;
  readonly authorizer: Authorizer;
  readonly hostId: string;
  readonly instanceId?: string;
  readonly clock?: () => number;
  /** 独立注入，给时钟跳变的用例。只管进程内的等待，不进任何持久标识。 */
  readonly monotonic?: () => number;
  readonly claimLeaseMs?: number;
  readonly dispatchTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /**
   * 调度三时刻（契约 §27.3）发到哪里：装配时接到事件总线的 `workspace.event`。
   * 只在提交成功之后调；不给就不发（单测与只要内核的调用方）。
   */
  readonly publish?: (workspaceId: string, event: ScheduleEvent) => void;
}

/** 内核发的三种事件：只带标识与稳定码，不带命令、参数与输出。 */
export type ScheduleEvent =
  | {
      readonly type: "schedule.fired";
      readonly planId: string;
      readonly runId: string;
      readonly nodeId?: string;
    }
  | {
      readonly type: "schedule.failed";
      readonly planId: string;
      readonly runId: string;
      readonly nodeId?: string;
      readonly reasonCode: string;
    }
  | {
      readonly type: "schedule.attention";
      readonly planId: string;
      readonly nodeId?: string;
      readonly reasonCode: string;
    };

export interface PlanSnapshot {
  readonly plan: AutomationPlan;
  readonly revision: number;
}

export interface RunSnapshot {
  readonly run: AutomationRun;
  readonly revision: number;
}
