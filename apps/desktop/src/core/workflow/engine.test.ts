import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { EventBus } from "../bus";
import { getContextLinks } from "../canvas/context-links";
import { loadBoard } from "../canvas/documents";
import { resetSendLimits } from "../collab/send-limits";
import { resetInboxWake } from "../collab/wake";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { parseDraft } from "./draft";
import { WorkflowEngine } from "./engine";
import {
  type TemplateRow,
  insertTemplate,
  runById,
  stepOfRun,
  stepsOf,
} from "./store";
import type { WorkflowDraft } from "./types";

/**
 * 运行引擎的验收（补全架构 §5.4）：三种步骤、关卡等人、取消、页面不在也推进、
 * 重启后续跑。
 *
 * 没有页面、没有真 CLI：终端桥是 fixture 的桩，角色节点「起来」由用例记下；
 * 投递落地就是把排队项改成 `done`（出队泵投出去之后就是这一行），节点的一轮
 * 就是往 `agent_status` 写 working / done——与 hook 上报落库之后一样。
 */

let fixture: AgentFixture;
let clock: number;
let launched: string[];
let engine: WorkflowEngine;

const DRAFT = {
  version: 1,
  title: "双人审查",
  params: [
    { name: "scopeA", type: "string" },
    { name: "scopeB", type: "string", default: "src/b" },
  ],
  roles: [
    { id: "reviewerA", agentId: "claude", permissionMode: "plan" },
    { id: "reviewerB", agentId: "codex" },
    { id: "lead", agentId: "claude" },
  ],
  links: [
    { from: "lead", to: "reviewerA", role: "supervises" },
    { from: "lead", to: "reviewerB", role: "supervises" },
  ],
  steps: [
    { id: "s1", kind: "prompt", role: "reviewerA", prompt: "审查 {{scopeA}}" },
    { id: "s2", kind: "prompt", role: "reviewerB", prompt: "审查 {{scopeB}}" },
    {
      id: "s3",
      kind: "collect",
      role: "lead",
      from: ["s1", "s2"],
      prompt: "汇总两份结论",
      after: ["s1", "s2"],
    },
    { id: "s4", kind: "gate", label: "合并前确认", after: ["s3"] },
    { id: "s5", kind: "prompt", role: "lead", prompt: "合并", after: ["s4"] },
  ],
};

function template(draft: unknown = DRAFT): TemplateRow {
  const parsed: WorkflowDraft = parseDraft(draft, {
    validAgentId: () => true,
  });
  return insertTemplate(fixture.database, {
    id: uuidV7(),
    name: parsed.title,
    template: parsed,
    createdFromDraft: null,
    createdAt: clock,
  });
}

function newEngine(): WorkflowEngine {
  return new WorkflowEngine({
    database: fixture.database,
    collab: () => fixture.collab,
    clock: () => clock,
    sweepEveryMs: false,
    launch: (node) => launched.push(node.nodeId),
  });
}

/** 节点报一次状态：写行，时刻往前走一秒。 */
function report(
  nodeId: string,
  state: string,
  verdict: { errored?: boolean } = {},
): void {
  clock += 1_000;
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, " +
        "restored, last_event_at, errored, interrupted, updated_at) " +
        "VALUES (?, ?, 'claude', ?, 0, 1, 0, ?, ?, 0, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, " +
        "last_event_at = excluded.last_event_at, errored = excluded.errored, " +
        "updated_at = excluded.updated_at",
    )
    .run(
      nodeId,
      fixture.workspaceId,
      state,
      new Date(clock).toISOString(),
      state === "done" ? (verdict.errored === true ? 1 : 0) : null,
      rfc3339(),
    );
  engine.handleEvent({ type: "agent.status", status: { nodeId, state } });
}

/** 出队泵把排给这个节点的那条投出去了。 */
function delivered(nodeId: string): string {
  const row = fixture.database
    .prepare(
      "SELECT id, body FROM agent_send_queue WHERE target_node_id = ? AND state = 'queued' ORDER BY created_at",
    )
    .get(nodeId) as { id: string; body: string } | undefined;
  if (row === undefined) throw new Error(`nothing queued for ${nodeId}`);
  fixture.database
    .prepare("UPDATE agent_send_queue SET state = 'done' WHERE id = ?")
    .run(row.id);
  return row.body;
}

