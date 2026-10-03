/**
 * 投递方，对着
 * 合并前的实现。
 *
 * 这个文件守的第一条是那句硬规矩：**`blocked` / `waiting` 的节点不投递**。停在
 * 一个问题上的 pane 收到一次写入，等于让这次投递碰巧带的字符去回答那个问题。
 *
 * 第二条是「送到不是做完」：写进去只报 `DELIVERED`，`SUCCEEDED` 要等别的证据。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  AutomationColdStartPolicy,
  AutomationOutcome,
  AutomationRunSchema,
  AutomationRunState,
  AutomationTargetSchema,
  type AutomationPlanConfig,
  AutomationTargetKind,
  CommandLaunchSpecSchema,
  type AutomationRun,
  type AutomationTarget,
  create,
} from "./types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NO_CUSTOM_AGENTS } from "../agent/registry";
import type { TerminalBridge } from "../collab/service";
import { type AgentLaunchRequest, COLD_START_COOLDOWN_MS } from "./cold-start";
import { TerminalDispatcher } from "./dispatch";
import { ScheduleEngine } from "./engine";
import { AUTH, HOST_ID, config, openStore } from "./fixture";
import { configHash, num } from "./plan";
import { ScheduleStore } from "./store";
import { workflowRunId } from "./workflow-target";
import {
  type WorkflowDomain,
  setWorkflowDomain,
  workflowDomain,
} from "../workflow/registry";
import {
  insertRun,
  insertTemplate,
  runById,
  setRunStatus,
} from "../workflow/store";
import type { WorkflowDraft } from "../workflow/types";
import { DomainError } from "../workspaces/support";

/** `loadNode` / `loadSession` / `getAgentStatus` 真正读的那几列。 */
function canvasTables(database: DatabaseSync): void {
  database.exec(`CREATE TABLE boards (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
CREATE TABLE nodes (
 id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL,
 type TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE terminal_sessions (
 id TEXT PRIMARY KEY, owner_node_id TEXT, generation INTEGER NOT NULL,
 status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE agent_status (
 node_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
 state TEXT, state_source TEXT, unread INTEGER NOT NULL DEFAULT 0,
 session_id TEXT, pending_id TEXT, verified INTEGER NOT NULL DEFAULT 0,
 restored INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
 transcript_path TEXT, last_event_at TEXT, session_phase TEXT,
 errored INTEGER, interrupted INTEGER
)`);
  database
    .prepare("INSERT INTO boards (id, workspace_id) VALUES ('b', 'ws')")
    .run();
  database
    .prepare(
      "INSERT INTO nodes (id, board_id, title, type, data_json) VALUES ('node-1', 'b', '节点', 'terminal', ?)",
    )
    .run(JSON.stringify({ agent: { id: "claude" } }));
  database
    .prepare(
      "INSERT INTO terminal_sessions (id, owner_node_id, generation, status, created_at) " +
        "VALUES ('session-1', 'node-1', 7, 'running', '2026-09-20T00:00:00Z')",
    )
    .run();
}

function state(database: DatabaseSync, value: string | null): void {
  database.prepare("DELETE FROM agent_status").run();
  if (value === null) return;
  database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("node-1", "ws", "claude", value, "2026-09-20T00:00:00Z");
}

/**
 * 目标终端此刻的画面（画面门经 `capture` 取）。缺省是 Claude 的输入框：首投
 * 要求看得见提示符，而这里的大多数用例说的是状态，不是画面。
 */
const CLAUDE_PROMPT = "────────\n❯ \n────────\n  ? for shortcuts";
const AUTO_MODE_DIALOG = [
  " Make auto mode your default permission mode?",
  " ❯ 1. Yes, set auto mode as my default permission mode",
  "   2. No, keep the current mode",
  " Enter to confirm · Esc to cancel",
].join("\n");
const screen = { current: CLAUDE_PROMPT };

beforeEach(() => {
  screen.current = CLAUDE_PROMPT;
});

