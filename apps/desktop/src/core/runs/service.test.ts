import { beforeEach, afterEach, expect, it } from "vitest";
import type { ControllerCommand } from "@armadra/shared";
import { fixture, type Fixture } from "../workspaces/fixture";
import { createWorkspace } from "../workspaces/table";
import { listBoards } from "../canvas/boards";
import { loadBoard } from "../canvas/documents";
import { loadNode, loadSession } from "../collab/nodes";
import { collabContext, type CollabContext } from "../collab/service";
import { stubTerminal } from "../agent/fixture";
import { SendPump } from "../collab/send-pump";
import { ControllerService } from "../controller/service";
import { authenticate, type ControllerActor } from "../controller/store";
import { uuidV7, rfc3339 } from "../workspaces/support";
import { RunService } from "./service";
import { recordTrustedReport } from "./reports";

let core: Fixture,
  controller: ControllerService,
  runs: RunService,
  actor: ControllerActor;
let token: string,
  boardId: string,
  workspaceId: string,
  clock: number,
  nodeIds: Record<string, string>;
let collab: CollabContext, pump: SendPump;
let terminal: ReturnType<typeof stubTerminal>;
let spawned: string[],
  revisions: Map<string, number>,
  reportCounts: Map<string, number>;
const call = (
  method: ControllerCommand["method"],
  params: Record<string, unknown>,
  key?: string,
) =>
  controller.dispatch(
    {
      schemaVersion: 1,
      requestId: "test",
      instanceId: "instance",
      method,
      params,
      ...(key ? { idempotencyKey: key } : {}),
    },
    token,
  ) as Promise<any>;
const input = (keys = ["implement", "review"]) => ({
  schemaVersion: 1,
  expectedUpdatedAt: loadBoard(core.database, workspaceId, boardId).board
    .updatedAt,
  tasks: keys.map((key, i) => ({
    key,
    nodeId: nodeIds[key],
    prompt: `Do ${key}; write reports/${key}.md`,
    after: i === 0 ? [] : [keys[i - 1]],
    outputs: [`reports/${key}.md`],
  })),
  maxConcurrency: 2,
  deadlineSeconds: 3600,
});

