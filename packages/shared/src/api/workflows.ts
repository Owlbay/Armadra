import { z } from "zod";

import { AGENT_IDS } from "../agents.js";
import { PERMISSION_MODES } from "../domain/primitives.js";

/**
 * Workflows and runners (contract §15, docs/design/coordinator-agent.md §5).
 *
 * §15.1 the draft JSON (`workflow-propose`'s `args.draft` and a template's
 * body), §15.2 drafts and templates, §15.3 runs, steps and gates, §15.4 the
 * three bus events. G2-4 adds the `wait` verb (§15.5) and G2-3 the automation
 * target (§15.6).
 *
 * The core validates the same rules by hand (`core/workflow/draft.ts`): the
 * core does not depend on this package. A rule changed here is changed there.
 */

/** The three step kinds of a workflow draft. */
export const WORKFLOW_STEP_KINDS = ["prompt", "collect", "gate"] as const;
export const workflowStepKindSchema = z.enum(WORKFLOW_STEP_KINDS);

export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

/** Upper bounds (contract §15.1). */
export const WORKFLOW_LIMITS = {
  title: 160,
  params: 32,
  roles: 8,
  links: 32,
  steps: 32,
  /** A prompt after `{{param}}` substitution: the send body limit. */
  prompt: 2_000,
  model: 120,
  paramValue: 2_000,
} as const;

/** `role.id`, `step.id`: short identifiers a prompt can name. */
export const WORKFLOW_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** `params[].name`, referenced as `{{name}}` in a prompt. */
export const WORKFLOW_PARAM_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CUSTOM_AGENT_PATTERN = /^custom:[A-Za-z0-9._:-]{1,64}$/;

export const WORKFLOW_PARAM_TYPES = ["string", "path", "text"] as const;

const workflowId = z.string().regex(WORKFLOW_ID_PATTERN);

/** A registry id or a `custom:` id. */
export const workflowAgentIdSchema = z
  .string()
  .refine(
    (value) =>
      (AGENT_IDS as readonly string[]).includes(value) ||
      CUSTOM_AGENT_PATTERN.test(value),
    { message: "unknown agentId" },
  );

export const workflowParamSchema = z.object({
  name: z.string().regex(WORKFLOW_PARAM_PATTERN),
  type: z.enum(WORKFLOW_PARAM_TYPES).default("string"),
  label: z.string().max(160).nullish(),
  default: z.string().max(WORKFLOW_LIMITS.paramValue).nullish(),
});

export const workflowRoleSchema = z.object({
  id: workflowId,
  agentId: workflowAgentIdSchema,
  title: z.string().min(1).max(160).nullish(),
  permissionMode: z.enum(PERMISSION_MODES).nullish(),
  model: z.string().min(1).max(WORKFLOW_LIMITS.model).nullish(),
  worktree: z.string().min(1).max(200).nullish(),
});

export const workflowLinkSchema = z.object({
  from: workflowId,
  to: workflowId,
  role: z.enum(["peer", "supervises"]).default("peer"),
});

const after = z.array(workflowId).max(WORKFLOW_LIMITS.steps).default([]);
const promptText = z.string().min(1).max(WORKFLOW_LIMITS.prompt);

export const workflowPromptStepSchema = z.object({
  id: workflowId,
  kind: z.literal("prompt"),
  role: workflowId,
  prompt: promptText,
  after,
});

export const workflowCollectStepSchema = z.object({
  id: workflowId,
  kind: z.literal("collect"),
  role: workflowId,
  from: z.array(workflowId).min(1).max(WORKFLOW_LIMITS.steps),
  prompt: promptText,
  after,
});

export const workflowGateStepSchema = z.object({
  id: workflowId,
  kind: z.literal("gate"),
  label: z.string().min(1).max(160),
  after,
});

export const workflowStepSchema = z.discriminatedUnion("kind", [
  workflowPromptStepSchema,
  workflowCollectStepSchema,
  workflowGateStepSchema,
]);

export const workflowSourceSchema = z.object({
  boardId: z.string().nullish(),
  nodeIds: z.array(z.string()).max(64).nullish(),
  proposedBy: z.string().max(64).nullish(),
  sessionId: z.string().max(200).nullish(),
});

/**
 * The draft JSON (contract §15.1). A template's body is the same shape; its
 * `version` only ever grows.
 */
