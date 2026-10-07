/**
 * ACP 会话视图的读模型（ACP 设计 §6）。
 *
 * 每个 sessionId 一份：消息、工具调用、计划、当前模式、用量；挂起的审批按
 * nodeId 存，因为 `agent.approval` 只认节点。两个来源喂同一份：
 *
 *  * `GET /api/acp/sessions/{id}/log` —— 镜像里的 `TranscriptEntry`，重载与
 *    第一次挂载时整份重建；
 *  * `acp.update` / `acp.turn` —— 活的那一段，逐条并进去。
 *
 * 归约都是纯函数，组件与测试走同一条路。
 */
import { scoped } from "../sources/scope";
import { create } from "zustand";
import {
  acpContentBlockSchema,
  acpElicitationRequestSchema,
  acpModeStateSchema,
  acpModelStateSchema,
  acpPermissionRequestSchema,
  acpPlanEntrySchema,
  acpToolCallSchema,
  type AcpElicitation,
  type AcpLogResponse,
  type AcpModeState,
  type AcpModel,
  type AcpModelState,
  type AcpPendingPermission,
  type AcpPermissionOption,
  type AcpPlanEntry,
  type AcpSessionUpdate,
  type AcpToolCall,
  type AcpToolCallContent,
  type AcpToolCallStatus,
  type AcpToolKind,
  type AcpTranscriptEntry,
  type AcpTurnEvent,
  type AcpTurnRecord,
} from "@armadra/shared";
import { z } from "zod";

export type AcpMessageRole = "user" | "assistant" | "thought";

