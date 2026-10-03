/**
 * 工作流域的形状（契约 §15.1–§15.4）。
 *
 * 与 `packages/shared/src/api/workflows.ts` 的 zod 是同一份说法：core 不依赖
 * `@armadra/shared`，所以这里是手写的类型，校验在 `draft.ts`。改一边就改另一边，
 * `draft.test.ts` 用同样的样本钉住两边的结论。
 */

export const WORKFLOW_STEP_KINDS = ["prompt", "collect", "gate"] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

export const WORKFLOW_PARAM_TYPES = ["string", "path", "text"] as const;
export type WorkflowParamType = (typeof WORKFLOW_PARAM_TYPES)[number];

export const WORKFLOW_LIMITS = {
  title: 160,
  params: 32,
  roles: 8,
  links: 32,
  steps: 32,
  /** 代入参数之后的提示词：就是 `send` 正文的上限。 */
  prompt: 2_000,
  model: 120,
  paramValue: 2_000,
  /** 草案 JSON 序列化之后的字节上限。 */
  draftBytes: 64 * 1024,
} as const;

export const WORKFLOW_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const WORKFLOW_PARAM_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface WorkflowParam {
  readonly name: string;
  readonly type: WorkflowParamType;
  readonly label?: string | null;
  readonly default?: string | null;
}

export interface WorkflowRole {
  readonly id: string;
  readonly agentId: string;
  readonly title?: string | null;
  readonly permissionMode?: string | null;
  readonly model?: string | null;
  readonly worktree?: string | null;
}

export interface WorkflowLink {
  readonly from: string;
  readonly to: string;
  readonly role: "peer" | "supervises";
}

export interface PromptStep {
  readonly id: string;
  readonly kind: "prompt";
  readonly role: string;
  readonly prompt: string;
  readonly after: readonly string[];
}

export interface CollectStep {
  readonly id: string;
  readonly kind: "collect";
  readonly role: string;
  readonly from: readonly string[];
  readonly prompt: string;
  readonly after: readonly string[];
}

export interface GateStep {
  readonly id: string;
  readonly kind: "gate";
  readonly label: string;
  readonly after: readonly string[];
}

export type WorkflowStep = PromptStep | CollectStep | GateStep;

export interface WorkflowSource {
  readonly boardId?: string | null;
  readonly nodeIds?: readonly string[] | null;
  readonly proposedBy?: string | null;
  readonly sessionId?: string | null;
}

/** 草案 JSON；模板的正文是同一个形状。 */
export interface WorkflowDraft {
  readonly version: number;
  readonly title: string;
  readonly params: readonly WorkflowParam[];
  readonly roles: readonly WorkflowRole[];
  readonly links: readonly WorkflowLink[];
  readonly steps: readonly WorkflowStep[];
  readonly source?: WorkflowSource | null;
}

export const DRAFT_STATUSES = ["pending", "confirmed", "discarded"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const RUN_STATUSES = [
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = [
  "pending",
  "running",
  "waiting",
  "done",
  "failed",
  "skipped",
  "cancelled",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** 不会再变的步骤状态。 */
export const STEP_FINAL: readonly StepStatus[] = [
  "done",
  "failed",
  "skipped",
  "cancelled",
];

export const RUN_FINAL: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

export const GATE_DECISIONS = ["approve", "reject"] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

/** 一步的产出：角色节点在这一步里 `canvas post` 的正文。 */
export interface StepOutput {
  readonly key: string;
  readonly body: string;
  readonly at: string;
  /** 这条 `post` 发给了谁（节点 id）。 */
  readonly target: string;
}

export interface StepOutcome {
  readonly outputs?: readonly StepOutput[];
  readonly decision?: GateDecision;
  readonly note?: string;
}

/** 稳定的错误码（契约 §15.2–§15.3）。 */
export const WORKFLOW_ERROR_CODES = [
  "invalid_draft",
  "draft_not_pending",
  "template_version_stale",
  "missing_param",
  "prompt_too_long",
  "permission_mode_unsupported",
  "run_finished",
  "gate_not_waiting",
] as const;
export type WorkflowErrorCode = (typeof WORKFLOW_ERROR_CODES)[number];
