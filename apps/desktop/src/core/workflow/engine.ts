import type { DatabaseSync } from "node:sqlite";
import { supportedPermissionModes } from "../agent/launch";
import { baseAgent, validAgentId } from "../agent/registry";
import { getAgentStatus } from "../agent/status";
import type { EventBus, WorkspaceEvent } from "../bus";
import { RECEIPT_KEY_PREFIX, TTL_SECONDS } from "../collab/mailbox";
import { loadNode } from "../collab/nodes";
import { cancelOwn } from "../collab/send-queue";
import type { CollabContext } from "../collab/service";
import { evaluate } from "../dependencies/evaluate";
import { DomainError, uuidV7 } from "../workspaces/support";
import { checkRendered, renderPrompt, resolveParams } from "./draft";
import {
  DeliveryRefused,
  type LayoutRole,
  type RunLayout,
  deliverPrompt,
  launchRoleNode,
  layoutRun,
  queueItem,
} from "./dispatch";
import {
  type RunRow,
  type StepRow,
  type TemplateRow,
  activeRuns,
  insertRun,
  noteBusy,
  noteDelivered,
  noteDispatched,
  runById,
  runsTouchingNode,
  setRunStatus,
  stepOfRun,
  stepsOf,
  transitionStep,
} from "./store";
import {
  type CollectStep,
  type GateDecision,
  type GateStep,
  type PromptStep,
  RUN_FINAL,
  type RunStatus,
  STEP_FINAL,
  type StepOutput,
  type StepStatus,
  type WorkflowStep,
} from "./types";

/**
 * 工作流运行引擎（补全架构 §5.4、协调 Agent §5）。
 *
 * 一次运行 = 画布上一个 Frame（`dispatch.ts::layoutRun`）+ 每一步一行
 * `workflow_run_steps`。引擎做的只有一件事：**把一次运行往前推**——
 *
 *   * `after` 全部 `done` 的步骤开始：`prompt` 把代入参数的提示词投给角色节点；
 *     `collect` 先把来源步骤的产出（`post` 正文）放进目标节点的收件箱，再投
 *     提示词；`gate` 停下等 `POST …/gates/{stepId}`。
 *   * `prompt` / `collect` 什么时候算完：投递落地之后，角色节点的下一轮干净
 *     结束——判定就是依赖编排那一份（`dependencies/evaluate.ts`）：只认基准之后
 *     的结束、失败与中断不放行、未知不放行、节点被删不是成功。
 *   * 一步失败，等它的步骤记 `skipped`；全部步骤都结束了，运行按「是否全部
 *     `done`」落 `succeeded` / `failed`。
 *
 * 推动它的是 core 自己的事件（`agent.status`、`agent.delivery`、`terminal.exit`）
 * 加一个周期扫描，**页面开不开都一样**。扫描用的判定与事件相同，所以重启之后
 * 第一遍扫描就是续跑：状态全在库里，进程里只有「同一次运行不并发推两遍」的锁。
 */

/** 扫描间隔：漏掉的事件最多晚这么久被补上。 */
export const WORKFLOW_SWEEP_MS = 30_000;
/** 一条提示词最多投几次（排队项过期或被门链退回时重投）。 */
export const MAX_DELIVERY_ATTEMPTS = 3;
/** 一步最多记几条产出、每条最多多长。 */
const MAX_OUTPUTS = 8;

const BUSY_STATES: readonly string[] = ["working", "waiting", "blocked"];