export interface AcpToolCallView {
  readonly toolCallId: string;
  readonly title: string;
  readonly kind?: AcpToolKind | undefined;
  readonly status?: AcpToolCallStatus | undefined;
  readonly content: readonly AcpToolCallContent[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

export type AcpItem =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly role: AcpMessageRole;
      readonly text: string;
      readonly turn: number;
      /** 页面自己先画上的那条用户消息：适配器回显的同一句不再画第二遍。 */
      readonly local?: true;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly call: AcpToolCallView;
      readonly turn: number;
    };

export interface AcpSessionView {
  readonly items: readonly AcpItem[];
  /** 当前回合号；每条用户消息开一回合。 */
  readonly turn: number;
  /** 发出 prompt 到 `acp.turn` 之间。 */
  readonly streaming: boolean;
  readonly modes: AcpModeState | null;
  /** 契约 §26.2：Agent 给的模型目录；不给选时 `null`。 */
  readonly models: AcpModelState | null;
  readonly plan: readonly AcpPlanEntry[];
  readonly usage: { readonly used: number; readonly size: number } | null;
  /** 上一回合没有正常结束；重试重发 `lastPrompt`。 */
  readonly failed: boolean;
  readonly lastPrompt: string | null;
  readonly endOffset: number;
  /** 本页最近发出的那一轮的 `clientTurnId`（契约 §39.9）。 */
  readonly clientTurnId: string | null;
  /** 发 prompt 的那次请求断在路上：core 收没收到还不知道，正在对账。 */
  readonly confirming: boolean;
  /** 对账确认 core 没收到（或无从确认）：重试沿用同一个 `clientTurnId`。 */
  readonly undelivered: boolean;
}

export interface AcpPermissionView {
  readonly pendingId: string;
  readonly toolCall: AcpToolCall;
  readonly options: readonly AcpPermissionOption[];
}

/** 一条挂起的 `elicitation/create`（契约 §26.1）。 */
export interface AcpElicitationView {
  readonly pendingId: string;
  readonly elicitation: AcpElicitation;
}

export const EMPTY_SESSION: AcpSessionView = {
  items: [],
  turn: 0,
  streaming: false,
  modes: null,
  models: null,
  plan: [],
  usage: null,
  failed: false,
  lastPrompt: null,
  endOffset: 0,
  clientTurnId: null,
  confirming: false,
  undelivered: false,
};

/* --------------------------------- 归约 ---------------------------------- */

function textOf(content: unknown): string {
  const block = acpContentBlockSchema.safeParse(content);
  if (!block.success) return "";
  return block.data.type === "text" ? (block.data.text ?? "") : "";
}

function toolView(call: AcpToolCall, previous?: AcpToolCallView) {
  return {
    toolCallId: call.toolCallId,
    title: call.title ?? previous?.title ?? "",
    kind: call.kind ?? previous?.kind,
    status: call.status ?? previous?.status,
    content: call.content ?? previous?.content ?? [],
    rawInput: call.rawInput !== undefined ? call.rawInput : previous?.rawInput,
    rawOutput:
      call.rawOutput !== undefined ? call.rawOutput : previous?.rawOutput,
  } satisfies AcpToolCallView;
}

function appendText(
  view: AcpSessionView,
  role: AcpMessageRole,
  text: string,
): AcpSessionView {
  if (!text) return view;
  const last = view.items.at(-1);
  if (role === "user") {
    // 回放里的用户消息开新回合；本回合页面已经画过的那一句不再重复。
    if (last?.kind === "message" && last.role === "user") {
      if (last.local) return view;
      return replaceLast(view, { ...last, text: last.text + text });
    }
    const turn = view.turn + 1;
    return {
      ...view,
      turn,
      items: [
        ...view.items,
        { kind: "message", id: `m${view.items.length}`, role, text, turn },
      ],
    };
  }
  if (
    last?.kind === "message" &&
    last.role === role &&
    last.turn === view.turn
  ) {
    return replaceLast(view, { ...last, text: last.text + text });
  }
  return {
    ...view,
    items: [
      ...view.items,
      {
        kind: "message",
        id: `m${view.items.length}`,
        role,
        text,
        turn: view.turn,
      },
    ],
  };
}

function replaceLast(view: AcpSessionView, item: AcpItem): AcpSessionView {
  return { ...view, items: [...view.items.slice(0, -1), item] };
}

function upsertTool(view: AcpSessionView, call: AcpToolCall): AcpSessionView {
  const index = view.items.findIndex(
    (item) => item.kind === "tool" && item.call.toolCallId === call.toolCallId,
  );
  if (index >= 0) {
    const item = view.items[index] as Extract<AcpItem, { kind: "tool" }>;
    const items = [...view.items];
    items[index] = { ...item, call: toolView(call, item.call) };
    return { ...view, items };
  }
  return {
    ...view,
    items: [
      ...view.items,
      {
        kind: "tool",
        id: `t${call.toolCallId}`,
        call: toolView(call),
        turn: view.turn,
      },
    ],
  };
}

const usageSchema = z.looseObject({ used: z.number(), size: z.number() });

/** 一条 `session/update`。不画的种类原样返回。 */
export function applyUpdate(
  view: AcpSessionView,
  update: AcpSessionUpdate,
): AcpSessionView {
  const body = update as Record<string, unknown>;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return appendText(view, "user", textOf(body.content));
    case "agent_message_chunk":
      return appendText(view, "assistant", textOf(body.content));
    case "agent_thought_chunk":
      return appendText(view, "thought", textOf(body.content));
    case "tool_call":
    case "tool_call_update": {
      const call = acpToolCallSchema.safeParse(body);
      return call.success ? upsertTool(view, call.data) : view;
    }
    case "plan": {
      const entries = z.array(acpPlanEntrySchema).safeParse(body.entries);
      return entries.success ? { ...view, plan: entries.data } : view;
    }
    case "current_mode_update": {
      if (typeof body.currentModeId !== "string" || !view.modes) return view;
      return {
        ...view,
        modes: { ...view.modes, currentModeId: body.currentModeId },
      };
    }
    case "config_option_update": {
      // 与 core 同一条规矩：已经有目录时才跟（没有改模型的路就不画 Select）。
      if (!view.models) return view;
      const models = modelStateOf(body.configOptions);
      return models ? { ...view, models } : view;
    }
    case "usage_update": {
      const usage = usageSchema.safeParse(body);
      return usage.success
        ? { ...view, usage: { used: usage.data.used, size: usage.data.size } }
        : view;
    }
    default:
      return view;
  }
}

const configOptionSchema = z.looseObject({
  id: z.string(),
  category: z.string().nullish(),
  currentValue: z.unknown().optional(),
  options: z.array(z.unknown()),
});

const configValueSchema = z.looseObject({
  value: z.string(),
  name: z.string().optional(),
  description: z.string().nullish(),
});

function flattenValues(options: readonly unknown[], out: AcpModel[]): void {
  for (const option of options) {
    const group = (option as { options?: unknown } | null)?.options;
    if (Array.isArray(group)) {
      flattenValues(group, out);
      continue;
    }
    const value = configValueSchema.safeParse(option);
    if (!value.success || out.some((m) => m.modelId === value.data.value))
      continue;
    out.push({
      modelId: value.data.value,
      name: value.data.name ?? value.data.value,
      ...(value.data.description
        ? { description: value.data.description }
        : {}),
    });
  }
}

