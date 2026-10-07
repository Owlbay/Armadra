import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coordinatorApi } from "@/coordinator/api";
import { workflowErrorKey, workflowsApi } from "@/workflow/api";
import { RuntimeRequestError } from "./request";
import { type Source, localSource, setCurrentSourceResolver } from "./source";

/**
 * workflows 与 coordinator 两个域的页面一侧（契约 §43.2、§43.3）：都发
 * `POST /api/rpc/<域>/<动词>`，体是 `{ json: { … } }`，答案过页面自己的 schema。
 * 分派抽屉的读与重试发往事件所属的源，其余发往当前源。
 */

const timestamp = "2026-10-06T00:00:00.000Z";
const boardId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const workspaceId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";

const body = {
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

const draftRow = {
  id: "d1",
  workspaceId,
  boardId,
  proposerNodeId: null,
  status: "pending",
  templateId: null,
  draft: body,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const templateRow = {
  id: "t1",
  name: "审查流程",
  version: 1,
  createdFromDraft: "d1",
  template: body,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const runRow = {
  id: "r1",
  templateId: "t1",
  templateVersion: 1,
  title: "一步加关卡",
  workspaceId,
  boardId,
  frameId: null,
  params: { scope: "src" },
  status: "waiting",
  reason: null,
  roles: { worker: "n1" },
  startedAt: timestamp,
  endedAt: null,
  steps: [
    {
      stepId: "s1",
      kind: "gate",
      role: null,
      status: "waiting",
      nodeId: null,
      startedAt: timestamp,
      endedAt: null,
      reason: null,
      outputs: [],
      decision: null,
      note: null,
    },
  ],
};

const taskRow = {
  taskId: "sess:n2",
  coordinatorNodeId: "n1",
  runnerId: "codex",
  nodeId: "n2",
  status: "failed",
  startedAt: timestamp,
  endedAt: timestamp,
  reason: "turnFailed",
  retryable: true,
};

type Call = { url: string; init: RequestInit };
let calls: Call[];

function answer(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stub(respond: (call: Call) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        url: input instanceof Request ? input.url : String(input),
        init: init ?? {},
      };
      calls.push(call);
      return respond(call);
    }),
  );
}

const ok = (json: unknown) => stub(() => answer(200, { json }));
const sent = (index = 0): unknown =>
  JSON.parse(String(calls[index]?.init.body ?? "null"));
const procedure = (index = 0): string | undefined =>
  calls[index]?.url.split("/api/rpc/")[1];

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCurrentSourceResolver(null);
});

describe("workflows：草案与模板", () => {
  it("草案列表只带给了的过滤条件，空串当没给", async () => {
    ok({ drafts: [draftRow] });
    const drafts = await workflowsApi.drafts({
      boardId,
      status: "",
    });
    expect(procedure()).toBe("workflows/drafts");
    expect(sent()).toEqual({ json: { boardId } });
    expect(drafts[0]).toMatchObject({ id: "d1", status: "pending" });
  });

  it("确认草案带名字与正文，答案里的正文再过页面的草案 schema", async () => {
    ok({
      draft: { ...draftRow, status: "confirmed", templateId: "t1" },
      template: templateRow,
    });
    const confirmed = await workflowsApi.confirmDraft("d1", {
      name: "审查流程",
    });
    expect(procedure()).toBe("workflows/confirmDraft");
    expect(sent()).toEqual({ json: { draftId: "d1", name: "审查流程" } });
    expect(confirmed.template.template.roles[0]?.agentId).toBe("codex");
    // 正文不合格（核心答了一份页面认不得的）在页面这一层炸，而不是渲染时。
    ok({
      draft: draftRow,
      template: { ...templateRow, template: { version: 1 } },
    });
    await expect(workflowsApi.confirmDraft("d1", {})).rejects.toThrow();
  });

  it("丢弃草案、列模板、改模板、删模板各是一条 procedure", async () => {
    ok({ draft: { ...draftRow, status: "discarded" } });
    await expect(workflowsApi.discardDraft("d1")).resolves.toMatchObject({
      status: "discarded",
    });
    ok({ templates: [templateRow] });
    await workflowsApi.templates();
    ok({ template: { ...templateRow, version: 2 } });
    const updated = await workflowsApi.updateTemplate("t1", {
      name: "第二版",
      template: { ...body, version: 2 } as never,
    });
    expect(updated.frozenSchedules).toEqual([]);
    ok(undefined);
    await workflowsApi.deleteTemplate("t1");
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "workflows/discardDraft",
      "workflows/templates",
      "workflows/updateTemplate",
      "workflows/deleteTemplate",
    ]);
    expect(sent(2)).toMatchObject({
      json: { templateId: "t1", name: "第二版" },
    });
    expect(sent(3)).toEqual({ json: { templateId: "t1" } });
  });

  it("升级计划把工作空间放进入参，而不是查询串", async () => {
    ok({
      upgraded: [{ scheduleId: "a", revision: 3 }],
      frozen: [],
    });
    const result = await workflowsApi.upgradeSchedules("t1", workspaceId, [
      "a",
    ]);
    expect(procedure()).toBe("workflows/upgradeSchedules");
    expect(sent()).toEqual({
      json: { templateId: "t1", workspaceId, scheduleIds: ["a"] },
    });
    expect(calls[0]?.url).not.toContain("?");
    expect(result.upgraded).toEqual([{ scheduleId: "a", revision: 3 }]);
  });
});

