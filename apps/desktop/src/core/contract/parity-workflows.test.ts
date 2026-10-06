import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { createBoard } from "../canvas/boards";
import { controlDispatcher } from "../collab/control";
import { resetSendLimits } from "../collab/send-limits";
import { resetInboxWake } from "../collab/wake";
import { routeScope } from "../http/route-scopes";
import { installContract } from "../http/rpc";
import type { AuthorizationSubject } from "../identity/authorize";
import { installRouteGuard, resetRouteGuard } from "../identity/gate";
import { type ShareRole, roleScopes } from "../identity/roles";
import { createRouteGuard } from "../identity/route-access";
import { type Scope, permits, scope } from "../identity/scopes";
import type { WorkflowScheduleBridge } from "../schedule/workflow-target";
import { WorkflowEngine } from "../workflow/engine";
import {
  setWorkflowDomain,
  setWorkflowScheduleBridge,
} from "../workflow/registry";
import { GATE_SCOPE, installWorkflowRoutes } from "../workflow/routes";
import { WorkflowService } from "../workflow/service";
import { finishTask, recordTaskStart } from "../workflow/task-runs";
import { createWorkspace } from "../workspaces/table";
import { type JsonValue, canonicalJson } from "./message";

/**
 * workflows 与 coordinator 两个域的对偶测试（契约 §43.2、§43.3；工程规范化包 §3 ④）。
 *
 * 与 `parity-agents.test.ts` 同一个做法：同一份夹具问三次——路由表里原来那条
 * handler、旧 REST 路径（经 HTTP，由契约实现经 `OpenAPIHandler` 答）、新
 * procedure。会改动状态的动作（确认、丢弃、起跑、取消、答关卡、重试）每个答法各用
 * 自己的对象，比较前把每次都会变的字段换成占位；失败的码、状态与原话相等
 * （procedure 多一个 `requestId`）。
 *
 * 单独一节写**拒绝路径**（投递门）：服务器壳上的成员经旧路径与 procedure 被同一道
 * 路由门拦下——只读的人确认不了草案、起不了跑、答不了关卡，也重试不了任务；模板
 * 的写只有 owner；别的画布上的人读不到这块画布的草案、运行与任务，拿别的画布的
 * 画板起跑也被拒（不跨工作空间）。被拒时状态一个字节都没变（草案仍待确认、运行仍
 * 在跑、任务仍是失败）。**关卡答复是 operator（`agent:launch`），不是替 Agent
 * 代答的 `approval:answer`**，契约与路由表两处一致。
 */

let f: AgentFixture;
let service: WorkflowService;
let engine: WorkflowEngine;
let base: string;
let coordinator: string;
let workspaceId: string;
let boardId: string;
let otherWorkspaceId: string;
let otherBoardId: string;

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

beforeAll(async () => {
  resetSendLimits();
  resetInboxWake();
  f = agentFixture();
  coordinator = f.agentNode("Lead", "claude");
  engine = new WorkflowEngine({
    database: f.database,
    collab: () => f.collab,
    sweepEveryMs: false,
    launch: () => {},
  });
  service = new WorkflowService({
    database: f.database,
    engine,
    collab: () => f.collab,
  });
  setWorkflowDomain({ engine, service, stop: () => engine.stop() });
  installWorkflowRoutes(f.server, service);
  installContract(f.server, { validateOutput: true, platform: f.platform });
  f.server.admission((request) => {
    const who = request.headers["x-parity-as"];
    return typeof who === "string"
      ? { identity: { subject: subject(who) } }
      : {};
  });
  const listener = f.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  workspaceId = f.workspaceId;
  boardId = f.boardId;
  const other = createWorkspace(f.database, {
    name: "other",
    rootPath: `${f.directory}/other`,
    permissions: { read: true, write: true, execute: true },
  });
  otherWorkspaceId = other.id;
  otherBoardId = createBoard(f.database, other.id, "Other").id;
});

afterAll(async () => {
  setWorkflowDomain(undefined);
  setWorkflowScheduleBridge(undefined);
  await engine.stop();
  await f.server.close();
  f.close();
});

/* -------------------------------- 三种答法 -------------------------------- */

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** 迁移前的答法：路由表里那条 handler。 */
async function table(
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const answer = await f.call(method, path, body);
  return { status: answer.status, body: answer.body };
}

/** 旧路径，经 HTTP；`as` 是服务器壳上的成员（投递门一节）。 */
async function legacy(
  method: string,
  path: string,
  body?: unknown,
  as?: string,
): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (as !== undefined) headers["x-parity-as"] = as;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? undefined : JSON.parse(text),
  };
}

