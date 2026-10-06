import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { controlDispatcher } from "../collab/control";
import { resetSendLimits } from "../collab/send-limits";
import { resetInboxWake } from "../collab/wake";
import type { CoreRequest } from "../http/router";
import { routeScope } from "../http/route-scopes";
import { WorkflowEngine } from "./engine";
import { setWorkflowDomain } from "./registry";
import { nodeCreator } from "../identity/creators";
import { runAs } from "../identity/gate";
import { scope } from "../identity/scopes";
import { GATE_SCOPE } from "./routes";
import { workflowDispatcher } from "./test-dispatch";
import { WorkflowService } from "./service";
import { finishTask, recordTaskStart } from "./task-runs";

/**
 * `/api/workflows/*` 与 `workflow-propose`（契约 §15.1–§15.3）：草案从动词进来、
 * 经路由确认成模板、模板起一次运行、关卡经路由答复。
 */

let fixture: AgentFixture;
let service: WorkflowService;
let engine: WorkflowEngine;
let dispatch: ReturnType<typeof workflowDispatcher>;
let coordinator: string;

const DRAFT = {
  version: 1,
  title: "一步加关卡",
  params: [{ name: "scope", type: "string" }],
  roles: [{ id: "worker", agentId: "codex" }],
  steps: [
    { id: "s1", kind: "gate", label: "开工前确认" },
    {
      id: "s2",
      kind: "prompt",
      role: "worker",
      prompt: "看 {{scope}}",
      after: ["s1"],
    },
  ],
};

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(path, "http://core");
  const encoded =
    body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const request = {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers: {},
    body: encoded,
    raw: undefined as never,
    json: <T>(): T => JSON.parse(encoded.toString("utf8")) as T,
  } satisfies CoreRequest;
  const answer = await dispatch(request);
  return {
    status: answer.status,
    body: (answer.body ?? {}) as Record<string, unknown>,
  };
}

async function propose(draft: unknown) {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(
    "workflow-propose",
    callerFor(fixture, coordinator),
    { draft },
  );
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  fixture = agentFixture();
  coordinator = fixture.agentNode("Lead", "claude");
  engine = new WorkflowEngine({
    database: fixture.database,
    collab: () => fixture.collab,
    sweepEveryMs: false,
    launch: () => {},
  });
  service = new WorkflowService({
    database: fixture.database,
    engine,
    collab: () => fixture.collab,
  });
  setWorkflowDomain({ engine, service, stop: () => engine.stop() });
  dispatch = workflowDispatcher(service);
});

afterEach(async () => {
  setWorkflowDomain(undefined);
  await engine.stop();
  fixture.close();
});

describe("workflow-propose", () => {
  it("stores a pending draft from the calling node and announces it", async () => {
    const outcome = await propose(DRAFT);
    expect(outcome.ok).toBe(true);
    const result = (
      outcome as unknown as { body: { result: Record<string, unknown> } }
    ).body.result;
    expect(result).toMatchObject({ status: "pending", title: "一步加关卡" });
    const listed = await call(
      "GET",
      `/api/workflows/drafts?boardId=${fixture.boardId}&status=pending`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.drafts).toEqual([
      expect.objectContaining({
        id: result.draftId,
        proposerNodeId: coordinator,
        boardId: fixture.boardId,
        workspaceId: fixture.workspaceId,
      }),
    ]);
    expect(
      fixture.events.some(
        (entry) =>
          entry.event.type === "workflow.draft" &&
          entry.event.draftId === result.draftId,
      ),
    ).toBe(true);
  });

  it("accepts the draft as a JSON string and refuses an invalid one", async () => {
    expect((await propose(JSON.stringify(DRAFT))).ok).toBe(true);
    const refused = await propose({
      ...DRAFT,
      roles: [{ id: "w", agentId: "nope" }],
    });
    expect(refused).toMatchObject({
      ok: false,
      status: 400,
      code: "invalid_draft",
    });
  });
});

