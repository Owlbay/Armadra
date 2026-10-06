/**
 * 一个以 ACP 驱动的节点会话（ACP 会话视图设计 §4、§5.4–§5.7；补全架构 §5.1）。
 *
 * 一个节点一个适配器进程、一个 ACP 会话，挂在 `terminal_sessions` 的一行
 * （`backend_kind = 'acp'`）的一代上。这里只管协议这一侧的语义，行、代次、
 * 租约、退出通知都是终端域的（`bridge.ts` 把它接成一个终端后端）：
 *
 *   * **回合**：`prompt` 排队、一次一个（ACP 不收并发的 `session/prompt`）；
 *     发出即 `working`（新回合），答复的 `stopReason` 落成 `done`
 *     （`normalize.ts`）。回合的结束另发一帧 `acp.turn`。
 *   * **镜像先于事件**：每条 `session/update` 先写镜像再发 `acp.update`
 *     （页面重载靠这个次序不丢分块）；`session/load` 的回放不发给页面，只在
 *     镜像还空着时写进去。
 *   * **审批**：`session/request_permission` 进现有的 `agent_approvals`（经
 *     `blocked` 事件与 reducer，`request_json = { protocol: "acp", toolCall,
 *     options }`）；答复从 `agent/approvals.ts` 的 `"acp"` 路由回到这里。
 *     回合被取消、适配器退出、切换驱动、休眠：挂起的请求一律回 `cancelled`，
 *     审批行记 `cancelled` / `core`。core 从不替人选项。
 *   * **elicitation**（契约 §26.1）：`elicitation/create` 同样进
 *     `agent_approvals`（`request_json = { protocol: "acp", elicitation }`），
 *     状态 `waiting`（带 `pendingId`）；答复经同一条审批路由回到这里，取消、
 *     退出、休眠一律回 `cancel`。core 从不替人填表。
 *   * **模型**（契约 §26.2）：目录来自开会话答的配置项，`config_option_update`
 *     与 `setModel` 更新它。
 */

import type { WorkspaceEvent } from "../bus";
import { AcpError } from "./client";
import type {
  AcpElicitationSettlement,
  AcpExit,
  AcpPendingElicitation,
  AcpPendingPermission,
  AcpPermissionSettlement,
} from "./client";
import { type StoredElicitation, storedElicitation } from "./elicitation";
import {
  type AcpModelCatalog,
  type AcpModelState,
  configOptionsOf,
  modelCatalogOf,
  modelStateOf,
} from "./models";
import type { AcpHostSession, AcpUpdateMeta } from "./host";
import type { AcpMirror } from "./mirror";
import type { AcpSignal } from "./normalize";
import type {
  AcpElicitationResult,
  AcpPermissionOption,
  AcpSessionModeState,
  AcpSessionNotification,
  AcpSessionUpdate,
  AcpToolCallUpdate,
} from "./types";

/** 会话层对外说话的全部出口；装配在 `index.ts`，用例换成假的。 */
export interface AcpSessionSink {
  /** 一个信号 → 归一化 → reducer（`raw` 是审批的请求记录）。 */
  signal(signal: AcpSignal, raw?: unknown): void;
  /** 一帧工作空间事件（`acp.update` / `acp.turn`）。 */
  publish(event: WorkspaceEvent): void;
  /** 一条挂起审批没人答就结束了：审批行记 `cancelled` / `core`。 */
  cancelled(pendingId: string): void;
  /**
   * 镜像路径：`opened` 信号的 `transcriptPath`。缺席不带——让节点继续认 CLI
   * 自己的转录（`same` 且本地历史找得到时）。
   */
  transcriptPath?(acpSessionId: string, mirrorPath: string): string | undefined;
  log?(message: string, fields?: Record<string, unknown>): void;
}

export interface AcpSessionIdentity {
  /** `terminal_sessions.id`：页面、事件与路由认的会话 id。 */
  readonly rowId: string;
  readonly generation: number;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly agentId: string;
}

/** 起适配器时交给它的回调（`host.ts::startAdapter` 的那几项）。 */
export interface AcpSessionCallbacks {
  readonly onUpdate: (
    notification: AcpSessionNotification,
    meta: AcpUpdateMeta,
  ) => void;
  readonly onPermission: (pending: AcpPendingPermission) => void;
  readonly onPermissionSettled: (
    pending: AcpPendingPermission,
    settlement: AcpPermissionSettlement,
  ) => void;
  readonly onElicitation: (pending: AcpPendingElicitation) => void;
  readonly onElicitationSettled: (
    pending: AcpPendingElicitation,
    settlement: AcpElicitationSettlement,
  ) => void;
  readonly onExit: (exit: AcpExit) => void;
}