export interface WorkflowEngineOptions {
  readonly database: DatabaseSync;
  /** 协作上下文，每次现取：终端桥在装配的后半段才交回来，之后还会换。 */
  readonly collab: () => CollabContext | undefined;
  readonly bus?: EventBus | undefined;
  /** 毫秒。 */
  readonly clock?: () => number;
  /** 为 `false` 时不武装周期扫描（用例手动调 {@link WorkflowEngine.sweep}）。 */
  readonly sweepEveryMs?: number | false;
  /** 起角色节点；缺省交给依赖编排（`dispatch.ts::launchRoleNode`）。 */
  readonly launch?: (node: {
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly boardId: string;
  }) => void;
  /** 建 Frame 与角色节点；缺省 `dispatch.ts::layoutRun`。 */
  readonly layout?: typeof layoutRun;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface StartRunRequest {
  readonly template: TemplateRow;
  readonly params?: unknown;
  readonly boardId?: string | undefined;
  /**
   * 运行 id；缺省新铸一个。定时起跑（`schedule/workflow-target.ts`）从投递的
   * 操作标识推出它，重试与复核据此认出「这次已经起过了」。
   */
  readonly runId?: string | undefined;
}

export class WorkflowEngine {
  private readonly database: DatabaseSync;
  private readonly clock: () => number;
  private readonly log: (
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  /** 每次运行一条推进链：同一次运行不会被两条路径同时推。 */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly options: WorkflowEngineOptions) {
    this.database = options.database;
    this.clock = options.clock ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  /** 订阅事件、武装扫描，并立刻扫一遍——那一遍就是重启之后的续跑。 */
  start(): void {
    const bus = this.options.bus;
    if (bus !== undefined) {
      this.unsubscribe = bus.on("workspace.event", ({ event }) => {
        this.handleEvent(event);
      });
    }
    const every = this.options.sweepEveryMs ?? WORKFLOW_SWEEP_MS;
    if (every !== false) {
      this.timer = setInterval(() => {
        void this.sweep().catch((error: unknown) => {
          this.log("工作流扫描失败", { error: describe(error) });
        });
      }, every);
      this.timer.unref?.();
    }
    void this.sweep().catch((error: unknown) => {
      this.log("工作流续跑失败", { error: describe(error) });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.unsubscribe?.();
    await Promise.allSettled([...this.chains.values()]);
  }

  /* --------------------------------- 起跑 --------------------------------- */

  /**
   * 起一次运行：先把能当场拒绝的全拒掉（参数、权限模式、超长），再建 Frame
   * 与节点、落库、起节点、推第一步。
   */
  async startRun(request: StartRunRequest): Promise<RunRow> {
    const collab = this.requireCollab();
    const template = request.template.template;
    const params = resolveParams(template, request.params);
    checkRendered(template, params);
    for (const role of template.roles) {
      if (!validAgentId(role.agentId)) {
        throw new DomainError(
          400,
          "invalid_draft",
          `角色 \`${role.id}\` 的 Agent \`${role.agentId}\` 在这台机器上不认识。`,
        );
      }
      if (role.permissionMode == null) continue;
      const supported = supportedPermissionModes(
        baseAgent(collab.settings, role.agentId),
      ) as readonly string[];
      if (!supported.includes(role.permissionMode)) {
        throw new DomainError(
          400,
          "permission_mode_unsupported",
          `角色 \`${role.id}\`（${role.agentId}）没有 \`${role.permissionMode}\` 这个权限模式；可用：${supported.join(" / ")}。`,
        );
      }
    }
    const boardId = request.boardId ?? template.source?.boardId ?? undefined;
    if (boardId === undefined || boardId === null || boardId === "") {
      throw new DomainError(400, "bad_request", "起一次运行要给 boardId。");
    }
    const workspaceId = workspaceOfBoard(this.database, boardId);
    if (workspaceId === undefined) {
      throw new DomainError(404, "not_found", "没有这块画布。");
    }

    const runId = request.runId ?? uuidV7();
    const roles: LayoutRole[] = template.roles.map((role) => ({
      id: role.id,
      agentId: role.agentId,
      title: role.title ?? role.id,
      permissionMode: role.permissionMode,
      model: role.model,
      worktree: role.worktree,
    }));
    const layout: RunLayout = await (this.options.layout ?? layoutRun)(collab, {
      workspaceId,
      boardId,
      title: template.title,
      runId,
      roles,
      links: template.links,
    });
    const run = insertRun(this.database, {
      id: runId,
      templateId: request.template.id,
      templateVersion: request.template.version,
      template,
      workspaceId,
      boardId,
      frameId: layout.frameId,
      anchorNodeId: layout.anchorNodeId,
      params,
      roles: layout.roles,
      startedAt: this.clock(),
    });
    const launch =
      this.options.launch ??
      ((node) => launchRoleNode(this.database, node, this.nowSeconds()));
    for (const nodeId of Object.values(layout.roles)) {
      launch({ nodeId, workspaceId, boardId });
    }
    this.publishRun(run, "running");
    this.log("工作流已起跑", { runId, templateId: request.template.id });
    await this.progress(runId);
    return runById(this.database, runId) as RunRow;
  }

  /* --------------------------------- 人 ------------------------------------ */

  /** 取消一次运行：没结束的步骤都记 `cancelled`，还排着的提示词收回来。节点留着。 */
  async cancel(runId: string): Promise<RunRow> {
    const run = this.requireRun(runId);
    if (RUN_FINAL.includes(run.status)) {
      throw new DomainError(409, "run_finished", "这次运行已经结束了。");
    }
    await this.serialize(runId, () => {
      const now = this.clock();
      if (
        !setRunStatus(this.database, runId, "cancelled", "cancelledByUser", now)
      )
        return;
      for (const step of stepsOf(this.database, runId)) {
        if (STEP_FINAL.includes(step.status)) continue;
        if (step.queueId !== null && run.anchorNodeId !== null) {
          cancelOwn(this.database, run.anchorNodeId, step.queueId);
        }
        transitionStep(
          this.database,
          runId,
          step.stepId,
          [step.status],
          "cancelled",
          {
            reason: "cancelledByUser",
            endedAt: now,
          },
        );
        if (step.kind === "gate" && step.status === "waiting") {
          this.publishGate(run, step.stepId, "cancelled");
        }
      }
      this.publishRun(run, "cancelled");
    });
    return this.requireRun(runId);
  }

  /** 答一个关卡。只有正在等人的关卡答得了。 */
  async answerGate(
    runId: string,
    stepId: string,
    decision: GateDecision,
    note?: string,
  ): Promise<RunRow> {
    const run = this.requireRun(runId);
    const step = stepOfRun(this.database, runId, stepId);
    if (step === undefined || step.kind !== "gate") {
      throw new DomainError(404, "not_found", "这次运行里没有这个关卡。");
    }
    if (step.status !== "waiting" || RUN_FINAL.includes(run.status)) {
      throw new DomainError(409, "gate_not_waiting", "这个关卡没有在等人。");
    }
    let answered = false;
    await this.serialize(runId, () => {
      const now = this.clock();
      answered = transitionStep(
        this.database,
        runId,
        stepId,
        ["waiting"],
        decision === "approve" ? "done" : "failed",
        {
          endedAt: now,
          reason: decision === "approve" ? null : "rejected",
          outcome: {
            decision,
            ...(note === undefined || note === "" ? {} : { note }),
          },
        },
      );
      if (answered) {
        this.publishGate(
          run,
          stepId,
          decision === "approve" ? "approved" : "rejected",
        );
      }
    });
    if (!answered) {
      throw new DomainError(409, "gate_not_waiting", "这个关卡没有在等人。");
    }
    await this.progress(runId);
    return this.requireRun(runId);
  }

  /* --------------------------------- 事件 --------------------------------- */

  handleEvent(event: WorkspaceEvent): void {
    if (this.stopped) return;
    let nodeId: string | undefined;
    if (event.type === "agent.status") {
      const id = (event.status as { nodeId?: unknown }).nodeId;
      if (typeof id === "string") nodeId = id;
    } else if (event.type === "agent.delivery") {
      nodeId = event.targetNodeId;
    } else if (event.type === "terminal.exit") {
      if (typeof event.nodeId === "string") {
        for (const runId of runsTouchingNode(this.database, event.nodeId)) {
          void this.progress(runId, event.nodeId);
        }
      }
      return;
    }
    if (nodeId === undefined) return;
    for (const runId of runsTouchingNode(this.database, nodeId)) {
      void this.progress(runId);
    }
  }

  /** 一遍完整的对账：每次没结束的运行推一次。重启之后第一遍就是续跑。 */
  async sweep(): Promise<void> {
    if (this.stopped) return;
    await Promise.all(
      activeRuns(this.database).map((run) => this.progress(run.id)),
    );
  }

  /**
   * 把一次运行往前推。同一次运行串行：正在推的时候又来一次，就在这一遍之后
   * 再推一遍，而不是并发两遍。`exitedNodeId` 是刚退出终端的节点。
   */
  progress(runId: string, exitedNodeId?: string): Promise<void> {
    if (this.chains.has(runId) && exitedNodeId === undefined) {
      this.again.add(runId);
      return this.chains.get(runId) as Promise<void>;
    }
    return this.serialize(runId, () => this.step(runId, exitedNodeId));
  }

  private serialize(
    runId: string,
    work: () => void | Promise<void>,
  ): Promise<void> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await work();
        while (this.again.delete(runId)) await this.step(runId);
      })
      .catch((error: unknown) => {
        this.log("工作流推进失败", { runId, error: describe(error) });
      })
      .finally(() => {
        if (this.chains.get(runId) === next) this.chains.delete(runId);
      });
    this.chains.set(runId, next);
    return next;
  }