describe("/api/workflows", () => {
  it("confirms a draft into a template, runs it and answers its gate", async () => {
    const proposed = await propose(DRAFT);
    const draftId = (
      proposed as unknown as { body: { result: { draftId: string } } }
    ).body.result.draftId;

    const confirmed = await call(
      "POST",
      `/api/workflows/drafts/${draftId}/confirm`,
      { name: "审查流程" },
    );
    expect(confirmed.status).toBe(200);
    const template = confirmed.body.template as Record<string, unknown>;
    expect(template).toMatchObject({
      name: "审查流程",
      version: 1,
      createdFromDraft: draftId,
    });
    expect(confirmed.body.draft).toMatchObject({
      status: "confirmed",
      templateId: template.id,
    });
    const again = await call(
      "POST",
      `/api/workflows/drafts/${draftId}/discard`,
    );
    expect(again).toMatchObject({
      status: 409,
      body: { code: "draft_not_pending" },
    });

    const started = await call("POST", "/api/workflows/runs", {
      templateId: template.id,
      params: { scope: "src" },
      boardId: fixture.boardId,
    });
    expect(started.status).toBe(201);
    const run = started.body.run as Record<string, unknown>;
    expect(run).toMatchObject({
      status: "waiting",
      title: "一步加关卡",
      params: { scope: "src" },
    });
    expect(run.steps).toEqual([
      expect.objectContaining({
        stepId: "s1",
        kind: "gate",
        status: "waiting",
      }),
      expect.objectContaining({
        stepId: "s2",
        kind: "prompt",
        role: "worker",
        status: "pending",
        outputs: [],
      }),
    ]);

    const answered = await call(
      "POST",
      `/api/workflows/runs/${run.id as string}/gates/s1`,
      { decision: "approve" },
    );
    expect(answered.status).toBe(200);
    expect((answered.body.run as Record<string, unknown>).steps).toEqual([
      expect.objectContaining({
        stepId: "s1",
        status: "done",
        decision: "approve",
      }),
      expect.objectContaining({ stepId: "s2", status: "running" }),
    ]);

    const listed = await call(
      "GET",
      `/api/workflows/runs?templateId=${template.id as string}`,
    );
    expect((listed.body.runs as unknown[]).length).toBe(1);

    const cancelled = await call(
      "POST",
      `/api/workflows/runs/${run.id as string}/cancel`,
    );
    expect((cancelled.body.run as Record<string, unknown>).status).toBe(
      "cancelled",
    );
  });

  it("keeps template versions monotonic and deletes", async () => {
    const created = await call("POST", "/api/workflows/templates", {
      template: DRAFT,
    });
    expect(created.status).toBe(201);
    const id = (created.body.template as { id: string }).id;
    const stale = await call("PUT", `/api/workflows/templates/${id}`, {
      template: DRAFT,
    });
    expect(stale).toMatchObject({
      status: 409,
      body: { code: "template_version_stale" },
    });
    const updated = await call("PUT", `/api/workflows/templates/${id}`, {
      name: "第二版",
      template: { ...DRAFT, version: 2 },
    });
    expect(updated.body.template).toMatchObject({ name: "第二版", version: 2 });
    expect(
      (
        (await call("GET", "/api/workflows/templates")).body
          .templates as unknown[]
      ).length,
    ).toBe(1);
    expect(
      (await call("DELETE", `/api/workflows/templates/${id}`)).status,
    ).toBe(204);
    expect((await call("GET", `/api/workflows/templates/${id}`)).status).toBe(
      404,
    );
  });

  it("answers errors as { code, message }", async () => {
    expect(await call("GET", "/api/workflows/nothing")).toMatchObject({
      status: 404,
      body: { code: "not_found" },
    });
    expect(await call("PATCH", "/api/workflows/templates")).toMatchObject({
      status: 405,
    });
    expect(
      await call("POST", "/api/workflows/templates", {
        template: { version: 1 },
      }),
    ).toMatchObject({ status: 400, body: { code: "invalid_draft" } });
    expect(
      await call("POST", "/api/workflows/runs", { templateId: "missing" }),
    ).toMatchObject({ status: 404 });
  });

  it("is read at canvas:read and written at agent:launch", () => {
    expect(routeScope("GET", "/api/workflows/runs")?.permission).toBe(
      "canvas:read",
    );
    expect(routeScope("POST", "/api/workflows/runs")?.permission).toBe(
      "agent:launch",
    );
    // 关卡答复（契约 §23）：operator，不是替 Agent 代答的 `approval:answer`。
    expect(
      routeScope("POST", "/api/workflows/runs/r1/gates/s1")?.permission,
    ).toBe(GATE_SCOPE);
    expect(GATE_SCOPE).toBe("agent:launch");
  });

  it("records whoever started the run as its role nodes' creator (§23)", async () => {
    const created = await call("POST", "/api/workflows/templates", {
      name: "成员起跑",
      template: DRAFT,
    });
    const templateId = (created.body.template as { id: string }).id;
    const started = await runAs(
      {
        subject: {
          principalId: "operator-1",
          kind: "member",
          scopes: [scope("identity:read")],
        },
      },
      () =>
        call("POST", "/api/workflows/runs", {
          templateId,
          params: { scope: "src" },
          boardId: fixture.boardId,
        }),
    );
    expect(started.status).toBe(201);
    const row = fixture.database
      .prepare("SELECT roles_json FROM workflow_runs WHERE id = ?")
      .get((started.body.run as { id: string }).id) as { roles_json: string };
    const roles = Object.values(JSON.parse(row.roles_json) as object);
    expect(roles).toHaveLength(1);
    for (const nodeId of roles) {
      expect(nodeCreator(fixture.database, nodeId as string)).toBe(
        "operator-1",
      );
    }
    // 桌面壳、owner：记空串。
    const local = await call("POST", "/api/workflows/runs", {
      templateId,
      params: { scope: "src" },
      boardId: fixture.boardId,
    });
    const localRow = fixture.database
      .prepare("SELECT roles_json FROM workflow_runs WHERE id = ?")
      .get((local.body.run as { id: string }).id) as { roles_json: string };
    for (const nodeId of Object.values(
      JSON.parse(localRow.roles_json) as object,
    )) {
      expect(nodeCreator(fixture.database, nodeId as string)).toBe("");
    }
  });
});