export interface AcpSessionOptions extends AcpSessionIdentity {
  readonly sink: AcpSessionSink;
  /** ACP 会话 id → 镜像。接回时 id 已知，回放据此判断镜像空不空。 */
  readonly mirrorFor: (acpSessionId: string) => AcpMirror;
  /** 接回这个 ACP 会话（回放进空镜像用）。 */
  readonly resumeSessionId?: string | undefined;
  /** 适配器自己退了（不是我们要它退的）。 */
  readonly onExit?: (exit: AcpExit) => void;
}

/** 页面重载时要画的那张卡。 */
export interface AcpPendingView {
  readonly pendingId: string;
  readonly protocol: "acp";
  readonly toolCall: AcpToolCallUpdate;
  readonly options: readonly AcpPermissionOption[];
}

/** 页面重载时要画的那张 elicitation 卡（契约 §26.1，`…/log` 的 `elicitations`）。 */
export interface AcpPendingElicitationView {
  readonly pendingId: string;
  readonly protocol: "acp";
  readonly elicitation: StoredElicitation;
}

/**
 * 一个最近的回合（契约 §39.9，`…/log` 的 `turns`）。页面发 prompt 的那次 POST
 * 没拿到答复时，凭 `clientTurnId` 在这里认出 core 到底收没收到、结局是什么。
 */
export interface AcpTurnRecord {
  readonly turnId: string;
  readonly clientTurnId?: string;
  readonly state: "queued" | "running" | "ended";
  readonly stopReason?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

/** 记多少个最近的回合：够页面对账断线那一会儿，不随会话变长。 */
const RECENT_TURNS = 32;

let permissionSeq = 0;

/** `<nodeId>-<epochMs>-acp-<n>`：过 `validPendingId`，全局唯一。 */
function pendingIdFor(nodeId: string): string {
  permissionSeq += 1;
  return `${nodeId}-${Date.now()}-acp-${permissionSeq}`;
}

export class AcpSession implements AcpSessionIdentity {
  readonly rowId: string;
  readonly generation: number;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly agentId: string;

  private readonly sink: AcpSessionSink;
  private readonly options: AcpSessionOptions;
  private host: AcpHostSession | undefined;
  private mirror: AcpMirror | undefined;
  /** 开会话之前到的更新：开完再按次序处理。 */
  private early: { update: AcpSessionUpdate; replay: boolean }[] = [];
  /** 回放能不能进镜像：只有镜像空着时。 */
  private replayIntoMirror = false;
  private replayMirror: AcpMirror | undefined;
  /** pendingId → 挂起表里的 id。 */
  private readonly permissions = new Map<string, AcpPendingPermission>();
  private readonly byProcessId = new Map<string, string>();
  /** pendingId → 挂起表里的 elicitation 与存进审批行的那一份。 */
  private readonly elicitations = new Map<
    string,
    {
      readonly pending: AcpPendingElicitation;
      readonly stored: StoredElicitation;
    }
  >();
  private turns = 0;
  private readonly recent: AcpTurnRecord[] = [];
  private queue: Promise<void> = Promise.resolve();
  private running: string | undefined;
  private queued = 0;
  private closed = false;
  private modeState: AcpSessionModeState | null = null;
  private modelCatalog: AcpModelCatalog | null = null;

  constructor(options: AcpSessionOptions) {
    this.options = options;
    this.rowId = options.rowId;
    this.generation = options.generation;
    this.nodeId = options.nodeId;
    this.workspaceId = options.workspaceId;
    this.agentId = options.agentId;
    this.sink = options.sink;
    if (options.resumeSessionId !== undefined) {
      const mirror = options.mirrorFor(options.resumeSessionId);
      this.replayIntoMirror = mirror.empty;
      this.replayMirror = mirror;
    }
  }

  /** 交给 `startAdapter` 的回调。 */
  callbacks(): AcpSessionCallbacks {
    return {
      onUpdate: (notification, meta) => this.onUpdate(notification, meta),
      onPermission: (pending) => this.onPermission(pending),
      onPermissionSettled: (pending, settlement) =>
        this.onPermissionSettled(pending, settlement),
      onElicitation: (pending) => this.onElicitation(pending),
      onElicitationSettled: (pending, settlement) =>
        this.onElicitationSettled(pending, settlement),
      onExit: (exit) => this.onExit(exit),
    };
  }

