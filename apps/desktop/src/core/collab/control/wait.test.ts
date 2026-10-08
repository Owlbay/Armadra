import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentFixture,
  agentFixture,
  callerFor,
} from "../../agent/fixture";
import { launchLine } from "../../dependencies/launch";
import { launchFor } from "../../dependencies/store";
import { taskRun } from "../../workflow/task-runs";
import { type ControlOutcome, controlDispatcher } from ".";
import { resetSendLimits } from "../send-limits";
import { LAUNCH_FAILED_REASON, failLaunch } from "../send-queue";
import { resetInboxWake } from "../wake";
import { parseCursor, resetWaitTrackers } from "./wait";

/**
 * `open-agent --task-id` 与 `wait`（补全架构 §5.3，契约 §15.5）：runner 起成员、
 * 按任务 id 幂等、长轮询五种状态、游标不漏不重、到点答 `running`。
 */

let fixture: AgentFixture;
let lead: string;

async function run(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, nodeId), args);
}

function result(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  }
  return outcome.body.result as Record<string, unknown>;
}

interface Answer {
  status: string;
  since: string;
  events: { type: string; seq?: number; key?: string; state?: string }[];
  approvalId?: string;
  reason?: string;
  result?: { text: string };
}

async function wait(
  task: string,
  since?: string,
  timeout = 0,
  caller = lead,
): Promise<Answer> {
  return result(
    await run(caller, "wait", {
      task,
      timeout: String(timeout),
      ...(since === undefined ? {} : { since }),
    }),
  ) as unknown as Answer;
}

/** 成员的状态行：`at` 是上报时刻，越大越新。 */
function report(
  nodeId: string,
  state: string,
  at: number,
  extra: { pendingId?: string; errored?: boolean; interrupted?: boolean } = {},
): void {
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, pending_id, verified, restored, " +
        "updated_at, last_event_at, errored, interrupted) VALUES (?, ?, 'codex', ?, 0, ?, 1, 0, ?, ?, ?, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, pending_id = excluded.pending_id, " +
        "last_event_at = excluded.last_event_at, errored = excluded.errored, interrupted = excluded.interrupted",
    )
    .run(
      nodeId,
      fixture.workspaceId,
      state,
      extra.pendingId ?? null,
      new Date(at).toISOString(),
      new Date(at).toISOString(),
      extra.errored === undefined ? null : Number(extra.errored),
      extra.interrupted === undefined ? null : Number(extra.interrupted),
    );
}

function deliverAll(nodeId: string): void {
  fixture.database
    .prepare(
      "UPDATE agent_send_queue SET state = 'done' WHERE target_node_id = ?",
    )
    .run(nodeId);
}

async function openTask(taskId: string, agent = "codex"): Promise<string> {
  const body = result(
    await run(lead, "open-agent", {
      agent,
      task: `do ${taskId}`,
      "task-id": taskId,
      name: `task ${taskId}`,
    }),
  );
  return body.id as string;
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
});

