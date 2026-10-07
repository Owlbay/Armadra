import { beforeEach, afterEach, expect, it } from "vitest";
import { fixture, type Fixture } from "../workspaces/fixture";
import { createWorkspace } from "../workspaces/table";
import { listBoards } from "../canvas/boards";
import { connect } from "../controller/store";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { runById, effect, taskById } from "./store";
import { recoverRun } from "./recovery";

let core: Fixture, runId: string, taskId: string;
beforeEach(() => {
  core = fixture([]);
  const ws = createWorkspace(core.database, {
    name: "recover",
    rootPath: core.directory,
  });
  const c = connect(core.database, ws.id);
  runId = uuidV7();
  taskId = uuidV7();
  const at = rfc3339();
  core.database
    .prepare(
      "INSERT INTO runs (id,controller_id,workspace_id,board_id,state,max_concurrency,deadline_at,created_at,updated_at) VALUES(?,?,?,?,'running',2,?,?,?)",
    )
    .run(
      runId,
      c.controllerId,
      ws.id,
      listBoards(core.database, ws.id)[0]!.id,
      Date.now() + 3600000,
      at,
      at,
    );
  const deliveryId = uuidV7(),
    nodeId = uuidV7();
  core.database
    .prepare(
      "INSERT INTO run_tasks(id,run_id,task_key,node_id,config_json,prompt,after_json,outputs_json,state,session_id,generation,delivery_id,created_at,updated_at) VALUES(?,?, 'root',?,'{}','do once','[]','[]','starting',?,1,?,?,?)",
    )
    .run(taskId, runId, nodeId, uuidV7(), deliveryId, at, at);
  core.database
    .prepare("INSERT INTO run_node_occupancy VALUES(?,?,?)")
    .run(nodeId, runId, taskId);
});
afterEach(() => core.close());
it("records a crash during startup as uncertain and retains occupancy, even when a pane is alive", async () => {
  effect(
    core.database,
    taskById(core.database, taskId)!,
    "launch",
    "executing",
  );
  await recoverRun(
    core.database,
    runById(core.database, runId)!,
    async () => "alive",
  );
  expect(taskById(core.database, taskId)).toMatchObject({
    state: "blocked",
    reason: "launch_unknown",
  });
  expect(
    core.database.prepare("SELECT state FROM run_effects").get(),
  ).toMatchObject({ state: "uncertain" });
  expect(
    core.database.prepare("SELECT count(*) n FROM run_node_occupancy").get(),
  ).toMatchObject({ n: 1 });
});
it("never puts an executing or unknown delivery back into the queue", async () => {
  const task = taskById(core.database, taskId)!;
  effect(core.database, task, "launch", "applied");
  effect(core.database, task, "delivery", "executing");
  core.database
    .prepare("UPDATE run_tasks SET state='delivering' WHERE id=?")
    .run(taskId);
  const run = runById(core.database, runId)!;
  core.database
    .prepare(
      "INSERT INTO agent_send_queue(id,workspace_id,source_node_id,target_node_id,origin,body,trail,created_at,expires_at,state,source_kind,controller_id,run_id,task_id) VALUES(?,?,NULL,?,'run-task','do once','[]',0,9999999999,'delivering','controller',?,?,?)",
    )
    .run(
      task.delivery_id,
      run.workspace_id,
      task.node_id,
      run.controller_id,
      runId,
      taskId,
    );
  await recoverRun(core.database, run, async () => "alive");
  expect(taskById(core.database, taskId)).toMatchObject({
    state: "blocked",
    reason: "delivery_unknown",
  });
  expect(
    core.database
      .prepare("SELECT state,last_reason FROM agent_send_queue")
      .get(),
  ).toMatchObject({ state: "done", last_reason: "WRITE_FAILED" });
});
it("preserves pending intent and safe queued input, but fails a lost direct session without replay", async () => {
  const task = taskById(core.database, taskId)!;
  effect(core.database, task, "launch", "applied");
  effect(core.database, task, "delivery", "pending");
  core.database
    .prepare("UPDATE run_tasks SET state='delivering' WHERE id=?")
    .run(taskId);
  await recoverRun(
    core.database,
    runById(core.database, runId)!,
    async () => "alive",
  );
  expect(taskById(core.database, taskId)?.state).toBe("delivering");
  await recoverRun(
    core.database,
    runById(core.database, runId)!,
    async () => "lost",
  );
  expect(taskById(core.database, taskId)).toMatchObject({
    state: "failed",
    reason: "session_lost",
  });
});
it("reattaches a surviving tmux binding without pretending its disconnected round is still attributable", async () => {
  const task = taskById(core.database, taskId)!;
  effect(core.database, task, "launch", "applied");
  effect(core.database, task, "delivery", "applied");
  core.database
    .prepare(
      "UPDATE run_tasks SET state='running',acknowledged=1,input_revision=2 WHERE id=?",
    )
    .run(taskId);
  await recoverRun(
    core.database,
    runById(core.database, runId)!,
    async () => "alive",
  );
  expect(taskById(core.database, taskId)).toMatchObject({
    state: "blocked",
    reason: "connection_lost",
  });
  expect(
    core.database
      .prepare("SELECT state FROM run_effects WHERE kind='delivery'")
      .get(),
  ).toMatchObject({ state: "applied" });
});