function post(source: string, target: string, key: string, body: string) {
  fixture.database
    .prepare(
      "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, message_key, body, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      uuidV7(),
      fixture.workspaceId,
      source,
      target,
      key,
      body,
      Math.floor(clock / 1000),
      Math.floor(clock / 1000) + 86_400,
    );
}

/** 一轮：投递落地 → 忙 → 干净地结束。答投进去的正文。 */
async function turn(runId: string, nodeId: string): Promise<string> {
  const body = delivered(nodeId);
  await engine.progress(runId);
  report(nodeId, "working");
  await engine.progress(runId);
  report(nodeId, "done");
  await engine.progress(runId);
  return body;
}

function statuses(runId: string): Record<string, string> {
  return Object.fromEntries(
    stepsOf(fixture.database, runId).map((step) => [step.stepId, step.status]),
  );
}

function events(type: string): Record<string, unknown>[] {
  return fixture.events
    .map((entry) => entry.event as unknown as Record<string, unknown>)
    .filter((event) => event.type === type);
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  fixture = agentFixture();
  clock = Date.now();
  launched = [];
  engine = newEngine();
});

afterEach(async () => {
  await engine.stop();
  fixture.close();
});

describe("starting a run", () => {
  it("lays out a Frame, an anchor and one linked node per role, and launches them", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "src/a" },
      boardId: fixture.boardId,
    });
    expect(run.status).toBe("running");
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    const frame = document.nodes.find((node) => node.id === run.frameId);
    expect(frame?.type).toBe("group");
    const anchor = document.nodes.find((node) => node.id === run.anchorNodeId);
    expect(anchor?.parentId).toBe(frame?.id);
    expect(Object.keys(run.roles).sort()).toEqual([
      "lead",
      "reviewerA",
      "reviewerB",
    ]);
    const reviewerA = document.nodes.find(
      (node) => node.id === run.roles.reviewerA,
    );
    expect(reviewerA?.parentId).toBe(frame?.id);
    expect(reviewerA?.data).toMatchObject({
      kind: "terminal",
      agent: { id: "claude", permissionMode: "plan" },
    });
    // 起点便签向每个角色一条主从线，草案的两条线照原样。
    const supervised = document.edges.filter(
      (edge) => edge.source === run.anchorNodeId,
    );
    expect(supervised).toHaveLength(3);
    expect(
      document.edges.some(
        (edge) =>
          edge.source === run.roles.lead &&
          edge.target === run.roles.reviewerB &&
          edge.role === "supervises",
      ),
    ).toBe(true);
    expect(
      getContextLinks(fixture.database, run.anchorNodeId as string).links.map(
        (link) => link.role,
      ),
    ).toEqual(["sub", "sub", "sub"]);
    expect(launched.sort()).toEqual(Object.values(run.roles).sort());
    // 两个没有依赖的步骤当场开始，提示词按参数代入（缺省值也算）。
    expect(statuses(run.id)).toMatchObject({
      s1: "running",
      s2: "running",
      s3: "pending",
      s4: "pending",
      s5: "pending",
    });
    const queued = fixture.database
      .prepare(
        "SELECT source_node_id, target_node_id, body, origin FROM agent_send_queue ORDER BY body",
      )
      .all() as {
      source_node_id: string;
      target_node_id: string;
      body: string;
      origin: string;
    }[];
    expect(queued.map((row) => row.body)).toEqual(["审查 src/a", "审查 src/b"]);
    expect(
      queued.every(
        (row) =>
          row.source_node_id === run.anchorNodeId &&
          row.origin === "first-task",
      ),
    ).toBe(true);
    expect(events("workflow.run")[0]).toMatchObject({
      runId: run.id,
      status: "running",
    });
  });

  it("refuses a missing parameter and an unsupported permission mode before touching the board", async () => {
    await expect(
      engine.startRun({ template: template(), boardId: fixture.boardId }),
    ).rejects.toMatchObject({ code: "missing_param" });
    const unsupported = {
      ...DRAFT,
      roles: [
        { id: "only", agentId: "custom:nothing", permissionMode: "plan" },
      ],
      links: [],
      steps: [{ id: "s1", kind: "prompt", role: "only", prompt: "x" }],
      params: [],
    };
    await expect(
      engine.startRun({
        template: template(unsupported),
        boardId: fixture.boardId,
      }),
    ).rejects.toMatchObject({ code: "permission_mode_unsupported" });
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    expect(document.nodes).toHaveLength(0);
  });
});

