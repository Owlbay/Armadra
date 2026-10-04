import type { DatabaseSync } from "node:sqlite";

/**
 * `workflow_task_runs`：协调者的 `task(agent=…)` 经画布节点执行的记录（补全
 * 架构 §5.3）。这里只有存取；`wait` 动词与 runner 适配器由 G2-4 接上（契约
 * §15.5）。
 *
 * `task_id` 是幂等键：ama 崩溃重试同一个任务时，`start` 先查这里——已有一行且
 * 节点还在，就直接返回那个节点，不起第二个。
 */

export const TASK_RUN_STATUSES = [
  "running",
  "done",
  "failed",
  "stopped",
] as const;
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

export interface TaskRun {
  readonly taskId: string;
  readonly coordinatorNodeId: string;
  readonly runnerId: string;
  readonly nodeId: string;
  readonly status: TaskRunStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly result: unknown;
}

interface TaskRunRecord {
  task_id: string;
  coordinator_node_id: string;
  runner_id: string;
  node_id: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  result_json: string | null;
}

const COLUMNS =
  "task_id, coordinator_node_id, runner_id, node_id, status, started_at, ended_at, result_json";

function taskRunOf(row: TaskRunRecord): TaskRun {
  let result: unknown = null;
  if (row.result_json !== null) {
    try {
      result = JSON.parse(row.result_json) as unknown;
    } catch {
      result = null;
    }
  }
  return {
    taskId: row.task_id,
    coordinatorNodeId: row.coordinator_node_id,
    runnerId: row.runner_id,
    nodeId: row.node_id,
    status: row.status as TaskRunStatus,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    result,
  };
}

/**
 * 记一次 `start`。同一个 `taskId` 已经有一行就原样答回去（`inserted: false`），
 * 调用方据此判断节点还在不在、要不要复用。
 */
export function recordTaskStart(
  database: DatabaseSync,
  task: {
    readonly taskId: string;
    readonly coordinatorNodeId: string;
    readonly runnerId: string;
    readonly nodeId: string;
    readonly now: number;
    /**
     * 第一条任务的正文（`--task`）。记在 `result_json.task`：分派抽屉的「重试」
     * 要把它再投一次（G5-09）；结束时写进的 `text` / `reason` 与它并存。
     */
    readonly task?: string | undefined;
  },
): { readonly inserted: boolean; readonly run: TaskRun } {
  const changes = database
    .prepare(
      `INSERT OR IGNORE INTO workflow_task_runs (${COLUMNS}) VALUES (?, ?, ?, ?, 'running', ?, NULL, ?)`,
    )
    .run(
      task.taskId,
      task.coordinatorNodeId,
      task.runnerId,
      task.nodeId,
      task.now,
      task.task === undefined ? null : JSON.stringify({ task: task.task }),
    );
  return {
    inserted: Number(changes.changes) > 0,
    run: taskRun(database, task.taskId) as TaskRun,
  };
}

export function taskRun(
  database: DatabaseSync,
  taskId: string,
): TaskRun | undefined {
  const row = database
    .prepare(`SELECT ${COLUMNS} FROM workflow_task_runs WHERE task_id = ?`)
    .get(taskId) as TaskRunRecord | undefined;
  return row === undefined ? undefined : taskRunOf(row);
}

/** 任务行里记着的第一条任务正文；没带 `--task` 起的任务没有。 */
export function taskPrompt(run: TaskRun): string | undefined {
  const result = run.result;
  if (result === null || typeof result !== "object") return undefined;
  const task = (result as { task?: unknown }).task;
  return typeof task === "string" && task !== "" ? task : undefined;
}

/** 只留下任务正文的 `result_json`（重开一次时用）。 */
function promptOnly(run: TaskRun | undefined): string | null {
  const task = run === undefined ? undefined : taskPrompt(run);
  return task === undefined ? null : JSON.stringify({ task });
}

/** 重试时节点已经不在了：换成新起的那个节点，状态回到 `running`。 */
export function rebindTask(
  database: DatabaseSync,
  taskId: string,
  nodeId: string,
  now: number,
): void {
  database
    .prepare(
      "UPDATE workflow_task_runs SET node_id = ?, status = 'running', started_at = ?, " +
        "ended_at = NULL, result_json = ? WHERE task_id = ?",
    )
    .run(nodeId, now, promptOnly(taskRun(database, taskId)), taskId);
}

