import { describe, expect, it } from "vitest";

import {
  EMPTY_SESSION,
  acpElicitationOf,
  acpPermissionOf,
  applyUpdate,
  beginTurn,
  endTurn,
  fromLog,
  modelStateOf,
  useAcpStore,
  type AcpItem,
  type AcpSessionView,
} from "./store";

const chunk = (sessionUpdate: string, text: string) => ({
  sessionUpdate,
  content: { type: "text", text },
});

function run(
  view: AcpSessionView,
  ...updates: Record<string, unknown>[]
): AcpSessionView {
  return updates.reduce<AcpSessionView>(
    (current, update) =>
      applyUpdate(current, update as { sessionUpdate: string }),
    view,
  );
}

const texts = (items: readonly AcpItem[]) =>
  items.map((item) =>
    item.kind === "message"
      ? `${item.role}:${item.text}`
      : `tool:${item.call.title}`,
  );

describe("applyUpdate", () => {
  it("merges chunks of one turn into one message and splits on a tool call", () => {
    const view = run(
      beginTurn(EMPTY_SESSION, "hi"),
      chunk("agent_thought_chunk", "plan"),
      chunk("agent_message_chunk", "Hel"),
      chunk("agent_message_chunk", "lo"),
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read a.ts",
        kind: "read",
        status: "pending",
      },
      chunk("agent_message_chunk", "Done"),
    );
    expect(texts(view.items)).toEqual([
      "user:hi",
      "thought:plan",
      "assistant:Hello",
      "tool:Read a.ts",
      "assistant:Done",
    ]);
  });

  it("starts a new message after a turn boundary", () => {
    let view = run(
      beginTurn(EMPTY_SESSION, "one"),
      chunk("agent_message_chunk", "A"),
    );
    view = endTurn(view, { stopReason: "end_turn" });
    view = run(view, chunk("agent_message_chunk", "B"));
    expect(texts(view.items)).toEqual([
      "user:one",
      "assistant:A",
      "assistant:B",
    ]);
    expect(view.streaming).toBe(false);
  });

  it("updates a tool call in place and keeps fields the update leaves out", () => {
    const view = run(
      EMPTY_SESSION,
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Run tests",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "pnpm test" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      },
    );
    expect(view.items).toHaveLength(1);
    const item = view.items[0] as Extract<AcpItem, { kind: "tool" }>;
    expect(item.call).toMatchObject({
      title: "Run tests",
      kind: "execute",
      status: "completed",
      rawInput: { command: "pnpm test" },
    });
    expect(item.call.content).toHaveLength(1);
  });

  it("does not draw the adapter's echo of the prompt a second time", () => {
    const view = run(
      beginTurn(EMPTY_SESSION, "hi"),
      chunk("user_message_chunk", "hi"),
    );
    expect(texts(view.items)).toEqual(["user:hi"]);
  });

  it("opens a turn for every replayed user message", () => {
    const view = run(
      EMPTY_SESSION,
      chunk("user_message_chunk", "one"),
      chunk("agent_message_chunk", "A"),
      chunk("user_message_chunk", "two"),
      chunk("agent_message_chunk", "B"),
    );
    expect(texts(view.items)).toEqual([
      "user:one",
      "assistant:A",
      "user:two",
      "assistant:B",
    ]);
  });

  it("tracks the mode, plan and usage and ignores what it does not draw", () => {
    const base = {
      ...EMPTY_SESSION,
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
    };
    const view = run(
      base,
      { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      {
        sessionUpdate: "plan",
        entries: [{ content: "x", priority: "high", status: "pending" }],
      },
      { sessionUpdate: "usage_update", used: 10, size: 100 },
      { sessionUpdate: "available_commands_update", availableCommands: [] },
      { sessionUpdate: "something_new" },
    );
    expect(view.modes?.currentModeId).toBe("plan");
    expect(view.plan).toHaveLength(1);
    expect(view.usage).toEqual({ used: 10, size: 100 });
    expect(view.items).toEqual([]);
  });
});

describe("endTurn", () => {
  it("marks refusals and errors as failed but not a cancel", () => {
    const started = beginTurn(EMPTY_SESSION, "x");
    expect(endTurn(started, { stopReason: "refusal" }).failed).toBe(true);
    expect(
      endTurn(started, { error: { code: "acp_protocol", message: "" } }).failed,
    ).toBe(true);
    expect(endTurn(started, { stopReason: "cancelled" }).failed).toBe(false);
  });
});