describe("open-agent --task-id", () => {
  it("records the task, launches the node in the core, and is idempotent", async () => {
    const first = result(
      await run(lead, "open-agent", {
        agent: "codex",
        task: "review src/x",
        "task-id": "s1:t1",
        name: "codex task t1",
      }),
    );
    const nodeId = first.id as string;
    expect(first).toMatchObject({ taskRunId: "s1:t1", reused: false });
    expect(taskRun(fixture.database, "s1:t1")).toMatchObject({
      coordinatorNodeId: lead,
      runnerId: "codex",
      nodeId,
      status: "running",
    });
    // 页面不在也起：一条没有边的启动行交给依赖编排。
    expect(launchFor(fixture.database, nodeId)).toMatchObject({
      state: "waiting",
    });
    const title = fixture.database
      .prepare("SELECT title FROM nodes WHERE id = ?")
      .get(nodeId) as { title: string };
    expect(title.title).toBe("codex task t1");

    const again = result(
      await run(lead, "open-agent", {
        agent: "codex",
        task: "review src/x",
        "task-id": "s1:t1",
      }),
    );
    expect(again).toMatchObject({ id: nodeId, reused: true });
    const count = fixture.database
      .prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'terminal'")
      .get() as { n: number };
    expect(Number(count.n)).toBe(2);

    // 节点被删了：重试起一个新的，任务换绑过去。
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
    const rebound = result(
      await run(lead, "open-agent", { agent: "codex", "task-id": "s1:t1" }),
    );
    expect(rebound.id).not.toBe(nodeId);
    expect(taskRun(fixture.database, "s1:t1")?.nodeId).toBe(rebound.id);
  });

  it("refuses a task id another coordinator owns, and a malformed one", async () => {
    await openTask("s1:t1");
    const other = fixture.agentNode("other", "ama");
    const refused = await run(other, "open-agent", {
      agent: "codex",
      "task-id": "s1:t1",
    });
    expect(refused).toMatchObject({ ok: false, code: "task_conflict" });
    const bad = await run(lead, "open-agent", {
      agent: "codex",
      "task-id": "has space",
    });
    expect(bad).toMatchObject({ ok: false, status: 400 });
  });

  it("answers an unsupported permission mode with its own code", async () => {
    const refused = await run(lead, "open-agent", {
      agent: "opencode",
      "permission-mode": "plan",
    });
    expect(refused).toMatchObject({
      ok: false,
      code: "permission_mode_unsupported",
    });
  });
});

/** 节点数据（存盘的那一份）。 */
function nodeData(nodeId: string): Record<string, unknown> {
  const row = fixture.database
    .prepare("SELECT data_json FROM nodes WHERE id = ?")
    .get(nodeId) as { data_json: string };
  return JSON.parse(row.data_json) as Record<string, unknown>;
}

