import { recoverRun } from "./recovery";
import { runSnapshot, eventPage, artifactPage } from "./queries";
import { EventEmitter } from "node:events";
import { CONTROLLER_LIMITS, type ControllerCommand } from "@armadra/shared";
import type { CoreContext } from "../main";
import type { CollabContext } from "../collab/service";
import { loadNode, loadSession, type NodeRef } from "../collab/nodes";
import { enqueue, byId, type QueueItem } from "../collab/send-queue";
import { ControllerError } from "../controller/errors";
import {
  idempotent,
  transaction,
  type ControllerActor,
} from "../controller/store";
import { controllerActor } from "../drive/lease";
import { launchNode } from "../dependencies/launch";
import { launchFor } from "../dependencies/store";
import { listAgents } from "../agent/list";
import { getWorkspace } from "../workspaces/table";
import { uuidV7, rfc3339 } from "../workspaces/support";
import {
  aggregateRun,
  considerReport,
  runnable,
  TERMINAL_TASKS,
} from "./evaluate";
import {
  activeRuns,
  effect,
  event,
  evidence,
  occupied,
  runById,
  taskById,
  taskForDelivery,
  tasksOf,
  transitionTask,
  type RunRow,
  type TaskRow,
} from "./store";
import { promptDigest, reportsAfter, sourceRevision } from "./reports";
import { setRunDeliveryBridge, type RunDeliveryBridge } from "./registry";
import { validateRun, type AgentRunProbe, type FrozenConfig } from "./validate";

export interface RunServiceOptions {
  /** Deterministic failure injection for embedded tests; no remote control surface. */
  effectProbe?: (
    point:
      | "launch.before"
      | "launch.after"
      | "delivery.before"
      | "delivery.after",
    task: TaskRow,
  ) => void;
  context: CoreContext;
  collab: () => CollabContext | undefined;
  clock?: () => number;
  delay?: (ms: number) => Promise<void>;
  sweepEveryMs?: number | false;
  probe?: (agentId: string) => AgentRunProbe;
  sourceRevision?: (
    sessionId: string,
    generation: number,
  ) => number | undefined;
}
const ACTIVE = ["starting", "delivering", "running", "blocked"];
const STICKY = [
  "delivery_unknown",
  "launch_unknown",
  "launch_write_unknown",
  "completion_unknown",
  "external_interference",
  "authorization_revoked",
  "scope_changed",
  "connection_lost",
];