  /* --------------------------------- 推进 --------------------------------- */

  private async step(runId: string, exitedNodeId?: string): Promise<void> {
    const run = runById(this.database, runId);
    if (run === undefined || RUN_FINAL.includes(run.status)) return;
    const collab = this.options.collab();
    const definitions = new Map(
      run.template.steps.map((step) => [step.id, step]),
    );

    // 1. 正在跑的那些：投递落地了没有，这一轮结束了没有。
    for (const step of stepsOf(this.database, runId)) {
      if (step.status !== "running") continue;
      if (step.kind === "gate") continue;
      this.check(run, step, collab, exitedNodeId);
    }

    // 2. 能开始的开始，等不到的跳过。开始一步可能让别的步骤立刻能开始（关卡
    //    不会，投递也不会当场结束），所以一遍就够。
    let steps = stepsOf(this.database, runId);
    const statusOf = new Map(steps.map((step) => [step.stepId, step.status]));
    for (const step of steps) {
      if (step.status !== "pending") continue;
      const definition = definitions.get(step.stepId);
      if (definition === undefined) continue;
      const upstream = definition.after.map((id) => statusOf.get(id));
      if (
        upstream.some(
          (status) =>
            status !== undefined &&
            status !== "done" &&
            STEP_FINAL.includes(status),
        )
      ) {
        if (
          transitionStep(
            this.database,
            runId,
            step.stepId,
            ["pending"],
            "skipped",
            {
              reason: "upstreamFailed",
              endedAt: this.clock(),
            },
          )
        ) {
          statusOf.set(step.stepId, "skipped");
          this.publishStep(run, step.stepId, "skipped");
        }
        continue;
      }
      if (!upstream.every((status) => status === "done")) continue;
      const started = this.begin(run, definition, collab);
      if (started !== undefined) statusOf.set(step.stepId, started);
    }

    // 跳过可能级联：跳过的步骤让等它的步骤也该跳过。再走几遍直到不动。
    for (let pass = 0; pass < run.template.steps.length; pass += 1) {
      let moved = false;
      for (const step of stepsOf(this.database, runId)) {
        if (step.status !== "pending") continue;
        const definition = definitions.get(step.stepId);
        if (definition === undefined) continue;
        const blocked = definition.after.some((id) => {
          const status = statusOf.get(id);
          return (
            status !== undefined &&
            status !== "done" &&
            STEP_FINAL.includes(status)
          );
        });
        if (
          blocked &&
          transitionStep(
            this.database,
            runId,
            step.stepId,
            ["pending"],
            "skipped",
            {
              reason: "upstreamFailed",
              endedAt: this.clock(),
            },
          )
        ) {
          statusOf.set(step.stepId, "skipped");
          this.publishStep(run, step.stepId, "skipped");
          moved = true;
        }
      }
      if (!moved) break;
    }

    // 3. 运行本身的状态。
    steps = stepsOf(this.database, runId);
    const fresh = runById(this.database, runId);
    if (fresh === undefined || RUN_FINAL.includes(fresh.status)) return;
    let next: RunStatus;
    let reason: string | null = null;
    if (steps.every((step) => STEP_FINAL.includes(step.status))) {
      const failed = steps.find((step) => step.status !== "done");
      next = failed === undefined ? "succeeded" : "failed";
      reason =
        failed === undefined
          ? null
          : `${failed.stepId}:${failed.reason ?? failed.status}`;
    } else if (steps.some((step) => step.status === "waiting")) {
      next = "waiting";
    } else {
      next = "running";
    }
    if (next === fresh.status) return;
    const final = RUN_FINAL.includes(next);
    if (
      setRunStatus(
        this.database,
        runId,
        next,
        reason,
        final ? this.clock() : null,
      )
    ) {
      this.publishRun(fresh, next);
    }
  }

