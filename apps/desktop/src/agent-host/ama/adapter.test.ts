import { describe, expect, it, vi } from "vitest";
import type { HostApi, ToolDefinition } from "@armadra/agent/host";
import { VERBS as CANVAS_VERBS } from "../../core/collab/control/index";
import { VERBS as CONTEXT_VERBS } from "../../core/collab/context-link";
import { VERB_NAMES as BROWSER_VERBS } from "../../core/browser/verb-spec";
import { AMA_HOOK_EVENTS } from "../../core/hook/install/events";
import { TRUST_RULE } from "../../core/collab/skill";
import { VERB_TOOLS } from "../../hook-client/verbs";
import { AMA_EVENTS, payloadOf, subscribeEvents } from "./events";
import { canvasToolNote } from "./instructions";
import { ADAPTER_ID, create, hostApi } from "./main";
import {
  AMA_SCHEMA_KEYWORDS,
  canvasTools,
  permissionOf,
  toolDefinition,
} from "./tools";

/** A HostApi that records what the adapter did with it. */
function fakeApi(env: NodeJS.ProcessEnv) {
  const tools: ToolDefinition[] = [];
  const instructions: unknown[] = [];
  const handlers = new Map<string, (event: unknown) => unknown>();
  const api = {
    version: 1,
    agent: { name: "ama", version: "0.6.2" },
    env: Object.freeze({ ...env }),
    mode: "interactive",
    session: {
      id: () => "ama-session-1",
      file: () => "/tmp/ama/session.jsonl",
      cwd: () => "/work",
      model: () => undefined,
    },
    tools: {
      register: (tool: ToolDefinition) => {
        tools.push(tool);
      },
      disable: vi.fn(),
      list: () => tools.map((tool) => tool.name),
    },
    instructions: { add: (source: unknown) => instructions.push(source) },
    events: {
      on: (name: string, handler: (event: unknown) => unknown) => {
        handlers.set(name, handler);
        return () => handlers.delete(name);
      },
    },
    approvals: { setBroker: vi.fn() },
    messages: { sendUser: vi.fn() },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    log: vi.fn(),
  } as unknown as HostApi;
  return { api, tools, instructions, handlers };
}

describe("the ama host adapter", () => {
  it("is written against host API 1", () => {
    expect(hostApi).toBe(1);
  });

  it("stays inactive outside a canvas node", () => {
    const { api, tools, handlers } = fakeApi({});
    expect(create(api)).toBeUndefined();
    expect(tools).toEqual([]);
    expect(handlers.size).toBe(0);
    expect(create(fakeApi({ ARMADRA_NODE_ID: "  " }).api)).toBeUndefined();
  });

  it("inside a node registers every verb, the note, and every event", () => {
    const { api, tools, instructions, handlers } = fakeApi({
      ARMADRA_NODE_ID: "node-1",
    });
    const adapter = create(api);
    expect(adapter?.id).toBe(ADAPTER_ID);
    expect(tools.map((tool) => tool.name)).toEqual(
      VERB_TOOLS.map((tool) => tool.name),
    );
    // ama's own `task` is left alone: the runners route it to the board.
    expect(api.tools.disable).not.toHaveBeenCalled();
    expect(instructions).toHaveLength(1);
    expect([...handlers.keys()].sort()).toEqual([...AMA_EVENTS].sort());
    adapter?.dispose?.();
    expect(handlers.size).toBe(0);
  });
});