describe("workflows：运行与关卡", () => {
  it("起跑、取消、答关卡都答一次运行；列表按模板与画板过滤", async () => {
    ok({ run: runRow });
    const run = await workflowsApi.startRun({
      templateId: "t1",
      params: { scope: "src" },
      boardId,
    });
    expect(run).toMatchObject({ id: "r1", status: "waiting" });
    await workflowsApi.answerGate("r1", "s1", {
      decision: "approve",
      note: "好",
    });
    await workflowsApi.cancelRun("r1");
    ok({ runs: [runRow] });
    await workflowsApi.runs({ templateId: "t1", limit: 5 });
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "workflows/startRun",
      "workflows/answerGate",
      "workflows/cancelRun",
      "workflows/runs",
    ]);
    expect(sent(0)).toEqual({
      json: { templateId: "t1", params: { scope: "src" }, boardId },
    });
    expect(sent(1)).toEqual({
      json: { runId: "r1", stepId: "s1", decision: "approve", note: "好" },
    });
    expect(sent(3)).toEqual({ json: { templateId: "t1", limit: 5 } });
  });

  it("被拒的码照旧换成界面文案键：认得的专门一句，其余「没有成功」", async () => {
    stub(() =>
      answer(409, {
        code: "gate_not_waiting",
        message: "不在等",
        requestId: "r",
      }),
    );
    const failure = await workflowsApi
      .answerGate("r1", "s1", { decision: "approve" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeRequestError);
    expect(workflowErrorKey(failure)).toBe("workflow.error.gate_not_waiting");
    stub(() =>
      answer(403, {
        code: "forbidden",
        message: "没有这项权限",
        requestId: "r",
      }),
    );
    const refused = await workflowsApi
      .cancelRun("r1")
      .catch((error: unknown) => error);
    expect(workflowErrorKey(refused)).toBe("workflow.error.forbidden");
    stub(() =>
      answer(409, { code: "elsewhere", message: "x", requestId: "r" }),
    );
    const other = await workflowsApi
      .cancelRun("r1")
      .catch((error: unknown) => error);
    expect(workflowErrorKey(other)).toBe("workflow.error.generic");
  });
});

describe("coordinator：分派抽屉", () => {
  it("任务列表按画板读，重试按任务；缺省发往此刻的源", async () => {
    ok({ tasks: [taskRow] });
    const tasks = await coordinatorApi.tasks(boardId);
    expect(procedure()).toBe("coordinator/tasks");
    expect(sent()).toEqual({ json: { boardId } });
    expect(tasks[0]).toMatchObject({ taskId: "sess:n2", retryable: true });
    ok({ task: { ...taskRow, status: "running", retryable: false } });
    await expect(coordinatorApi.retry("sess:n2")).resolves.toMatchObject({
      status: "running",
    });
    expect(procedure(1)).toBe("coordinator/retry");
    expect(sent(1)).toEqual({ json: { taskId: "sess:n2" } });
    expect(calls[0]?.url.startsWith(localSource.httpBase)).toBe(true);
  });

  it("带了源就发往那个源", async () => {
    ok({ tasks: [] });
    const remote: Source = {
      ...localSource,
      sourceId: "remote",
      httpBase: "https://remote.example",
    };
    await coordinatorApi.tasks(boardId, remote);
    await coordinatorApi.retry("sess:n2", remote).catch(() => undefined);
    expect(calls[0]?.url).toBe(
      "https://remote.example/api/rpc/coordinator/tasks",
    );
    expect(calls[1]?.url).toBe(
      "https://remote.example/api/rpc/coordinator/retry",
    );
  });

  it("读到的行不带任务正文，也不被页面 schema 补出正文", async () => {
    ok({ tasks: [taskRow] });
    const tasks = await coordinatorApi.tasks(boardId);
    expect(JSON.stringify(tasks)).not.toContain("prompt");
  });
});
