import { z } from "zod";

import {
  WORKFLOW_DRAFT_STATUSES,
  workflowFrozenScheduleSchema,
  workflowRunSchema,
  workflowUpgradeResultSchema,
} from "../api/workflows.js";
import { errors } from "./errors.js";
import { jsonObjectSchema } from "./json.js";
import { meta, oc } from "./meta.js";

/**
 * `workflows.*`（契约 §43.2）：协调者沉淀的草案、模板与按参数起的运行，加关卡
 * 答复（§15.2–§15.3、§15.6）。路径里没有工作空间：草案与运行按 `boardId` 过滤，
 * 模板是本机共用的一份库；服务器壳上的路由门按草案 / 运行 / 画板查出画布再判
 * （`identity/route-access.ts`），改模板只有 owner。
 *
 * 入参只校形状：草案与模板的正文是一份 JSON 对象，长度上限、引用的角色与步骤、
 * 环、Agent 标识等由域里的手写校验判（`core/workflow/draft.ts`，拒绝码
 * `invalid_draft` 等），旧路径与 procedure 走同一份实现，拒绝的码与原话一样；所以
 * 契约不用页面那份带 `superRefine` 的 `workflowDraftSchema`，页面读回时再解析一遍。
 *
 * **关卡答复不是替 Agent 代答**：放行或拦下一次运行，与起跑同一档
 * （`agent:launch`，要运行所在画布上的 operator），不是 `approval:answer`（§23）。
 *
 * 权限与路由表（`core/http/route-scopes.ts`）给旧路径的一致：读是 `canvas:read`，
 * 写是 `agent:launch`。协调者任务的两条读写在 `coordinator.*`（§43.3），路径同属
 * `/api/workflows/`。
 */

const DRAFT = "/api/workflows/drafts/{draftId}";
const TEMPLATE = "/api/workflows/templates/{templateId}";
const RUN = "/api/workflows/runs/{runId}";
const base = { since: "1.12", contract: "§43.2" } as const;

const draftRef = z.object({ draftId: z.string().min(1) });
const templateRef = z.object({ templateId: z.string().min(1) });
const runRef = z.object({ runId: z.string().min(1) });