describe("协调者任务（契约 §15.7）", () => {
  function seed(task: string | undefined) {
    const member = fixture.agentNode("Member", "codex");
    recordTaskStart(fixture.database, {
      taskId: `sess:${member}`,
      coordinatorNodeId: coordinator,
      runnerId: "codex",
      nodeId: member,
      now: 1_000,
      task,
    });
    return { member, taskId: `sess:${member}` };
  }

  it("lists a board's task rows without the task text", async () => {
    const { member, taskId } = seed("审查 src/x");
    finishTask(
      fixture.database,
      taskId,
      "failed",
      { reason: "turnFailed" },
      5_000,
    );
    const listed = await call(
      "GET",
      `/api/workflows/tasks?boardId=${fixture.boardId}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.tasks).toEqual([
      {
        taskId,
        coordinatorNodeId: coordinator,
        runnerId: "codex",
        nodeId: member,
        status: "failed",
        startedAt: new Date(1_000).toISOString(),
        endedAt: new Date(5_000).toISOString(),
        reason: "turnFailed",
        retryable: true,
      },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain("审查 src/x");
    const other = await call("GET", "/api/workflows/tasks?boardId=elsewhere");
    expect(other.body.tasks).toEqual([]);
    const missing = await call("GET", "/api/workflows/tasks");
    expect(missing).toMatchObject({
      status: 400,
      body: { code: "bad_request" },
    });
  });

  it("retry re-queues the task text from the coordinator and reopens the row", async () => {
    const { member, taskId } = seed("审查 src/x");
    const early = await call(
      "POST",
      `/api/workflows/tasks/${encodeURIComponent(taskId)}/retry`,
    );
    expect(early).toMatchObject({
      status: 409,
      body: { code: "task_not_failed" },
    });
    finishTask(fixture.database, taskId, "failed", { reason: "x" }, 5_000);
    const retried = await call(
      "POST",
      `/api/workflows/tasks/${encodeURIComponent(taskId)}/retry`,
    );
    expect(retried.status).toBe(200);
    expect(retried.body.task).toMatchObject({
      taskId,
      status: "running",
      endedAt: null,
      reason: null,
      retryable: false,
    });
    const queued = fixture.database
      .prepare(
        "SELECT source_node_id, body FROM agent_send_queue WHERE target_node_id = ?",
      )
      .all(member) as { source_node_id: string; body: string }[];
    expect(queued).toEqual([
      { source_node_id: coordinator, body: "审查 src/x" },
    ]);
    // 再失败一次，正文还在。
    finishTask(fixture.database, taskId, "failed", { reason: "y" }, 9_000);
    const again = await call(
      "GET",
      `/api/workflows/tasks?boardId=${fixture.boardId}`,
    );
    expect(again.body.tasks).toEqual([
      expect.objectContaining({ taskId, retryable: true, reason: "y" }),
    ]);
  });

  it("refuses a retry without task text, for an unknown task or a deleted member", async () => {
    const bare = seed(undefined);
    finishTask(fixture.database, bare.taskId, "failed", null, 5_000);
    expect(
      await call(
        "POST",
        `/api/workflows/tasks/${encodeURIComponent(bare.taskId)}/retry`,
      ),
    ).toMatchObject({ status: 409, body: { code: "task_prompt_missing" } });
    expect(await call("POST", "/api/workflows/tasks/nope/retry")).toMatchObject(
      { status: 404, body: { code: "not_found" } },
    );
    const gone = seed("x");
    finishTask(fixture.database, gone.taskId, "failed", null, 5_000);
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(gone.member);
    expect(
      await call(
        "POST",
        `/api/workflows/tasks/${encodeURIComponent(gone.taskId)}/retry`,
      ),
    ).toMatchObject({ status: 409, body: { code: "task_node_missing" } });
  });

  it("reads with canvas:read and retries with agent:launch", () => {
    expect(routeScope("GET", "/api/workflows/tasks")).toMatchObject({
      permission: "canvas:read",
    });
    expect(routeScope("POST", "/api/workflows/tasks/t/retry")).toMatchObject({
      permission: "agent:launch",
    });
  });
});
