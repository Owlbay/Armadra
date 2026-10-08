import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeApi } from "./client";
import { RuntimeRequestError } from "./request";
import { type Source, localSource, setCurrentSourceResolver } from "./source";

/**
 * agents 域的页面一侧（契约 §39）：都发 `POST /api/rpc/agents/<动词>`，体是
 * `{ json: { … } }`，答案过页面自己的 schema。缺省发往当前源；依赖等待带了
 * `source` 就发往那个源。白板导出与资源上传留在 REST，不经这里。
 */

const timestamp = "2026-08-13T00:00:00.000Z";
const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const nodeId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";
const otherId = "019ff7d1-ab76-728d-be18-3acfd6181af8";

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

/** 一份装好的集成状态（设计 agent-integration §5）。 */
function installed(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "claude",
    mode: "launch",
    hook: { installed: true, path: "/data/claude/settings.json", revision: 4 },
    skill: { installed: true, path: "/data/claude/SKILL.md", revision: 6 },
    legacy: { found: [] },
    revision: 406,
    installedRevision: 406,
    stale: false,
    launchArgs: ["--settings", "/data/claude/settings.json"],
    ...overrides,
  };
}

describe("目录与集成", () => {
  it("Agent 列表保留 resolvedPath 为 null 的未安装项", async () => {
    ok([
      {
        id: "codex",
        label: "Codex",
        color: "#10a37f",
        launchCmd: "codex",
        promptMode: "argv",
        capabilities: ["hooks"],
        resolvedPath: null,
        installed: false,
      },
    ]);
    const agents = await runtimeApi.agents();
    expect(procedure()).toBe("agents/list");
    expect(agents[0]).toMatchObject({ id: "codex", installed: false });
    expect(agents[0]?.resolvedPath).toBeNull();
  });

  it("读、装、卸、修各是一条 procedure，入参只有 agentId", async () => {
    ok(installed());
    const state = await runtimeApi.agentIntegration("claude");
    expect(state.hook.installed && state.skill.installed).toBe(true);
    await runtimeApi.installAgentIntegration("claude");
    await runtimeApi.uninstallAgentIntegration("claude");
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "agents/integration",
      "agents/installIntegration",
      "agents/uninstallIntegration",
    ]);
    expect(sent(1)).toEqual({ json: { agentId: "claude" } });

    calls = [];
    ok({
      agentId: "claude",
      found: [],
      removed: ["/home/u/.codex/hooks.json: version"],
      kept: ["/home/u/.codex/hooks.json: session_start → /opt/audit.sh"],
      backup: "/home/u/.codex/hooks.json.armadra-backup-20260913101500",
      backups: ["/home/u/.codex/hooks.json.armadra-backup-20260913101500"],
    });
    const report = await runtimeApi.repairAgentIntegration("claude");
    expect(procedure()).toBe("agents/repairIntegration");
    expect(report.kept[0]).toContain("/opt/audit.sh");
  });

  it("旧修订读出来就是 stale，旧残留原样带回来", async () => {
    ok(
      installed({
        installedRevision: 305,
        stale: true,
        legacy: {
          found: [
            {
              kind: "hook_entry",
              path: "/home/u/.claude/settings.json",
              detail: "/usr/local/bin/aicc-hook claude",
            },
          ],
        },
      }),
    );
    const state = await runtimeApi.agentIntegration("claude");
    expect(state.stale).toBe(true);
    expect(state.legacy.found[0]?.kind).toBe("hook_entry");
  });

  it("读集成状态时把中止信号交给请求", async () => {
    ok(installed());
    const controller = new AbortController();
    await runtimeApi.agentIntegration("claude", controller.signal);
    expect(calls[0]?.init.signal).toBeDefined();
  });

  it("ama 密钥：设的时候带供应商与值，答案只有状态", async () => {
    ok({ backend: "file", providers: [{ id: "openai", isSet: true }] });
    const status = await runtimeApi.setAmaCredential("openai", "sk-x");
    expect(procedure()).toBe("agents/setAmaCredential");
    expect(sent()).toEqual({ json: { provider: "openai", apiKey: "sk-x" } });
    expect(JSON.stringify(status)).not.toContain("sk-x");
  });
});

describe("节点状态与人的答复", () => {
  it("清未读标记调 agents.markRead", async () => {
    ok({
      nodeId,
      workspaceId,
      agentId: "claude",
      unread: false,
      verified: true,
      restored: false,
      updatedAt: timestamp,
    });
    const status = await runtimeApi.markAgentRead(nodeId);
    expect(procedure()).toBe("agents/markRead");
    expect(sent()).toEqual({ json: { nodeId } });
    expect(status.unread).toBe(false);
  });

  it("回答审批时只发 pendingId 与 decision，按 core 真正答的形状读", async () => {
    ok({
      id: "p1",
      nodeId: "node-1",
      workspaceId,
      request: { tool: "Bash" },
      answer: "allow",
      answeredBy: "user",
      createdAt: timestamp,
      answeredAt: timestamp,
      revision: 1,
      route: "file",
    });
    await expect(
      runtimeApi.answerApproval("p1", "allow"),
    ).resolves.toMatchObject({ id: "p1", answer: "allow", route: "file" });
    expect(procedure()).toBe("agents/answerApproval");
    expect(sent()).toEqual({ json: { pendingId: "p1", decision: "allow" } });
  });

  it("被路由门拦下是 403 forbidden，与旧路径同一种错误", async () => {
    stub(() =>
      answer(403, {
        code: "forbidden",
        message: "没有这项权限",
        requestId: "r",
      }),
    );
    const failure = await runtimeApi
      .answerApproval("p1", "deny")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeRequestError);
    expect((failure as RuntimeRequestError).code).toBe("forbidden");
  });

  it("关闭确认带 requestId 与 approve", async () => {
    ok({ requestId: "c1", approve: false, accepted: true });
    await runtimeApi.confirmControl("c1", false);
    expect(procedure()).toBe("agents/confirmControl");
    expect(sent()).toEqual({ json: { requestId: "c1", approve: false } });
  });
});

describe("投递、连线与依赖", () => {
  it("投递记录带 limit，排队带 node，两者是同一条 procedure", async () => {
    ok([]);
    await runtimeApi.deliveries(workspaceId);
    await runtimeApi.deliveryQueue(workspaceId, nodeId);
    expect(procedure(0)).toBe("agents/deliveries");
    expect(sent(0)).toEqual({ json: { workspaceId, limit: 200 } });
    expect(sent(1)).toEqual({ json: { workspaceId, node: nodeId } });
  });

  it("写上下文链接是整表替换", async () => {
    ok({ nodeId, links: [], updatedAt: timestamp });
    await runtimeApi.putContextLinks(workspaceId, nodeId, [
      { id: otherId, title: "构建", kind: "terminal", role: "sub" },
    ]);
    expect(procedure()).toBe("agents/putContextLinks");
    expect(sent()).toEqual({
      json: {
        workspaceId,
        nodeId,
        links: [{ id: otherId, title: "构建", kind: "terminal", role: "sub" }],
      },
    });
  });

  it("依赖等待带了源就发往那个源，缺省发往当前源", async () => {
    ok({ launches: [] });
    const remote: Source = {
      ...localSource,
      sourceId: "remote",
      httpBase: "https://remote.example",
    };
    await runtimeApi.dependencies(workspaceId, undefined, remote);
    await runtimeApi.dependencies(workspaceId);
    expect(calls[0]?.url).toBe(
      "https://remote.example/api/rpc/agents/dependencies",
    );
    expect(calls[1]?.url.startsWith(localSource.httpBase)).toBe(true);
  });
});
