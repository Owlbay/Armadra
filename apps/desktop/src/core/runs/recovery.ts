import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../controller/store";
import {
  effect,
  event,
  tasksOf,
  transitionTask,
  type RunRow,
  type TaskRow,
} from "./store";
import { TERMINAL_TASKS, aggregateRun, runnable } from "./evaluate";

/** Reconcile persisted evidence, never repeat an unknown external effect. */
export async function recoverRun(
  database: DatabaseSync,
  run: RunRow,
  bindingState: (task: TaskRow) => Promise<"alive" | "lost" | "unknown">,
): Promise<void> {
  for (const task of tasksOf(database, run.id)) {
    if (TERMINAL_TASKS.includes(task.state) || task.state === "pending")
      continue;
    const intents = database
      .prepare("SELECT kind, state FROM run_effects WHERE task_id = ?")
      .all(task.id) as { kind: string; state: string }[];
    const intent = (kind: string) =>
      intents.find((row) => row.kind === kind)?.state;
    const actual =
      task.session_id && task.generation !== null
        ? await bindingState(task)
        : "unknown";
    transaction(database, () => {
      if (["executing", "uncertain"].includes(intent("delivery") ?? "")) {
        effect(database, task, "delivery", "uncertain", {
          reason: "core_restart",
        });
        database
          .prepare(
            "UPDATE agent_send_queue SET state = 'done', last_reason = 'WRITE_FAILED' WHERE id = ? AND state IN ('queued','delivering')",
          )
          .run(task.delivery_id);
        transitionTask(database, task, "blocked", "delivery_unknown");
      } else if (
        ["executing", "uncertain"].includes(intent("launch") ?? "") ||
        ["executing", "uncertain"].includes(intent("launch-write") ?? "")
      ) {
        effect(database, task, "launch", "uncertain", {
          reason: "core_restart",
        });
        transitionTask(
          database,
          task,
          "blocked",
          intent("launch-write") === "executing"
            ? "launch_write_unknown"
            : "launch_unknown",
        );
      } else if (actual === "lost") {
        transitionTask(database, task, "failed", "session_lost");
        database
          .prepare(
            "UPDATE agent_send_queue SET state = 'cancelled', last_reason = 'SESSION_LOST' WHERE id = ? AND state = 'queued'",
          )
          .run(task.delivery_id);
      } else if (task.acknowledged) {
        // An attached tmux pane is not proof that no other input occurred while core was gone.
        transitionTask(database, task, "blocked", "connection_lost");
      } else if (actual === "unknown")
        transitionTask(database, task, "blocked", "connection_lost");
      else
        event(
          database,
          run.id,
          "recovery.ready",
          {
            taskId: task.id,
            sessionId: task.session_id,
            generation: task.generation,
          },
          task.id,
        );
      if (["executing", "uncertain"].includes(intent("cancel") ?? ""))
        effect(database, task, "cancel", "uncertain", {
          reason: "core_restart",
        });
    });
  }
  transaction(database, () => {
    const rows = tasksOf(database, run.id),
      byKey = new Map(rows.map((task) => [task.task_key, task]));
    for (const task of rows)
      if (
        task.state === "pending" &&
        (JSON.parse(task.after_json) as string[]).some((key) =>
          ["failed", "cancelled", "skipped"].includes(byKey.get(key)!.state),
        )
      )
        transitionTask(database, task, "skipped", "upstream_failed");
    if (run.state !== "cancelling") {
      const tasks = tasksOf(database, run.id),
        state = aggregateRun(
          tasks.map((task) => task.state),
          tasks.some(
            (task) =>
              task.state === "pending" &&
              runnable(
                (JSON.parse(task.after_json) as string[]).map(
                  (key) => tasks.find((row) => row.task_key === key)!.state,
                ),
              ),
          ),
        );
      database
        .prepare("UPDATE runs SET state = ? WHERE id = ?")
        .run(state, run.id);
      event(database, run.id, "run.recovered", { state });
    }
  });
}