beforeEach(async () => {
  core = fixture([]);
  workspaceId = createWorkspace(core.database, {
    name: "isolated",
    rootPath: core.directory,
    permissions: { read: true, write: true, execute: true },
  }).id;
  boardId = listBoards(core.database, workspaceId)[0]!.id;
  clock = Date.now();
  spawned = [];
  revisions = new Map();
  reportCounts = new Map();
  terminal = stubTerminal();
  terminal.bridge.generation = (sessionId) => {
    const row = core.database
      .prepare("SELECT generation, status FROM terminal_sessions WHERE id = ?")
      .get(sessionId) as any;
    return row?.status === "running" ? row.generation : undefined;
  };
  terminal.bridge.spawnForNode = async (request) => {
    const sessionId = uuidV7();
    spawned.push(request.nodeId);
    revisions.set(sessionId, 0);
    core.database
      .prepare(
        "INSERT INTO terminal_sessions (id, session_key, workspace_id, owner_node_id, cwd, shell, kind, backend_kind, generation, status, agent_id, attach_state, created_at) VALUES (?, ?, ?, ?, ?, '/bin/sh', 'terminal', 'direct', 1, 'running', ?, 'detached', ?)",
      )
      .run(
        sessionId,
        sessionId,
        workspaceId,
        request.nodeId,
        core.directory,
        request.agentId,
        rfc3339(),
      );
    return { sessionId, generation: 1 };
  };
  terminal.bridge.foreground = async (sessionId) => ({
    command: (
      core.database
        .prepare("SELECT agent_id FROM terminal_sessions WHERE id = ?")
        .get(sessionId) as any
    )?.agent_id,
  });
  terminal.bridge.inputRevision = (sessionId) => revisions.get(sessionId);
  terminal.bridge.terminateBound = async (sessionId, generation) => {
    if (terminal.bridge.generation(sessionId) !== generation)
      throw new Error("generation changed");
    terminal.terminated.push(sessionId);
  };
  terminal.bridge.isCurrentNodeSession = async (
    nodeId,
    sessionId,
    generation,
  ) => {
    const session = loadSession(core.database, nodeId);
    return (
      session?.sessionId === sessionId &&
      session.generation === generation &&
      session.status === "running"
    );
  };
  terminal.bridge.writeSubmit = async (sessionId, generation, data, driver) => {
    if (terminal.submitError) throw terminal.submitError;
    revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
    terminal.submits.push({ sessionId, generation, data, driver });
    return { inputRevision: revisions.get(sessionId)! };
  };
  collab = collabContext({
    database: core.database,
    settings: { customAgents: () => [] },
    dataDir: core.directory,
    terminals: terminal.bridge,
    audience: () => 0,
    now: () => new Date(clock),
    publish: (id, event) =>
      core.bus.emit("workspace.event", { workspaceId: id, event }),
    nudge: () => {},
  });
  runs = new RunService({
    context: core,
    collab: () => collab,
    clock: () => clock,
    delay: async (ms) => {
      clock += ms;
    },
    sweepEveryMs: false,
    probe: () => ({ installed: true, trustedCompletion: true }),
    sourceRevision: () => 0,
  });
  controller = new ControllerService(core, "instance", { runs });
  const connected = await call("connect", { workspaceId });
  token = connected.credential;
  actor = authenticate(core.database, token);
  const board = loadBoard(core.database, workspaceId, boardId);
  const made = await call(
    "graph.apply",
    {
      boardId,
      input: {
        schemaVersion: 1,
        expectedUpdatedAt: board.board.updatedAt,
        operations: ["implement", "review", "independent", "other"].map(
          (key) => ({
            op: "createNode",
            key,
            type: "terminal",
            title: key,
            data: {
              kind: "terminal",
              agent: { id: key === "review" ? "claude" : "codex" },
            },
          }),
        ),
      },
    },
    "graph",
  );
  nodeIds = made.nodeIds;
  pump = new SendPump(() => collab);
});
afterEach(async () => {
  pump.stop();
  await runs.stop();
  core.close();
});

function report(
  key: string,
  event: {
    state: string;
    newTurn?: boolean;
    errored?: boolean;
    interrupted?: boolean;
  },
  prompt?: string,
  revision?: number,
) {
  const session = loadSession(core.database, nodeIds[key]!)!;
  revision ??= (reportCounts.get(key) ?? 0) + 1;
  reportCounts.set(key, Math.max(revision, reportCounts.get(key) ?? 0));
  return recordTrustedReport(
    core.database,
    {
      sessionId: session.sessionId,
      generation: session.generation,
      sourceRevision: String(revision),
    },
    {
      nodeId: nodeIds[key]!,
      agentId: loadNode(core.database, nodeIds[key]!)!.agentId!,
      kind: "state",
      stateSource: "hook",
      verified: true,
      sessionId: `provider-${key}`,
      ...event,
    } as any,
    prompt ? { prompt } : {},
    core.bus,
  );
}
async function startRound(key: string) {
  await pump.drain(nodeIds[key]!);
  const submit = terminal.submits.find(
    (item) =>
      item.sessionId === loadSession(core.database, nodeIds[key]!)?.sessionId,
  )!;
  expect(submit).toBeDefined();
  report(key, { state: "working", newTurn: true }, submit.data);
  await runs.sweep();
}