describe("the three step kinds", () => {
  it("runs prompt → collect → gate → prompt to success", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "src/a" },
      boardId: fixture.boardId,
    });
    const { reviewerA, reviewerB, lead } = run.roles as {
      reviewerA: string;
      reviewerB: string;
      lead: string;
    };

    // 投出去之前、节点早先的一次 done 不算这一轮的。
    report(reviewerA, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).s1).toBe("running");

    delivered(reviewerA);
    await engine.progress(run.id);
    report(reviewerA, "working");
    post(reviewerA, lead, "review-a", "A 的结论");
    report(reviewerA, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).s1).toBe("done");
    expect(stepOfRun(fixture.database, run.id, "s1")?.outcome).toMatchObject({
      outputs: [{ key: "review-a", body: "A 的结论", target: lead }],
    });
    expect(statuses(run.id).s3).toBe("pending");

    delivered(reviewerB);
    await engine.progress(run.id);
    report(reviewerB, "working");
    post(reviewerB, reviewerA, "review-b", "B 的结论");
    report(reviewerB, "done");
    await engine.progress(run.id);
    expect(statuses(run.id)).toMatchObject({
      s2: "done",
      s3: "running",
    });

    // collect：B 的结论（发给了别人）放进 lead 的收件箱；A 的本来就在那里。
    const inbox = fixture.database
      .prepare(
        "SELECT source_node_id, message_key, body FROM agent_mailbox WHERE target_node_id = ? ORDER BY sequence",
      )
      .all(lead) as {
      source_node_id: string;
      message_key: string;
      body: string;
    }[];
    expect(inbox.map((row) => row.body)).toEqual(["A 的结论", "B 的结论"]);
    expect(inbox[1]).toMatchObject({
      source_node_id: reviewerB,
      message_key: `workflow:${run.id}:s2:0`,
    });

    const collected = await turn(run.id, lead);
    expect(collected).toContain("汇总两份结论");
    expect(collected).toContain("canvas inbox");
    expect(statuses(run.id)).toMatchObject({ s3: "done", s4: "waiting" });
    expect(runById(fixture.database, run.id)?.status).toBe("waiting");
    expect(events("workflow.gate").at(-1)).toMatchObject({
      runId: run.id,
      stepId: "s4",
      label: "合并前确认",
      state: "waiting",
    });

    // 关卡等人：怎么推都不动。
    await engine.sweep();
    expect(statuses(run.id).s5).toBe("pending");

    await engine.answerGate(run.id, "s4", "approve", "可以合");
    expect(stepOfRun(fixture.database, run.id, "s4")?.outcome).toEqual({
      decision: "approve",
      note: "可以合",
    });
    expect(statuses(run.id).s5).toBe("running");
    expect(runById(fixture.database, run.id)?.status).toBe("running");
    expect(await turn(run.id, lead)).toBe("合并");
    const finished = runById(fixture.database, run.id);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.endedAt).not.toBeNull();
    await expect(
      engine.answerGate(run.id, "s4", "approve"),
    ).rejects.toMatchObject({ code: "gate_not_waiting" });
  });

  it("fails the run when a gate is rejected, skipping what waited on it", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    const { reviewerA, reviewerB, lead } = run.roles as {
      reviewerA: string;
      reviewerB: string;
      lead: string;
    };
    await turn(run.id, reviewerA);
    await turn(run.id, reviewerB);
    await turn(run.id, lead);
    await engine.answerGate(run.id, "s4", "reject");
    expect(statuses(run.id)).toMatchObject({ s4: "failed", s5: "skipped" });
    const finished = runById(fixture.database, run.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.reason).toBe("s4:rejected");
    expect(events("workflow.gate").at(-1)).toMatchObject({ state: "rejected" });
  });

  it("fails a step whose turn ends in an error, and skips its dependents", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    const { reviewerA, reviewerB } = run.roles as {
      reviewerA: string;
      reviewerB: string;
    };
    delivered(reviewerA);
    await engine.progress(run.id);
    report(reviewerA, "working");
    report(reviewerA, "done", { errored: true });
    await engine.progress(run.id);
    expect(stepOfRun(fixture.database, run.id, "s1")).toMatchObject({
      status: "failed",
      reason: "turnFailed",
    });
    expect(statuses(run.id)).toMatchObject({
      s3: "skipped",
      s4: "skipped",
      s5: "skipped",
    });
    // 独立的那一支照常跑完，然后整次运行落 failed。
    expect(runById(fixture.database, run.id)?.status).toBe("running");
    await turn(run.id, reviewerB);
    expect(runById(fixture.database, run.id)?.status).toBe("failed");
  });

  it("re-delivers an expired prompt, and gives up after the third attempt", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    const reviewerA = run.roles.reviewerA as string;
    const expire = () =>
      fixture.database
        .prepare(
          "UPDATE agent_send_queue SET state = 'expired', last_reason = 'TARGET_STARTING' " +
            "WHERE target_node_id = ? AND state = 'queued'",
        )
        .run(reviewerA);
    expire();
    await engine.progress(run.id);
    expect(stepOfRun(fixture.database, run.id, "s1")).toMatchObject({
      status: "running",
      attempts: 2,
    });
    expire();
    await engine.progress(run.id);
    expire();
    await engine.progress(run.id);
    expect(stepOfRun(fixture.database, run.id, "s1")).toMatchObject({
      status: "failed",
      reason: "TARGET_STARTING",
      attempts: 3,
    });
  });
});