  /** 开始一步。答它的新状态；开始不了（缺上下文）答 `undefined`。 */
  private begin(
    run: RunRow,
    definition: WorkflowStep,
    collab: CollabContext | undefined,
  ): StepStatus | undefined {
    const now = this.clock();
    if (definition.kind === "gate") {
      if (
        transitionStep(
          this.database,
          run.id,
          definition.id,
          ["pending"],
          "waiting",
          {
            startedAt: now,
          },
        )
      ) {
        this.publishStep(run, definition.id, "waiting");
        this.publishGate(run, definition.id, "waiting", definition);
        return "waiting";
      }
      return undefined;
    }
    if (collab === undefined) return undefined;
    if (
      !transitionStep(
        this.database,
        run.id,
        definition.id,
        ["pending"],
        "running",
        {
          startedAt: now,
        },
      )
    ) {
      return undefined;
    }
    this.publishStep(run, definition.id, "running");
    if (definition.kind === "collect") this.gather(run, definition, collab);
    this.dispatch(run, definition, collab);
    return "running";
  }

  /** 投（或重投）这一步的提示词。投不上就让这一步失败。 */
  private dispatch(
    run: RunRow,
    definition: PromptStep | CollectStep,
    collab: CollabContext,
  ): void {
    const nodeId = run.roles[definition.role];
    if (nodeId === undefined || run.anchorNodeId === null) {
      this.fail(run, definition.id, "roleMissing");
      return;
    }
    let body = renderPrompt(definition.prompt, run.params);
    if (definition.kind === "collect")
      body = `${body}\n${collectNote(definition)}`;
    try {
      const queueId = deliverPrompt(collab, {
        workspaceId: run.workspaceId,
        sourceNodeId: run.anchorNodeId,
        targetNodeId: nodeId,
        body,
        nowSeconds: this.nowSeconds(),
      });
      noteDispatched(this.database, run.id, definition.id, queueId);
    } catch (error) {
      const code =
        error instanceof DeliveryRefused ? error.code : "deliveryFailed";
      this.fail(run, definition.id, code);
    }
  }