interface Written {
  sessionId: string;
  generation: number;
  data: string;
}

function bridge(written: Written[], live = 7): TerminalBridge {
  return {
    async write(sessionId, generation, data) {
      written.push({ sessionId, generation, data });
    },
    async capture() {
      return { lines: 4, data: screen.current };
    },
    async foreground() {
      return undefined;
    },
    generation: (sessionId) => (sessionId === "session-1" ? live : undefined),
    async terminate() {},
    async isCurrentNodeSession() {
      return true;
    },
  };
}

function setUp(options: { live?: number; bridged?: boolean } = {}) {
  const { database, store } = openStore();
  canvasTables(database);
  const written: Written[] = [];
  const terminals =
    options.bridged === false ? undefined : bridge(written, options.live ?? 7);
  const dispatcher = new TerminalDispatcher({
    database,
    store,
    hostId: HOST_ID,
    terminals: () => terminals,
    clock: () => 1_700_000_000_000,
  });
  return { database, store, dispatcher, written };
}

const PROMPT = Buffer.from("跑一次检查");

function agentTargetOf(): AutomationTarget {
  return config().target as AutomationTarget;
}

function runFor(store: ScheduleStore, target: AutomationTarget): AutomationRun {
  const digest = createHash("sha256").update(PROMPT).digest();
  const frozen = config();
  frozen.target = target;
  frozen.payloadRef = digest.toString("hex");
  frozen.payloadSha256 = digest;
  store.putPayload("ws", frozen.payloadRef, PROMPT, digest, 1);
  return create(AutomationRunSchema, {
    id: "run-1",
    planId: "p1",
    workspaceId: "ws",
    operationId: "automation/p/host-x/ws/dispatch/run-1",
    requestSha256: new Uint8Array(32).fill(1),
    frozenConfig: frozen,
    dispatchAttempts: 1,
  });
}

describe("Agent 目标的探测", () => {
  it("节点在跑而且没在等人就是就绪", async () => {
    const { database, dispatcher } = setUp();
    state(database, "idle");
    expect(await dispatcher.supports(agentTargetOf())).toEqual({
      state: "ready",
      generation: 7,
    });
  });

  it("停在一个问题上的 pane 算忙，不投递", async () => {
    const { database, dispatcher } = setUp();
    for (const value of ["blocked", "waiting"]) {
      state(database, value);
      expect((await dispatcher.supports(agentTargetOf())).state).toBe("busy");
    }
  });

  it("正在干活也算忙", async () => {
    const { database, dispatcher } = setUp();
    state(database, "working");
    expect((await dispatcher.supports(agentTargetOf())).state).toBe("busy");
  });

  it("没人报过状态的节点不算在等人", async () => {
    const { database, dispatcher } = setUp();
    state(database, null);
    expect((await dispatcher.supports(agentTargetOf())).state).toBe("ready");
  });

  it("节点上没有会话是离线，不是不支持", async () => {
    const { database, dispatcher } = setUp({ live: 0 });
    state(database, "idle");
    database.prepare("DELETE FROM terminal_sessions").run();
    expect((await dispatcher.supports(agentTargetOf())).state).toBe("offline");
  });

  it("节点现在跑的是另一个 Agent 就是不支持", async () => {
    const { database, dispatcher } = setUp();
    state(database, "idle");
    database
      .prepare("UPDATE nodes SET data_json = ? WHERE id = 'node-1'")
      .run(JSON.stringify({ agent: { id: "codex" } }));
    expect((await dispatcher.supports(agentTargetOf())).state).toBe(
      "unsupported",
    );
  });

  it("别的执行主机的目标一概不支持", async () => {
    const { dispatcher } = setUp();
    const target = agentTargetOf();
    target.executionHostId = "0".repeat(32);
    expect((await dispatcher.supports(target)).state).toBe("unsupported");
  });

  it("终端域还没装好时是「不知道」，不是「坏了」", async () => {
    const { database, dispatcher } = setUp({ bridged: false });
    state(database, "idle");
    expect((await dispatcher.supports(agentTargetOf())).state).toBe("unknown");
  });
});