/** Durable run orchestration. Launches and submits through the existing domains only. */
export class RunService implements RunDeliveryBridge {
  private readonly database;
  private readonly clock;
  private readonly notifications = new EventEmitter();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly unsubscribing: (() => void)[] = [];
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private scheduled = false;
  private sweepPromise: Promise<void> | undefined;
  private recoveryPromise: Promise<void> | undefined;
  private readonly recoveringIds: string[];
  private readonly recoveredIds = new Set<string>();
  constructor(private readonly options: RunServiceOptions) {
    this.database = options.context.db.database;
    this.recoveringIds = activeRuns(this.database).map((run) => run.id);
    this.clock = options.clock ?? (() => Date.now());
    this.notifications.setMaxListeners(100);
    setRunDeliveryBridge(this.database, this);
  }
  begin(): void {
    this.unsubscribing.push(
      this.options.context.bus.on("run.report", () => this.nudge()),
    );
    this.unsubscribing.push(
      this.options.context.bus.on("workspace.event", ({ event }) => {
        if (
          [
            "board.changed",
            "terminal.exit",
            "agent.status",
            "agent.delivery",
          ].includes(event.type)
        )
          this.nudge();
      }),
    );
    if (this.options.sweepEveryMs !== false) {
      this.timer = setInterval(
        () => this.nudge(),
        this.options.sweepEveryMs ?? 1000,
      );
      this.timer.unref();
    }
    this.nudge();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const off of this.unsubscribing.splice(0)) off();
    this.notifications.emit("closing");
    await this.sweepPromise;
    await Promise.allSettled([...this.inFlight.values()]);
    setRunDeliveryBridge(this.database, undefined);
  }
  private nudge(): void {
    if (this.stopped || this.scheduled || this.options.sweepEveryMs === false)
      return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.sweep().catch((error) =>
        this.options.context.log.warn("运行推进失败", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }
  private assertActor(actor: ControllerActor, capability: string): void {
    const row = this.database
      .prepare(
        "SELECT workspace_id, capabilities_json, revoked_at FROM controller_profiles WHERE id = ?",
      )
      .get(actor.controllerId) as
      | {
          workspace_id: string;
          capabilities_json: string;
          revoked_at: string | null;
        }
      | undefined;
    if (!row || row.workspace_id !== actor.workspaceId)
      throw new ControllerError(
        "scope_denied",
        "Run profile is outside this workspace",
        403,
      );
    if (row.revoked_at)
      throw new ControllerError(
        "authorization_revoked",
        "Controller authorization has been revoked",
        403,
      );
    if (!(JSON.parse(row.capabilities_json) as string[]).includes(capability))
      throw new ControllerError(
        "scope_denied",
        "Profile lacks the required run capability",
        403,
      );
    if (getWorkspace(this.database, actor.workspaceId).executionHostId)
      throw new ControllerError(
        "scope_denied",
        "Workspace is no longer local",
        403,
      );
  }
  private actorFor(run: RunRow): ControllerActor {
    return {
      kind: "controller",
      controllerId: run.controller_id,
      workspaceId: run.workspace_id,
      capabilities: [],
    };
  }
  private ownedRun(
    actor: ControllerActor,
    id: string,
    capability = "run:read",
  ): RunRow {
    this.assertActor(actor, capability);
    const run = runById(this.database, id);
    if (
      !run ||
      run.controller_id !== actor.controllerId ||
      run.workspace_id !== actor.workspaceId
    )
      throw new ControllerError(
        "scope_denied",
        "Run does not belong to this profile",
        403,
      );
    return run;
  }
  private probe(agentId: string): AgentRunProbe {
    if (this.options.probe) return this.options.probe(agentId);
    const collab = this.options.collab();
    const row =
      collab &&
      listAgents({
        dataDir: this.options.context.dataDir,
        settings: collab.settings,
      }).find((row) => row.id === agentId);
    return {
      installed: row?.installed === true,
      trustedCompletion: ["codex", "claude"].includes(agentId),
    };
  }
  start(
    actor: ControllerActor,
    boardId: string,
    raw: unknown,
    command: ControllerCommand,
    initiator?: { kind: "human"; principalId: string },
  ): { runId: string; state: string } {
    if (process.platform === "win32")
      throw new ControllerError(
        "unsupported_platform",
        "Controller runs v1 requires a macOS or Linux Unix host",
      );
    this.assertActor(actor, "agent:execute");
    const result = idempotent(this.database, actor, command, () => {
      const collab = this.options.collab();
      if (!collab?.terminals)
        throw new ControllerError(
          "run_capability_unavailable",
          "Terminal execution is not assembled",
        );
      const prepared = validateRun(
        this.database,
        actor,
        boardId,
        raw,
        collab,
        (id) => this.probe(id),
        this.clock(),
      );
      const runId = uuidV7(),
        at = rfc3339();
      this.database
        .prepare(
          "INSERT INTO runs (id, controller_id, workspace_id, board_id, state, max_concurrency, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
        )
        .run(
          runId,
          actor.controllerId,
          actor.workspaceId,
          boardId,
          prepared.input.maxConcurrency,
          this.clock() + prepared.input.deadlineSeconds * 1000,
          at,
          at,
        );
      const taskIds = new Map(
        prepared.input.tasks.map((task) => [task.key, uuidV7()]),
      );
      prepared.input.tasks.forEach((task, i) => {
        const taskId = taskIds.get(task.key)!,
          deliveryId = uuidV7();
        this.database
          .prepare(
            "INSERT INTO run_tasks (id, run_id, task_key, node_id, config_json, prompt, after_json, outputs_json, state, delivery_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
          )
          .run(
            taskId,
            runId,
            task.key,
            task.nodeId,
            JSON.stringify(prepared.configs[i]),
            task.prompt,
            JSON.stringify(task.after),
            JSON.stringify(task.outputs),
            deliveryId,
            at,
            at,
          );
        this.database
          .prepare("INSERT INTO run_node_occupancy VALUES (?, ?, ?)")
          .run(task.nodeId, runId, taskId);
        const row = taskById(this.database, taskId)!;
        effect(this.database, row, "launch", "pending");
        effect(this.database, row, "delivery", "pending");
        this.database
          .prepare(
            "INSERT INTO agent_dependency_launches (node_id, workspace_id, board_id, task_hops, task_trail, state, created_at, updated_at, source_kind, controller_id, run_id, task_id) VALUES (?, ?, ?, 0, '[]', 'waiting', ?, ?, 'controller', ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET task_body = NULL, task_source_node_id = NULL, task_hops = 0, task_trail = '[]', state = 'waiting', reason = NULL, attempts = 0, session_id = NULL, task_queue_id = NULL, created_at = excluded.created_at, updated_at = excluded.updated_at, launched_at = NULL, source_kind = 'controller', controller_id = excluded.controller_id, run_id = excluded.run_id, task_id = excluded.task_id",
          )
          .run(
            task.nodeId,
            actor.workspaceId,
            boardId,
            Math.floor(this.clock() / 1000),
            Math.floor(this.clock() / 1000),
            actor.controllerId,
            runId,
            taskId,
          );
      });
      for (const task of prepared.input.tasks)
        for (const upstream of task.after) {
          const parent = prepared.input.tasks.find(
            (entry) => entry.key === upstream,
          )!;
          this.database
            .prepare(
              "INSERT INTO agent_dependencies (id, workspace_id, downstream_node_id, upstream_node_id, condition, baseline_state, baseline_event_at, observed_busy, state, created_at, updated_at, expires_at, source_kind, controller_id, run_id, task_id) VALUES (?, ?, ?, ?, 'current', NULL, NULL, 0, 'waiting', ?, ?, ?, 'controller', ?, ?, ?) ON CONFLICT(downstream_node_id, upstream_node_id) DO UPDATE SET condition = 'current', baseline_state = NULL, baseline_event_at = NULL, observed_busy = 0, state = 'waiting', reason = NULL, resolved_at = NULL, created_at = excluded.created_at, updated_at = excluded.updated_at, expires_at = excluded.expires_at, source_kind = 'controller', controller_id = excluded.controller_id, run_id = excluded.run_id, task_id = excluded.task_id",
            )
            .run(
              uuidV7(),
              actor.workspaceId,
              task.nodeId,
              parent.nodeId,
              Math.floor(this.clock() / 1000),
              Math.floor(this.clock() / 1000),
              Math.floor(
                (this.clock() + prepared.input.deadlineSeconds * 1000) / 1000,
              ),
              actor.controllerId,
              runId,
              taskIds.get(task.key)!,
            );
        }
      event(this.database, runId, "run.created", {
        state: "queued",
        taskCount: prepared.input.tasks.length,
        ...(initiator ? { initiator } : {}),
      });
      return { runId, state: "queued" };
    });
    if (!result.replayed) {
      this.notify(result.result.runId);
      this.nudge();
    }
    return result.result;
  }
  private notify(id: string): void {
    this.notifications.emit(id);
  }
  nodeOccupied(nodeId: string): boolean {
    return occupied(this.database, nodeId);
  }
  private configuration(task: TaskRow): FrozenConfig {
    return JSON.parse(task.config_json) as FrozenConfig;
  }
  private writableTask(task: TaskRow): RunRow {
    const run = runById(this.database, task.run_id)!;
    this.assertActor(this.actorFor(run), "agent:execute");
    if (
      ["cancelling", "completed", "failed", "cancelled"].includes(run.state) ||
      TERMINAL_TASKS.includes(task.state) ||
      (task.state === "blocked" && STICKY.includes(task.reason ?? ""))
    )
      throw new ControllerError(
        "run_stopped",
        "This run cannot issue more input",
        409,
      );
    const owner = this.database
      .prepare("SELECT task_id FROM run_node_occupancy WHERE node_id = ?")
      .get(task.node_id) as { task_id: string } | undefined;
    const node = loadNode(this.database, task.node_id),
      config = this.configuration(task);
    if (
      !owner ||
      owner.task_id !== task.id ||
      !node ||
      node.workspaceId !== run.workspace_id ||
      node.boardId !== run.board_id
    )
      throw new ControllerError(
        "node_busy",
        "Run no longer owns the target node",
        409,
      );
    if (
      getWorkspace(this.database, run.workspace_id).rootPath !==
      config.workspaceRoot
    )
      throw new ControllerError(
        "scope_changed",
        "Workspace root changed during this run",
        403,
      );
    return run;
  }
  authorize(item: QueueItem): NodeRef {
    const task = taskForDelivery(this.database, item.id);
    if (
      task &&
      this.recoveringIds.includes(task.run_id) &&
      !this.recoveredIds.has(task.run_id)
    )
      throw new ControllerError(
        "recovery_pending",
        "Run recovery has not completed",
        409,
      );
    if (!task)
      throw new ControllerError(
        "scope_denied",
        "No task owns this delivery",
        403,
      );
    const run = this.writableTask(task);
    if (
      item.controllerId !== run.controller_id ||
      item.runId !== run.id ||
      item.taskId !== task.id ||
      item.targetNodeId !== task.node_id ||
      item.workspaceId !== run.workspace_id ||
      item.sourceNodeId !== null
    )
      throw new ControllerError(
        "scope_denied",
        "Delivery actor or target does not match this run",
        403,
      );
    return this.configuration(task).node;
  }
  authorizeSession(
    controllerId: string,
    sessionId: string,
    generation: number,
  ): void {
    const task = this.database
      .prepare(
        "SELECT * FROM run_tasks WHERE session_id = ? AND generation = ? AND state NOT IN ('completed','failed','cancelled','skipped') ORDER BY rowid DESC LIMIT 1",
      )
      .get(sessionId, generation) as unknown as TaskRow | undefined;
    if (!task || this.writableTask(task).controller_id !== controllerId)
      throw new ControllerError(
        "scope_denied",
        "PTY binding is outside this controller run",
        403,
      );
  }
  driver(item: QueueItem, sessionId: string) {
    return controllerActor(item.controllerId!, sessionId, "Armadra controller");
  }
  beforeSubmit(
    item: QueueItem,
    binding: { sessionId: string; generation: number },
    envelope: string,
  ): void {
    this.authorize(item);
    const task = taskForDelivery(this.database, item.id)!;
    if (
      task.session_id !== binding.sessionId ||
      task.generation !== binding.generation
    )
      throw new ControllerError(
        "node_busy",
        "Delivery generation changed",
        409,
      );
    const source =
      this.options.sourceRevision?.(binding.sessionId, binding.generation) ??
      sourceRevision(
        this.options.context.dataDir,
        binding.sessionId,
        binding.generation,
      );
    if (
      source === undefined ||
      this.options.collab()?.terminals?.inputRevision?.(binding.sessionId) ===
        undefined
    ) {
      transaction(this.database, () =>
        transitionTask(this.database, task, "blocked", "completion_unknown"),
      );
      this.notify(task.run_id);
      throw new ControllerError(
        "completion_adapter_unavailable",
        "No reliable input or Hook revision baseline is available",
      );
    }
    transaction(this.database, () => {
      this.authorize(item);
      const baseline = Number(
        (
          this.database
            .prepare("SELECT COALESCE(MAX(seq), 0) seq FROM run_reports")
            .get() as { seq: number }
        ).seq,
      );
      this.database
        .prepare(
          "UPDATE run_tasks SET baseline_seq = ?, source_baseline = ?, prompt_hash = ?, report_cursor = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          baseline,
          source,
          promptDigest(envelope),
          baseline,
          rfc3339(),
          task.id,
        );
      effect(this.database, task, "delivery", "executing", {
        sessionId: binding.sessionId,
        generation: binding.generation,
        deliveryId: item.id,
      });
      event(
        this.database,
        task.run_id,
        "delivery.executing",
        { taskId: task.id, deliveryId: item.id },
        task.id,
      );
    });
    this.notify(task.run_id);
    this.options.effectProbe?.("delivery.before", task);
  }
  afterSubmit(
    item: QueueItem,
    outcome: "applied" | "uncertain",
    inputRevision?: number,
  ): void {
    const task = taskForDelivery(this.database, item.id);
    if (!task) return;
    if (outcome === "applied")
      this.options.effectProbe?.("delivery.after", task);
    transaction(this.database, () => {
      effect(this.database, task, "delivery", outcome, {
        deliveryId: item.id,
        ...(inputRevision === undefined ? {} : { inputRevision }),
      });
      if (outcome === "applied") {
        this.database
          .prepare(
            "UPDATE run_tasks SET acknowledged = 1, input_revision = ?, updated_at = ? WHERE id = ?",
          )
          .run(inputRevision ?? null, rfc3339(), task.id);
        if (
          !TERMINAL_TASKS.includes(task.state) &&
          !STICKY.includes(task.reason ?? "")
        )
          transitionTask(
            this.database,
            task,
            inputRevision === undefined ? "blocked" : "running",
            inputRevision === undefined ? "completion_unknown" : null,
          );
      } else if (
        !TERMINAL_TASKS.includes(task.state) &&
        task.reason !== "authorization_revoked"
      )
        transitionTask(this.database, task, "blocked", "delivery_unknown");
      event(
        this.database,
        task.run_id,
        "delivery." + outcome,
        { taskId: task.id, deliveryId: item.id },
        task.id,
      );
    });
    this.notify(task.run_id);
    this.nudge();
  }
  sweep(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.sweepPromise) return this.sweepPromise;
    this.sweepPromise = this.performSweep().finally(() => {
      this.sweepPromise = undefined;
    });
    return this.sweepPromise;
  }
  async recover(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = (async () => {
      const terminals = this.options.collab()?.terminals;
      await terminals?.ready?.();
      for (const id of this.recoveringIds) {
        const run = runById(this.database, id);
        if (!run || ["completed", "failed", "cancelled"].includes(run.state))
          continue;
        await recoverRun(this.database, run, async (task) => {
          if (!terminals || !task.session_id || task.generation === null)
            return "unknown";
          const session = loadSession(this.database, task.node_id);
          if (
            !session ||
            session.sessionId !== task.session_id ||
            session.generation !== task.generation ||
            session.status !== "running"
          )
            return "lost";
          return (await terminals.isCurrentNodeSession(
            task.node_id,
            task.session_id,
            task.generation,
          ))
            ? "alive"
            : "lost";
        });
        this.recoveredIds.add(id);
        this.notify(id);
      }
    })();
    return this.recoveryPromise;
  }
  private async performSweep(): Promise<void> {
    await this.recover();
    for (const run of activeRuns(this.database)) {
      if (this.stopped) return;
      if (run.state === "cancelling") {
        await this.cancelBindings(run);
        continue;
      }
      try {
        this.assertActor(this.actorFor(run), "agent:execute");
      } catch (error) {
        this.revoke(
          run.controller_id,
          error instanceof ControllerError
            ? error.code
            : "authorization_revoked",
        );
        continue;
      }
      this.consumeReports(run);
      if (runById(this.database, run.id)?.state === "completed") continue;
      if (this.clock() >= run.deadline_at) {
        this.markCancelling(run, "deadline_exceeded");
        await this.cancelBindings(runById(this.database, run.id)!);
        continue;
      }
      transaction(this.database, () => {
        const rows = tasksOf(this.database, run.id),
          byKey = new Map(rows.map((task) => [task.task_key, task]));
        for (const task of rows) {
          if (TERMINAL_TASKS.includes(task.state)) continue;
          if (!loadNode(this.database, task.node_id)) {
            transitionTask(this.database, task, "failed", "node_deleted");
            this.cancelQueue(task);
            continue;
          }
          if (
            task.state === "pending" &&
            (JSON.parse(task.after_json) as string[]).some((key) =>
              ["failed", "cancelled", "skipped"].includes(
                byKey.get(key)!.state,
              ),
            )
          )
            transitionTask(this.database, task, "skipped", "upstream_failed");
          if (
            task.state === "delivering" ||
            (task.state === "blocked" &&
              !task.acknowledged &&
              !STICKY.includes(task.reason ?? ""))
          ) {
            const queued = byId(this.database, task.delivery_id);
            if (queued?.state === "expired" || queued?.state === "cancelled")
              transitionTask(
                this.database,
                task,
                "failed",
                queued.state === "expired"
                  ? "queue_expired"
                  : "delivery_cancelled",
              );
            else if (queued?.lastReason === "TARGET_AWAITING_APPROVAL")
              transitionTask(
                this.database,
                task,
                "blocked",
                "awaiting_approval",
              );
            else if (queued?.lastReason === "TARGET_INPUT_PENDING")
              transitionTask(this.database, task, "blocked", "awaiting_input");
          }
          if (
            task.session_id &&
            task.generation !== null &&
            task.acknowledged &&
            !TERMINAL_TASKS.includes(task.state)
          ) {
            const session = loadSession(this.database, task.node_id);
            if (
              !session ||
              session.sessionId !== task.session_id ||
              session.generation !== task.generation ||
              session.status !== "running"
            )
              transitionTask(this.database, task, "failed", "session_lost");
          }
        }
        this.aggregate(run.id);
      });
      this.notify(run.id);
      const rows = tasksOf(this.database, run.id),
        byKey = new Map(rows.map((task) => [task.task_key, task]));
      const starts = rows.filter(
        (task) =>
          task.state === "pending" &&
          runnable(
            (JSON.parse(task.after_json) as string[]).map(
              (key) => byKey.get(key)!.state,
            ),
          ),
      );
      for (const task of starts) {
        const active = Number(
          (
            this.database
              .prepare(
                "SELECT COUNT(*) n FROM run_tasks t JOIN runs r ON r.id = t.run_id WHERE r.controller_id = ? AND t.state IN ('starting','delivering','running','blocked')",
              )
              .get(run.controller_id) as { n: number }
          ).n,
        );
        const cap = Number(
          (
            this.database
              .prepare(
                "SELECT COALESCE(MAX(max_concurrency), 2) n FROM runs WHERE controller_id = ? AND state NOT IN ('completed','failed','cancelled')",
              )
              .get(run.controller_id) as { n: number }
          ).n,
        );
        const ownActive = tasksOf(this.database, run.id).filter((task) =>
          ACTIVE.includes(task.state),
        ).length;
        if (active >= cap || ownActive >= run.max_concurrency) break;
        await this.launchTask(task);
      }
      transaction(this.database, () => this.aggregate(run.id));
      this.notify(run.id);
    }
  }
  private launchTask(task: TaskRow): Promise<void> {
    const existing = this.inFlight.get(task.id);
    if (existing) return existing;
    const collab = this.options.collab();
    if (!collab?.terminals) return Promise.resolve();
    transaction(this.database, () => {
      this.writableTask(task);
      transitionTask(this.database, task, "starting");
      effect(this.database, task, "launch", "executing");
      this.aggregate(task.run_id);
    });
    this.notify(task.run_id);
    this.options.effectProbe?.("launch.before", task);
    const pending = (async () => {
      const run = runById(this.database, task.run_id)!,
        config = this.configuration(task);
      const allowed = () => {
        try {
          this.writableTask(taskById(this.database, task.id)!);
          return !this.stopped;
        } catch {
          return false;
        }
      };
      const launch = launchFor(this.database, task.node_id)!;
      const outcome = await launchNode(
        {
          collab,
          clock: this.clock,
          delay:
            this.options.delay ??
            ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
          log: (message, fields) =>
            this.options.context.log.info(message, fields),
          run: {
            node: config.node,
            command: config.launchCommand,
            allowed,
            bound: (sessionId, generation) =>
              transaction(this.database, () => {
                this.database
                  .prepare(
                    "UPDATE run_tasks SET session_id = ?, generation = ?, updated_at = ? WHERE id = ?",
                  )
                  .run(sessionId, generation, rfc3339(), task.id);
                effect(this.database, task, "launch", "executing", {
                  sessionId,
                  generation,
                });
              }),
            beforeWrite: (sessionId, generation) =>
              transaction(this.database, () => {
                this.writableTask(taskById(this.database, task.id)!);
                effect(this.database, task, "launch-write", "executing", {
                  sessionId,
                  generation,
                });
              }),
            afterWrite: () => {
              this.options.effectProbe?.("launch.after", task);
              transaction(this.database, () =>
                effect(this.database, task, "launch-write", "applied"),
              );
            },
            driver: (sessionId) =>
              controllerActor(
                run.controller_id,
                sessionId,
                "Armadra controller",
              ),
          },
        },
        launch,
      );
      transaction(this.database, () => {
        const latest = taskById(this.database, task.id)!;
        if (outcome.kind === "launched") {
          effect(this.database, latest, "launch", "applied", {
            sessionId: latest.session_id,
            generation: latest.generation,
          });
          this.database
            .prepare(
              "UPDATE agent_dependency_launches SET state = 'launched', session_id = ?, task_queue_id = ?, launched_at = ?, updated_at = ? WHERE node_id = ? AND task_id = ?",
            )
            .run(
              latest.session_id,
              latest.delivery_id,
              Math.floor(this.clock() / 1000),
              Math.floor(this.clock() / 1000),
              task.node_id,
              task.id,
            );
          if (allowed()) {
            const queued = enqueue(this.database, {
              id: task.delivery_id,
              workspaceId: run.workspace_id,
              sourceKind: "controller",
              sourceNodeId: null,
              controllerId: run.controller_id,
              runId: run.id,
              taskId: task.id,
              targetNodeId: task.node_id,
              origin: "run-task",
              body: task.prompt,
              messageKey: task.id,
              hops: 0,
              trail: [],
              now: Math.floor(this.clock() / 1000),
              state: "queued",
            });
            transitionTask(
              this.database,
              latest,
              queued.kind === "inserted" || queued.kind === "duplicate"
                ? "delivering"
                : "blocked",
              queued.kind === "full"
                ? "queue_full"
                : queued.kind === "conflict"
                  ? "idempotency_conflict"
                  : null,
            );
          }
        } else if (
          !TERMINAL_TASKS.includes(latest.state) &&
          !STICKY.includes(latest.reason ?? "")
        ) {
          const uncertain = outcome.kind === "uncertain";
          effect(
            this.database,
            latest,
            "launch",
            uncertain ? "uncertain" : "applied",
            {
              reason: outcome.kind === "gone" ? "node_deleted" : outcome.reason,
            },
          );
          transitionTask(
            this.database,
            latest,
            this.stopped || uncertain || outcome.kind === "retry"
              ? "blocked"
              : "failed",
            outcome.kind === "gone" ? "node_deleted" : outcome.reason,
          );
        }
        this.aggregate(run.id);
      });
      if (outcome.kind === "launched") collab.nudge?.(task.node_id);
      this.notify(task.run_id);
    })()
      .catch((error) => {
        transaction(this.database, () => {
          const current = taskById(this.database, task.id)!;
          effect(this.database, current, "launch", "uncertain");
          if (!TERMINAL_TASKS.includes(current.state))
            transitionTask(this.database, current, "blocked", "launch_unknown");
          this.aggregate(task.run_id);
        });
        this.options.context.log.warn("运行启动结果未知", {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.notify(task.run_id);
      })
      .finally(() => this.inFlight.delete(task.id));
    this.inFlight.set(task.id, pending);
    return pending;
  }
  private consumeReports(run: RunRow): void {
    transaction(this.database, () => {
      for (let task of tasksOf(this.database, run.id)) {
        if (
          !task.acknowledged ||
          !task.session_id ||
          task.generation === null ||
          TERMINAL_TASKS.includes(task.state) ||
          (STICKY.includes(task.reason ?? "") &&
            !(
              task.reason === "completion_unknown" &&
              task.input_revision !== null
            ))
        )
          continue;
        let deferred = false,
          consumed = task.report_cursor;
        for (const report of reportsAfter(
          this.database,
          task.node_id,
          task.session_id,
          task.generation,
          task.report_cursor,
        )) {
          const verdict = considerReport(
            evidence(task),
            report,
            this.options.collab()?.terminals?.inputRevision?.(task.session_id!),
          );
          if (
            verdict.kind === "ignore" &&
            !task.turn_started &&
            report.state === "done" &&
            (report.sourceRevision ?? 0) > task.source_baseline
          ) {
            deferred = true;
            transitionTask(
              this.database,
              task,
              "blocked",
              "completion_unknown",
            );
          } else if (verdict.kind === "start") {
            this.database
              .prepare(
                "UPDATE run_tasks SET turn_started = 1, provider_session_id = ? WHERE id = ?",
              )
              .run(verdict.providerSessionId, task.id);
            transitionTask(this.database, task, "running");
          } else if (verdict.kind === "complete") {
            transitionTask(this.database, task, "completed");
            this.database
              .prepare(
                "UPDATE agent_dependencies SET state = 'satisfied', reason = 'run_task_completed', resolved_at = ?, updated_at = ? WHERE run_id = ? AND upstream_node_id = ? AND state = 'waiting'",
              )
              .run(
                Math.floor(this.clock() / 1000),
                Math.floor(this.clock() / 1000),
                run.id,
                task.node_id,
              );
          } else if (verdict.kind === "fail")
            transitionTask(this.database, task, "failed", verdict.reason);
          else if (verdict.kind === "block")
            transitionTask(this.database, task, "blocked", verdict.reason);
          consumed = Math.max(consumed, report.seq);
          task = taskById(this.database, task.id)!;
          if (
            TERMINAL_TASKS.includes(task.state) ||
            (STICKY.includes(task.reason ?? "") &&
              task.reason !== "completion_unknown")
          )
            break;
        }
        if (!deferred || task.turn_started)
          this.database
            .prepare("UPDATE run_tasks SET report_cursor = ? WHERE id = ?")
            .run(consumed, task.id);
      }
      this.aggregate(run.id);
    });
    this.notify(run.id);
  }
  private aggregate(id: string): void {
    const run = runById(this.database, id)!,
      tasks = tasksOf(this.database, id);
    if (run.state === "cancelling") return;
    const byKey = new Map(tasks.map((task) => [task.task_key, task]));
    const activeCount = Number(
      (
        this.database
          .prepare(
            "SELECT COUNT(*) n FROM run_tasks t JOIN runs r ON r.id = t.run_id WHERE r.controller_id = ? AND t.state IN ('starting','delivering','running','blocked')",
          )
          .get(run.controller_id) as { n: number }
      ).n,
    );
    const cap = Number(
      (
        this.database
          .prepare(
            "SELECT COALESCE(MAX(max_concurrency), 2) n FROM runs WHERE controller_id = ? AND state NOT IN ('completed','failed','cancelled')",
          )
          .get(run.controller_id) as { n: number }
      ).n,
    );
    const ownActive = tasks.filter((task) =>
      ACTIVE.includes(task.state),
    ).length;
    const hasRunnable =
      activeCount < cap &&
      ownActive < run.max_concurrency &&
      tasks.some(
        (task) =>
          task.state === "pending" &&
          runnable(
            (JSON.parse(task.after_json) as string[]).map(
              (key) => byKey.get(key)!.state,
            ),
          ),
      );
    const state = aggregateRun(
      tasks.map((task) => task.state),
      hasRunnable,
    );
    if (run.state !== state) {
      this.database
        .prepare("UPDATE runs SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, rfc3339(), id);
      event(this.database, id, "run.changed", { state, reason: run.reason });
    }
  }
  private cancelQueue(task: TaskRow): void {
    this.database
      .prepare(
        "UPDATE agent_send_queue SET state = 'cancelled', last_reason = 'RUN_CANCELLED' WHERE id = ? AND state = 'queued'",
      )
      .run(task.delivery_id);
  }
  revoke(controllerId: string, reason = "authorization_revoked"): void {
    for (const run of activeRuns(this.database).filter(
      (run) => run.controller_id === controllerId,
    )) {
      transaction(this.database, () => {
        for (const task of tasksOf(this.database, run.id))
          if (!TERMINAL_TASKS.includes(task.state)) {
            transitionTask(this.database, task, "blocked", reason);
            this.cancelQueue(task);
          }
        this.database
          .prepare("UPDATE runs SET reason = ? WHERE id = ?")
          .run(reason, run.id);
        this.aggregate(run.id);
      });
      this.notify(run.id);
    }
  }
  snapshot(actor: ControllerActor, id: string, offset = 0) {
    return runSnapshot(this.database, this.ownedRun(actor, id), offset);
  }
  artifacts(actor: ControllerActor, id: string, offset = 0) {
    return artifactPage(this.database, this.ownedRun(actor, id), offset);
  }
  private page(
    actor: ControllerActor,
    id: string,
    cursor: number,
    detailed = false,
  ) {
    return eventPage(this.database, this.ownedRun(actor, id), cursor, detailed);
  }
  async wait(
    actor: ControllerActor,
    id: string,
    cursor: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
    detailed = false,
  ) {
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds < 0 ||
      timeoutSeconds > 60
    )
      throw new ControllerError(
        "invalid_arguments",
        "Wait requires a nonnegative cursor and 0–60 second timeout",
      );
    let page = this.page(actor, id, cursor, detailed);
    if (["completed", "failed", "cancelled", "blocked"].includes(page.state))
      return { ...page, timedOut: false };
    if (page.events.length || page.snapshotRequired || timeoutSeconds === 0)
      return {
        ...page,
        timedOut: !page.events.length && !page.snapshotRequired,
      };
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.notifications.off(id, changed);
        this.notifications.off("closing", closed);
        signal?.removeEventListener("abort", aborted);
      };
      const changed = () => {
        try {
          page = this.page(actor, id, cursor, detailed);
          if (page.events.length || page.snapshotRequired) {
            cleanup();
            resolve();
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const aborted = () => {
        cleanup();
        reject(new ControllerError("wait_aborted", "Waiter disconnected", 408));
      };
      const closed = () => {
        cleanup();
        reject(
          new ControllerError("core_unavailable", "Core is stopping", 503),
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutSeconds * 1000);
      this.notifications.on(id, changed);
      this.notifications.on("closing", closed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      else changed();
    });
    // A profile revoked while idle is still denied at timeout, independently of events.
    page = this.page(actor, id, cursor, detailed);
    return { ...page, timedOut: !page.events.length && !page.snapshotRequired };
  }
  cancel(actor: ControllerActor, id: string, command: ControllerCommand) {
    const run = this.ownedRun(actor, id, "run:cancel");
    this.consumeReports(run);
    const result = idempotent(this.database, actor, command, () => {
      const current = runById(this.database, id)!;
      if (["completed", "failed", "cancelled"].includes(current.state))
        return { runId: id, state: current.state, alreadyTerminal: true };
      this.markCancelling(current, "cancel_requested", false);
      return { runId: id, state: "cancelling", alreadyTerminal: false };
    });
    this.notify(id);
    this.nudge();
    return result.result;
  }
  private markCancelling(
    run: RunRow,
    reason: string,
    ownTransaction = true,
  ): void {
    const write = () => {
      this.database
        .prepare(
          "UPDATE runs SET state = 'cancelling', reason = ?, updated_at = ? WHERE id = ?",
        )
        .run(reason, rfc3339(), run.id);
      for (const task of tasksOf(this.database, run.id)) {
        if (TERMINAL_TASKS.includes(task.state)) continue;
        this.cancelQueue(task);
        effect(this.database, task, "cancel", "pending");
        if (task.state === "pending")
          transitionTask(this.database, task, "cancelled", reason);
      }
      event(this.database, run.id, "run.changed", {
        state: "cancelling",
        reason,
      });
    };
    if (ownTransaction) {
      transaction(this.database, write);
      this.notify(run.id);
    } else write();
  }
  private async cancelBindings(run: RunRow): Promise<void> {
    for (const task of tasksOf(this.database, run.id)) {
      if (TERMINAL_TASKS.includes(task.state)) continue;
      if (!task.session_id || task.generation === null) {
        if (this.inFlight.has(task.id)) continue;
        transaction(this.database, () => {
          transitionTask(
            this.database,
            task,
            "blocked",
            "cancel_launch_unknown",
          );
          effect(this.database, task, "cancel", "uncertain");
        });
        continue;
      }
      const priorCancel = this.database
        .prepare(
          "SELECT state FROM run_effects WHERE task_id = ? AND kind = 'cancel'",
        )
        .get(task.id) as { state: string } | undefined;
      if (priorCancel?.state === "uncertain") continue;
      const terminal = this.options.collab()?.terminals;
      const current = await terminal?.isCurrentNodeSession(
        task.node_id,
        task.session_id,
        task.generation,
      );
      if (!current) {
        transaction(this.database, () => {
          transitionTask(
            this.database,
            task,
            "cancelled",
            "binding_no_longer_current",
          );
          effect(this.database, task, "cancel", "applied", {
            bindingChanged: true,
          });
        });
        continue;
      }
      if (!terminal?.terminateBound) {
        transaction(this.database, () => {
          transitionTask(
            this.database,
            task,
            "blocked",
            "cancel_capability_unavailable",
          );
          effect(this.database, task, "cancel", "uncertain");
        });
        continue;
      }
      transaction(this.database, () =>
        effect(this.database, task, "cancel", "executing", {
          sessionId: task.session_id,
          generation: task.generation,
        }),
      );
      try {
        await terminal.terminateBound(
          task.session_id,
          task.generation,
          "session",
        );
        transaction(this.database, () => {
          const latest = taskById(this.database, task.id)!;
          if (!TERMINAL_TASKS.includes(latest.state))
            transitionTask(
              this.database,
              latest,
              "cancelled",
              run.reason ?? "cancel_requested",
            );
          effect(this.database, latest, "cancel", "applied");
        });
      } catch {
        transaction(this.database, () => {
          transitionTask(this.database, task, "blocked", "cancel_unknown");
          effect(this.database, task, "cancel", "uncertain");
        });
      }
    }
    transaction(this.database, () => {
      const tasks = tasksOf(this.database, run.id);
      if (tasks.every((task) => TERMINAL_TASKS.includes(task.state))) {
        const state = tasks.every((task) => task.state === "completed")
          ? "completed"
          : "cancelled";
        this.database
          .prepare("UPDATE runs SET state = ?, updated_at = ? WHERE id = ?")
          .run(state, rfc3339(), run.id);
        event(this.database, run.id, "run.changed", {
          state,
          reason: run.reason,
        });
      }
    });
    this.notify(run.id);
  }
}