  /** 正在跑的一步：投递、基准、这一轮的结束。 */
  private check(
    run: RunRow,
    step: StepRow,
    collab: CollabContext | undefined,
    exitedNodeId: string | undefined,
  ): void {
    const nodeId = step.nodeId;
    if (nodeId === null) {
      this.fail(run, step.stepId, "roleMissing");
      return;
    }
    const node = loadNode(this.database, nodeId);
    if (node === undefined) {
      this.fail(run, step.stepId, "nodeDeleted");
      return;
    }
    const status = getAgentStatus(this.database, nodeId);
    let current = step;
    if (!current.delivered) {
      const item =
        current.queueId === null
          ? undefined
          : queueItem(this.database, current.queueId);
      if (item === undefined || item.state === "done") {
        // 没有排队项（投过、过了保留期被清掉）按已投读；基准取这一步开始的时刻，
        // 之后节点任何一次干净的结束都算这一轮的。
        const lost = item === undefined;
        noteDelivered(this.database, run.id, step.stepId, {
          state: lost ? null : (status?.state ?? null),
          eventAt: lost
            ? new Date(step.startedAt ?? 0).toISOString()
            : (status?.lastEventAt ?? null),
          busy:
            !lost &&
            status?.state !== undefined &&
            BUSY_STATES.includes(status.state),
        });
        current = stepOfRun(this.database, run.id, step.stepId) as StepRow;
      } else if (item.state === "cancelled" || item.state === "expired") {
        if (current.attempts < MAX_DELIVERY_ATTEMPTS && collab !== undefined) {
          const definition = run.template.steps.find(
            (entry) => entry.id === step.stepId,
          );
          if (definition !== undefined && definition.kind !== "gate") {
            this.dispatch(run, definition, collab);
          }
          return;
        }
        this.fail(
          run,
          step.stepId,
          item.lastReason ?? `delivery${capitalize(item.state)}`,
        );
        return;
      } else {
        return;
      }
    }
    const verdict = evaluate(
      {
        condition: "current",
        observedBusy: current.observedBusy,
        baselineEventAt: current.baselineEventAt,
      },
      { exists: true, ...(status === undefined ? {} : { status }) },
    );
    switch (verdict.kind) {
      case "busy":
        noteBusy(this.database, run.id, step.stepId);
        return;
      case "satisfied": {
        const now = this.clock();
        if (
          transitionStep(
            this.database,
            run.id,
            step.stepId,
            ["running"],
            "done",
            {
              endedAt: now,
              outcome: {
                outputs: outputsOf(
                  this.database,
                  nodeId,
                  current.startedAt ?? 0,
                ),
              },
            },
          )
        ) {
          this.publishStep(run, step.stepId, "done");
        }
        return;
      }
      case "failed":
        // 依赖编排说的是「上游」；在这里那就是这一步自己的这一轮。
        this.fail(
          run,
          step.stepId,
          verdict.reason === "upstreamInterrupted"
            ? "turnInterrupted"
            : "turnFailed",
        );
        return;
      case "missing":
        this.fail(run, step.stepId, "nodeDeleted");
        return;
      default:
        // 终端退出了而这一轮没有结束：不会再结束了。
        if (exitedNodeId === nodeId) this.fail(run, step.stepId, "nodeExited");
        return;
    }
  }

