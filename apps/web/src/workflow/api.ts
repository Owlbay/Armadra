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

import { currentClient } from "@/api/client";
import { RuntimeRequestError } from "@/api/request";

/**
 * 工作流的调用面（契约 §15.2–§15.3、§43.2）：经 `workflows.*` procedure，答案照旧
 * 过页面自己的 schema（草案与模板的正文在契约里是一份 JSON 对象，这里再按带上限
 * 与交叉校验的 `workflowDraftSchema` 解析一遍）。路径里没有工作空间：草案与运行
 * 按 `boardId` 过滤，模板是全局的。
 */

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

/** 去掉没给的键（procedure 的入参不收 `undefined`）。 */
function given<T extends Record<string, string | number | undefined>>(
  values: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export const workflowsApi = {
  drafts: async (filter: { boardId?: string; status?: string }) =>
    draftsSchema.parse(await currentClient().workflows.drafts(given(filter)))
      .drafts,
  confirmDraft: async (
    draftId: string,
    input: { name?: string; draft?: WorkflowDraft },
  ) =>
    confirmSchema.parse(
      await currentClient().workflows.confirmDraft({ draftId, ...input }),
    ),
  discardDraft: async (draftId: string) =>
    draftSchema.parse(await currentClient().workflows.discardDraft({ draftId }))
      .draft,
  templates: async () =>
    templatesSchema.parse(await currentClient().workflows.templates())
      .templates,
  updateTemplate: async (
    templateId: string,
    input: { name?: string; template: WorkflowDraft },
  ) =>
    updatedTemplateSchema.parse(
      await currentClient().workflows.updateTemplate({ templateId, ...input }),
    ),
  /** 把冻结在旧版本上的计划升到模板的当前版本（只升参数相容的）。 */
  upgradeSchedules: async (
    templateId: string,
    workspaceId: string,
    scheduleIds: readonly string[],
  ) =>
    workflowUpgradeResultSchema.parse(
      await currentClient().workflows.upgradeSchedules({
        templateId,
        workspaceId,
        scheduleIds: [...scheduleIds],
      }),
    ),
  deleteTemplate: async (templateId: string) => {
    await currentClient().workflows.deleteTemplate({ templateId });
  },
  runs: async (filter: {
    templateId?: string;
    boardId?: string;
    limit?: number;
  }) =>
    runsSchema.parse(await currentClient().workflows.runs(given(filter))).runs,
  startRun: async (input: {
    templateId: string;
    params: Record<string, string>;
    boardId: string;
  }) => runSchema.parse(await currentClient().workflows.startRun(input)).run,
  cancelRun: async (runId: string) =>
    runSchema.parse(await currentClient().workflows.cancelRun({ runId })).run,
  answerGate: async (
    runId: string,
    stepId: string,
    input: { decision: "approve" | "reject"; note?: string },
  ) =>
    runSchema.parse(
      await currentClient().workflows.answerGate({ runId, stepId, ...input }),
    ).run,
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
