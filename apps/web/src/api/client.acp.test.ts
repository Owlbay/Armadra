import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acpApi } from "@/acp/api";
import { RuntimeRequestError } from "./request";
import { setCurrentSourceResolver } from "./source";

/**
 * acp 域的页面一侧（契约 §43.1）：都发 `POST /api/rpc/acp/<动词>`，体是
 * `{ json: { … } }`，答案过页面自己的 schema；审批与 elicitation 的答复发
 * `agents.answerApproval`（人替 Agent 回答的那一条，§39.3）。
 */

const timestamp = "2026-10-06T00:00:00.000Z";
const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const nodeId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";
const sessionId = "019ff7d1-ab76-728d-be18-3acfd6181af8";

const row = {
  id: sessionId,
  workspaceId,
  sessionKey: "k",
  backend: "acp",
  generation: 1,
  cwd: "/tmp/one",
  shell: "/bin/zsh",
  command: null,
  status: "running",
  exitCode: null,
  createdAt: timestamp,
  endedAt: null,
};

type Call = { url: string; init: RequestInit };
let calls: Call[];

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
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

describe("acp：会话经 procedure", () => {
  it("起会话发 acp.createSession，体是页面校过的那份，答的是终端会话行", async () => {
    ok(row);
    const session = await acpApi.createSession({
      workspaceId,
      nodeId,
      cwd: "/tmp/one",
      agentId: "claude",
      prompt: "hi",
    });
    expect(procedure()).toBe("acp/createSession");
    expect(sent()).toEqual({
      json: {
        workspaceId,
        nodeId,
        cwd: "/tmp/one",
        agentId: "claude",
        prompt: "hi",
      },
    });
    expect(session).toMatchObject({ id: sessionId, backend: "acp" });
  });

  it("读镜像带 after（数字），答案过页面 schema，多出来的字段原样带回", async () => {
    ok({
      entries: [
        {
          role: "user",
          blocks: [{ type: "text", text: "hi" }],
          endOffset: 12,
        },
      ],
      endOffset: 12,
      modes: { currentModeId: "default", availableModes: [] },
      models: null,
      pending: [],
      extra: 1,
    });
    const log = await acpApi.log(sessionId, 7);
    expect(procedure()).toBe("acp/log");
    expect(sent()).toEqual({ json: { sessionId, after: 7 } });
    expect(log.entries[0]?.blocks[0]).toMatchObject({ text: "hi" });
    expect(log.endOffset).toBe(12);
    expect(log.models).toBeNull();
  });

  it("发提示、打断、切模式与模型、切换驱动各是一条 procedure", async () => {
    ok({ turnId: "t1" });
    await expect(acpApi.prompt(sessionId, "ping")).resolves.toMatchObject({
      turnId: "t1",
    });
    ok(undefined);
    await acpApi.cancel(sessionId);
    await acpApi.setMode(sessionId, "plan");
    await acpApi.setModel(sessionId, "m1");
    ok({ sessionId, resumed: false });
    await expect(acpApi.switchDriver(nodeId, "terminal")).resolves.toEqual({
      sessionId,
      resumed: false,
    });
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "acp/prompt",
      "acp/cancel",
      "acp/setMode",
      "acp/setModel",
      "acp/switchDriver",
    ]);
    expect(sent(0)).toEqual({ json: { sessionId, text: "ping" } });
    expect(sent(2)).toEqual({ json: { sessionId, modeId: "plan" } });
    expect(sent(3)).toEqual({ json: { sessionId, modelId: "m1" } });
    expect(sent(4)).toEqual({ json: { nodeId, driver: "terminal" } });
  });

  it("空提示在页面这一层就拦下，不发请求", async () => {
    ok({ turnId: "t1" });
    await expect(acpApi.prompt(sessionId, "")).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("审批卡片与 elicitation 的答复发 agents.answerApproval，只带人的决定", async () => {
    ok({
      id: "p1",
      nodeId,
      answer: "allow",
      answeredAt: timestamp,
      revision: 2,
      route: "acp",
    });
    await expect(acpApi.answer("p1", "allow", "opt-1")).resolves.toMatchObject({
      id: "p1",
      route: "acp",
    });
    expect(procedure()).toBe("agents/answerApproval");
    expect(sent()).toEqual({
      json: { pendingId: "p1", decision: "allow", optionId: "opt-1" },
    });
    await acpApi.answerElicitation("p2", { action: "decline" });
    expect(procedure(1)).toBe("agents/answerApproval");
    expect(sent(1)).toEqual({
      json: { pendingId: "p2", elicitation: { action: "decline" } },
    });
  });

  it("被路由门拦下是 403 forbidden，抛的还是 RuntimeRequestError", async () => {
    stub(() =>
      answer(403, {
        code: "forbidden",
        message: "没有这项权限",
        requestId: "r",
      }),
    );
    const failure = await acpApi
      .prompt(sessionId, "x")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeRequestError);
    expect((failure as RuntimeRequestError).code).toBe("forbidden");
    expect((failure as RuntimeRequestError).status).toBe(403);
  });

  it("ACP 自己的拒绝码带着原样的状态与码", async () => {
    stub(() =>
      answer(409, {
        code: "acp_auth_required",
        message: "needs sign-in",
        requestId: "r",
      }),
    );
    const failure = await acpApi
      .createSession({
        workspaceId,
        nodeId,
        cwd: "/tmp/one",
        agentId: "claude",
      })
      .catch((error: unknown) => error);
    expect((failure as RuntimeRequestError).code).toBe("acp_auth_required");
    expect((failure as RuntimeRequestError).status).toBe(409);
  });
});

describe("acp：输出到画板与输入框的租约", () => {
  it("代码块发 files.exportText，来源节点是 exportId；文件名在页面这一层先校", async () => {
    ok({ path: "/w/.armadra/x.ts", relativePath: ".armadra/x.ts", bytes: 3 });
    await expect(
      acpApi.exportText(workspaceId, nodeId, "x.ts", "abc"),
    ).resolves.toEqual({
      path: "/w/.armadra/x.ts",
      relativePath: ".armadra/x.ts",
      bytes: 3,
    });
    expect(procedure()).toBe("files/exportText");
    expect(sent()).toEqual({
      json: { workspaceId, exportId: nodeId, name: "x.ts", content: "abc" },
    });
    await expect(
      acpApi.exportText(workspaceId, nodeId, "../x", "abc"),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("输入框的租约发 terminals.drive，答的是新的租约", async () => {
    ok({
      state: "humanTakeover",
      generation: 3,
      expiresAt: "",
      holder: { kind: "human", id: "device-1", displayName: "Mac" },
    });
    await expect(acpApi.drive(sessionId, "takeover")).resolves.toMatchObject({
      state: "humanTakeover",
      generation: 3,
    });
    expect(procedure()).toBe("terminals/drive");
    expect(sent()).toEqual({ json: { sessionId, action: "takeover" } });
  });
});