  /**
   * `collect`：来源步骤的产出放进目标节点的收件箱（发信人是产出它的那个节点）。
   * 已经是发给目标的 `post` 不再放第二份。
   */
  private gather(
    run: RunRow,
    definition: CollectStep,
    collab: CollabContext,
  ): void {
    const targetId = run.roles[definition.role];
    if (targetId === undefined) return;
    const nowSeconds = this.nowSeconds();
    const insert = collab.database.prepare(
      "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, message_key, body, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_node_id, target_node_id, message_key) DO NOTHING",
    );
    for (const sourceStepId of definition.from) {
      const source = stepOfRun(this.database, run.id, sourceStepId);
      if (source?.nodeId == null || source.nodeId === targetId) continue;
      if (loadNode(this.database, source.nodeId) === undefined) continue;
      (source.outcome?.outputs ?? []).forEach((output, index) => {
        if (output.target === targetId) return;
        insert.run(
          uuidV7(),
          run.workspaceId,
          source.nodeId,
          targetId,
          `workflow:${run.id}:${sourceStepId}:${index}`,
          output.body,
          nowSeconds,
          nowSeconds + TTL_SECONDS,
        );
      });
    }
    collab.nudge?.(targetId);
  }

  private fail(run: RunRow, stepId: string, reason: string): void {
    if (
      transitionStep(
        this.database,
        run.id,
        stepId,
        ["running", "pending"],
        "failed",
        {
          reason,
          endedAt: this.clock(),
        },
      )
    ) {
      this.publishStep(run, stepId, "failed");
    }
  }