describe("the tool table", () => {
  it("is the verb table: every runtime verb, nothing else", () => {
    const names = canvasTools().map((tool) => tool.name);
    const expected = [
      ...CANVAS_VERBS.map((verb) => `canvas_${verb.replace(/-/g, "_")}`),
      ...CONTEXT_VERBS.map((verb) => `context_${verb.replace(/-/g, "_")}`),
      ...BROWSER_VERBS.map((verb) => `browser_${verb.replace(/-/g, "_")}`),
    ];
    expect([...names].sort()).toEqual([...expected].sort());
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
  });

  it("states every parameter schema in the subset ama accepts", () => {
    const allowed = new Set<string>(AMA_SCHEMA_KEYWORDS);
    const visit = (schema: unknown, path: string): string[] => {
      const node = schema as Record<string, unknown>;
      const bad = Object.keys(node)
        .filter((key) => !allowed.has(key))
        .map((key) => `${path}.${key}`);
      for (const [key, child] of Object.entries(
        (node.properties as Record<string, unknown>) ?? {},
      ))
        bad.push(...visit(child, `${path}.${key}`));
      if (node.items !== undefined) bad.push(...visit(node.items, `${path}[]`));
      return bad;
    };
    for (const tool of canvasTools()) {
      expect(visit(tool.parameters, tool.name)).toEqual([]);
    }
    // The bound is not lost: it moved into the description.
    const inbox = canvasTools().find((tool) => tool.name === "canvas_inbox");
    const limit = (
      inbox?.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties.limit;
    expect(limit?.description).toMatch(/≥ 1/);
  });

  it("files reading as read and stopping another agent as execute", () => {
    const byName = new Map(VERB_TOOLS.map((tool) => [tool.name, tool]));
    const permission = (name: string) =>
      permissionOf(byName.get(name) as (typeof VERB_TOOLS)[number]);
    expect(permission("canvas_list")).toBe("read");
    expect(permission("canvas_inbox")).toBe("read");
    expect(permission("context_summary")).toBe("read");
    expect(permission("context_transcript")).toBe("read");
    expect(permission("canvas_open_agent")).toBe("write");
    expect(permission("canvas_team")).toBe("write");
    expect(permission("canvas_send")).toBe("write");
    expect(permission("canvas_ack")).toBe("write");
    expect(permission("canvas_sticky")).toBe("write");
    expect(permission("canvas_interrupt")).toBe("execute");
    expect(permission("canvas_close")).toBe("execute");
    expect(permission("browser_click")).toBe("write");
  });

  it("returns the runtime's prose, and its refusal as an error", async () => {
    const sticky = VERB_TOOLS.find((tool) => tool.name === "canvas_sticky");
    if (sticky === undefined) throw new Error("no canvas_sticky");
    const calls: unknown[] = [];
    const ok = toolDefinition(sticky, async (_tool, input) => {
      calls.push(input);
      return { ok: "created sticky" };
    });
    const answer = await ok.execute({ content: "summary" }, {} as never);
    expect(answer).toEqual({ content: "created sticky" });
    expect(calls).toEqual([{ content: "summary" }]);
    const refused = toolDefinition(sticky, async () => ({
      error: "not linked (403)",
    }));
    expect(await refused.execute({}, {} as never)).toEqual({
      content: "not linked (403)",
      isError: true,
    });
  });
});

describe("status reports", () => {
  it("subscribes exactly the events the core's ama adapter normalises", () => {
    expect([...AMA_EVENTS]).toEqual([...AMA_HOOK_EVENTS]);
  });

  it("speaks Pi's payload shape, attributed to ama", () => {
    const session = {
      id: () => "s-1",
      file: () => "/tmp/s.jsonl",
      cwd: () => "/work",
    };
    expect(
      payloadOf("before_agent_start", { prompt: "review" }, session),
    ).toEqual({
      hookEventName: "before_agent_start",
      provider: "ama",
      sessionId: "s-1",
      transcriptPath: "/tmp/s.jsonl",
      cwd: "/work",
      prompt: "review",
    });
    expect(
      payloadOf(
        "model_select",
        { model: { id: "gpt-x", provider: "openai" } },
        session,
      ).modelId,
    ).toBe("gpt-x");
    expect(
      payloadOf(
        "tool_approval_requested",
        { toolName: "bash", requestId: "r" },
        session,
      ).toolName,
    ).toBe("bash");
  });

  it("awaits the shutdown report and only that one", async () => {
    const { api, handlers } = fakeApi({ ARMADRA_NODE_ID: "node-1" });
    const sent: string[] = [];
    let release: () => void = () => {};
    subscribeEvents(api, (payload) => {
      sent.push(String(payload.hookEventName));
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    expect(handlers.get("agent_settled")?.({})).toBeUndefined();
    const shutdown = handlers.get("session_shutdown")?.({});
    expect(shutdown).toBeInstanceOf(Promise);
    release();
    await shutdown;
    expect(sent).toEqual(["agent_settled", "session_shutdown"]);
  });
});

describe("the instructions", () => {
  it("name the tools and carry the trust rule the core uses", () => {
    const note = canvasToolNote();
    expect(note).toContain("canvas_open_agent");
    expect(note).toContain(TRUST_RULE);
  });
});

describe("the boundary", () => {
  it("never imports the core or ama's runtime code", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const name of readdirSync(__dirname)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const source = readFileSync(join(__dirname, name), "utf8");
      expect(source, name).not.toMatch(/from "\.\.\/\.\.\/core\//);
      // ama's types only: the bundle carries none of its code.
      for (const line of source.split("\n")) {
        if (line.includes('"@armadra/agent')) {
          expect(line, name).not.toMatch(/^import \{/);
        }
      }
    }
  });
});