describe("open-agent --cwd", () => {
  it("opens the member in a directory inside the workspace, relative or absolute", async () => {
    mkdirSync(join(fixture.directory, "src", "app"), { recursive: true });
    const relative = result(
      await run(lead, "open-agent", { agent: "claude", cwd: "src/app" }),
    );
    expect(relative.cwd).toBe(join(fixture.directory, "src", "app"));
    expect(nodeData(relative.id as string).cwd).toBe(
      join(fixture.directory, "src", "app"),
    );
    const absolute = result(
      await run(lead, "open-agent", {
        agent: "claude",
        cwd: join(fixture.directory, "src"),
      }),
    );
    expect(nodeData(absolute.id as string).cwd).toBe(
      join(fixture.directory, "src"),
    );
    // 工作区根本身也算在里面。
    const rooted = result(
      await run(lead, "open-agent", { agent: "claude", cwd: "." }),
    );
    expect(rooted.cwd).toBe(fixture.directory);
    // 演练只报不建。
    const dry = result(
      await run(lead, "open-agent", {
        agent: "claude",
        cwd: "src",
        "dry-run": true,
      }),
    );
    expect(dry).toMatchObject({
      dryRun: true,
      cwd: join(fixture.directory, "src"),
    });
  });

  it("refuses a directory outside the workspace, through .. or a symlink", async () => {
    const outside = mkdtempSync(join(tmpdir(), "armadra-outside-"));
    try {
      symlinkSync(outside, join(fixture.directory, "escape"));
      const before = fixture.database
        .prepare("SELECT COUNT(*) AS n FROM nodes")
        .get() as { n: number };
      for (const cwd of ["..", outside, "escape", join(outside, "missing")]) {
        expect(
          await run(lead, "open-agent", { agent: "claude", cwd }),
        ).toMatchObject({
          ok: false,
          status: 400,
          code: "cwd_outside_workspace",
        });
      }
      const after = fixture.database
        .prepare("SELECT COUNT(*) AS n FROM nodes")
        .get() as { n: number };
      expect(Number(after.n)).toBe(Number(before.n));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a missing directory, a file, and --worktree alongside it", async () => {
    expect(
      await run(lead, "open-agent", { agent: "claude", cwd: "nope" }),
    ).toMatchObject({ ok: false, status: 400, code: "bad_request" });
    expect(
      await run(lead, "open-agent", { agent: "claude", cwd: "canvas.db" }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await run(lead, "open-agent", {
        agent: "claude",
        cwd: ".",
        worktree: "fix",
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe("open-agent --resume", () => {
  it("launches the member in the core on the CLI's own resume line", async () => {
    const body = result(
      await run(lead, "open-agent", {
        agent: "claude",
        resume: "0199aa00-1111-7222-8333-444455556666",
      }),
    );
    const nodeId = body.id as string;
    expect(body.resume).toBe("0199aa00-1111-7222-8333-444455556666");
    const data = nodeData(nodeId);
    expect((data.agent as Record<string, unknown>).resume).toBe(
      "0199aa00-1111-7222-8333-444455556666",
    );
    // 页面敲的是新开的行：带 --resume 的节点由 core 起，即使没有 --task-id。
    expect(launchFor(fixture.database, nodeId)).toMatchObject({
      state: "waiting",
    });
    expect(launchLine(fixture.collab, "claude", data)).toContain(
      "--resume 0199aa00-1111-7222-8333-444455556666",
    );
    const codex = result(
      await run(lead, "open-agent", { agent: "codex", resume: "thread-1" }),
    );
    expect(
      launchLine(fixture.collab, "codex", nodeData(codex.id as string)),
    ).toMatch(/codex\S* resume thread-1/);
  });

  it("takes a member's node id for the session that node reported", async () => {
    const member = fixture.agentNode("old reviewer", "claude");
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, session_id, verified, restored, " +
          "updated_at, last_event_at) VALUES (?, ?, 'claude', 'done', 0, 'sess-claude-1', 1, 0, ?, ?)",
      )
      .run(
        member,
        fixture.workspaceId,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    const body = result(
      await run(lead, "open-agent", { agent: "claude", resume: member }),
    );
    expect(body.resume).toBe("sess-claude-1");
    // 跑的不是同一家：接不回。
    expect(
      await run(lead, "open-agent", { agent: "codex", resume: member }),
    ).toMatchObject({ ok: false, code: "resume_unsupported" });
    // 从没报过会话 id：接不回。
    const silent = fixture.agentNode("silent", "claude");
    expect(
      await run(lead, "open-agent", { agent: "claude", resume: silent }),
    ).toMatchObject({ ok: false, code: "resume_unsupported" });
  });

  it("answers resume_unsupported for a CLI that cannot resume, and 400 for a malformed id", async () => {
    fixture.customAgents.push({
      id: "custom:once",
      label: "once",
      launchCmd: "once",
      baseAgent: "claude",
      disabledCapabilities: ["resume"],
    });
    const before = fixture.database
      .prepare("SELECT COUNT(*) AS n FROM nodes")
      .get() as { n: number };
    expect(
      await run(lead, "open-agent", { agent: "custom:once", resume: "s-1" }),
    ).toMatchObject({ ok: false, status: 400, code: "resume_unsupported" });
    expect(
      await run(lead, "open-agent", { agent: "claude", resume: "a b; rm" }),
    ).toMatchObject({ ok: false, status: 400, code: "bad_request" });
    const after = fixture.database
      .prepare("SELECT COUNT(*) AS n FROM nodes")
      .get() as { n: number };
    expect(Number(after.n)).toBe(Number(before.n));
  });
});

describe("wait", () => {
  it("walks running → blocked → needsInput → done, the cursor neither losing nor repeating", async () => {
    const member = await openTask("s1:t1");

    // 第一条任务还排着：running，没有事件。
    let answer = await wait("s1:t1");
    expect(answer).toMatchObject({ status: "running", events: [] });
    expect(parseCursor(answer.since)).toEqual({ post: 0, state: "" });

    deliverAll(member);
    report(member, "working", 1_000);
    answer = await wait("s1:t1", answer.since);
    expect(answer.status).toBe("running");
    expect(answer.events).toEqual([
      expect.objectContaining({ type: "status", state: "working" }),
    ]);
    // 同一个状态不再报。
    const quiet = await wait("s1:t1", answer.since);
    expect(quiet.events).toEqual([]);

    report(member, "blocked", 2_000, { pendingId: "approval-1" });
    answer = await wait("s1:t1", answer.since);
    expect(answer).toMatchObject({
      status: "blocked",
      approvalId: "approval-1",
      reason: "approval",
    });
    // 停在审批上不是结束：没有人替它回答，任务还在跑。
    expect(taskRun(fixture.database, "s1:t1")?.status).toBe("running");

    report(member, "waiting", 3_000);
    answer = await wait("s1:t1", answer.since);
    expect(answer.status).toBe("needsInput");

    report(member, "working", 4_000);
    expect(
      await run(member, "post", {
        to: lead,
        key: "task:s1:t1:progress",
        body: "half way",
      }),
    ).toMatchObject({ ok: true });
    // 别的任务的 post 与不带任务键的 post 不算。
    await run(member, "post", { to: lead, key: "note-1", body: "unrelated" });
    await run(member, "post", {
      to: lead,
      key: "task:s1:t10:result",
      body: "other task",
    });
    await run(member, "post", {
      to: lead,
      key: "task:s1:t1:result",
      body: "x looks fine",
    });
    answer = await wait("s1:t1", answer.since);
    expect(answer.status).toBe("done");
    expect(answer.result?.text).toBe("x looks fine");
    expect(
      answer.events.filter((event) => event.type === "post").map((e) => e.key),
    ).toEqual(["task:s1:t1:progress", "task:s1:t1:result"]);
    expect(taskRun(fixture.database, "s1:t1")).toMatchObject({
      status: "done",
      result: { text: "x looks fine" },
    });
    // runner 替协调者取走了结果：不再算未读。
    const unread = fixture.database
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_mailbox WHERE message_key = 'task:s1:t1:result' AND acknowledged_at IS NULL",
      )
      .get() as { n: number };
    expect(Number(unread.n)).toBe(0);

    // 带着答回来的游标再等：同样的 post 不再出现。
    const after = await wait("s1:t1", answer.since);
    expect(after.events.filter((event) => event.type === "post")).toEqual([]);
  });

  it("reports a turn held on an approval as blocked, and finishes once a person answers it", async () => {
    const member = await openTask("s1:held");
    deliverAll(member);
    let answer = await wait("s1:held");
    report(member, "working", 1_000);
    answer = await wait("s1:held", answer.since);
    expect(answer.status).toBe("running");

    // 长轮询挂着时成员停到审批上：一有变化就答，带审批 id。
    const pending = wait("s1:held", answer.since, 10);
    report(member, "blocked", 2_000, { pendingId: "member-1-2-3" });
    answer = await pending;
    expect(answer).toMatchObject({
      status: "blocked",
      approvalId: "member-1-2-3",
      reason: "approval",
    });
    expect(answer.events).toEqual([
      expect.objectContaining({ type: "status", state: "blocked" }),
    ]);
    // 再等一次仍是 blocked：动词不替人答，也不把它当结束。
    const still = await wait("s1:held", answer.since);
    expect(still).toMatchObject({ status: "blocked", events: [] });
    expect(taskRun(fixture.database, "s1:held")?.status).toBe("running");

    // 人在页面上答了：成员接着干，这一轮干净地结束。
    report(member, "working", 3_000);
    answer = await wait("s1:held", answer.since);
    expect(answer.status).toBe("running");
    report(member, "done", 4_000);
    answer = await wait("s1:held", answer.since);
    expect(answer.status).toBe("done");
    expect(answer.result).toBeUndefined();
    expect(taskRun(fixture.database, "s1:held")?.status).toBe("done");
  });

  it("falls back to the member's turn ending after the delivery", async () => {
    const clean = await openTask("s1:clean");
    report(clean, "done", 500);
    deliverAll(clean);
    let answer = await wait("s1:clean");
    expect(answer.status).toBe("running");
    report(clean, "working", 1_000);
    answer = await wait("s1:clean", answer.since);
    expect(answer.status).toBe("running");
    report(clean, "done", 2_000, { errored: false, interrupted: false });
    answer = await wait("s1:clean", answer.since);
    expect(answer).toMatchObject({ status: "done" });
    expect(answer.result).toBeUndefined();

    const broken = await openTask("s1:broken");
    deliverAll(broken);
    report(broken, "working", 1_000);
    answer = await wait("s1:broken");
    report(broken, "done", 2_000, { interrupted: true });
    answer = await wait("s1:broken", answer.since);
    expect(answer).toMatchObject({
      status: "failed",
      reason: "turnInterrupted",
    });
    expect(taskRun(fixture.database, "s1:broken")?.status).toBe("failed");
  });

  it("fails when the node is gone or the delivery expired", async () => {
    const gone = await openTask("s1:gone");
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(gone);
    expect(await wait("s1:gone")).toMatchObject({
      status: "failed",
      reason: "nodeDeleted",
    });

    const late = await openTask("s1:late");
    fixture.database
      .prepare(
        "UPDATE agent_send_queue SET state = 'expired', last_reason = 'TARGET_STARTING' WHERE target_node_id = ?",
      )
      .run(late);
    expect(await wait("s1:late")).toMatchObject({
      status: "failed",
      reason: "TARGET_STARTING",
    });
  });

  it("fails with launch_failed once the member's launch has failed twice", async () => {
    const member = await openTask("s1:dead");
    expect(failLaunch(fixture.database, member)).toBeGreaterThan(0);
    expect(await wait("s1:dead")).toMatchObject({
      status: "failed",
      reason: LAUNCH_FAILED_REASON,
    });
    expect(taskRun(fixture.database, "s1:dead")?.status).toBe("failed");
  });

  it("holds the request until the timeout and then answers running", async () => {
    const member = await openTask("s1:slow");
    deliverAll(member);
    report(member, "working", 1_000);
    const first = await wait("s1:slow");
    const started = Date.now();
    const answer = await wait("s1:slow", first.since, 1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(answer).toMatchObject({ status: "running", events: [] });
    expect(answer.since).toBe(first.since);
  });

  it("returns as soon as something new arrives", async () => {
    const member = await openTask("s1:fast");
    deliverAll(member);
    report(member, "working", 1_000);
    const first = await wait("s1:fast");
    const pending = wait("s1:fast", first.since, 10);
    setTimeout(() => {
      void run(member, "post", {
        to: lead,
        key: "task:s1:fast:result",
        body: "quick",
      });
    }, 100);
    const started = Date.now();
    const answer = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(answer).toMatchObject({ status: "done", result: { text: "quick" } });
  });

  it("is only for the coordinator that started the task", async () => {
    await openTask("s1:mine");
    const other = fixture.agentNode("other", "ama");
    expect(
      await run(other, "wait", { task: "s1:mine", timeout: "0" }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await run(lead, "wait", { task: "s1:none", timeout: "0" }),
    ).toMatchObject({ ok: false, code: "task_not_found" });
    expect(
      await run(lead, "wait", { task: "s1:mine", since: "x!" }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await run(lead, "wait", { task: "s1:mine", timeout: "61" }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await run(lead, "wait", { task: "s1:mine", node: "nope", timeout: "0" }),
    ).toMatchObject({ ok: false, code: "task_node_mismatch" });
  });
});