describe("cancelling", () => {
  it("cancels the steps and takes back the prompts still queued, leaving the nodes", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    await engine.cancel(run.id);
    const finished = runById(fixture.database, run.id);
    expect(finished?.status).toBe("cancelled");
    expect(new Set(Object.values(statuses(run.id)))).toEqual(
      new Set(["cancelled"]),
    );
    const states = fixture.database
      .prepare("SELECT DISTINCT state FROM agent_send_queue")
      .all() as { state: string }[];
    expect(states.map((row) => row.state)).toEqual(["cancelled"]);
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    expect(document.nodes.some((node) => node.id === run.roles.lead)).toBe(
      true,
    );
    await expect(engine.cancel(run.id)).rejects.toMatchObject({
      code: "run_finished",
    });
  });
});

describe("without a page", () => {
  it("advances on bus events alone", async () => {
    const bus = new EventBus();
    await engine.stop();
    engine = new WorkflowEngine({
      database: fixture.database,
      collab: () => fixture.collab,
      bus,
      clock: () => clock,
      sweepEveryMs: false,
      launch: (node) => launched.push(node.nodeId),
    });
    engine.start();
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    const reviewerA = run.roles.reviewerA as string;
    delivered(reviewerA);
    for (const state of ["working", "done"]) {
      clock += 1_000;
      fixture.database
        .prepare(
          "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, " +
            "restored, last_event_at, errored, interrupted, updated_at) VALUES (?, ?, 'claude', ?, 0, 1, 0, ?, 0, 0, ?) " +
            "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, last_event_at = excluded.last_event_at",
        )
        .run(
          reviewerA,
          fixture.workspaceId,
          state,
          new Date(clock).toISOString(),
          rfc3339(),
        );
      bus.emit("workspace.event", {
        workspaceId: fixture.workspaceId,
        event: { type: "agent.status", status: { nodeId: reviewerA, state } },
      });
      await engine.progress(run.id);
    }
    expect(statuses(run.id).s1).toBe("done");
  });
});

describe("restarting", () => {
  it("picks a run up where it was from the database alone", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    const reviewerA = run.roles.reviewerA as string;
    delivered(reviewerA);
    await engine.progress(run.id);
    await engine.stop();

    // core 不在的时候节点干完了这一轮：状态已经在库里。
    clock += 1_000;
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, " +
          "restored, last_event_at, errored, interrupted, updated_at) VALUES (?, ?, 'claude', 'done', 0, 1, 0, ?, 0, 0, ?)",
      )
      .run(
        reviewerA,
        fixture.workspaceId,
        new Date(clock).toISOString(),
        rfc3339(),
      );

    engine = newEngine();
    await engine.sweep();
    expect(statuses(run.id)).toMatchObject({ s1: "done", s2: "running" });
    expect(runById(fixture.database, run.id)?.status).toBe("running");
  });
});
