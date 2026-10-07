import type { DatabaseSync } from "node:sqlite";
import { rfc3339 } from "../workspaces/support";
import {
  TERMINAL_TASKS,
  type CompletionEvidence,
  type RunState,
  type TaskState,
} from "./evaluate";

export interface RunRow {
  id: string;
  controller_id: string;
  workspace_id: string;
  board_id: string;
  state: RunState;
  reason: string | null;
  max_concurrency: number;
  deadline_at: number;
  event_floor: number;
  created_at: string;
  updated_at: string;
}
export interface TaskRow {
  id: string;
  run_id: string;
  task_key: string;
  node_id: string;
  config_json: string;
  prompt: string;
  after_json: string;
  outputs_json: string;
  state: TaskState;
  reason: string | null;
  session_id: string | null;
  generation: number | null;
  delivery_id: string;
  baseline_seq: number;
  source_baseline: number;
  report_cursor: number;
  acknowledged: number;
  turn_started: number;
  provider_session_id: string | null;
  prompt_hash: string | null;
  input_revision: number | null;
  created_at: string;
  updated_at: string;
}
export function runById(
  database: DatabaseSync,
  id: string,
): RunRow | undefined {
  return database
    .prepare("SELECT * FROM runs WHERE id = ?")
    .get(id) as unknown as RunRow | undefined;
}
export function tasksOf(database: DatabaseSync, runId: string): TaskRow[] {
  return database
    .prepare("SELECT * FROM run_tasks WHERE run_id = ? ORDER BY rowid")
    .all(runId) as unknown as TaskRow[];
}
export function taskById(
  database: DatabaseSync,
  id: string,
): TaskRow | undefined {
  return database
    .prepare("SELECT * FROM run_tasks WHERE id = ?")
    .get(id) as unknown as TaskRow | undefined;
}
export function taskForDelivery(
  database: DatabaseSync,
  id: string,
): TaskRow | undefined {
  return database
    .prepare("SELECT * FROM run_tasks WHERE delivery_id = ?")
    .get(id) as unknown as TaskRow | undefined;
}
export function activeRuns(database: DatabaseSync): RunRow[] {
  return database
    .prepare(
      "SELECT * FROM runs WHERE state NOT IN ('completed','failed','cancelled') ORDER BY rowid",
    )
    .all() as unknown as RunRow[];
}
export function occupied(database: DatabaseSync, nodeId: string): boolean {
  return !!database
    .prepare("SELECT 1 FROM run_node_occupancy WHERE node_id = ?")
    .get(nodeId);
}
export function event(
  database: DatabaseSync,
  runId: string,
  type: string,
  fields: Record<string, unknown> = {},
  taskId?: string,
): number {
  const at = rfc3339();
  const written = database
    .prepare(
      "INSERT INTO run_events (run_id, task_id, event_json, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(runId, taskId ?? null, JSON.stringify({ type, ...fields }), at);
  database
    .prepare("UPDATE runs SET updated_at = ? WHERE id = ?")
    .run(at, runId);
  pruneRunEvents(database, runId);
  return Number(written.lastInsertRowid);
}
export function transitionTask(
  database: DatabaseSync,
  task: TaskRow,
  state: TaskState,
  reason: string | null = null,
): boolean {
  if (task.state === state && task.reason === reason) return false;
  database
    .prepare(
      "UPDATE run_tasks SET state = ?, reason = ?, updated_at = ? WHERE id = ?",
    )
    .run(state, reason, rfc3339(), task.id);
  if (TERMINAL_TASKS.includes(state))
    database
      .prepare("DELETE FROM run_node_occupancy WHERE task_id = ?")
      .run(task.id);
  event(
    database,
    task.run_id,
    "task.changed",
    { taskId: task.id, key: task.task_key, state, reason },
    task.id,
  );
  return true;
}
export function effect(
  database: DatabaseSync,
  task: TaskRow,
  kind: string,
  state: "pending" | "executing" | "applied" | "uncertain",
  detail: Record<string, unknown> = {},
): void {
  const at = rfc3339();
  database
    .prepare(
      "INSERT INTO run_effects (run_id, task_id, kind, state, detail_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, kind) DO UPDATE SET state = excluded.state, detail_json = excluded.detail_json, updated_at = excluded.updated_at",
    )
    .run(task.run_id, task.id, kind, state, JSON.stringify(detail), at, at);
}
export function evidence(task: TaskRow): CompletionEvidence {
  return {
    taskId: task.id,
    runId: task.run_id,
    deliveryId: task.delivery_id,
    nodeId: task.node_id,
    sessionId: task.session_id,
    generation: task.generation,
    baseline: task.baseline_seq,
    sourceBaseline: task.source_baseline,
    acknowledged: !!task.acknowledged,
    promptHash: task.prompt_hash,
    inputRevision: task.input_revision,
    providerSessionId: task.provider_session_id,
    turnStarted: !!task.turn_started,
    state: task.state,
  };
}

export function pruneRunEvents(
  database: DatabaseSync,
  id: string,
  retained = 1000,
): void {
  const cut = database
    .prepare(
      "SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
    )
    .get(id, retained) as { seq: number } | undefined;
  if (!cut) return;
  database
    .prepare("DELETE FROM run_events WHERE run_id = ? AND seq <= ?")
    .run(id, cut.seq);
  database
    .prepare("UPDATE runs SET event_floor = MAX(event_floor, ?) WHERE id = ?")
    .run(cut.seq, id);
}