describe("画面门", () => {
  /** Hook 报过一轮结束的空闲：不是首投。 */
  function reportedIdle(database: DatabaseSync): void {
    database.prepare("DELETE FROM agent_status").run();
    database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, state_source, updated_at, last_event_at) " +
          "VALUES ('node-1', 'ws', 'claude', 'idle', 'hook', ?, ?)",
      )
      .run("2026-09-20T00:00:00Z", "2026-09-20T00:00:00Z");
  }

  it("停在对话框上不投：报过空闲也算忙，理由是 TARGET_NOT_AT_PROMPT", async () => {
    const { database, store, dispatcher, written } = setUp();
    reportedIdle(database);
    screen.current = `${CLAUDE_PROMPT}\n${AUTO_MODE_DIALOG}`;
    expect(await dispatcher.supports(agentTargetOf())).toEqual({
      state: "busy",
      generation: 7,
      reason: "TARGET_NOT_AT_PROMPT",
    });
    const receipt = await dispatcher.dispatch(runFor(store, agentTargetOf()));
    expect(receipt?.outcome).toBe(AutomationOutcome.NOT_DISPATCHED);
    expect(receipt?.reasonCode).toBe("TARGET_NOT_AT_PROMPT");
    expect(written).toHaveLength(0);

    // 人在终端里答掉之后，下一拍看到的是输入框，投出去。
    screen.current = `${AUTO_MODE_DIALOG}\n${CLAUDE_PROMPT}`;
    const again = runFor(store, agentTargetOf());
    again.operationId = `${again.operationId}-2`;
    expect((await dispatcher.dispatch(again))?.outcome).toBe(
      AutomationOutcome.DELIVERED,
    );
    expect(written).toHaveLength(1);
  });

  it("首投（没有一条回合结束的真上报）看不见提示符：算忙", async () => {
    const { database, dispatcher } = setUp();
    state(database, null);
    screen.current = " Claude Code vX.Y.Z\n loading…";
    expect(await dispatcher.supports(agentTargetOf())).toEqual({
      state: "busy",
      generation: 7,
      reason: "TARGET_NOT_AT_PROMPT",
    });
  });

  it("平常的投递不要求提示符，只拦对话框与选择菜单", async () => {
    const { database, dispatcher } = setUp();
    reportedIdle(database);
    screen.current = "some output\nthat is not a known dialog";
    expect((await dispatcher.supports(agentTargetOf())).state).toBe("ready");
    screen.current = `${CLAUDE_PROMPT}\n Something new?\n ❯ 1. Yes\n   2. No`;
    expect((await dispatcher.supports(agentTargetOf())).state).toBe("busy");
  });

  it("没有画面特征的 Agent 不取画面", async () => {
    const { database, dispatcher } = setUp();
    database
      .prepare("UPDATE nodes SET data_json = ? WHERE id = 'node-1'")
      .run(JSON.stringify({ agent: { id: "opencode" } }));
    screen.current = AUTO_MODE_DIALOG;
    const target = agentTargetOf();
    target.agentLaunch = { ...target.agentLaunch!, agentId: "opencode" };
    expect((await dispatcher.supports(target)).state).toBe("ready");
  });
});