it("persists a run immediately, starts roots off-page, and only starts review after this acknowledged trusted turn", async () => {
  const started = await call("run.start", { boardId, input: input() }, "start");
  expect(started.runId).toBeTruthy();
  expect(spawned).toHaveLength(0);
  await runs.sweep();
  expect(spawned).toEqual([nodeIds.implement]);
  expect(
    core.database
      .prepare(
        "SELECT source_kind, source_node_id, controller_id, run_id, task_id FROM agent_send_queue",
      )
      .get(),
  ).toMatchObject({
    source_kind: "controller",
    source_node_id: null,
    controller_id: actor.controllerId,
    run_id: started.runId,
  });
  report("implement", { state: "done" }, undefined, 1);
  await runs.sweep();
  expect(spawned).toHaveLength(1);
  await startRound("implement");
  report("implement", { state: "done" }, undefined, 3);
  await runs.sweep();
  expect(spawned).toEqual([nodeIds.implement, nodeIds.review]);
  await startRound("review");
  report("review", { state: "done" }, undefined, 2);
  await runs.sweep();
  expect(await call("run.get", { runId: started.runId })).toMatchObject({
    state: "completed",
    tasks: [{ state: "completed" }, { state: "completed" }],
  });
  expect(terminal.submits).toHaveLength(2);
  expect(terminal.submits[0]?.driver).toMatchObject({
    kind: "controller",
    controllerId: actor.controllerId,
  });
});

it("returns the same run on concurrent retries, rejects another owner and node occupation, and validates DAG atomically", async () => {
  const params = { boardId, input: input() };
  const [first, second] = await Promise.all([
    call("run.start", params, "once"),
    call("run.start", params, "once"),
  ]);
  expect(first).toEqual(second);
  await expect(call("run.start", params, "another")).rejects.toMatchObject({
    code: "node_busy",
  });
  await expect(
    call(
      "run.start",
      { ...params, input: { ...params.input, maxConcurrency: 4 } },
      "once",
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  const cyclic = input(["independent", "other"]);
  cyclic.tasks[0]!.after = ["other"];
  await expect(
    call("run.start", { boardId, input: cyclic }, "cycle"),
  ).rejects.toMatchObject({ code: "dependency_cycle" });
  expect(
    core.database.prepare("SELECT count(*) n FROM runs").get(),
  ).toMatchObject({ n: 1 });
});

it("enforces controller-wide concurrency across independent runs", async () => {
  const root = input(["implement", "review"]);
  root.tasks[1]!.after = [];
  const another = input(["independent", "other"]);
  another.tasks[1]!.after = [];
  await call("run.start", { boardId, input: root }, "first");
  await call("run.start", { boardId, input: another }, "second");
  await runs.sweep();
  expect(spawned).toHaveLength(2);
  await runs.sweep();
  expect(spawned).toHaveLength(2);
});

it("keeps uncertain delivery blocked, does not resubmit, and skips a failed upstream's descendants", async () => {
  const started = await call(
    "run.start",
    { boardId, input: input() },
    "unknown",
  );
  await runs.sweep();
  terminal.submitError = new Error("write lost after external effect");
  await pump.drain(nodeIds.implement!);
  await runs.sweep();
  expect(
    (await call("run.get", { runId: started.runId })).tasks[0],
  ).toMatchObject({ state: "blocked", reason: "delivery_unknown" });
  terminal.submitError = undefined;
  await pump.drain(nodeIds.implement!);
  expect(terminal.submits).toHaveLength(0);
  expect(
    core.database
      .prepare("SELECT state FROM run_effects WHERE kind = 'delivery'")
      .get(),
  ).toMatchObject({ state: "uncertain" });
});

it("waits finitely without cancelling and cancels only this run's bound generation", async () => {
  const unrelated = await terminal.bridge.spawnForNode!({
    workspaceId,
    nodeId: nodeIds.other!,
    agentId: "codex",
    cwd: core.directory,
  });
  const started = await call("run.start", { boardId, input: input() }, "run");
  await runs.sweep();
  const snapshot = await call("run.get", { runId: started.runId });
  expect(
    await call("run.wait", {
      runId: started.runId,
      cursor: snapshot.cursor,
      timeoutSeconds: 0,
    }),
  ).toMatchObject({ timedOut: true });
  const first = await call("run.cancel", { runId: started.runId }, "cancel");
  expect(await call("run.cancel", { runId: started.runId }, "cancel")).toEqual(
    first,
  );
  await runs.sweep();
  expect(terminal.terminated).not.toContain(unrelated.sessionId);
  expect(terminal.terminated).toEqual([snapshot.tasks[0].sessionId]);
  expect((await call("run.get", { runId: started.runId })).state).toBe(
    "cancelled",
  );
});

it("revocation stops pending work and future queue submission", async () => {
  const started = await call(
    "run.start",
    { boardId, input: input() },
    "revoke",
  );
  await runs.sweep();
  await call("disconnect", {});
  await pump.drain(nodeIds.implement!);
  await runs.sweep();
  expect(terminal.submits).toHaveLength(0);
  expect(
    core.database
      .prepare("SELECT state, reason FROM run_tasks WHERE run_id = ?")
      .all(started.runId),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        state: "blocked",
        reason: "authorization_revoked",
      }),
    ]),
  );
  await expect(call("run.get", { runId: started.runId })).rejects.toMatchObject(
    { code: "authorization_revoked" },
  );
});