/** 新 procedure；成功取 `json`，失败去掉 `requestId`。 */
async function procedure(
  name: string,
  input?: unknown,
  as?: string,
): Promise<Answer> {
  const response = await fetch(`${base}/api/rpc/${name.replace(".", "/")}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(as === undefined ? {} : { "x-parity-as": as }),
    },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  const text = await response.text();
  const body = (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
  if (response.ok) return { status: response.status, body: body.json };
  expect(typeof body.requestId).toBe("string");
  const { requestId: _requestId, ...rest } = body;
  return { status: response.status, body: rest };
}

/** 每个对象、每次调用都会变的字段。 */
const VOLATILE = new Set([
  "id",
  "draftId",
  "templateId",
  "createdFromDraft",
  "runId",
  "nodeId",
  "frameId",
  "createdAt",
  "updatedAt",
  "startedAt",
  "endedAt",
  "at",
  "taskId",
  "roles",
]);

function stable(value: unknown, volatile: ReadonlySet<string>): JsonValue {
  if (Array.isArray(value)) return value.map((one) => stable(one, volatile));
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    out[key] = volatile.has(key) ? "<volatile>" : stable(field, volatile);
  }
  return out;
}

const NOTHING = new Set<string>();

/**
 * 三种答法：状态一样（procedure 成功恒为 200；旧路径与表上的 201 / 204 照旧），
 * 体规范化后逐字节相等。
 */
function expectParity(
  [old, rest, rpc]: readonly [Answer, Answer, Answer],
  volatile: ReadonlySet<string> = NOTHING,
): void {
  const text = (answer: Answer) => canonicalJson(stable(answer.body, volatile));
  expect(rest.status, "旧路径的状态").toBe(old.status);
  expect(rpc.status, "procedure 的状态").toBe(
    old.status >= 400 ? old.status : 200,
  );
  expect(text(rest), "旧路径的体").toBe(text(old));
  expect(text(rpc), "procedure 的体").toBe(text(old));
}

/** 三种答法各跑一次：`run(kind, i)` 用 `i` 取各自的对象。 */
async function thrice<T>(
  run: (kind: "table" | "legacy" | "rpc", index: number) => Promise<T>,
): Promise<readonly [T, T, T]> {
  const out: T[] = [];
  for (const [index, kind] of (["table", "legacy", "rpc"] as const).entries()) {
    out.push(await run(kind, index));
  }
  return out as unknown as readonly [T, T, T];
}

/** 一个动词的三种答法。 */
function ask(
  kind: "table" | "legacy" | "rpc",
  method: string,
  path: string,
  name: string,
  input: Record<string, unknown>,
  body?: unknown,
  as?: string,
): Promise<Answer> {
  if (kind === "table") return table(method, path, body);
  if (kind === "legacy") return legacy(method, path, body, as);
  return procedure(name, input, as);
}

/* --------------------------------- 夹具 --------------------------------- */

const W = "/api/workflows";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

async function propose(draft: unknown = DRAFT): Promise<string> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  const outcome = await dispatcher.dispatch(
    "workflow-propose",
    callerFor(f, coordinator),
    { draft },
  );
  expect(outcome.ok).toBe(true);
  return (outcome as unknown as { body: { result: { draftId: string } } }).body
    .result.draftId;
}

async function template(version = 1): Promise<string> {
  const created = await table("POST", `${W}/templates`, {
    name: "模板",
    template: { ...DRAFT, version },
  });
  expect(created.status).toBe(201);
  return (created.body as { template: { id: string } }).template.id;
}

async function startRun(templateId: string): Promise<string> {
  const started = await table("POST", `${W}/runs`, {
    templateId,
    params: { scope: "src" },
    boardId,
  });
  expect(started.status).toBe(201);
  return (started.body as { run: { id: string } }).run.id;
}

function seedTask(task: string | null = "审查 src/x"): {
  member: string;
  taskId: string;
} {
  const member = f.agentNode("Member", "codex");
  recordTaskStart(f.database, {
    taskId: `sess:${member}`,
    coordinatorNodeId: coordinator,
    runnerId: "codex",
    nodeId: member,
    now: 1_000,
    task: task ?? undefined,
  });
  return { member, taskId: `sess:${member}` };
}

/* ------------------------------ §43.2 草案 ------------------------------ */

describe("草案", () => {
  it("drafts、draft：一块画板上的草案，按状态过滤", async () => {
    const a = await propose();
    await propose();
    for (const suffix of ["", "&status=pending", "&status=discarded"]) {
      const answers = [
        await table("GET", `${W}/drafts?boardId=${boardId}${suffix}`),
        await legacy("GET", `${W}/drafts?boardId=${boardId}${suffix}`),
        await procedure("workflows.drafts", {
          boardId,
          ...(suffix === "" ? {} : { status: suffix.slice("&status=".length) }),
        }),
      ] as const;
      expect(answers[0].status).toBe(200);
      expectParity(answers, VOLATILE);
    }
    const one = [
      await table("GET", `${W}/drafts/${a}`),
      await legacy("GET", `${W}/drafts/${a}`),
      await procedure("workflows.draft", { draftId: a }),
    ] as const;
    expect(one[0].body).toMatchObject({ draft: { id: a, status: "pending" } });
    expectParity(one);
    const gone = [
      await table("GET", `${W}/drafts/nope`),
      await legacy("GET", `${W}/drafts/nope`),
      await procedure("workflows.draft", { draftId: "nope" }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });

  it("confirmDraft：确认成模板（可带名字与改过的正文），再确认、丢弃都是 409", async () => {
    const drafts = [await propose(), await propose(), await propose()];
    const answers = await thrice((kind, index) =>
      ask(
        kind,
        "POST",
        `${W}/drafts/${drafts[index]}/confirm`,
        "workflows.confirmDraft",
        { draftId: drafts[index], name: "审查流程" },
        { name: "审查流程" },
      ),
    );
    expect(answers[0].status).toBe(200);
    expect(answers[0].body).toMatchObject({
      draft: { status: "confirmed" },
      template: { name: "审查流程", version: 1 },
    });
    expectParity(answers, VOLATILE);
    // 不带体也行（旧路径空体、procedure 只有 draftId）。
    const bare = [await propose(), await propose(), await propose()];
    expectParity(
      await thrice((kind, index) =>
        ask(
          kind,
          "POST",
          `${W}/drafts/${bare[index]}/confirm`,
          "workflows.confirmDraft",
          { draftId: bare[index] },
        ),
      ),
      VOLATILE,
    );
    const again = [
      await table("POST", `${W}/drafts/${drafts[0]}/confirm`, {}),
      await legacy("POST", `${W}/drafts/${drafts[0]}/confirm`, {}),
      await procedure("workflows.confirmDraft", { draftId: drafts[0] }),
    ] as const;
    expect(again[0]).toMatchObject({
      status: 409,
      body: { code: "draft_not_pending" },
    });
    expectParity(again);
  });

  it("confirmDraft：正文不合格被域拒绝（invalid_draft），码与原话一样", async () => {
    const id = await propose();
    const body = { draft: { version: 1 } };
    const answers = [
      await table("POST", `${W}/drafts/${id}/confirm`, body),
      await legacy("POST", `${W}/drafts/${id}/confirm`, body),
      await procedure("workflows.confirmDraft", { draftId: id, ...body }),
    ] as const;
    expect(answers[0]).toMatchObject({
      status: 400,
      body: { code: "invalid_draft" },
    });
    expectParity(answers);
  });

  it("discardDraft：丢弃，再丢弃是 409，不存在是 404", async () => {
    const drafts = [await propose(), await propose(), await propose()];
    const answers = await thrice((kind, index) =>
      ask(
        kind,
        "POST",
        `${W}/drafts/${drafts[index]}/discard`,
        "workflows.discardDraft",
        { draftId: drafts[index] },
        {},
      ),
    );
    expect(answers[0].body).toMatchObject({ draft: { status: "discarded" } });
    expectParity(answers, VOLATILE);
    for (const id of [drafts[0] as string, "nope"]) {
      const refused = [
        await table("POST", `${W}/drafts/${id}/discard`, {}),
        await legacy("POST", `${W}/drafts/${id}/discard`, {}),
        await procedure("workflows.discardDraft", { draftId: id }),
      ] as const;
      expect(refused[0].status).toBeGreaterThanOrEqual(400);
      expectParity(refused);
    }
  });
});

/* ------------------------------ §43.2 模板 ------------------------------ */

describe("模板", () => {
  it("createTemplate：旧路径答 201，procedure 恒为 200，体相同", async () => {
    const answers = await thrice((kind) =>
      ask(
        kind,
        "POST",
        `${W}/templates`,
        "workflows.createTemplate",
        { name: "模板", template: DRAFT },
        { name: "模板", template: DRAFT },
      ),
    );
    expect(answers[0].status).toBe(201);
    expect(answers[1].status).toBe(201);
    expect(answers[2].status).toBe(200);
    const text = (answer: Answer) =>
      canonicalJson(stable(answer.body, VOLATILE));
    expect(text(answers[1])).toBe(text(answers[0]));
    expect(text(answers[2])).toBe(text(answers[0]));
    const bad = { template: { version: 1 } };
    const refused = [
      await table("POST", `${W}/templates`, bad),
      await legacy("POST", `${W}/templates`, bad),
      await procedure("workflows.createTemplate", bad),
    ] as const;
    expect(refused[0]).toMatchObject({
      status: 400,
      body: { code: "invalid_draft" },
    });
    expectParity(refused);
  });

  it("templates、template：列表与单个", async () => {
    const id = await template();
    const list = [
      await table("GET", `${W}/templates`),
      await legacy("GET", `${W}/templates`),
      await procedure("workflows.templates"),
    ] as const;
    expect(list[0].status).toBe(200);
    expectParity(list, VOLATILE);
    const one = [
      await table("GET", `${W}/templates/${id}`),
      await legacy("GET", `${W}/templates/${id}`),
      await procedure("workflows.template", { templateId: id }),
    ] as const;
    expectParity(one);
    const gone = [
      await table("GET", `${W}/templates/nope`),
      await legacy("GET", `${W}/templates/nope`),
      await procedure("workflows.template", { templateId: "nope" }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });

  it("updateTemplate：版本只增；改成功答里多一列冻结的计划", async () => {
    const ids = [await template(), await template(), await template()];
    const stale = await thrice((kind, index) =>
      ask(
        kind,
        "PUT",
        `${W}/templates/${ids[index]}`,
        "workflows.updateTemplate",
        { templateId: ids[index], template: DRAFT },
        { template: DRAFT },
      ),
    );
    expect(stale[0]).toMatchObject({
      status: 409,
      body: { code: "template_version_stale" },
    });
    expectParity(stale);
    const bumped = { name: "第二版", template: { ...DRAFT, version: 2 } };
    const updated = await thrice((kind, index) =>
      ask(
        kind,
        "PUT",
        `${W}/templates/${ids[index]}`,
        "workflows.updateTemplate",
        { templateId: ids[index], ...bumped },
        bumped,
      ),
    );
    expect(updated[0].body).toMatchObject({
      template: { name: "第二版", version: 2 },
      frozenSchedules: [],
    });
    expectParity(updated, VOLATILE);
  });

  it("deleteTemplate：成功答 204（procedure 恒为 200、无体），之后是 404", async () => {
    const ids = [await template(), await template(), await template()];
    const answers = await thrice((kind, index) =>
      ask(
        kind,
        "DELETE",
        `${W}/templates/${ids[index]}`,
        "workflows.deleteTemplate",
        { templateId: ids[index] },
      ),
    );
    expect(answers[0].status).toBe(204);
    expect(answers[1].status).toBe(204);
    expect(answers[2].status).toBe(200);
    expect(answers[2].body).toBeUndefined();
    const gone = [
      await table("DELETE", `${W}/templates/${ids[0]}`),
      await legacy("DELETE", `${W}/templates/${ids[0]}`),
      await procedure("workflows.deleteTemplate", { templateId: ids[0] }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });

  it("upgradeSchedules：没有自动化域、计划标识不合格被拒；工作空间两种拼法都到得了桥", async () => {
    const id = await template();
    const path = `${W}/templates/${id}/upgrade-schedules?workspaceId=ws`;
    // 没有自动化域。
    const none = [
      await table("POST", path, { scheduleIds: ["a"] }),
      await legacy("POST", path, { scheduleIds: ["a"] }),
      await procedure("workflows.upgradeSchedules", {
        templateId: id,
        workspaceId: "ws",
        scheduleIds: ["a"],
      }),
    ] as const;
    expect(none[0]).toMatchObject({
      status: 501,
      body: { code: "unsupported" },
    });
    expectParity(none);
    // 装一座记录入参的桥。
    const seen: { workspaceId: string; ids: readonly string[] }[] = [];
    const bridge: WorkflowScheduleBridge = {
      frozen: () => [],
      upgrade: async (_request, workspace, _template, ids) => {
        seen.push({ workspaceId: workspace, ids });
        return { upgraded: [{ scheduleId: "a", revision: 3 }], frozen: [] };
      },
    };
    setWorkflowScheduleBridge(bridge);
    try {
      const answers = [
        await table("POST", path, { scheduleIds: ["a"] }),
        await legacy("POST", path, { scheduleIds: ["a"] }),
        await procedure("workflows.upgradeSchedules", {
          templateId: id,
          workspaceId: "ws",
          scheduleIds: ["a"],
        }),
      ] as const;
      expect(answers[0].body).toEqual({
        upgraded: [{ scheduleId: "a", revision: 3 }],
        frozen: [],
      });
      expectParity(answers);
      expect(seen.map((entry) => entry.workspaceId)).toEqual([
        "ws",
        "ws",
        "ws",
      ]);
      // 标识不合格（空表、太多、空串）由域拒绝，码与原话一样。
      for (const scheduleIds of [[], Array(201).fill("x"), [""]]) {
        const refused = [
          await table("POST", path, { scheduleIds }),
          await legacy("POST", path, { scheduleIds }),
          await procedure("workflows.upgradeSchedules", {
            templateId: id,
            workspaceId: "ws",
            scheduleIds,
          }),
        ] as const;
        expect(refused[0].status).toBe(400);
        expectParity(refused);
      }
      // 模板不在：404，桥一次都没被叫到。
      const before = seen.length;
      const missing = `${W}/templates/nope/upgrade-schedules?workspaceId=ws`;
      const gone = [
        await table("POST", missing, { scheduleIds: ["a"] }),
        await legacy("POST", missing, { scheduleIds: ["a"] }),
        await procedure("workflows.upgradeSchedules", {
          templateId: "nope",
          workspaceId: "ws",
          scheduleIds: ["a"],
        }),
      ] as const;
      expect(gone[0].status).toBe(404);
      expectParity(gone);
      expect(seen.length).toBe(before);
    } finally {
      setWorkflowScheduleBridge(undefined);
    }
  });
});

/* ------------------------------ §43.2 运行 ------------------------------ */

describe("运行与关卡", () => {
  it("startRun、run、runs：起跑旧路径答 201，读与列表三者相等", async () => {
    const id = await template();
    const started = await thrice((kind) =>
      ask(
        kind,
        "POST",
        `${W}/runs`,
        "workflows.startRun",
        { templateId: id, params: { scope: "src" }, boardId },
        { templateId: id, params: { scope: "src" }, boardId },
      ),
    );
    expect(started[0].status).toBe(201);
    expect(started[1].status).toBe(201);
    expect(started[2].status).toBe(200);
    const text = (answer: Answer) =>
      canonicalJson(stable(answer.body, VOLATILE));
    expect(text(started[1])).toBe(text(started[0]));
    expect(text(started[2])).toBe(text(started[0]));
    expect(started[0].body).toMatchObject({
      run: { status: "waiting", title: "一步加关卡", params: { scope: "src" } },
    });
    const runId = (started[2].body as { run: { id: string } }).run.id;
    const one = [
      await table("GET", `${W}/runs/${runId}`),
      await legacy("GET", `${W}/runs/${runId}`),
      await procedure("workflows.run", { runId }),
    ] as const;
    expectParity(one);
    for (const [query, input] of [
      [`templateId=${id}`, { templateId: id }],
      [`boardId=${boardId}&limit=2`, { boardId, limit: 2 }],
      [`boardId=${boardId}&limit=2`, { boardId, limit: "2" }],
    ] as const) {
      const list = [
        await table("GET", `${W}/runs?${query}`),
        await legacy("GET", `${W}/runs?${query}`),
        await procedure("workflows.runs", input),
      ] as const;
      expect(list[0].status).toBe(200);
      expectParity(list);
    }
  });

  it("startRun、run：缺模板、不存在的模板与运行被拒，码与原话一样", async () => {
    const cases: readonly [string, string, string, Record<string, unknown>][] =
      [
        ["POST", `${W}/runs`, "workflows.startRun", {}],
        ["POST", `${W}/runs`, "workflows.startRun", { templateId: "missing" }],
        ["GET", `${W}/runs/nope`, "workflows.run", { runId: "nope" }],
      ];
    for (const [method, path, name, input] of cases) {
      const body = method === "GET" ? undefined : input;
      const answers = [
        await table(method, path, body),
        await legacy(method, path, body),
        await procedure(name, input),
      ] as const;
      expect(answers[0].status, name).toBeGreaterThanOrEqual(400);
      expectParity(answers);
    }
  });

  it("answerGate：放行后第二步开跑；再答是 409，决定不认识是 400", async () => {
    const id = await template();
    const runs = [await startRun(id), await startRun(id), await startRun(id)];
    const answers = await thrice((kind, index) =>
      ask(
        kind,
        "POST",
        `${W}/runs/${runs[index]}/gates/s1`,
        "workflows.answerGate",
        { runId: runs[index], stepId: "s1", decision: "approve" },
        { decision: "approve" },
      ),
    );
    expect(answers[0].body).toMatchObject({
      run: {
        steps: [
          { stepId: "s1", status: "done", decision: "approve" },
          { stepId: "s2", status: "running" },
        ],
      },
    });
    expectParity(answers, VOLATILE);
    const second = [
      await table("POST", `${W}/runs/${runs[0]}/gates/s1`, {
        decision: "approve",
      }),
      await legacy("POST", `${W}/runs/${runs[0]}/gates/s1`, {
        decision: "approve",
      }),
      await procedure("workflows.answerGate", {
        runId: runs[0],
        stepId: "s1",
        decision: "approve",
      }),
    ] as const;
    expect(second[0].status).toBeGreaterThanOrEqual(400);
    expectParity(second);
    const fresh = await startRun(id);
    const odd = [
      await table("POST", `${W}/runs/${fresh}/gates/s1`, {}),
      await legacy("POST", `${W}/runs/${fresh}/gates/s1`, {}),
      await procedure("workflows.answerGate", { runId: fresh, stepId: "s1" }),
    ] as const;
    expect(odd[0].status).toBe(400);
    expectParity(odd);
  });

  it("cancelRun：取消；再取消仍答那次运行或 409，三者一致", async () => {
    const id = await template();
    const runs = [await startRun(id), await startRun(id), await startRun(id)];
    const answers = await thrice((kind, index) =>
      ask(
        kind,
        "POST",
        `${W}/runs/${runs[index]}/cancel`,
        "workflows.cancelRun",
        { runId: runs[index] },
        {},
      ),
    );
    expect(answers[0].body).toMatchObject({ run: { status: "cancelled" } });
    expectParity(answers, VOLATILE);
    const again = [
      await table("POST", `${W}/runs/${runs[0]}/cancel`, {}),
      await legacy("POST", `${W}/runs/${runs[0]}/cancel`, {}),
      await procedure("workflows.cancelRun", { runId: runs[0] }),
    ] as const;
    expectParity(again, VOLATILE);
    const gone = [
      await table("POST", `${W}/runs/nope/cancel`, {}),
      await legacy("POST", `${W}/runs/nope/cancel`, {}),
      await procedure("workflows.cancelRun", { runId: "nope" }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });
});

/* ------------------------------ §43.3 协调者任务 ------------------------------ */

describe("协调者任务", () => {
  it("tasks：一块画板上的任务，不带任务正文；缺 boardId 是 400", async () => {
    const { taskId } = seedTask("审查 src/x");
    finishTask(f.database, taskId, "failed", { reason: "turnFailed" }, 5_000);
    const answers = [
      await table("GET", `${W}/tasks?boardId=${boardId}`),
      await legacy("GET", `${W}/tasks?boardId=${boardId}`),
      await procedure("coordinator.tasks", { boardId }),
    ] as const;
    expect(answers[0].status).toBe(200);
    expect(JSON.stringify(answers[0].body)).not.toContain("审查 src/x");
    expect(
      (answers[0].body as { tasks: { taskId: string }[] }).tasks.map(
        (row) => row.taskId,
      ),
    ).toContain(taskId);
    expectParity(answers);
    const missing = [
      await table("GET", `${W}/tasks`),
      await legacy("GET", `${W}/tasks`),
      await procedure("coordinator.tasks", {}),
    ] as const;
    expect(missing[0]).toMatchObject({
      status: 400,
      body: { code: "bad_request" },
    });
    expectParity(missing);
  });

  it("retry：失败的任务重投一次，没失败、没正文、不存在、成员没了各按原话拒绝", async () => {
    const seeds = [seedTask(), seedTask(), seedTask()];
    for (const one of seeds) {
      finishTask(f.database, one.taskId, "failed", { reason: "x" }, 5_000);
    }
    const answers = await thrice((kind, index) =>
      ask(
        kind,
        "POST",
        `${W}/tasks/${encodeURIComponent(seeds[index]!.taskId)}/retry`,
        "coordinator.retry",
        { taskId: seeds[index]!.taskId },
        {},
      ),
    );
    expect(answers[0].body).toMatchObject({
      task: { status: "running", retryable: false },
    });
    expectParity(answers, VOLATILE);

    const running = seedTask();
    const bare = seedTask(null);
    finishTask(f.database, bare.taskId, "failed", null, 5_000);
    const gone = seedTask();
    finishTask(f.database, gone.taskId, "failed", null, 5_000);
    f.database.prepare("DELETE FROM nodes WHERE id = ?").run(gone.member);
    for (const taskId of [running.taskId, bare.taskId, "nope", gone.taskId]) {
      const path = `${W}/tasks/${encodeURIComponent(taskId)}/retry`;
      const refused = [
        await table("POST", path, {}),
        await legacy("POST", path, {}),
        await procedure("coordinator.retry", { taskId }),
      ] as const;
      expect(
        refused[0].status,
        `${taskId} ${JSON.stringify(refused[0].body)}`,
      ).toBeGreaterThanOrEqual(400);
      expectParity(refused, VOLATILE);
    }
  });
});

/* -------------------------------- 投递门 --------------------------------- */

const GRANTS: Record<string, Record<"w1" | "w2", ShareRole | undefined>> = {
  driver: { w1: "driver", w2: undefined },
  operator: { w1: "operator", w2: undefined },
  editor: { w1: "editor", w2: undefined },
  viewer: { w1: "viewer", w2: undefined },
  outsider: { w1: undefined, w2: "driver" },
  stranger: { w1: undefined, w2: undefined },
};

function subject(name: string): AuthorizationSubject {
  return {
    principalId: name,
    kind: "member",
    scopes: [scope("identity:read")],
  };
}

function granted(principalId: string): Scope[] {
  const grants = GRANTS[principalId];
  if (grants === undefined) return [];
  const out: Scope[] = [];
  if (grants.w1 !== undefined) out.push(...roleScopes(grants.w1, workspaceId));
  if (grants.w2 !== undefined) {
    out.push(...roleScopes(grants.w2, otherWorkspaceId));
  }
  return out;
}

describe("投递门：成员经旧路径与 procedure 被同一道路由门拦下", () => {
  beforeAll(() => {
    installRouteGuard(
      createRouteGuard({
        database: f.database,
        permits: (who, required) =>
          permits([...who.scopes, ...granted(who.principalId)], required),
        effectiveScopes: (who) => [...who.scopes, ...granted(who.principalId)],
      }),
    );
  });
  afterAll(() => resetRouteGuard());

  const FORBIDDEN = { code: "forbidden", message: "没有这项权限" };

  /** 旧路径与 procedure 对同一个成员答同一个码、状态与原话。 */
  async function both(
    as: string,
    method: string,
    path: string,
    body: unknown,
    name: string,
    input: unknown,
  ): Promise<[Answer, Answer]> {
    const rest = await legacy(method, path, body, as);
    const rpc = await procedure(name, input, as);
    expect(rpc.status, `${as} ${name}`).toBe(
      rest.status >= 400 ? rest.status : 200,
    );
    if (rest.status >= 400) {
      expect(rpc.body, `${as} ${name}`).toEqual(rest.body);
    }
    return [rest, rpc];
  }

  it("读：同画布的 viewer 读得到草案、运行与任务；别的画布上的人与没有授权的人读不到", async () => {
    const draftId = await propose();
    const runId = await startRun(await template());
    const { taskId } = seedTask();
    const reads: readonly [string, string, Record<string, unknown>][] = [
      [`${W}/drafts?boardId=${boardId}`, "workflows.drafts", { boardId }],
      [`${W}/drafts/${draftId}`, "workflows.draft", { draftId }],
      [`${W}/runs?boardId=${boardId}`, "workflows.runs", { boardId }],
      [`${W}/runs/${runId}`, "workflows.run", { runId }],
      [`${W}/tasks?boardId=${boardId}`, "coordinator.tasks", { boardId }],
    ];
    for (const [path, name, input] of reads) {
      for (const [as, status] of [
        ["viewer", 200],
        ["driver", 200],
        ["outsider", 403],
        ["stranger", 403],
      ] as const) {
        const [rest, rpc] = await both(as, "GET", path, undefined, name, input);
        expect(rest.status, `${as} ${name}`).toBe(status);
        expect(rpc.status, `${as} ${name}`).toBe(status === 200 ? 200 : 403);
        if (status === 403) expect(rest.body).toEqual(FORBIDDEN);
      }
    }
    expect(taskId).toBeTruthy();
  });

  it("读：不带 boardId 的列表对成员一律不放（procedure 也一样）", async () => {
    for (const [path, name] of [
      [`${W}/drafts`, "workflows.drafts"],
      [`${W}/runs`, "workflows.runs"],
      [`${W}/tasks`, "coordinator.tasks"],
    ] as const) {
      const [rest] = await both("driver", "GET", path, undefined, name, {});
      expect(rest.status, name).toBe(403);
    }
  });

  it("草案：viewer、editor 与别的画布上的人确认、丢弃不了，草案仍待确认；operator 可以", async () => {
    const draftId = await propose();
    for (const as of ["viewer", "editor", "outsider", "stranger"]) {
      const [confirm] = await both(
        as,
        "POST",
        `${W}/drafts/${draftId}/confirm`,
        {},
        "workflows.confirmDraft",
        { draftId },
      );
      expect(confirm.status, as).toBe(403);
      expect(confirm.body).toEqual(FORBIDDEN);
      const [discard] = await both(
        as,
        "POST",
        `${W}/drafts/${draftId}/discard`,
        {},
        "workflows.discardDraft",
        { draftId },
      );
      expect(discard.status, as).toBe(403);
    }
    const row = f.database
      .prepare("SELECT status FROM workflow_drafts WHERE id = ?")
      .get(draftId) as { status: string };
    expect(row.status).toBe("pending");
    const ok = await procedure(
      "workflows.confirmDraft",
      { draftId },
      "operator",
    );
    expect(ok.status).toBe(200);
  });

  it("模板：读要在某块画布上能起 Agent；写只有 owner，operator 与 driver 也不行", async () => {
    const id = await template();
    for (const [as, status] of [
      ["viewer", 403],
      ["editor", 403],
      ["operator", 200],
      ["stranger", 403],
    ] as const) {
      const [rest] = await both(
        as,
        "GET",
        `${W}/templates`,
        undefined,
        "workflows.templates",
        {},
      );
      expect(rest.status, as).toBe(status);
    }
    const writes: readonly [string, string, string, Record<string, unknown>][] =
      [
        [
          "POST",
          `${W}/templates`,
          "workflows.createTemplate",
          { template: DRAFT },
        ],
        [
          "PUT",
          `${W}/templates/${id}`,
          "workflows.updateTemplate",
          { templateId: id, template: { ...DRAFT, version: 9 } },
        ],
        [
          "DELETE",
          `${W}/templates/${id}`,
          "workflows.deleteTemplate",
          { templateId: id },
        ],
        [
          "POST",
          `${W}/templates/${id}/upgrade-schedules`,
          "workflows.upgradeSchedules",
          { templateId: id, scheduleIds: ["a"] },
        ],
      ];
    for (const as of ["operator", "driver"]) {
      for (const [method, path, name, input] of writes) {
        const { templateId: _t, ...body } = input;
        const [rest] = await both(as, method, path, body, name, input);
        expect(rest.status, `${as} ${name}`).toBe(403);
        expect(rest.body).toEqual(FORBIDDEN);
      }
    }
    // 拦在门上：模板没被改，也没被删。
    const row = f.database
      .prepare("SELECT version FROM workflow_templates WHERE id = ?")
      .get(id) as { version: number } | undefined;
    expect(row?.version).toBe(1);
  });

  it("起跑：operator 在自己这块画布上可以；拿别的画布的画板起跑、只读的人起跑被拒，一次运行也没多出来", async () => {
    const id = await template();
    const count = () =>
      (
        f.database.prepare("SELECT count(*) AS n FROM workflow_runs").get() as {
          n: number;
        }
      ).n;
    const before = count();
    const cases: readonly [string, string][] = [
      ["viewer", boardId],
      ["editor", boardId],
      ["outsider", boardId],
      ["operator", otherBoardId],
      ["driver", otherBoardId],
    ];
    for (const [as, board] of cases) {
      const body = { templateId: id, params: { scope: "src" }, boardId: board };
      const [rest] = await both(
        as,
        "POST",
        `${W}/runs`,
        body,
        "workflows.startRun",
        body,
      );
      expect(rest.status, `${as} ${board}`).toBe(403);
      expect(rest.body).toEqual(FORBIDDEN);
    }
    expect(count()).toBe(before);
    const ok = await procedure(
      "workflows.startRun",
      { templateId: id, params: { scope: "src" }, boardId },
      "operator",
    );
    expect(ok.status).toBe(200);
  });

  it("关卡与取消：是 operator（agent:launch），不是 approval:answer；viewer、editor、别的画布上的人答不了，运行仍在等", async () => {
    // 契约与路由表两处一致：关卡答复不是替 Agent 代答。
    const gate = contractEntries().find(
      (entry) => entry.name === "workflows.answerGate",
    );
    expect(gate?.meta.scope).toBe(GATE_SCOPE);
    expect(gate?.meta.scope).not.toBe("approval:answer");
    expect(
      routeScope("POST", `${W}/runs/{runId}/gates/{stepId}`)?.permission,
    ).toBe(GATE_SCOPE);

    const id = await template();
    const runId = await startRun(id);
    for (const as of ["viewer", "editor", "outsider", "stranger"]) {
      const body = { decision: "approve" };
      const [answer] = await both(
        as,
        "POST",
        `${W}/runs/${runId}/gates/s1`,
        body,
        "workflows.answerGate",
        { runId, stepId: "s1", ...body },
      );
      expect(answer.status, as).toBe(403);
      expect(answer.body).toEqual(FORBIDDEN);
      const [cancel] = await both(
        as,
        "POST",
        `${W}/runs/${runId}/cancel`,
        {},
        "workflows.cancelRun",
        { runId },
      );
      expect(cancel.status, as).toBe(403);
    }
    const waiting = f.database
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(waiting.status).toBe("waiting");
    // operator 答得了（它没有 approval:answer，也不需要）。
    const ok = await procedure(
      "workflows.answerGate",
      { runId, stepId: "s1", decision: "approve" },
      "operator",
    );
    expect(ok.status).toBe(200);
  });

  it("任务：重试要 operator；只读与别的画布上的人重试不了，任务仍是失败", async () => {
    const { taskId } = seedTask();
    finishTask(f.database, taskId, "failed", { reason: "x" }, 5_000);
    const path = `${W}/tasks/${encodeURIComponent(taskId)}/retry`;
    for (const as of ["viewer", "editor", "outsider", "stranger"]) {
      const [rest] = await both(as, "POST", path, {}, "coordinator.retry", {
        taskId,
      });
      expect(rest.status, as).toBe(403);
      expect(rest.body).toEqual(FORBIDDEN);
    }
    const row = f.database
      .prepare("SELECT status FROM workflow_task_runs WHERE task_id = ?")
      .get(taskId) as { status: string };
    expect(row.status).toBe("failed");
    const ok = await procedure("coordinator.retry", { taskId }, "operator");
    expect(ok.status).toBe(200);
  });
});

/* ------------------------------ 入参形状错 ------------------------------ */

describe("入参形状错：procedure 与旧路径由契约先答 bad_request", () => {
  it("类型不对：码与状态与原 handler 一致，procedure 带 issues", async () => {
    const id = await template();
    const draftId = await propose();
    const cases: readonly [string, string, unknown, string, unknown][] = [
      [
        "POST",
        `${W}/drafts/${draftId}/confirm`,
        { name: 5 },
        "workflows.confirmDraft",
        { draftId, name: 5 },
      ],
      [
        "POST",
        `${W}/templates/${id}/upgrade-schedules`,
        { scheduleIds: "a" },
        "workflows.upgradeSchedules",
        { templateId: id, scheduleIds: "a" },
      ],
      [
        "POST",
        `${W}/runs`,
        { templateId: 5 },
        "workflows.startRun",
        { templateId: 5 },
      ],
    ];
    for (const [method, path, body, name, input] of cases) {
      const old = await table(method, path, body);
      const rest = await legacy(method, path, body);
      const rpc = await procedure(name, input);
      for (const answer of [old, rest, rpc]) {
        expect(answer.status, name).toBe(400);
        expect(answer.body, name).toMatchObject({ code: "bad_request" });
      }
      const detail = (rpc.body as { details?: { issues?: unknown[] } }).details;
      expect(detail?.issues?.length, name).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------- 两张表 ------------------------------- */

describe("契约与 core 的两张表（workflows、coordinator）", () => {
  const entries = contractEntries().filter(
    (entry) =>
      entry.name.startsWith("workflows.") ||
      entry.name.startsWith("coordinator."),
  );

  it("15 + 2 条都在契约里，每条都有旧路径", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      [
        "workflows.answerGate",
        "workflows.cancelRun",
        "workflows.confirmDraft",
        "workflows.createTemplate",
        "workflows.deleteTemplate",
        "workflows.discardDraft",
        "workflows.draft",
        "workflows.drafts",
        "workflows.run",
        "workflows.runs",
        "workflows.startRun",
        "workflows.template",
        "workflows.templates",
        "workflows.updateTemplate",
        "workflows.upgradeSchedules",
        "coordinator.retry",
        "coordinator.tasks",
      ].sort(),
    );
    for (const entry of entries) {
      expect(entry.meta.legacy, entry.name).toBeDefined();
    }
  });

  it("meta.scope 与路由表给旧路径的要求一致；旧路径都在路由表里并有人认领", () => {
    for (const entry of entries) {
      const legacyRoute = entry.meta.legacy!;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = f.server.router.match(legacyRoute.path);
      expect(found?.entry.methods ?? []).toContain(legacyRoute.method);
      expect(
        f.server.router.claimed(
          legacyRoute.method,
          found?.entry.path as string,
        ),
        entry.name,
      ).toBe(true);
    }
  });
});