describe("fromLog", () => {
  it("rebuilds messages and folds tool results into their calls", () => {
    const view = fromLog([
      {
        role: "user",
        blocks: [{ type: "text", text: "fix it" }],
        endOffset: 1,
      },
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "Looking" },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "a" } },
        ],
        endOffset: 2,
      },
      {
        role: "user",
        blocks: [{ type: "tool_result", id: "t1", content: "body" }],
        endOffset: 3,
      },
      {
        role: "system",
        blocks: [{ type: "text", text: "ignored" }],
        endOffset: 4,
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Fixed" }],
        endOffset: 5,
      },
    ]);
    expect(texts(view.items)).toEqual([
      "user:fix it",
      "assistant:Looking",
      "tool:Read",
      "assistant:Fixed",
    ]);
    const tool = view.items[2] as Extract<AcpItem, { kind: "tool" }>;
    expect(tool.call.status).toBe("completed");
    expect(tool.call.rawOutput).toBe("body");
  });
});

describe("acpPermissionOf", () => {
  const payload = {
    protocol: "acp",
    toolCall: { toolCallId: "t1", title: "Run pnpm test" },
    options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
  };

  it("reads the approval record and the bare payload", () => {
    expect(
      acpPermissionOf("p1", { id: "p1", request: payload })?.options,
    ).toHaveLength(1);
    expect(acpPermissionOf("p1", payload)?.toolCall.title).toBe(
      "Run pnpm test",
    );
  });

  it("ignores hook approvals", () => {
    expect(
      acpPermissionOf("p1", { id: "p1", request: { tool_name: "Bash" } }),
    ).toBeNull();
  });
});

describe("models (contract §26.2)", () => {
  const options = [
    { id: "mode", category: "mode", currentValue: "x", options: [] },
    {
      id: "model",
      category: "model",
      currentValue: "large",
      options: [
        { value: "small", name: "Small" },
        {
          group: "big",
          name: "Big",
          options: [{ value: "large", name: "Large", description: "slow" }],
        },
      ],
    },
  ];

  it("reads the model option and flattens groups like the core", () => {
    expect(modelStateOf(options)).toEqual({
      currentModelId: "large",
      availableModels: [
        { modelId: "small", name: "Small" },
        { modelId: "large", name: "Large", description: "slow" },
      ],
    });
    expect(modelStateOf([{ id: "model", options: [{ value: "a" }] }])).toEqual({
      currentModelId: "a",
      availableModels: [{ modelId: "a", name: "a" }],
    });
    expect(modelStateOf([])).toBeNull();
    expect(modelStateOf("nope")).toBeNull();
  });

  it("follows config_option_update only once there is a catalog", () => {
    const update = {
      sessionUpdate: "config_option_update",
      configOptions: options,
    };
    expect(run(EMPTY_SESSION, update).models).toBeNull();
    const withCatalog = {
      ...EMPTY_SESSION,
      models: { currentModelId: "small", availableModels: [] },
    };
    expect(run(withCatalog, update).models?.currentModelId).toBe("large");
  });
});

describe("elicitations (contract §26.1)", () => {
  const elicitation = { message: "Name?", mode: "form" as const };

  it("reads the approval record and the bare payload, not permissions", () => {
    const payload = { protocol: "acp", elicitation };
    expect(acpElicitationOf("e1", { request: payload })).toEqual({
      pendingId: "e1",
      elicitation,
    });
    expect(acpElicitationOf("e1", payload)?.pendingId).toBe("e1");
    expect(
      acpElicitationOf("p1", { protocol: "acp", toolCall: {}, options: [] }),
    ).toBeNull();
  });

  it("hydrates, resolves by pendingId and clears at the end of a turn", () => {
    const store = useAcpStore.getState;
    store().reset();
    store().hydrate("s1", "n1", {
      entries: [],
      endOffset: 0,
      models: null,
      elicitations: [{ pendingId: "e1", protocol: "acp", elicitation }],
    });
    expect(store().elicitations.n1).toEqual([{ pendingId: "e1", elicitation }]);
    expect(store().sessions.s1?.models).toBeNull();
    store().resolvePermission("e1");
    expect(store().elicitations.n1).toBeUndefined();
    store().addElicitation("n1", { pendingId: "e2", elicitation });
    store().end("s1", "n1", { stopReason: "cancelled" });
    expect(store().elicitations.n1).toBeUndefined();
  });
});
