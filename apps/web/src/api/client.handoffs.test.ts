import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeApi } from "./client";
import { RuntimeRequestError } from "./request";
import { setCurrentSourceResolver } from "./source";

/**
 * 对话交接的页面一侧（契约 §39.8）：都发 `POST /api/rpc/agents/<动词>`，体是
 * `{ json: { … } }`，答案过页面自己的 `handoffViewSchema`。
 */

const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const source = "019ff7d1-7419-74df-89e2-b1619d36ea7d";
const target = "019ff7d1-ab76-728d-be18-3acfd6181af8";
const session = "019ff7d1-ab76-728d-be18-3acfd6181af9";
const handoffId = "019ff7d1-ab76-728d-be18-3acfd6181afa";
const timestamp = "2026-10-06T00:00:00.000Z";

function identity(nodeId: string) {
  return {
    nodeId,
    nodeTitle: "Node",
    sessionId: session,
    generation: 1,
    agentId: "claude",
    provider: "claude",
    providerSessionId: null,
    modelId: null,
    accountId: null,
    executionHost: "local-runtime",
    workingDirectory: "/w",
  };
}

const view = {
  bundle: {
    version: 1,
    handoffId,
    workspaceId,
    createdAt: timestamp,
    source: identity(source),
    target: identity(target),
    cutoff: {
      kind: "unavailable",
      reference: null,
      sourceRevision: null,
      sha256: null,
      sourceUpdatedAt: null,
    },
    sections: {
      goal: "finish",
      constraints: "",
      completed: "",
      pending: "",
      decisions: "",
      toolSummary: "",
    },
    transcriptExcerpt: "",
    summaryMethod: "editableTemplateAndExcerpt",
    trust: "peerDataNotSystemInstructions",
    sourcePreserved: true,
    files: [],
    git: {
      headOid: null,
      indexDigest: null,
      worktreeDigest: null,
      repositoryId: null,
      worktreeId: null,
      status: "unavailable",
      worktreeDigestBasis: "statusSummary",
    },
    attachments: [],
    budget: {
      byteLimit: 8192,
      usedBytes: 100,
      tokenEstimate: null,
      capacityTokens: null,
      availableTokens: null,
      reservedTokens: null,
      truncated: false,
      omitted: [],
    },
  },
  digest: "d1",
  state: "prepared",
  mailboxId: null,
  traceId: null,
  errorCode: null,
  acceptedAt: null,
  updatedAt: timestamp,
  sourceHasNewActivity: false,
  attempts: 0,
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

describe("对话交接经 agents.* procedure", () => {
  it("冻结：体是页面校过、补齐缺省的那份", async () => {
    ok(view);
    const prepared = await runtimeApi.prepareHandoff(workspaceId, {
      sourceNodeId: source,
      sourceSessionId: session,
      sourceGeneration: 1,
      targetNodeId: target,
      targetSessionId: session,
      targetGeneration: 1,
      sections: {
        goal: "finish",
        constraints: "",
        completed: "",
        pending: "",
        decisions: "",
        toolSummary: "",
      },
      filePaths: [],
      byteBudget: 8192,
      includeTranscript: true,
    });
    expect(procedure()).toBe("agents/prepareHandoff");
    expect(sent()).toMatchObject({
      json: { workspaceId, sourceNodeId: source, byteBudget: 8192 },
    });
    expect(prepared.state).toBe("prepared");
  });

  it("读、批准、撤回、列出各是一条 procedure", async () => {
    ok(view);
    await runtimeApi.handoff(workspaceId, handoffId);
    await runtimeApi.acceptHandoff(workspaceId, handoffId, "d1");
    await runtimeApi.cancelHandoff(workspaceId, handoffId, "d2");
    ok([view]);
    await expect(
      runtimeApi.handoffs(workspaceId, source),
    ).resolves.toHaveLength(1);
    await runtimeApi.workspaceHandoffs(workspaceId);
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "agents/handoff",
      "agents/acceptHandoff",
      "agents/cancelHandoff",
      "agents/handoffs",
      "agents/handoffs",
    ]);
    expect(sent(0)).toEqual({ json: { workspaceId, handoffId } });
    expect(sent(1)).toEqual({
      json: { workspaceId, handoffId, expectedDigest: "d1" },
    });
    expect(sent(2)).toEqual({
      json: { workspaceId, handoffId, expectedDigest: "d2" },
    });
    expect(sent(3)).toEqual({ json: { workspaceId, sourceNodeId: source } });
    expect(sent(4)).toEqual({ json: { workspaceId } });
  });

  it("中止信号交给请求", async () => {
    ok([view]);
    const controller = new AbortController();
    await runtimeApi.workspaceHandoffs(workspaceId, controller.signal);
    expect(calls[0]?.init.signal).toBeDefined();
  });

  it("摘要变了是 409 conflict，抛的还是 RuntimeRequestError", async () => {
    stub(() =>
      answer(409, {
        code: "conflict",
        message: "Handoff preview digest changed",
        requestId: "r",
      }),
    );
    const failure = await runtimeApi
      .acceptHandoff(workspaceId, handoffId, "stale")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeRequestError);
    expect((failure as RuntimeRequestError).status).toBe(409);
    expect((failure as RuntimeRequestError).code).toBe("conflict");
  });
});