export const workflowDraftSchema = z
  .object({
    version: z.number().int().min(1),
    title: z.string().min(1).max(WORKFLOW_LIMITS.title),
    params: z
      .array(workflowParamSchema)
      .max(WORKFLOW_LIMITS.params)
      .default([]),
    roles: z.array(workflowRoleSchema).min(1).max(WORKFLOW_LIMITS.roles),
    links: z.array(workflowLinkSchema).max(WORKFLOW_LIMITS.links).default([]),
    steps: z.array(workflowStepSchema).min(1).max(WORKFLOW_LIMITS.steps),
    source: workflowSourceSchema.nullish(),
  })
  .superRefine((draft, context) => {
    const issue = (message: string, path: (string | number)[]) =>
      context.addIssue({ code: "custom", message, path });
    const unique = (ids: string[], where: string) => {
      const seen = new Set<string>();
      ids.forEach((id, index) => {
        if (seen.has(id)) issue(`duplicate ${where} id ${id}`, [where, index]);
        seen.add(id);
      });
      return seen;
    };
    unique(
      draft.params.map((param) => param.name),
      "params",
    );
    const roles = unique(
      draft.roles.map((role) => role.id),
      "roles",
    );
    const steps = unique(
      draft.steps.map((step) => step.id),
      "steps",
    );
    draft.links.forEach((link, index) => {
      if (!roles.has(link.from) || !roles.has(link.to) || link.from === link.to)
        issue("link must join two different roles", ["links", index]);
    });
    draft.steps.forEach((step, index) => {
      if (step.kind !== "gate" && !roles.has(step.role))
        issue(`unknown role ${step.role}`, ["steps", index, "role"]);
      for (const id of step.after) {
        if (!steps.has(id) || id === step.id)
          issue(`unknown step ${id} in after`, ["steps", index, "after"]);
      }
      if (step.kind === "collect") {
        for (const id of step.from) {
          if (!step.after.includes(id))
            issue(`collect source ${id} must be in after`, [
              "steps",
              index,
              "from",
            ]);
        }
      }
    });
    if (hasCycle(draft.steps)) issue("after has a cycle", ["steps"]);
  });

