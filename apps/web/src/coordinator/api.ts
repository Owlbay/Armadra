import { z } from "zod";

import { json, request } from "@/api/request";

/**
 * 分派抽屉的调用面（契约 §15.7）：协调者在这块画板上分派出去的任务，与失败行
 * 的「重试」。正文（任务提示词、成员的结果）不在答复里。
 */

export const TASK_STATUSES = ["running", "done", "failed", "stopped"] as const;

export const dispatchTaskSchema = z.object({
  taskId: z.string(),
  coordinatorNodeId: z.string(),
  runnerId: z.string(),
  nodeId: z.string(),
  status: z.enum(TASK_STATUSES),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  reason: z.string().nullable().default(null),
  retryable: z.boolean().default(false),
});

export type DispatchTask = z.infer<typeof dispatchTaskSchema>;

const tasksSchema = z.object({ tasks: z.array(dispatchTaskSchema) });
const taskSchema = z.object({ task: dispatchTaskSchema });

export const coordinatorKeys = {
  /** 挂在 `workflow` 之下：`workflow.*` 帧整组重读时它跟着重读。 */
  tasks: (boardId: string) => ["workflow", "tasks", boardId] as const,
};

export const coordinatorApi = {
  tasks: (boardId: string) =>
    request(
      `/api/workflows/tasks?boardId=${encodeURIComponent(boardId)}`,
      tasksSchema,
    ).then((body) => body.tasks),
  retry: (taskId: string) =>
    request(
      `/api/workflows/tasks/${encodeURIComponent(taskId)}/retry`,
      taskSchema,
      { method: "POST", ...json({}) },
    ).then((body) => body.task),
};