  /**
   * 会话开好了：记下进程、镜像，说一句 `session` / `start`，再把开会话期间
   * 到的更新补上。
   */
  opened(host: AcpHostSession): void {
    this.host = host;
    this.modeState = host.modes;
    this.modelCatalog = host.models;
    const mirror = this.options.mirrorFor(host.sessionId);
    this.mirror = mirror;
    this.sink.signal({
      signal: "opened",
      sessionId: host.sessionId,
      transcriptPath: this.sink.transcriptPath?.(host.sessionId, mirror.path),
    });
    const early = this.early;
    this.early = [];
    for (const item of early) this.consume(item.update, item.replay);
  }

  get acpSessionId(): string | undefined {
    return this.host?.sessionId;
  }

  get pid(): number | undefined {
    return this.host?.process.pid;
  }

  get alive(): boolean {
    return this.host?.process.alive === true && !this.closed;
  }

  get resumed(): boolean {
    return this.host?.resumed === true;
  }

  /** 一个回合正在跑或排着。 */
  get busy(): boolean {
    return this.running !== undefined || this.queued > 0;
  }

  get modes(): AcpSessionModeState | null {
    return this.modeState;
  }

  /** 模型目录（`…/log` 的 `models`）；不给选时为 `null`。 */
  get models(): AcpModelState | null {
    return modelStateOf(this.modelCatalog);
  }

  get mirrorPath(): string | undefined {
    return this.mirror?.path;
  }

  /** 镜像渲染出的最后几行（桥的 `capture`）。 */
  capture(lines: number): string {
    return this.mirror?.capture(lines) ?? "";
  }

  /** 最近的回合，旧的在前（`…/log` 的 `turns`，契约 §39.9）。 */
  recentTurns(): AcpTurnRecord[] {
    return [...this.recent];
  }

  private record(turnId: string, next: Partial<AcpTurnRecord>): void {
    const index = this.recent.findIndex((turn) => turn.turnId === turnId);
    if (index < 0) return;
    this.recent[index] = { ...(this.recent[index] as AcpTurnRecord), ...next };
  }

  private clientTurnOf(turnId: string): string | undefined {
    return this.recent.find((turn) => turn.turnId === turnId)?.clientTurnId;
  }

  /** 挂起的审批（`…/log` 的 `pending`）。 */
  pending(): AcpPendingView[] {
    return [...this.permissions.entries()].map(([pendingId, pending]) => ({
      pendingId,
      protocol: "acp",
      toolCall: pending.toolCall,
      options: pending.options,
    }));
  }

  /** 挂起的 elicitation（`…/log` 的 `elicitations`）。 */
  pendingElicitations(): AcpPendingElicitationView[] {
    return [...this.elicitations.entries()].map(([pendingId, entry]) => ({
      pendingId,
      protocol: "acp",
      elicitation: entry.stored,
    }));
  }

  /* --------------------------------- 回合 --------------------------------- */

  /**
   * 一条 prompt。排进队列，答回合 id；回合的结局经 `acp.turn` 说。适配器已经
   * 不在了就当场拒绝。`clientTurnId` 是页面给这一轮起的 id（§39.9），随回合
   * 记下、随 `acp.turn` 带回；去重在路由那一层。
   */
  prompt(text: string, clientTurnId?: string): string {
    if (!this.alive) {
      throw new AcpError("acp_exited", "the ACP agent is not running");
    }
    this.turns += 1;
    const turnId = `${this.generation}-${this.turns}`;
    this.recent.push({
      turnId,
      ...(clientTurnId === undefined ? {} : { clientTurnId }),
      state: "queued",
    });
    if (this.recent.length > RECENT_TURNS) this.recent.shift();
    this.queued += 1;
    this.queue = this.queue.then(async () => {
      this.queued -= 1;
      await this.runTurn(turnId, text);
    });
    return turnId;
  }