function hasCycle(
  steps: readonly { readonly id: string; readonly after: readonly string[] }[],
): boolean {
  const edges = new Map(steps.map((step) => [step.id, step.after]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    const mark = state.get(id);
    if (mark === 2) return false;
    if (mark === 1) return true;
    state.set(id, 1);
    for (const next of edges.get(id) ?? []) {
      if (edges.has(next) && visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };
  return steps.some((step) => visit(step.id));
}

export type WorkflowDraft = z.infer<typeof workflowDraftSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowRole = z.infer<typeof workflowRoleSchema>;

/* ------------------------------- §15.2 ------------------------------------ */

export const WORKFLOW_DRAFT_STATUSES = [
  "pending",
  "confirmed",
  "discarded",
] as const;

export const workflowDraftRowSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  boardId: z.string(),
  proposerNodeId: z.string().nullable(),
  status: z.enum(WORKFLOW_DRAFT_STATUSES),
  templateId: z.string().nullable(),
  draft: workflowDraftSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workflowTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().min(1),
  createdFromDraft: z.string().nullable(),
  template: workflowDraftSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

/* ------------------------------- §15.3 ------------------------------------ */

export const WORKFLOW_RUN_STATUSES = [
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const WORKFLOW_STEP_STATUSES = [
  "pending",
  "running",
  "waiting",
  "done",
  "failed",
  "skipped",
  "cancelled",
] as const;

export const WORKFLOW_GATE_DECISIONS = ["approve", "reject"] as const;

export const workflowStepOutputSchema = z.object({
  key: z.string(),
  body: z.string(),
  at: z.string(),
  /** The node the `post` was addressed to. */
  target: z.string(),
});

export const workflowRunStepSchema = z.object({
  stepId: z.string(),
  kind: workflowStepKindSchema,
  role: z.string().nullable(),
  status: z.enum(WORKFLOW_STEP_STATUSES),
  nodeId: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  reason: z.string().nullable(),
  outputs: z.array(workflowStepOutputSchema),
  decision: z.enum(WORKFLOW_GATE_DECISIONS).nullable(),
  note: z.string().nullable(),
});

export const workflowRunSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  templateVersion: z.number().int(),
  title: z.string(),
  workspaceId: z.string(),
  boardId: z.string(),
  frameId: z.string().nullable(),
  params: z.record(z.string(), z.string()),
  status: z.enum(WORKFLOW_RUN_STATUSES),
  reason: z.string().nullable(),
  roles: z.record(z.string(), z.string()),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  steps: z.array(workflowRunStepSchema),
});

export type WorkflowRunJson = z.infer<typeof workflowRunSchema>;
export type WorkflowRunStepJson = z.infer<typeof workflowRunStepSchema>;
export type WorkflowTemplateJson = z.infer<typeof workflowTemplateSchema>;
export type WorkflowDraftRow = z.infer<typeof workflowDraftRowSchema>;

/** `workflow_task_runs` (§15.5 is G2-4's; the row shape is defined here). */
export const WORKFLOW_TASK_RUN_STATUSES = [
  "running",
  "done",
  "failed",
  "stopped",
] as const;

export const workflowTaskRunSchema = z.object({
  taskId: z.string(),
  coordinatorNodeId: z.string(),
  runnerId: z.string(),
  nodeId: z.string(),
  status: z.enum(WORKFLOW_TASK_RUN_STATUSES),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  result: z.unknown().nullable(),
});

/* ------------------------------- §15.4 ------------------------------------ */

export const workflowDraftEventSchema = z.object({
  type: z.literal("workflow.draft"),
  draftId: z.string(),
  boardId: z.string(),
  status: z.enum(WORKFLOW_DRAFT_STATUSES),
});

export const workflowRunEventSchema = z.object({
  type: z.literal("workflow.run"),
  runId: z.string(),
  boardId: z.string(),
  status: z.enum(WORKFLOW_RUN_STATUSES),
  stepId: z.string().optional(),
  stepStatus: z.enum(WORKFLOW_STEP_STATUSES).optional(),
});

export const workflowGateEventSchema = z.object({
  type: z.literal("workflow.gate"),
  runId: z.string(),
  boardId: z.string(),
  stepId: z.string(),
  label: z.string(),
  state: z.enum(["waiting", "approved", "rejected", "cancelled"]),
  /** 运行的 Frame（推送深链打开它）。 */
  nodeId: z.string().optional(),
});

/* ------------------------------- §15.6 ------------------------------------ */

/** 自动化目标的种类名（`/api/automations/*` 的 `target.kind`）。 */
export const WORKFLOW_RUN_TARGET_KIND = "AUTOMATION_TARGET_KIND_WORKFLOW_RUN";

/**
 * 自动化目标 `WORKFLOW_RUN` 的 `target.workflowRun`：起哪个模板的哪一版、在哪块
 * 画布上。`templateVersion` 给 0 表示「定义时的当前版」，core 存成具体的数；
 * 之后模板改过，计划到点按 `TARGET_UNSUPPORTED` 跳过，要人重新存。
 */
export const workflowRunTargetSchema = z.object({
  templateId: z.string().min(1).max(128),
  templateVersion: z.number().int().min(0),
  boardId: z.string().min(1).max(128),
});

export type WorkflowRunTarget = z.infer<typeof workflowRunTargetSchema>;

/** 这种计划的载荷：`{"params":{名字:值}}` 的 UTF-8（参数按模板校验）。 */
export const workflowRunPayloadSchema = z.object({
  params: z
    .record(
      z.string().regex(WORKFLOW_PARAM_PATTERN),
      z.string().max(WORKFLOW_LIMITS.paramValue),
    )
    .default({}),
});

export type WorkflowRunPayload = z.infer<typeof workflowRunPayloadSchema>;

/** 计划载荷的文本：键按名字排好，同样的参数总是同一份字节（同一个摘要）。 */
export function workflowRunPayload(params: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const name of Object.keys(params).sort()) {
    sorted[name] = params[name] as string;
  }
  return JSON.stringify({ params: sorted });
}

/** 收据里与工作流目标有关的理由码（`automation_runs.reasonCode`）。 */
export const WORKFLOW_RUN_REASONS = [
  "WORKFLOW_RUNNING",
  "WORKFLOW_WAITING",
  "WORKFLOW_SUCCEEDED",
  "WORKFLOW_FAILED",
  "WORKFLOW_CANCELLED",
] as const;