it("keeps unknown launches inside the concurrency budget", async () => {
  const plan = input(["implement", "review", "independent", "other"]);
  for (const task of plan.tasks) task.after = [];
  terminal.bridge.spawnForNode = async (request) => {
    spawned.push(request.nodeId);
    throw new Error("spawn result lost");
  };
  const started = await call(
    "run.start",
    { boardId, input: plan },
    "unknown-launch",
  );
  await runs.sweep();
  await runs.sweep();
  expect(spawned).toHaveLength(2);
  expect(
    (await call("run.get", { runId: started.runId })).tasks.slice(0, 2),
  ).toEqual([
    expect.objectContaining({ state: "blocked", reason: "launch_unknown" }),
    expect.objectContaining({ state: "blocked", reason: "launch_unknown" }),
  ]);
});

it("skips failed dependencies while unrelated branches continue", async () => {
  const plan = input(["implement", "review", "independent"]);
  plan.tasks[2]!.after = [];
  const started = await call("run.start", { boardId, input: plan }, "branches");
  await runs.sweep();
  await startRound("implement");
  report("implement", { state: "done", errored: true });
  await runs.sweep();
  let snapshot = await call("run.get", { runId: started.runId });
  expect(snapshot.tasks[0]).toMatchObject({
    state: "failed",
    reason: "agent_error",
  });
  expect(snapshot.tasks[1]).toMatchObject({
    state: "skipped",
    reason: "upstream_failed",
  });
  expect(spawned).not.toContain(nodeIds.review);
  await startRound("independent");
  report("independent", { state: "done" });
  await runs.sweep();
  snapshot = await call("run.get", { runId: started.runId });
  expect(snapshot.state).toBe("failed");
  expect(snapshot.tasks[2].state).toBe("completed");
});

it("does not create phantom state changes by replaying a wait, and accepts a late prompt-start before its Stop", async () => {
  const started = await call(
    "run.start",
    { boardId, input: input() },
    "report-order",
  );
  await runs.sweep();
  await startRound("implement");
  report("implement", { state: "blocked" });
  await runs.sweep();
  const before = await call("run.get", { runId: started.runId });
  await runs.sweep();
  const unchanged = await call("run.get", { runId: started.runId });
  expect(unchanged.cursor).toBe(before.cursor);
  report("implement", { state: "done" });
  await runs.sweep();
  await runs.sweep();
  await pump.drain(nodeIds.review!);
  const review = terminal.submits.find(
    (item) =>
      item.sessionId === loadSession(core.database, nodeIds.review!)!.sessionId,
  )!;
  report("review", { state: "done" }, undefined, 2);
  await runs.sweep();
  expect((await call("run.get", { runId: started.runId })).state).not.toBe(
    "completed",
  );
  report("review", { state: "working", newTurn: true }, review.data, 1);
  await runs.sweep();
  expect((await call("run.get", { runId: started.runId })).state).toBe(
    "completed",
  );
});