/**
 * 人从分派抽屉点「重试」：已结束的任务回到 `running`、重新计时，节点不变。
 * 只有 `failed` / `stopped` 的才改，答有没有改到。
 */
export function reopenTask(
  database: DatabaseSync,
  taskId: string,
  now: number,
): boolean {
  const changes = database
    .prepare(
      "UPDATE workflow_task_runs SET status = 'running', started_at = ?, ended_at = NULL, " +
        "result_json = ? WHERE task_id = ? AND status IN ('failed','stopped')",
    )
    .run(now, promptOnly(taskRun(database, taskId)), taskId);
  return Number(changes.changes) > 0;
}

/** 结束一次任务。只有还在 `running` 的才改，答有没有改到。 */
export function finishTask(
  database: DatabaseSync,
  taskId: string,
  status: Exclude<TaskRunStatus, "running">,
  result: unknown,
  now: number,
): boolean {
  // 起任务时记下的正文（`task`）留着：结束写的是 `text` / `reason`，两者并存。
  const previous = taskRun(database, taskId);
  const task = previous === undefined ? undefined : taskPrompt(previous);
  const merged =
    task === undefined
      ? result
      : result !== null && typeof result === "object" && !Array.isArray(result)
        ? { ...(result as Record<string, unknown>), task }
        : { task };
  const changes = database
    .prepare(
      "UPDATE workflow_task_runs SET status = ?, ended_at = ?, result_json = ? " +
        "WHERE task_id = ? AND status = 'running'",
    )
    .run(
      status,
      now,
      merged === undefined || merged === null ? null : JSON.stringify(merged),
      taskId,
    );
  return Number(changes.changes) > 0;
}

export function taskRunsFor(
  database: DatabaseSync,
  coordinatorNodeId: string,
): TaskRun[] {
  const rows = database
    .prepare(
      `SELECT ${COLUMNS} FROM workflow_task_runs WHERE coordinator_node_id = ? ORDER BY started_at DESC`,
    )
    .all(coordinatorNodeId) as unknown as TaskRunRecord[];
  return rows.map(taskRunOf);
}

/**
 * 一块画板上的任务行（分派抽屉，契约 §15.7）：协调者节点在这块板上的。新的在
 * 前，最多 `limit` 行。
 */
export function taskRunsForBoard(
  database: DatabaseSync,
  boardId: string,
  limit = 200,
): TaskRun[] {
  const rows = database
    .prepare(
      `SELECT ${COLUMNS} FROM workflow_task_runs WHERE coordinator_node_id IN ` +
        "(SELECT id FROM nodes WHERE board_id = ?) ORDER BY started_at DESC LIMIT ?",
    )
    .all(boardId, limit) as unknown as TaskRunRecord[];
  return rows.map(taskRunOf);
}

/**
 * 页面看到的一行（契约 §15.7）。不带任务正文与成员的结果正文：抽屉只要状态、
 * 时刻与「能不能重试」，正文留在库里。
 */
export function taskRowJson(run: TaskRun): Record<string, unknown> {
  const result = run.result as { reason?: unknown } | null;
  const reason =
    result !== null &&
    typeof result === "object" &&
    typeof result.reason === "string"
      ? result.reason
      : null;
  return {
    taskId: run.taskId,
    coordinatorNodeId: run.coordinatorNodeId,
    runnerId: run.runnerId,
    nodeId: run.nodeId,
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt === null ? null : new Date(run.endedAt).toISOString(),
    reason,
    retryable:
      (run.status === "failed" || run.status === "stopped") &&
      taskPrompt(run) !== undefined,
  };
}

export function taskRunJson(run: TaskRun): Record<string, unknown> {
  return {
    taskId: run.taskId,
    coordinatorNodeId: run.coordinatorNodeId,
    runnerId: run.runnerId,
    nodeId: run.nodeId,
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt === null ? null : new Date(run.endedAt).toISOString(),
    result: run.result ?? null,
  };
}
