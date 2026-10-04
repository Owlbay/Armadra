import { describe, expect, it } from "vitest";

import { normalizeAs } from "../hook/normalize";
import { type Current, emptyCurrent, newMemory, reduce } from "../hook/reduce";
import { type AcpSignal, normalize } from "./normalize";

/**
 * ACP 会话视图设计 §5.4 的整张表：每个信号一行，断言它落成的 `AgentEvent`，
 * 再过一遍真 reducer，确认状态与 Hook 模式同一套语义。
 */

const NODE = "11111111-2222-4333-8444-555555555555";

function event(signal: AcpSignal) {
  return normalize(NODE, "claude", signal);
}

describe("ACP → AgentEvent (§5.4)", () => {
  it.each([
    [
      "session/new or session/load succeeded",
      { signal: "opened", sessionId: "s-1", transcriptPath: "/m.acp.jsonl" },
      {
        kind: "session",
        sessionPhase: "start",
        sessionId: "s-1",
        transcriptPath: "/m.acp.jsonl",
      },
    ],
    [
      "we sent session/prompt",
      { signal: "prompt", text: "  fix   the\nbug " },
      {
        kind: "state",
        state: "working",
        newTurn: true,
        lastMessage: "fix the bug",
      },
    ],
    [
      "an execute tool call",
      { signal: "tool", title: "npm test", toolKind: "execute" },
      { kind: "state", state: "working", lastMessage: "npm test" },
    ],
    [
      "permission requested",
      { signal: "permission", pendingId: `${NODE}-1-acp-1` },
      { kind: "state", state: "blocked", pendingId: `${NODE}-1-acp-1` },
    ],
    [
      "permission settled",
      { signal: "permissionSettled" },
      { kind: "state", state: "working" },
    ],
    [
      "end_turn",
      { signal: "turn", stopReason: "end_turn" },
      { kind: "state", state: "done", errored: false, interrupted: false },
    ],
    [
      "max_tokens",
      { signal: "turn", stopReason: "max_tokens" },
      { kind: "state", state: "done", errored: false, interrupted: false },
    ],
    [
      "max_turn_requests",
      { signal: "turn", stopReason: "max_turn_requests" },
      { kind: "state", state: "done", errored: false, interrupted: false },
    ],
    [
      "cancelled",
      { signal: "turn", stopReason: "cancelled" },
      { kind: "state", state: "done", errored: false, interrupted: true },
    ],
    [
      "refusal",
      { signal: "turn", stopReason: "refusal" },
      { kind: "state", state: "done", errored: true },
    ],
    [
      "a JSON-RPC error",
      { signal: "turn", error: "internal error" },
      {
        kind: "state",
        state: "done",
        errored: true,
        lastMessage: "internal error",
      },
    ],
    [
      "elicitation/create",
      { signal: "elicitation", pendingId: "p-1" },
      { kind: "state", state: "waiting", pendingId: "p-1" },
    ],
    [
      "the session closed",
      { signal: "closed" },
      { kind: "session", sessionPhase: "end" },
    ],
  ] as const)("%s", (_label, signal, expected) => {
    const result = event(signal as AcpSignal);
    expect(result).toMatchObject({
      nodeId: NODE,
      agentId: "claude",
      stateSource: "acp",
      verified: true,
      ...expected,
    });
  });

  it("does not carry a non-execute tool's title", () => {
    expect(
      event({ signal: "tool", title: "Read a.ts", toolKind: "read" })
        ?.lastMessage,
    ).toBeUndefined();
  });

  it("ignores anything that is not a signal", () => {
    expect(normalize(NODE, "claude", null)).toBeUndefined();
    expect(normalize(NODE, "claude", { signal: "nope" })).toBeUndefined();
    expect(
      normalize(NODE, "claude", { signal: "opened", sessionId: "" }),
    ).toBeUndefined();
    expect(
      normalize(NODE, "claude", { signal: "permission", pendingId: "" }),
    ).toBeUndefined();
    expect(
      normalize(NODE, "claude", { signal: "elicitation", pendingId: "" }),
    ).toBeUndefined();
  });

  it("does not hold an elicitation as an unanswered question (§26.1)", () => {
    // 答复一定经 permissionSettled 回来；挂着 awaitingInput 会把答完之后的
    // done 改写成 waiting。
    expect(
      event({ signal: "elicitation", pendingId: "p-1" })?.awaitingInput,
    ).toBeUndefined();
  });

  it("is reached through the hook dispatcher's `acp` case", () => {
    expect(normalizeAs("acp", "codex", NODE, { signal: "turn" })).toMatchObject(
      { agentId: "codex", state: "done", stateSource: "acp" },
    );
  });

  it("drives the same reducer as a hook: a turn, an approval, its answer, the end", () => {
    const memory = newMemory();
    let current: Current = emptyCurrent();
    const step = (signal: AcpSignal, at: number) => {
      const next = reduce(at, current, memory, event(signal)!);
      if (next === undefined) return current;
      current = {
        ...current,
        state: next.state,
        stateSource: next.stateSource,
        pendingId: next.pendingId,
        sessionId: next.sessionId,
        errored: next.errored,
        interrupted: next.interrupted,
        unread: next.unread,
      };
      return current;
    };
    step({ signal: "opened", sessionId: "s-1" }, 0);
    expect(current).toMatchObject({ state: undefined, sessionId: "s-1" });
    step({ signal: "prompt", text: "go" }, 10);
    expect(current.state).toBe("working");
    step({ signal: "permission", pendingId: "p-1" }, 20);
    expect(current).toMatchObject({ state: "blocked", pendingId: "p-1" });
    step({ signal: "permissionSettled" }, 30);
    expect(current).toMatchObject({ state: "working", pendingId: undefined });
    step({ signal: "turn", stopReason: "end_turn" }, 40);
    expect(current).toMatchObject({
      state: "done",
      stateSource: "acp",
      errored: false,
      unread: true,
    });
  });
});
