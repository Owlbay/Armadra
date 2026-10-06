import { z } from "zod";

import { WORKFLOW_TASK_RUN_STATUSES } from "../api/workflows.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `coordinator.*`（契约 §43.3）：分派抽屉的两条调用（§15.7）——协调者在一块画板上
 * 分派出去的任务，与失败行的「重试」。路径同属 `/api/workflows/`，实现与 `workflows.*`
 * 同在 `core/workflow/`。
 *
 * 一行只带状态、时刻与「能不能重试」，不带任务提示词与成员的结果正文（正文留在库里）。
 * 重试是再投一次任务提示词，与起跑同一档（`agent:launch`，要任务所在画布上的
 * operator）；投递仍经协作域的投递门，不替人回答权限提示。
 */

const base = { since: "1.12", contract: "§43.3" } as const;

const taskRowWire = z.object({
  taskId: z.string(),
  coordinatorNodeId: z.string(),
  runnerId: z.string(),
  nodeId: z.string(),
  status: z.enum(WORKFLOW_TASK_RUN_STATUSES),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  reason: z.string().nullable(),
  retryable: z.boolean(),
});

export const coordinator = {
  /** 一块画板上的任务；服务器壳上必须带 `boardId`，按它查出画布。 */
  tasks: oc
    .input(z.object({ boardId: z.string().optional() }))
    .output(z.object({ tasks: z.array(taskRowWire) }))
    .errors(errors.pick("forbidden"))
    .meta(
      meta({
        ...base,
        scope: "canvas:read",
        legacy: { method: "GET", path: "/api/workflows/tasks" },
      }),
    ),
  /** 重试一条失败或已停的任务。 */
  retry: oc
    .input(z.object({ taskId: z.string().min(1) }))
    .output(z.object({ task: taskRowWire }))
    .errors(errors.pick("forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "agent:launch",
        legacy: { method: "POST", path: "/api/workflows/tasks/{taskId}/retry" },
      }),
    ),
};
