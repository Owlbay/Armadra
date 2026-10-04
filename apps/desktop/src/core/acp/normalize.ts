/**
 * ACP → 现有 `AgentEvent`（ACP 会话视图设计 §5.4；补全架构 §5.1）。
 *
 * ACP 只是同一个节点的另一种驱动方式，所以它的状态也只是第四种**来源**
 * （`stateSource = "acp"`），不是第二套状态：这里产出的事件经
 * `hook/ingest.ts::apply` 走同一个 reducer、同一张 `agent_status`、同一条
 * `agent.status` 事件。`hook/normalize/index.ts` 的 `case "acp"` 转到这里。
 *
 * 输入是会话层（`session.ts`）说出的一个**信号**，不是 ACP 的原始帧：回合边界
 * （我方发出 `session/prompt`、它的答复）只有客户端知道，帧里没有。分块
 * （`agent_message_chunk` 等）不进 reducer，只进镜像与页面——reducer 看回合
 * 边界，与 Hook 模式对齐。
 *
 * | 信号                 | AgentEvent                                                 |
 * | -------------------- | ---------------------------------------------------------- |
 * | `opened`             | `session` / `start`，`sessionId`、`transcriptPath`         |
 * | `prompt`             | `working`，`newTurn`，摘要进 `lastMessage`                 |
 * | `tool`               | `working`；`execute` 的标题进 `lastMessage`                |
 * | `permission`         | `blocked`，`pendingId`                                     |
 * | `permissionSettled`  | `working`                                                  |
 * | `turn` 正常结束      | `done`（`errored: false`）                                 |
 * | `turn` `cancelled`   | `done`，`interrupted`                                      |
 * | `turn` 拒答或出错    | `done`，`errored`，`lastMessage` 记错误                    |
 * | `elicitation`        | `waiting`，`pendingId`（core 从不自动答，契约 §26.1）      |
 * | `closed`             | `session` / `end`                                          |
 *
 * elicitation 不置 `awaitingInput`：那条「问题未答时回合结束改写成 waiting」的
 * 规则是给 Hook 模式里看不见答复的提问用的；ACP 的答复（或取消）一定经
 * `permissionSettled` 回来，挂着它只会让答完之后的 `done` 被改写成 `waiting`。
 *
 * 适配器退出不在这里：那是终端域的退出通知（`terminalGoneEvent`），与 PTY
 * 死亡同一条路。
 */

import { STATE_SOURCE_ACP } from "../agent/registry";
import {
  type AgentEvent,
  BLOCKED,
  DONE,
  WAITING,
  WORKING,
  sessionEvent,
  stateEvent,
  truncate,
} from "../hook/normalize/event";

/** 会话层说出的一件事。 */
export type AcpSignal =
  | {
      readonly signal: "opened";
      readonly sessionId: string;
      readonly transcriptPath?: string | undefined;
    }
  | { readonly signal: "prompt"; readonly text: string }
  | {
      readonly signal: "tool";
      readonly title?: string | undefined;
      readonly toolKind?: string | undefined;
    }
  | { readonly signal: "permission"; readonly pendingId: string }
  | { readonly signal: "permissionSettled" }
  | {
      readonly signal: "turn";
      readonly stopReason?: string | undefined;
      readonly error?: string | undefined;
    }
  | { readonly signal: "elicitation"; readonly pendingId: string }
  | { readonly signal: "closed" };

/** `lastMessage` 的上限与共享 schema 一致；提示只留开头，够认出是哪一轮。 */
const MESSAGE_LIMIT = 20_000;
const PROMPT_SUMMARY = 200;

/** 正常结束的三种 `stopReason`（规范 v1）。 */
const CLEAN_STOPS = new Set(["end_turn", "max_tokens", "max_turn_requests"]);

function isSignal(value: unknown): value is AcpSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { signal?: unknown }).signal === "string"
  );
}

function summary(text: string, limit: number): string | undefined {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed === "" ? undefined : truncate(trimmed, limit);
}

/**
 * 一个信号 → 一个事件；认不出的信号答 `undefined`（与各家 Hook 的「没话
 * 说」同一个约定）。来源恒为 `acp`：由 core 自己写死，客户端无法自称。
 */
export function normalize(
  nodeId: string,
  agentId: string,
  payload: unknown,
): AgentEvent | undefined {
  if (!isSignal(payload)) return undefined;
  const event = eventOf(nodeId, agentId, payload);
  if (event === undefined) return undefined;
  event.stateSource = STATE_SOURCE_ACP;
  // core 自己产出的上报：与验过节点令牌的 Hook 同一档可信。
  event.verified = true;
  return event;
}

function eventOf(
  nodeId: string,
  agentId: string,
  signal: AcpSignal,
): AgentEvent | undefined {
  switch (signal.signal) {
    case "opened": {
      if (typeof signal.sessionId !== "string" || signal.sessionId === "") {
        return undefined;
      }
      const event = sessionEvent(nodeId, agentId, "start");
      event.sessionId = truncate(signal.sessionId, 200);
      if (signal.transcriptPath !== undefined) {
        event.transcriptPath = signal.transcriptPath;
      }
      return event;
    }
    case "closed":
      return sessionEvent(nodeId, agentId, "end");
    case "prompt": {
      const event = stateEvent(nodeId, agentId, WORKING);
      event.newTurn = true;
      const message = summary(String(signal.text ?? ""), PROMPT_SUMMARY);
      if (message !== undefined) event.lastMessage = message;
      return event;
    }
    case "tool": {
      const event = stateEvent(nodeId, agentId, WORKING);
      if (signal.toolKind === "execute" && typeof signal.title === "string") {
        const message = summary(signal.title, MESSAGE_LIMIT);
        if (message !== undefined) event.lastMessage = message;
      }
      return event;
    }
    case "permission": {
      if (typeof signal.pendingId !== "string" || signal.pendingId === "") {
        return undefined;
      }
      const event = stateEvent(nodeId, agentId, BLOCKED);
      event.pendingId = signal.pendingId;
      return event;
    }
    case "permissionSettled":
      return stateEvent(nodeId, agentId, WORKING);
    case "turn": {
      const event = stateEvent(nodeId, agentId, DONE);
      if (signal.error !== undefined) {
        event.errored = true;
        event.interrupted = false;
        const message = summary(signal.error, MESSAGE_LIMIT);
        if (message !== undefined) event.lastMessage = message;
        return event;
      }
      const reason = signal.stopReason ?? "end_turn";
      if (reason === "cancelled") {
        event.errored = false;
        event.interrupted = true;
      } else if (CLEAN_STOPS.has(reason)) {
        event.errored = false;
        event.interrupted = false;
      } else {
        // `refusal` 与规范之外的值：没有正常结束。
        event.errored = true;
        event.interrupted = false;
        event.lastMessage = `stopReason=${truncate(reason, 100)}`;
      }
      return event;
    }
    case "elicitation": {
      if (typeof signal.pendingId !== "string" || signal.pendingId === "") {
        return undefined;
      }
      const event = stateEvent(nodeId, agentId, WAITING);
      event.pendingId = signal.pendingId;
      return event;
    }
    default:
      return undefined;
  }
}