  /* --------------------------------- 发布 --------------------------------- */

  private publishRun(run: RunRow, status: RunStatus): void {
    this.options.collab()?.publish(run.workspaceId, {
      type: "workflow.run",
      runId: run.id,
      boardId: run.boardId,
      status,
    });
  }

  private publishStep(
    run: RunRow,
    stepId: string,
    stepStatus: StepStatus,
  ): void {
    const current = runById(this.database, run.id);
    this.options.collab()?.publish(run.workspaceId, {
      type: "workflow.run",
      runId: run.id,
      boardId: run.boardId,
      status: current?.status ?? run.status,
      stepId,
      stepStatus,
    });
  }

  private publishGate(
    run: RunRow,
    stepId: string,
    state: "waiting" | "approved" | "rejected" | "cancelled",
    definition?: GateStep,
  ): void {
    const gate =
      definition ??
      (run.template.steps.find((step) => step.id === stepId) as
        | GateStep
        | undefined);
    this.options.collab()?.publish(run.workspaceId, {
      type: "workflow.gate",
      runId: run.id,
      boardId: run.boardId,
      stepId,
      label: gate?.label ?? stepId,
      state,
      ...(run.frameId === null ? {} : { nodeId: run.frameId }),
    });
  }

  /* --------------------------------- 杂项 --------------------------------- */

  private nowSeconds(): number {
    return Math.floor(this.clock() / 1000);
  }

  private requireCollab(): CollabContext {
    const collab = this.options.collab();
    if (collab === undefined) {
      throw new DomainError(503, "unavailable", "协作域还没有装配好。");
    }
    return collab;
  }

  private requireRun(runId: string): RunRow {
    const run = runById(this.database, runId);
    if (run === undefined) {
      throw new DomainError(404, "not_found", "没有这次运行。");
    }
    return run;
  }
}

/** `collect` 投出去的正文末尾那一句。长度计进 `COLLECT_NOTE_RESERVE`。 */
export function collectNote(definition: CollectStep): string {
  return `（来源步骤 ${definition.from.join("、")} 的结论已放进你的收件箱：canvas inbox。）`;
}

/**
 * 一步的产出：角色节点在这一步开始之后 `post` 出去的正文，最早的在前。回执
 * 与引擎自己放进收件箱的副本不算。
 */
function outputsOf(
  database: DatabaseSync,
  nodeId: string,
  since: number,
): StepOutput[] {
  const rows = database
    .prepare(
      "SELECT target_node_id, message_key, body, created_at FROM agent_mailbox " +
        "WHERE source_node_id = ? AND created_at >= ? AND message_key NOT LIKE ? " +
        "AND message_key NOT LIKE 'workflow:%' ORDER BY sequence LIMIT ?",
    )
    .all(
      nodeId,
      Math.floor(since / 1000),
      `${RECEIPT_KEY_PREFIX}%`,
      MAX_OUTPUTS,
    ) as {
    target_node_id: string;
    message_key: string;
    body: string;
    created_at: number;
  }[];
  return rows.map((row) => ({
    key: row.message_key,
    body: row.body,
    at: new Date(Number(row.created_at) * 1000).toISOString(),
    target: row.target_node_id,
  }));
}

export function workspaceOfBoard(
  database: DatabaseSync,
  boardId: string,
): string | undefined {
  const row = database
    .prepare("SELECT workspace_id FROM boards WHERE id = ?")
    .get(boardId) as { workspace_id?: string } | undefined;
  return row?.workspace_id;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