/** 草案行：正文放宽成 JSON 对象，页面再按 `workflowDraftRowSchema` 解析一遍。 */
const draftRowWire = z.object({
  id: z.string(),
  workspaceId: z.string(),
  boardId: z.string(),
  proposerNodeId: z.string().nullable(),
  status: z.enum(WORKFLOW_DRAFT_STATUSES),
  templateId: z.string().nullable(),
  draft: jsonObjectSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const templateWire = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int(),
  createdFromDraft: z.string().nullable(),
  template: jsonObjectSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workflows = {
  /* --------------------------------- 草案 -------------------------------- */
  /** 一块画板上的草案；服务器壳上必须带 `boardId`，按它查出画布。 */
  drafts: oc
    .input(
      z.object({
        boardId: z.string().optional(),
        status: z.string().optional(),
      }),
    )
    .output(z.object({ drafts: z.array(draftRowWire) }))
    .errors(errors.pick("forbidden"))
    .meta(
      meta({
        ...base,
        scope: "canvas:read",
        legacy: { method: "GET", path: "/api/workflows/drafts" },
      }),
    ),
  draft: oc
    .input(draftRef)
    .output(z.object({ draft: draftRowWire }))
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "canvas:read",
        legacy: { method: "GET", path: DRAFT },
      }),
    ),
  /** 人确认草案：可带改过的名字与正文，确认成模板。 */
  confirmDraft: oc
    .input(
      draftRef.extend({
        name: z.string().optional(),
        draft: jsonObjectSchema.optional(),
      }),
    )
    .output(z.object({ draft: draftRowWire, template: templateWire }))
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "agent:launch",
        legacy: { method: "POST", path: `${DRAFT}/confirm` },
      }),
    ),
  discardDraft: oc
    .input(draftRef)
    .output(z.object({ draft: draftRowWire }))
    .errors(errors.pick("forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "agent:launch",
        legacy: { method: "POST", path: `${DRAFT}/discard` },
      }),
    ),

  /* --------------------------------- 模板 -------------------------------- */
  templates: oc
    .input(z.object({}).optional())
    .output(z.object({ templates: z.array(templateWire) }))
    .errors(errors.pick("forbidden"))
    .meta(
      meta({
        ...base,
        scope: "canvas:read",
        legacy: { method: "GET", path: "/api/workflows/templates" },
      }),
    ),
  /** 新建模板；旧路径答 201，procedure 恒为 200，体相同。 */
  createTemplate: oc
    .input(
      z.object({
        name: z.string().optional(),
        template: jsonObjectSchema.optional(),
      }),
    )
    .output(z.object({ template: templateWire }))
    .errors(errors.pick("bad_request", "forbidden"))
    .meta(
      meta({
        ...base,
        scope: "agent:launch",
        legacy: {
          method: "POST",
          path: "/api/workflows/templates",
          successStatus: 201,
        },
      }),
    ),
  template: oc
    .input(templateRef)
    .output(z.object({ template: templateWire }))
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "canvas:read",
        legacy: { method: "GET", path: TEMPLATE },
      }),
    ),
  /** 改模板（版本只增）；答里多一列冻结在旧版本上的计划（§15.6）。 */
  updateTemplate: oc
    .input(
      templateRef.extend({
        name: z.string().optional(),
        template: jsonObjectSchema.optional(),
      }),
    )
    .output(
      z.object({
        template: templateWire,
        frozenSchedules: z.array(workflowFrozenScheduleSchema),
      }),
    )
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "agent:launch",
        legacy: { method: "PUT", path: TEMPLATE },
      }),
    ),
  /**
   * 把冻结在旧版本上的计划升到模板的当前版本（只升参数相容的）。计划所在的工作空间
   * 在 `workspaceId`；旧路径把它放在查询串里（`?workspaceId=`），两种拼法都收。
   */
  upgradeSchedules: oc
    .input(
      templateRef.extend({
        workspaceId: z.string().optional(),
        scheduleIds: z.array(z.string()).optional(),
      }),
    )
    .output(workflowUpgradeResultSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "agent:launch",
        legacy: { method: "POST", path: `${TEMPLATE}/upgrade-schedules` },
      }),
    ),
  /** 删模板；答 204。 */
  deleteTemplate: oc
    .input(templateRef)
    .output(z.void())
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "agent:launch",
        legacy: { method: "DELETE", path: TEMPLATE, successStatus: 204 },
      }),
    ),

  /* --------------------------------- 运行 -------------------------------- */
  /** 运行记录；`limit` 缺省 50，旧路径上是字符串，两种拼法都收。 */
  runs: oc
    .input(
      z.object({
        templateId: z.string().optional(),
        boardId: z.string().optional(),
        limit: z.union([z.number(), z.string()]).optional(),
      }),
    )
    .output(z.object({ runs: z.array(workflowRunSchema) }))
    .errors(errors.pick("forbidden"))
    .meta(
      meta({
        ...base,
        scope: "canvas:read",
        legacy: { method: "GET", path: "/api/workflows/runs" },
      }),
    ),
  /** 起一次运行：开节点与 Agent，要 operator；旧路径答 201，procedure 恒为 200。 */
  startRun: oc
    .input(
      z.object({
        templateId: z.string().optional(),
        params: jsonObjectSchema.optional(),
        boardId: z.string().optional(),
      }),
    )
    .output(z.object({ run: workflowRunSchema }))
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "agent:launch",
        legacy: {
          method: "POST",
          path: "/api/workflows/runs",
          successStatus: 201,
        },
      }),
    ),
  run: oc
    .input(runRef)
    .output(z.object({ run: workflowRunSchema }))
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "canvas:read",
        legacy: { method: "GET", path: RUN },
      }),
    ),
  cancelRun: oc
    .input(runRef)
    .output(z.object({ run: workflowRunSchema }))
    .errors(errors.pick("forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "agent:launch",
        legacy: { method: "POST", path: `${RUN}/cancel` },
      }),
    ),
  /** 答一道关卡：放行或拦下（`decision` 是 `approve` / `reject`）；不是替 Agent 代答。 */
  answerGate: oc
    .input(
      runRef.extend({
        stepId: z.string().min(1),
        decision: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .output(z.object({ run: workflowRunSchema }))
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "agent:launch",
        legacy: { method: "POST", path: `${RUN}/gates/{stepId}` },
      }),
    ),
};