it("deleting a node fails its task and never releases its downstream", async () => {
  const started = await call(
    "run.start",
    { boardId, input: input() },
    "delete",
  );
  await runs.sweep();
  core.database
    .prepare("DELETE FROM nodes WHERE id = ?")
    .run(nodeIds.implement!);
  await runs.sweep();
  await runs.sweep();
  const snapshot = await call("run.get", { runId: started.runId });
  expect(snapshot.tasks[0]).toMatchObject({
    state: "failed",
    reason: "node_deleted",
  });
  expect(snapshot.tasks[1].state).toBe("skipped");
  expect(spawned).not.toContain(nodeIds.review);
});

it("cancellation during an acknowledged-write gap stays scoped and never replays the task", async () => {
  const started = await call(
    "run.start",
    { boardId, input: input() },
    "write-race",
  );
  await runs.sweep();
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = terminal.bridge.writeSubmit!;
  terminal.bridge.writeSubmit = async (...args) => {
    const receipt = await original(...args);
    entered();
    await held;
    return receipt;
  };
  const delivery = pump.drain(nodeIds.implement!);
  await reached;
  const cancelled = await call(
    "run.cancel",
    { runId: started.runId },
    "cancel-write-race",
  );
  await runs.sweep();
  release();
  await delivery;
  await runs.sweep();
  expect(
    await call("run.cancel", { runId: started.runId }, "cancel-write-race"),
  ).toEqual(cancelled);
  expect((await call("run.get", { runId: started.runId })).state).toBe(
    "cancelled",
  );
  expect(terminal.submits).toHaveLength(1);
  expect(terminal.terminated).toHaveLength(1);
  expect(spawned).not.toContain(nodeIds.review);
});

it("trusted completion committed before cancel wins and is not claimed to have rolled back", async () => {
  const started = await call(
    "run.start",
    { boardId, input: input(["implement"]) },
    "finish-race",
  );
  await runs.sweep();
  await startRound("implement");
  report("implement", { state: "done" });
  expect(
    await call("run.cancel", { runId: started.runId }, "cancel-finished"),
  ).toMatchObject({ state: "completed", alreadyTerminal: true });
  expect(terminal.terminated).toHaveLength(0);
});

it("deadline expiry uses the same cancellation path and keeps its reason", async () => {
  const plan = input();
  plan.deadlineSeconds = 1;
  const started = await call("run.start", { boardId, input: plan }, "deadline");
  await runs.sweep();
  clock += 10000;
  await runs.sweep();
  expect(await call("run.get", { runId: started.runId })).toMatchObject({
    state: "cancelled",
    reason: "deadline_exceeded",
  });
  expect(terminal.terminated).toHaveLength(1);
  expect(spawned).not.toContain(nodeIds.review);
});

it("revokes a currently waiting reader instead of returning a snapshot with stale authorization", async () => {
  const started = await call(
    "run.start",
    { boardId, input: input() },
    "wait-revoke",
  );
  const snapshot = await call("run.get", { runId: started.runId });
  const waiting = runs.wait(actor, started.runId, snapshot.cursor, 30);
  const rejected = expect(waiting).rejects.toMatchObject({
    code: "authorization_revoked",
  });
  await call("disconnect", {});
  await rejected;
  expect(terminal.submits).toHaveLength(0);
});

it("a disconnected waiter releases itself without cancelling the persisted run", async () => {
  const started = await call(
    "run.start",
    { boardId, input: input() },
    "wait-abort",
  );
  const snapshot = await call("run.get", { runId: started.runId });
  const abort = new AbortController();
  const waiting = runs.wait(
    actor,
    started.runId,
    snapshot.cursor,
    30,
    abort.signal,
  );
  const rejected = expect(waiting).rejects.toMatchObject({
    code: "wait_aborted",
  });
  abort.abort();
  await rejected;
  expect((await call("run.get", { runId: started.runId })).state).toBe(
    "queued",
  );
  expect(terminal.terminated).toHaveLength(0);
});