describe("命令目标", () => {
  it("没冻结过的会话不支持", async () => {
    const { dispatcher } = setUp();
    const target = create((await import("./types")).AutomationTargetSchema, {
      executionHostId: HOST_ID,
      kind: AutomationTargetKind.NON_INTERACTIVE_COMMAND,
      sessionId: "session-1",
      generation: 7n,
    });
    expect((await dispatcher.supports(target)).state).toBe("unsupported");
  });

  it("代数变了就是不支持——那是另一个进程", async () => {
    const { store, dispatcher } = setUp({ live: 9 });
    store.putCommandRoot("root", "ws", "/tmp/ws", 1);
    store.putCommandSession({
      sessionId: "session-1",
      rootId: "root",
      workspaceId: "ws",
      executionHostId: HOST_ID,
      launch: create(CommandLaunchSpecSchema, { executable: "/bin/true" }),
      launchSha256: new Uint8Array(32),
      generation: 7,
      state: 1,
      reasonCode: "",
      revision: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const target = create((await import("./types")).AutomationTargetSchema, {
      executionHostId: HOST_ID,
      kind: AutomationTargetKind.NON_INTERACTIVE_COMMAND,
      sessionId: "session-1",
      generation: 7n,
    });
    expect((await dispatcher.supports(target)).state).toBe("unsupported");
  });
});

describe("投递", () => {
  it("包裹与回车是同一次写", async () => {
    const { database, store, dispatcher, written } = setUp();
    state(database, "idle");
    const receipt = await dispatcher.dispatch(runFor(store, agentTargetOf()));
    expect(receipt?.outcome).toBe(AutomationOutcome.DELIVERED);
    expect(receipt?.reasonCode).toBe("WRITTEN");
    expect(written).toHaveLength(1);
    expect(written[0]?.sessionId).toBe("session-1");
    expect(written[0]?.generation).toBe(7);
    expect(written[0]?.data).toBe(`[200~跑一次检查[201~\r`);
  });

  it("探测和写入之间目标变了是「肯定没投递」", async () => {
    const { database, store, dispatcher, written } = setUp();
    state(database, "blocked");
    const receipt = await dispatcher.dispatch(runFor(store, agentTargetOf()));
    expect(receipt?.outcome).toBe(AutomationOutcome.NOT_DISPATCHED);
    expect(receipt?.reasonCode).toBe("TARGET_NOT_READY");
    expect(written).toHaveLength(0);
  });

  it("载荷与冻结的摘要对不上就不写", async () => {
    const { database, store, dispatcher, written } = setUp();
    state(database, "idle");
    const run = runFor(store, agentTargetOf());
    run.frozenConfig!.payloadSha256 = new Uint8Array(32).fill(9);
    await expect(dispatcher.dispatch(run)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(written).toHaveLength(0);
  });

  it("第二次尝试先问上一次做了什么", async () => {
    const { database, store, dispatcher, written } = setUp();
    state(database, "idle");
    const run = runFor(store, agentTargetOf());
    await dispatcher.dispatch(run);
    run.dispatchAttempts = 2;
    const again = await dispatcher.dispatch(run);
    // 同一张收据回来，没有第二次写入。
    expect(num(again?.sequence)).toBe(1);
    expect(written).toHaveLength(1);
  });

  it("查不到收据时答「不知道」，不答「没投递」", async () => {
    const { store, dispatcher } = setUp();
    const run = runFor(store, agentTargetOf());
    const receipt = await dispatcher.lookup(run);
    expect(receipt?.outcome).toBe(AutomationOutcome.UNKNOWN);
    expect(receipt?.reasonCode).toBe("NO_RECEIPT");
  });
});

describe("冷启动", () => {
  const NOW = 1_700_000_000_000;

  function coldSetUp(options: { policy?: string } = {}) {
    const { database, store } = openStore();
    canvasTables(database);
    database.prepare("DELETE FROM terminal_sessions").run();
    const written: Written[] = [];
    const launches: AgentLaunchRequest[] = [];
    const sessions = new Map<string, number>();
    const pending = new Set<string>();
    let clock = NOW;
    const terminals: TerminalBridge = {
      ...bridge(written),
      generation: (sessionId) => sessions.get(sessionId),
      observed: (sessionId) =>
        sessions.has(sessionId)
          ? {
              pending: pending.has(sessionId),
              lastInputAt: undefined,
              lastOutputAt: undefined,
            }
          : undefined,
    };
    const dispatcher = new TerminalDispatcher({
      database,
      store,
      hostId: HOST_ID,
      terminals: () => terminals,
      clock: () => clock,
      settings: () => NO_CUSTOM_AGENTS,
      launcher: () => async (request) => {
        launches.push(request);
        const sessionId = `cold-${launches.length}`;
        database
          .prepare(
            "INSERT INTO terminal_sessions (id, owner_node_id, generation, status, created_at) " +
              "VALUES (?, 'node-1', 1, 'running', '2026-09-20T00:00:00Z')",
          )
          .run(sessionId);
        sessions.set(sessionId, 1);
        return { sessionId, generation: 1 };
      },
    });
    const target = agentTargetOf();
    target.coldStartPolicy = (options.policy ??
      AutomationColdStartPolicy.LAUNCH_FROZEN) as AutomationColdStartPolicy;
    target.agentLaunch = {
      agentId: "claude",
      workingDirectory: "/tmp/ws",
      args: ["--model", "it's"],
      permissionMode: "default",
      modelId: "",
      accountId: "default",
    };
    return {
      database,
      dispatcher,
      target,
      launches,
      sessions,
      pending,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  function report(
    database: DatabaseSync,
    value: string,
    lastEventAt: string,
  ): void {
    database.prepare("DELETE FROM agent_status").run();
    database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, state_source, updated_at, last_event_at) " +
          "VALUES ('node-1', 'ws', 'claude', ?, 'hook', ?, ?)",
      )
      .run(value, lastEventAt, lastEventAt);
  }

  it("只在运行的目标探测里起进程，激活与写入前的复核不起", async () => {
    const { dispatcher, target, launches } = coldSetUp();
    expect((await dispatcher.supports(target)).state).toBe("offline");
    expect(launches).toHaveLength(0);
  });

  it("没授权冷启动的计划遇到空节点照样跳过", async () => {
    const { dispatcher, target, launches } = coldSetUp({
      policy: AutomationColdStartPolicy.SKIP,
    });
    expect((await dispatcher.supports(target, { coldStart: true })).state).toBe(
      "offline",
    );
    expect(launches).toHaveLength(0);
  });

  it("按冻结的定义起一个，程序由注册表解析、参数按需引用，然后报忙", async () => {
    const { dispatcher, target, launches } = coldSetUp();
    expect(await dispatcher.supports(target, { coldStart: true })).toEqual({
      state: "busy",
      generation: 1,
    });
    expect(launches).toEqual([
      {
        workspaceId: "ws",
        nodeId: "node-1",
        agentId: "claude",
        cwd: "/tmp/ws",
        // 冷启动按平台缺省 shell 的方言引用：Windows 上是 cmd.exe。
        line:
          process.platform === "win32"
            ? `claude --model "it's"`
            : `claude --model 'it'\\''s'`,
      },
    ]);
  });

  it("旧会话留下的那行空闲不算，要等冷启动之后的一条真上报", async () => {
    const { database, dispatcher, target, advance } = coldSetUp();
    report(database, "idle", new Date(NOW - 60_000).toISOString());
    await dispatcher.supports(target, { coldStart: true });
    advance(5_000);
    expect((await dispatcher.supports(target, { coldStart: true })).state).toBe(
      "busy",
    );
    report(database, "idle", new Date(NOW + 4_000).toISOString());
    expect((await dispatcher.supports(target, { coldStart: true })).state).toBe(
      "ready",
    );
  });

  it("有人留了半行没提交也算忙", async () => {
    const { database, dispatcher, target, pending, advance } = coldSetUp();
    await dispatcher.supports(target, { coldStart: true });
    advance(5_000);
    report(database, "idle", new Date(NOW + 4_000).toISOString());
    pending.add("cold-1");
    expect((await dispatcher.supports(target, { coldStart: true })).state).toBe(
      "busy",
    );
  });

  it("起来就退出的 CLI 在冷却窗口里不会被再起一次", async () => {
    const { dispatcher, target, launches, sessions, advance } = coldSetUp();
    await dispatcher.supports(target, { coldStart: true });
    sessions.clear();
    advance(10_000);
    expect((await dispatcher.supports(target, { coldStart: true })).state).toBe(
      "offline",
    );
    expect(launches).toHaveLength(1);
    advance(COLD_START_COOLDOWN_MS);
    expect((await dispatcher.supports(target, { coldStart: true })).state).toBe(
      "busy",
    );
    expect(launches).toHaveLength(2);
  });
});

/* ------------------------- 工作流目标（契约 §15.6） ------------------------- */

const WORKFLOW_MIGRATION = new URL(
  "../db/migrations/0034_workflow.sql",
  import.meta.url,
);

const TEMPLATE_BODY: WorkflowDraft = {
  version: 1,
  title: "定时审查",
  params: [{ name: "scope", type: "string" }],
  roles: [{ id: "worker", agentId: "claude" }],
  links: [],
  steps: [
    {
      id: "s1",
      kind: "prompt",
      role: "worker",
      prompt: "审查 {{scope}}",
      after: [],
    },
  ],
};

/**
 * 一个只有表与假引擎的工作流域：起跑就是插一行运行，状态由用例摆布。真引擎
 * 的起跑（建 Frame、起节点、投递）由 `workflow/engine.test.ts` 守。
 */
function workflowSetUp() {
  const setup = setUp();
  setup.database.exec(readFileSync(WORKFLOW_MIGRATION, "utf8"));
  const template = insertTemplate(setup.database, {
    id: "tpl-1",
    name: "定时审查",
    template: TEMPLATE_BODY,
    createdFromDraft: null,
    createdAt: 1,
  });
  const started: { runId: string | undefined; params: unknown }[] = [];
  const domain = {
    service: { database: setup.database },
    engine: {
      async startRun(request: {
        template: { id: string; version: number; template: WorkflowDraft };
        params?: unknown;
        boardId?: string;
        runId?: string;
      }) {
        started.push({ runId: request.runId, params: request.params });
        return insertRun(setup.database, {
          id: request.runId ?? "run-x",
          templateId: request.template.id,
          templateVersion: request.template.version,
          template: request.template.template,
          workspaceId: "ws",
          boardId: request.boardId ?? "b",
          frameId: null,
          anchorNodeId: null,
          params: request.params as Record<string, string>,
          roles: {},
          startedAt: 1,
        });
      },
    },
    stop: async () => {},
  };
  setWorkflowDomain(domain as unknown as WorkflowDomain);
  const payload = Buffer.from(JSON.stringify({ params: { scope: "src" } }));
  const digest = createHash("sha256").update(payload).digest();
  setup.store.putPayload("ws", digest.toString("hex"), payload, digest, 1);
  const target = create(AutomationTargetSchema, {
    executionHostId: HOST_ID,
    kind: AutomationTargetKind.WORKFLOW_RUN,
    workflowRun: { templateId: "tpl-1", templateVersion: 1, boardId: "b" },
  });
  const frozen = config({ target: {} });
  frozen.target = target;
  frozen.payloadRef = digest.toString("hex");
  frozen.payloadSha256 = digest;
  const run = create(AutomationRunSchema, {
    id: "run-1",
    planId: "plan-1",
    workspaceId: "ws",
    operationId: "op-1",
    requestSha256: new Uint8Array(32).fill(1),
    dispatchAttempts: 1,
    frozenConfig: frozen,
  });
  return { ...setup, template, started, target, run, frozen, payload };
}

describe("工作流目标", () => {
  afterEach(() => setWorkflowDomain(undefined));

  it("探测只看模板、版本与画布，不碰终端", async () => {
    const { dispatcher, target, database, written } = workflowSetUp();
    expect(await dispatcher.supports(target)).toEqual({
      state: "ready",
      generation: 0,
    });
    // 模板改过一版：计划冻结的那一版不在了。
    database
      .prepare("UPDATE workflow_templates SET version = 2 WHERE id = 'tpl-1'")
      .run();
    expect((await dispatcher.supports(target)).state).toBe("unsupported");
    expect(written).toEqual([]);
  });

  it("没有工作流域时答 unknown，等下一拍", async () => {
    const { dispatcher, target } = workflowSetUp();
    setWorkflowDomain(undefined);
    expect((await dispatcher.supports(target)).state).toBe("unknown");
  });

  it("投递就是起跑：参数取自载荷，运行 id 由操作标识推出，重试不起第二次", async () => {
    const { dispatcher, run, started, written } = workflowSetUp();
    const first = await dispatcher.dispatch(run);
    expect(first?.outcome).toBe(AutomationOutcome.RUNNING);
    expect(first?.reasonCode).toBe("WORKFLOW_RUNNING");
    expect(started).toEqual([
      { runId: workflowRunId("op-1"), params: { scope: "src" } },
    ]);
    // 第二次尝试（例如超时之后）认出这次已经起过了。
    run.dispatchAttempts = 2;
    const again = await dispatcher.dispatch(run);
    expect(again?.outcome).toBe(AutomationOutcome.RUNNING);
    expect(started).toHaveLength(1);
    expect(written).toEqual([]);
  });

  it("复核按运行的状态出收据：变了序号加一，没变交回原来那张", async () => {
    const { dispatcher, run, database } = workflowSetUp();
    const first = await dispatcher.dispatch(run);
    expect(await dispatcher.lookup(run)).toEqual(first);
    setRunStatus(database, workflowRunId("op-1"), "succeeded", null, 2);
    const done = await dispatcher.lookup(run);
    expect(done?.outcome).toBe(AutomationOutcome.SUCCEEDED);
    expect(num(done?.sequence)).toBe(num(first?.sequence) + 1);
    // 同一个结局再问一次：同一张收据，内核据此认作重复而不是冲突。
    expect(await dispatcher.lookup(run)).toEqual(done);
  });

  it("起跑当场被拒记 FAILED 加拒绝码，不算结果不明", async () => {
    const { dispatcher, run } = workflowSetUp();
    const domain = workflowDomain() as unknown as {
      engine: { startRun: () => Promise<never> };
    };
    domain.engine.startRun = async () => {
      throw new DomainError(400, "permission_mode_unsupported", "不支持");
    };
    const receipt = await dispatcher.dispatch(run);
    expect(receipt?.outcome).toBe(AutomationOutcome.FAILED);
    expect(receipt?.reasonCode).toBe("WORKFLOW_PERMISSION_MODE_UNSUPPORTED");
  });

  it("调度内核：到点起跑，占着闸门直到运行结束", async () => {
    const { database, store, dispatcher, frozen } = workflowSetUp();
    const now = { value: 1_700_000_000_000 };
    const engine = new ScheduleEngine({
      store,
      dispatcher,
      authorizer: { verify: async () => {} },
      hostId: HOST_ID,
      instanceId: "instance-1",
      clock: () => now.value,
      monotonic: () => now.value,
      claimLeaseMs: 30_000,
      dispatchTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    const defined = await engine.define(AUTH, "p1", frozen, 0);
    const stored = engine.getPlan("ws", "p1");
    await engine.activate(
      AUTH,
      "ws",
      "p1",
      defined.revision,
      Number(defined.plan.configVersion),
      configHash(stored.plan.config as AutomationPlanConfig),
    );
    await engine.tick();
    const plan = engine.getPlan("ws", "p1").plan;
    const active = engine.getRun("ws", plan.activeRunId).run;
    expect(active.state).toBe(AutomationRunState.RUNNING);
    const runId = workflowRunId(active.operationId);
    expect(runById(database, runId)?.params).toEqual({ scope: "src" });
    // 运行结束：下一拍复核收下 SUCCEEDED，闸门放开。
    setRunStatus(database, runId, "succeeded", null, 2);
    now.value += 2_000;
    await engine.tick();
    const finished = engine.getRun("ws", active.id).run;
    expect(finished.state).toBe(AutomationRunState.SUCCEEDED);
    expect(finished.reasonCode).toBe("WORKFLOW_SUCCEEDED");
    expect(engine.getPlan("ws", "p1").plan.activeRunId).toBe("");
  });
});
