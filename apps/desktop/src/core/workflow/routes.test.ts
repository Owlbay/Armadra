import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { controlDispatcher } from "../collab/control";
import { resetSendLimits } from "../collab/send-limits";
import { resetInboxWake } from "../collab/wake";
import type { CoreRequest } from "../http/router";
import { routeScope } from "../http/route-scopes";
import { WorkflowEngine } from "./engine";
import { setWorkflowDomain } from "./registry";
import { answerWorkflowRequest, workflowRoutes } from "./routes";
import { WorkflowService } from "./service";

/**
 * `/api/workflows/*` 与 `workflow-propose`（契约 §15.1–§15.3）：草案从动词进来、
 * 经路由确认成模板、模板起一次运行、关卡经路由答复。
 */

let fixture: AgentFixture;
let service: WorkflowService;
let engine: WorkflowEngine;
let routes: ReturnType<typeof workflowRoutes>;
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
  const answer = await answerWorkflowRequest(routes, request);
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
  routes = workflowRoutes(service);
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
  });
});
