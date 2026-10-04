import { z } from "zod";
import {
  workflowDraftRowSchema,
  workflowFrozenScheduleSchema,
  workflowRunSchema,
  workflowTemplateSchema,
  workflowUpgradeResultSchema,
  type WorkflowDraft,
  type WorkflowDraftRow,
  type WorkflowRunJson,
  type WorkflowTemplateJson,
} from "@armadra/shared";

import {
  RuntimeRequestError,
  json,
  noContentSchema,
  request,
} from "@/api/request";

/**
 * 工作流的调用面（契约 §15.2–§15.3）。路径里没有工作空间：草案与运行按
 * `boardId` 过滤，模板是全局的。
 */

const BASE = "/api/workflows";

const draftsSchema = z.object({ drafts: z.array(workflowDraftRowSchema) });
const draftSchema = z.object({ draft: workflowDraftRowSchema });
const confirmSchema = z.object({
  draft: workflowDraftRowSchema,
  template: workflowTemplateSchema,
});
const templatesSchema = z.object({
  templates: z.array(workflowTemplateSchema),
});
/** 改模板的答复：多一列冻结在旧版本上的计划（契约 §15.6）。 */
const updatedTemplateSchema = z.object({
  template: workflowTemplateSchema,
  frozenSchedules: z.array(workflowFrozenScheduleSchema).default([]),
});
const runsSchema = z.object({ runs: z.array(workflowRunSchema) });
const runSchema = z.object({ run: workflowRunSchema });

function search(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

const id = (value: string) => encodeURIComponent(value);

export const workflowsApi = {
  drafts: (filter: { boardId?: string; status?: string }) =>
    request(`${BASE}/drafts${search(filter)}`, draftsSchema).then(
      (body) => body.drafts,
    ),
  confirmDraft: (
    draftId: string,
    input: { name?: string; draft?: WorkflowDraft },
  ) =>
    request(`${BASE}/drafts/${id(draftId)}/confirm`, confirmSchema, {
      method: "POST",
      ...json(input),
    }),
  discardDraft: (draftId: string) =>
    request(`${BASE}/drafts/${id(draftId)}/discard`, draftSchema, {
      method: "POST",
      ...json({}),
    }).then((body) => body.draft),
  templates: () =>
    request(`${BASE}/templates`, templatesSchema).then(
      (body) => body.templates,
    ),
  updateTemplate: (
    templateId: string,
    input: { name?: string; template: WorkflowDraft },
  ) =>
    request(`${BASE}/templates/${id(templateId)}`, updatedTemplateSchema, {
      method: "PUT",
      ...json(input),
    }),
  /** 把冻结在旧版本上的计划升到模板的当前版本（只升参数相容的）。 */
  upgradeSchedules: (
    templateId: string,
    workspaceId: string,
    scheduleIds: readonly string[],
  ) =>
    request(
      `${BASE}/templates/${id(templateId)}/upgrade-schedules${search({ workspaceId })}`,
      workflowUpgradeResultSchema,
      { method: "POST", ...json({ scheduleIds }) },
    ),
  deleteTemplate: (templateId: string) =>
    request(`${BASE}/templates/${id(templateId)}`, noContentSchema, {
      method: "DELETE",
    }),
  runs: (filter: { templateId?: string; boardId?: string; limit?: number }) =>
    request(`${BASE}/runs${search(filter)}`, runsSchema).then(
      (body) => body.runs,
    ),
  startRun: (input: {
    templateId: string;
    params: Record<string, string>;
    boardId: string;
  }) =>
    request(`${BASE}/runs`, runSchema, { method: "POST", ...json(input) }).then(
      (body) => body.run,
    ),
  cancelRun: (runId: string) =>
    request(`${BASE}/runs/${id(runId)}/cancel`, runSchema, {
      method: "POST",
      ...json({}),
    }).then((body) => body.run),
  answerGate: (
    runId: string,
    stepId: string,
    input: { decision: "approve" | "reject"; note?: string },
  ) =>
    request(`${BASE}/runs/${id(runId)}/gates/${id(stepId)}`, runSchema, {
      method: "POST",
      ...json(input),
    }).then((body) => body.run),
};

export type { WorkflowDraftRow, WorkflowRunJson, WorkflowTemplateJson };

/** core 的拒绝码里页面认得、有专门一句话的那些（其余一律「没有成功」）。 */
const KNOWN_CODES = new Set([
  "missing_param",
  "prompt_too_long",
  "permission_mode_unsupported",
  "invalid_draft",
  "draft_not_pending",
  "template_version_stale",
  "run_finished",
  "gate_not_waiting",
  "forbidden",
  "not_found",
]);

/** 一次失败对应的文案键（`workflow.error.*`）。 */
export function workflowErrorKey(error: unknown): string {
  if (error instanceof RuntimeRequestError && error.code !== undefined) {
    if (KNOWN_CODES.has(error.code)) return `workflow.error.${error.code}`;
  }
  return "workflow.error.generic";
}