  private async runTurn(turnId: string, text: string): Promise<void> {
    const host = this.host;
    if (host === undefined || !this.alive) {
      this.endTurn(turnId, {
        error: { code: "acp_exited", message: "the ACP agent is not running" },
      });
      return;
    }
    this.running = turnId;
    this.record(turnId, { state: "running" });
    // 我方这条也是对话的一部分：先进镜像，再让别的设备看见。
    this.mirror?.prompt(text);
    this.sink.publish({
      type: "acp.update",
      sessionId: this.rowId,
      nodeId: this.nodeId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text },
      },
    });
    this.sink.signal({ signal: "prompt", text });
    try {
      const result = await host.process.prompt(host.sessionId, [
        { type: "text", text },
      ]);
      this.endTurn(turnId, { stopReason: result.stopReason });
    } catch (error) {
      const gone = !host.process.alive;
      this.endTurn(turnId, {
        error: gone
          ? { code: "acp_exited", message: "the ACP agent exited" }
          : { code: "acp_protocol", message: messageOf(error) },
      });
    } finally {
      this.running = undefined;
    }
  }

  private endTurn(
    turnId: string,
    end: {
      readonly stopReason?: string;
      readonly error?: { readonly code: string; readonly message: string };
    },
  ): void {
    this.record(turnId, {
      state: "ended",
      ...(end.stopReason === undefined ? {} : { stopReason: end.stopReason }),
      ...(end.error === undefined ? {} : { error: end.error }),
    });
    const clientTurnId = this.clientTurnOf(turnId);
    if (end.error === undefined) {
      this.sink.signal({ signal: "turn", stopReason: end.stopReason });
    } else if (end.error.code !== "acp_exited") {
      // 进程没了的那一种不在这里落 `done`：退出走终端域的退出通知
      // （`terminalGoneEvent`），与 PTY 死掉同一条路。
      this.sink.signal({ signal: "turn", error: end.error.message });
    }
    this.sink.publish({
      type: "acp.turn",
      sessionId: this.rowId,
      nodeId: this.nodeId,
      turnId,
      ...(clientTurnId === undefined ? {} : { clientTurnId }),
      ...(end.stopReason === undefined ? {} : { stopReason: end.stopReason }),
      ...(end.error === undefined ? {} : { error: end.error }),
    });
  }

  /** `session/cancel`：挂起的审批由客户端回 `cancelled`。 */
  async cancel(): Promise<void> {
    const host = this.host;
    if (host === undefined || !host.process.alive) return;
    await host.process.cancel(host.sessionId);
  }

  /** `session/set_mode`。模式不在这家的列表里答 `acp_mode_unavailable`。 */
  async setMode(modeId: string): Promise<void> {
    const host = this.host;
    if (host === undefined || !this.alive) {
      throw new AcpError("acp_exited", "the ACP agent is not running");
    }
    const modes = this.modeState;
    if (
      modes === null ||
      !modes.availableModes.some((mode) => mode.id === modeId)
    ) {
      throw new AcpError(
        "acp_mode_unavailable",
        `the agent has no mode ${modeId}`,
      );
    }
    await host.process.setMode(host.sessionId, modeId);
    this.modeState = { ...modes, currentModeId: modeId };
  }

  /**
   * 落模型（`session/set_config_option`）。目录里没有答 `acp_model_unavailable`，
   * 客户端没有这个能力答 `acp_model_unsupported`。
   */
  async setModel(modelId: string): Promise<void> {
    const host = this.host;
    if (host === undefined || !this.alive) {
      throw new AcpError("acp_exited", "the ACP agent is not running");
    }
    const catalog = this.modelCatalog;
    if (
      catalog === null ||
      !catalog.availableModels.some((model) => model.modelId === modelId)
    ) {
      throw new AcpError(
        "acp_model_unavailable",
        `the agent offers no model ${modelId}`,
      );
    }
    const answer = await host.process.setConfigOption(
      host.sessionId,
      catalog.configId,
      modelId,
    );
    this.modelCatalog = modelCatalogOf(answer) ?? {
      ...catalog,
      currentModelId: modelId,
    };
  }

  /**
   * 答一条挂起的 elicitation（内容已由审批层按 schema 校验）。不认识或已经
   * 结束的答 `false`。
   */
  answerElicitation(pendingId: string, result: AcpElicitationResult): boolean {
    const entry = this.elicitations.get(pendingId);
    const host = this.host;
    if (entry === undefined || host === undefined) return false;
    return host.process.answerElicitation(entry.pending.id, result);
  }

  /**
   * 答一条挂起的审批。`optionId` 必须是 Agent 给的选项之一；`null` = 回
   * `cancelled`。不认识或已经结束的答 `false`。
   */
  answer(pendingId: string, optionId: string | null): boolean {
    const pending = this.permissions.get(pendingId);
    const host = this.host;
    if (pending === undefined || host === undefined) return false;
    return host.process.answerPermission(pending.id, optionId);
  }

  /** 这条审批归不归这个会话管。 */
  owns(pendingId: string): boolean {
    return this.permissions.has(pendingId) || this.elicitations.has(pendingId);
  }

  /**
   * 结束：回合里先 `session/cancel`，再收掉进程（及其子树）。挂起的审批在
   * 进程退出时由客户端一律回 `cancelled`。
   */
  async terminate(): Promise<void> {
    this.closed = true;
    const host = this.host;
    if (host === undefined) return;
    if (this.running !== undefined) {
      await host.process.cancel(host.sessionId).catch(() => undefined);
    }
    await host.process.terminate();
  }

  /* -------------------------------- 回调 --------------------------------- */

  private onUpdate(
    notification: AcpSessionNotification,
    meta: AcpUpdateMeta,
  ): void {
    if (this.host === undefined) {
      this.early.push({ update: notification.update, replay: meta.replay });
      return;
    }
    if (notification.sessionId !== this.host.sessionId) return;
    this.consume(notification.update, meta.replay);
  }

  private consume(update: AcpSessionUpdate, replay: boolean): void {
    if (replay) {
      // 回放：镜像里已经有就什么都不做；从别的驱动切过来、镜像还空着时把它
      // 记下，会话视图才看得到之前的对话。不发给页面、不进状态。
      if (this.replayIntoMirror) {
        (this.replayMirror ?? this.mirror)?.update(update, true);
      }
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      const modeId = (update as { currentModeId?: unknown }).currentModeId;
      if (typeof modeId === "string" && this.modeState !== null) {
        this.modeState = { ...this.modeState, currentModeId: modeId };
      }
    }
    if (
      (update.sessionUpdate as string) === "config_option_update" &&
      this.modelCatalog !== null
    ) {
      // 只在已经有目录时跟：没有 `configOptions` 能力就没有改模型的路，跟了
      // 也只是画一个改不了的 Select。
      const next = modelCatalogOf(configOptionsOf(update));
      if (next !== null) this.modelCatalog = next;
    }
    try {
      this.mirror?.update(update, false);
    } catch (error) {
      this.sink.log?.("could not write the ACP mirror", {
        nodeId: this.nodeId,
        error: messageOf(error),
      });
    }
    this.sink.publish({
      type: "acp.update",
      sessionId: this.rowId,
      nodeId: this.nodeId,
      update: update as unknown as { sessionUpdate: string },
    });
    if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      // 工具调用不改状态（仍是 working），只在回合里续上「还活着」；回合外到
      // 的迟到更新（取消之后的最后几条）不把 done 掀回 working。
      if (this.running !== undefined) {
        const body = update as { title?: unknown; kind?: unknown };
        this.sink.signal({
          signal: "tool",
          title: typeof body.title === "string" ? body.title : undefined,
          toolKind: typeof body.kind === "string" ? body.kind : undefined,
        });
      }
    }
  }

  private onPermission(pending: AcpPendingPermission): void {
    const pendingId = pendingIdFor(this.nodeId);
    this.permissions.set(pendingId, pending);
    this.byProcessId.set(pending.id, pendingId);
    this.sink.signal(
      { signal: "permission", pendingId },
      { protocol: "acp", toolCall: pending.toolCall, options: pending.options },
    );
  }

  private onPermissionSettled(
    pending: AcpPendingPermission,
    settlement: AcpPermissionSettlement,
  ): void {
    const pendingId = this.byProcessId.get(pending.id);
    if (pendingId === undefined) return;
    this.byProcessId.delete(pending.id);
    this.permissions.delete(pendingId);
    if (settlement.by === "cancelled") this.sink.cancelled(pendingId);
    // 答了（或被取消了）：回合还在就回到 working，直到它的 stopReason。
    if (this.running !== undefined && this.host?.process.alive === true) {
      this.sink.signal({ signal: "permissionSettled" });
    }
  }

  private onElicitation(pending: AcpPendingElicitation): void {
    // 一个进程一个会话：没带 sessionId 的也是这个会话的。
    if (
      pending.sessionId !== "" &&
      this.host !== undefined &&
      pending.sessionId !== this.host.sessionId
    ) {
      return;
    }
    const pendingId = pendingIdFor(this.nodeId);
    const stored = storedElicitation(pending.request);
    this.elicitations.set(pendingId, { pending, stored });
    this.byProcessId.set(pending.id, pendingId);
    this.sink.signal(
      { signal: "elicitation", pendingId },
      { protocol: "acp", elicitation: stored },
    );
  }

  private onElicitationSettled(
    pending: AcpPendingElicitation,
    settlement: AcpElicitationSettlement,
  ): void {
    const pendingId = this.byProcessId.get(pending.id);
    if (pendingId === undefined) return;
    this.byProcessId.delete(pending.id);
    this.elicitations.delete(pendingId);
    if (settlement.by === "cancelled") this.sink.cancelled(pendingId);
    if (this.running !== undefined && this.host?.process.alive === true) {
      this.sink.signal({ signal: "permissionSettled" });
    }
  }

  private onExit(exit: AcpExit): void {
    this.closed = true;
    this.options.onExit?.(exit);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