/**
 * `config_option_update` 的配置项 → 模型目录（与 `core/acp/models.ts` 同一个
 * 认法：`category: "model"`，没有分类时 id 为 `model`；分组摊平）。
 */
export function modelStateOf(configOptions: unknown): AcpModelState | null {
  const list = z.array(z.unknown()).safeParse(configOptions);
  if (!list.success) return null;
  const options = list.data.flatMap((item) => {
    const parsed = configOptionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  const option =
    options.find((item) => item.category === "model") ??
    options.find((item) => item.category == null && item.id === "model");
  if (!option) return null;
  const models: AcpModel[] = [];
  flattenValues(option.options, models);
  const first = models[0];
  if (!first) return null;
  const current =
    typeof option.currentValue === "string" &&
    models.some((m) => m.modelId === option.currentValue)
      ? option.currentValue
      : first.modelId;
  return { currentModelId: current, availableModels: models };
}

/** 页面发出一条 prompt：先画上，回合开始。 */
export function beginTurn(
  view: AcpSessionView,
  text: string,
  clientTurnId: string | null = null,
): AcpSessionView {
  if (
    view.undelivered &&
    clientTurnId !== null &&
    clientTurnId === view.clientTurnId
  ) {
    // 重试没送达的那一轮：提问已经画着，不再画第二遍。
    return { ...view, streaming: true, failed: false, undelivered: false };
  }
  const turn = view.turn + 1;
  return {
    ...view,
    turn,
    streaming: true,
    failed: false,
    lastPrompt: text,
    clientTurnId,
    confirming: false,
    undelivered: false,
    items: [
      ...view.items,
      {
        kind: "message",
        id: `m${view.items.length}`,
        role: "user",
        text,
        turn,
        local: true,
      },
    ],
  };
}

/**
 * `acp.turn`：回合结束。拒答与协议错误算失败，取消不算。本页那一轮还在对账
 * （或已判没送达）时，带着别的 `clientTurnId` 的结束帧不是它的结局，不动。
 */
export function endTurn(
  view: AcpSessionView,
  event: Pick<AcpTurnEvent, "stopReason" | "error" | "clientTurnId">,
): AcpSessionView {
  if (
    (view.confirming || view.undelivered) &&
    event.clientTurnId !== undefined &&
    event.clientTurnId !== view.clientTurnId
  ) {
    return view;
  }
  const failed = Boolean(event.error) || event.stopReason === "refusal";
  return {
    ...view,
    streaming: false,
    failed,
    confirming: false,
    undelivered: false,
    // 回合边界之后的第一段输出必须是新的一条，哪怕上一条也是助手说的。
    turn: view.turn + 1,
  };
}

/** 本页那一轮的提问不在时间线上（镜像里还没有）时补画上。 */
function withLocalPrompt(view: AcpSessionView): AcpSessionView {
  const text = view.lastPrompt;
  if (!text) return view;
  const last = [...view.items]
    .reverse()
    .find((item) => item.kind === "message" && item.role === "user");
  if (last?.kind === "message" && last.text === text) return view;
  const turn = view.turn + 1;
  return {
    ...view,
    turn,
    items: [
      ...view.items,
      {
        kind: "message",
        id: `m${view.items.length}`,
        role: "user",
        text,
        turn,
        local: true,
      },
    ],
  };
}

/**
 * 对账（契约 §39.9）：拿镜像读回来的 `turns` 认本页那一轮。core 有这一轮就照
 * 它的真实状态画（排队、在跑、已结束）；正在确认而 core 没有，判没送达，重试
 * 沿用同一个 id。`turns` 缺席（旧 core、会话不在跑）同样无从确认。
 */
export function reconcileTurn(
  view: AcpSessionView,
  turns: readonly AcpTurnRecord[] | undefined,
): AcpSessionView {
  const id = view.clientTurnId;
  if (!id || !(view.confirming || view.undelivered || view.streaming)) {
    return view;
  }
  const record = turns?.find((turn) => turn.clientTurnId === id);
  if (record?.state === "ended") {
    return endTurn(
      { ...view, confirming: false, undelivered: false },
      {
        ...(record.stopReason === undefined
          ? {}
          : { stopReason: record.stopReason as AcpTurnEvent["stopReason"] }),
        ...(record.error === undefined ? {} : { error: record.error }),
      },
    );
  }
  if (record) {
    return {
      ...withLocalPrompt(view),
      streaming: true,
      failed: false,
      confirming: false,
      undelivered: false,
    };
  }
  if (!view.confirming) return view;
  return {
    ...withLocalPrompt(view),
    streaming: false,
    failed: true,
    confirming: false,
    undelivered: true,
  };
}

/** 镜像里的记录 → 时间线。工具结果并回它的调用。 */
export function fromLog(
  entries: readonly AcpTranscriptEntry[],
  base: AcpSessionView = EMPTY_SESSION,
): AcpSessionView {
  let view: AcpSessionView = { ...base, items: [], turn: 0 };
  for (const entry of entries) {
    if (entry.role === "system") continue;
    if (entry.role === "user") {
      const text = entry.blocks
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      // 只有工具结果的 user 记录（Claude 的转录这样存）不开新回合。
      if (text) {
        view = appendText(view, "user", text);
        continue;
      }
    }
    for (const block of entry.blocks) {
      if (block.type === "text") {
        view = appendText(view, "assistant", block.text);
      } else if (block.type === "tool_use" && block.id) {
        view = upsertTool(view, {
          toolCallId: block.id,
          title: block.name,
          rawInput: block.input,
        });
      } else if (block.type === "tool_result" && block.id) {
        view = upsertTool(view, {
          toolCallId: block.id,
          status: "completed",
          rawOutput: block.content,
        });
      }
    }
  }
  return { ...view, turn: view.turn + 1 };
}

/**
 * `agent.approval` 的 `request` 是审批记录（`request` 字段才是 ACP 的载荷），
 * 也认直接给载荷的形状。不是 ACP 的审批回 `null`。
 */
export function acpPermissionOf(
  pendingId: string,
  request: unknown,
): AcpPermissionView | null {
  const record = request as { request?: unknown } | null;
  for (const candidate of [record?.request, request]) {
    const parsed = acpPermissionRequestSchema.safeParse(candidate);
    if (parsed.success)
      return {
        pendingId,
        toolCall: parsed.data.toolCall,
        options: parsed.data.options,
      };
  }
  return null;
}

/** `agent.approval` 里的 elicitation（形状同上）；不是就回 `null`。 */
export function acpElicitationOf(
  pendingId: string,
  request: unknown,
): AcpElicitationView | null {
  const record = request as { request?: unknown } | null;
  for (const candidate of [record?.request, request]) {
    const parsed = acpElicitationRequestSchema.safeParse(candidate);
    if (parsed.success)
      return { pendingId, elicitation: parsed.data.elicitation };
  }
  return null;
}

/* --------------------------------- store --------------------------------- */

/** 三张表的键都是 `${sourceId}:${id}`（`sources/scope.ts`）。 */
interface AcpStoreState {
  readonly sessions: Readonly<Record<string, AcpSessionView>>;
  readonly permissions: Readonly<Record<string, readonly AcpPermissionView[]>>;
  /** 挂起的 elicitation，按 nodeId 存（与审批同理）。 */
  readonly elicitations: Readonly<
    Record<string, readonly AcpElicitationView[]>
  >;
  hydrate: (sessionId: string, nodeId: string, log: AcpLogResponse) => void;
  update: (sessionId: string, update: AcpSessionUpdate) => void;
  begin: (sessionId: string, text: string, clientTurnId?: string) => void;
  end: (
    sessionId: string,
    nodeId: string,
    event: Pick<AcpTurnEvent, "stopReason" | "error" | "clientTurnId">,
  ) => void;
  /** 发 prompt 的请求断在路上：进入「确认中」。 */
  confirm: (sessionId: string) => void;
  /** 拿镜像读回来的 `turns` 对账（`reconcileTurn`）。 */
  reconcile: (
    sessionId: string,
    turns: readonly AcpTurnRecord[] | undefined,
  ) => void;
  setMode: (sessionId: string, modeId: string) => void;
  setModel: (sessionId: string, modelId: string) => void;
  addPermission: (nodeId: string, permission: AcpPermissionView) => void;
  addElicitation: (nodeId: string, elicitation: AcpElicitationView) => void;
  /** 审批与 elicitation 共用一个 pendingId 空间：两边一起收。 */
  resolvePermission: (pendingId: string) => void;
  reset: () => void;
}

function patchSession(
  state: AcpStoreState,
  sessionId: string,
  next: (view: AcpSessionView) => AcpSessionView,
): Pick<AcpStoreState, "sessions"> {
  const key = scoped(sessionId);
  const view = state.sessions[key] ?? EMPTY_SESSION;
  return { sessions: { ...state.sessions, [key]: next(view) } };
}

function withoutPending<T extends { readonly pendingId: string }>(
  map: Readonly<Record<string, readonly T[]>>,
  pendingId: string,
): Record<string, readonly T[]> {
  const out: Record<string, readonly T[]> = {};
  for (const [nodeId, list] of Object.entries(map)) {
    const kept = list.filter((item) => item.pendingId !== pendingId);
    if (kept.length > 0) out[nodeId] = kept;
  }
  return out;
}

export const useAcpStore = create<AcpStoreState>((set) => ({
  sessions: {},
  permissions: {},
  elicitations: {},
  hydrate: (sessionId, nodeId, log) =>
    set((state) => {
      const key = scoped(sessionId);
      const nodeKey = scoped(nodeId);
      const previous = state.sessions[key] ?? EMPTY_SESSION;
      const modes = acpModeStateSchema.safeParse(log.modes);
      const models = acpModelStateSchema.safeParse(log.models);
      const view: AcpSessionView = {
        ...fromLog(log.entries, previous),
        modes: modes.success ? modes.data : previous.modes,
        // `null` 是「不给选」，照样记下；字段不在（旧 core）时保留之前的。
        models: models.success
          ? models.data
          : log.models === null
            ? null
            : previous.models,
        endOffset: log.endOffset,
      };
      const pending = (log.pending ?? []).map((item: AcpPendingPermission) => ({
        pendingId: item.pendingId,
        toolCall: item.toolCall,
        options: item.options,
      }));
      const elicitations = (log.elicitations ?? []).map((item) => ({
        pendingId: item.pendingId,
        elicitation: item.elicitation,
      }));
      return {
        sessions: { ...state.sessions, [key]: view },
        permissions:
          log.pending === undefined
            ? state.permissions
            : { ...state.permissions, [nodeKey]: pending },
        elicitations:
          log.elicitations === undefined
            ? state.elicitations
            : { ...state.elicitations, [nodeKey]: elicitations },
      };
    }),
  update: (sessionId, update) =>
    set((state) =>
      patchSession(state, sessionId, (view) => applyUpdate(view, update)),
    ),
  begin: (sessionId, text, clientTurnId) =>
    set((state) =>
      patchSession(state, sessionId, (view) =>
        beginTurn(view, text, clientTurnId ?? null),
      ),
    ),
  confirm: (sessionId) =>
    set((state) =>
      patchSession(state, sessionId, (view) => ({ ...view, confirming: true })),
    ),
  reconcile: (sessionId, turns) =>
    set((state) =>
      patchSession(state, sessionId, (view) => reconcileTurn(view, turns)),
    ),
  end: (sessionId, nodeId, event) =>
    set((state) => {
      const current = state.sessions[scoped(sessionId)] ?? EMPTY_SESSION;
      const next = endTurn(current, event);
      if (next === current) return {};
      // 回合结束时挂起的审批都已由 core 回了 `cancelled`（ACP 设计 §5.5）。
      const permissions = { ...state.permissions };
      delete permissions[scoped(nodeId)];
      const elicitations = { ...state.elicitations };
      delete elicitations[scoped(nodeId)];
      return {
        ...patchSession(state, sessionId, () => next),
        permissions,
        elicitations,
      };
    }),
  setMode: (sessionId, modeId) =>
    set((state) =>
      patchSession(state, sessionId, (view) =>
        view.modes
          ? { ...view, modes: { ...view.modes, currentModeId: modeId } }
          : view,
      ),
    ),
  setModel: (sessionId, modelId) =>
    set((state) =>
      patchSession(state, sessionId, (view) =>
        view.models
          ? { ...view, models: { ...view.models, currentModelId: modelId } }
          : view,
      ),
    ),
  addPermission: (nodeId, permission) =>
    set((state) => {
      const key = scoped(nodeId);
      const list = (state.permissions[key] ?? []).filter(
        (item) => item.pendingId !== permission.pendingId,
      );
      return {
        permissions: { ...state.permissions, [key]: [...list, permission] },
      };
    }),
  addElicitation: (nodeId, elicitation) =>
    set((state) => {
      const key = scoped(nodeId);
      const list = (state.elicitations[key] ?? []).filter(
        (item) => item.pendingId !== elicitation.pendingId,
      );
      return {
        elicitations: {
          ...state.elicitations,
          [key]: [...list, elicitation],
        },
      };
    }),
  resolvePermission: (pendingId) =>
    set((state) => ({
      permissions: withoutPending(state.permissions, pendingId),
      elicitations: withoutPending(state.elicitations, pendingId),
    })),
  reset: () => set({ sessions: {}, permissions: {}, elicitations: {} }),
}));
