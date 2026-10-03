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
import { create } from "zustand";
import {
  acpContentBlockSchema,
  acpModeStateSchema,
  acpPermissionRequestSchema,
  acpPlanEntrySchema,
  acpToolCallSchema,
  type AcpLogResponse,
  type AcpModeState,
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
  readonly plan: readonly AcpPlanEntry[];
  readonly usage: { readonly used: number; readonly size: number } | null;
  /** 上一回合没有正常结束；重试重发 `lastPrompt`。 */
  readonly failed: boolean;
  readonly lastPrompt: string | null;
  readonly endOffset: number;
}

export interface AcpPermissionView {
  readonly pendingId: string;
  readonly toolCall: AcpToolCall;
  readonly options: readonly AcpPermissionOption[];
}

export const EMPTY_SESSION: AcpSessionView = {
  items: [],
  turn: 0,
  streaming: false,
  modes: null,
  plan: [],
  usage: null,
  failed: false,
  lastPrompt: null,
  endOffset: 0,
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

/** 页面发出一条 prompt：先画上，回合开始。 */
export function beginTurn(view: AcpSessionView, text: string): AcpSessionView {
  const turn = view.turn + 1;
  return {
    ...view,
    turn,
    streaming: true,
    failed: false,
    lastPrompt: text,
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

/** `acp.turn`：回合结束。拒答与协议错误算失败，取消不算。 */
export function endTurn(
  view: AcpSessionView,
  event: Pick<AcpTurnEvent, "stopReason" | "error">,
): AcpSessionView {
  const failed = Boolean(event.error) || event.stopReason === "refusal";
  return {
    ...view,
    streaming: false,
    failed,
    // 回合边界之后的第一段输出必须是新的一条，哪怕上一条也是助手说的。
    turn: view.turn + 1,
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

/* --------------------------------- store --------------------------------- */

interface AcpStoreState {
  readonly sessions: Readonly<Record<string, AcpSessionView>>;
  readonly permissions: Readonly<Record<string, readonly AcpPermissionView[]>>;
  hydrate: (sessionId: string, nodeId: string, log: AcpLogResponse) => void;
  update: (sessionId: string, update: AcpSessionUpdate) => void;
  begin: (sessionId: string, text: string) => void;
  end: (
    sessionId: string,
    nodeId: string,
    event: Pick<AcpTurnEvent, "stopReason" | "error">,
  ) => void;
  setMode: (sessionId: string, modeId: string) => void;
  addPermission: (nodeId: string, permission: AcpPermissionView) => void;
  resolvePermission: (pendingId: string) => void;
  reset: () => void;
}

function patchSession(
  state: AcpStoreState,
  sessionId: string,
  next: (view: AcpSessionView) => AcpSessionView,
): Pick<AcpStoreState, "sessions"> {
  const view = state.sessions[sessionId] ?? EMPTY_SESSION;
  return { sessions: { ...state.sessions, [sessionId]: next(view) } };
}

export const useAcpStore = create<AcpStoreState>((set) => ({
  sessions: {},
  permissions: {},
  hydrate: (sessionId, nodeId, log) =>
    set((state) => {
      const previous = state.sessions[sessionId] ?? EMPTY_SESSION;
      const modes = acpModeStateSchema.safeParse(log.modes);
      const view: AcpSessionView = {
        ...fromLog(log.entries, previous),
        modes: modes.success ? modes.data : previous.modes,
        endOffset: log.endOffset,
      };
      const pending = (log.pending ?? []).map((item: AcpPendingPermission) => ({
        pendingId: item.pendingId,
        toolCall: item.toolCall,
        options: item.options,
      }));
      return {
        sessions: { ...state.sessions, [sessionId]: view },
        permissions:
          log.pending === undefined
            ? state.permissions
            : { ...state.permissions, [nodeId]: pending },
      };
    }),
  update: (sessionId, update) =>
    set((state) =>
      patchSession(state, sessionId, (view) => applyUpdate(view, update)),
    ),
  begin: (sessionId, text) =>
    set((state) =>
      patchSession(state, sessionId, (view) => beginTurn(view, text)),
    ),
  end: (sessionId, nodeId, event) =>
    set((state) => {
      // 回合结束时挂起的审批都已由 core 回了 `cancelled`（ACP 设计 §5.5）。
      const permissions = { ...state.permissions };
      delete permissions[nodeId];
      return {
        ...patchSession(state, sessionId, (view) => endTurn(view, event)),
        permissions,
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
  addPermission: (nodeId, permission) =>
    set((state) => {
      const list = (state.permissions[nodeId] ?? []).filter(
        (item) => item.pendingId !== permission.pendingId,
      );
      return {
        permissions: { ...state.permissions, [nodeId]: [...list, permission] },
      };
    }),
  resolvePermission: (pendingId) =>
    set((state) => {
      const permissions: Record<string, readonly AcpPermissionView[]> = {};
      for (const [nodeId, list] of Object.entries(state.permissions)) {
        const kept = list.filter((item) => item.pendingId !== pendingId);
        if (kept.length > 0) permissions[nodeId] = kept;
      }
      return { permissions };
    }),
  reset: () => set({ sessions: {}, permissions: {} }),
}));
