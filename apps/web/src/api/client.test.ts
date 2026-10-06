import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardDocument } from "@armadra/shared";
import {
  RuntimeConnectionError,
  RuntimeRequestError,
  isConflict,
  isLeaseHeld,
  runtimeApi,
  terminalWebSocketUrl,
  workspaceEventsUrl,
} from "./client";
import { translate } from "../i18n";

const timestamp = "2026-08-13T00:00:00.000Z";
const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const boardId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";
const sessionId = "019ff7d1-ab76-728d-be18-3acfd6181af8";

function stubJson(payload: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof stubJson>, call = 0): unknown {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

const boardDocument: BoardDocument = {
  board: {
    id: boardId,
    workspaceId,
    name: "Default",
    sortOrder: 0,
    viewport: { x: 12, y: -8, zoom: 0.75 },
    whiteboard: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  nodes: [],
  edges: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Runtime 连接失败", () => {
  it("把 WebKit 的 Load failed 变成可操作的连接错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Load failed")),
    );

    const error = await runtimeApi.health().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RuntimeConnectionError);
    expect(error).toMatchObject({
      message: expect.stringContaining("无法连接本地 Runtime"),
      endpoint: "http://127.0.0.1:43120",
    });
    if (!(error instanceof Error)) throw new Error("expected an Error");
    expect(error.message).not.toContain("Load failed");
  });

  it("非 2xx 时按 code 取界面文案，core 的原话留在 coreMessage 上", async () => {
    stubJson({ code: "conflict", message: "画布已被其他窗口修改" }, false, 409);

    const error = await runtimeApi
      .loadBoard(workspaceId, boardId)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RuntimeRequestError);
    const failure = error as RuntimeRequestError;
    // core 的 message 通篇中文，英文界面上原样透出去就是一句中文。
    expect(failure.message).toBe(translate("zh-CN", "error.conflict"));
    expect(failure.coreMessage).toBe("画布已被其他窗口修改");
    expect(failure.status).toBe(409);
  });

  it("认不出的 code（和根本没有 code）才落回 core 那句原话", async () => {
    stubJson({ code: "some_new_code", message: "core 自己的说法" }, false, 400);
    await expect(runtimeApi.loadBoard(workspaceId, boardId)).rejects.toThrow(
      "core 自己的说法",
    );
  });
});

describe("画布文档（契约 §36）", () => {
  it("保存调 boards.save，带上 CAS 时间戳与视口，不再有 strokes", async () => {
    const fetchMock = stubJson({ json: boardDocument });

    await runtimeApi.saveBoard(workspaceId, boardId, boardDocument);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:43120/api/rpc/boards/save");
    expect(init.method).toBe("POST");
    expect(bodyOf(fetchMock)).toMatchObject({
      json: {
        workspaceId,
        boardId,
        expectedUpdatedAt: timestamp,
        nodes: [],
        edges: [],
        viewport: { x: 12, y: -8, zoom: 0.75 },
        whiteboard: "",
      },
    });
  });

  it("读回画布时保留持久化的视口", async () => {
    const fetchMock = stubJson({ json: boardDocument });

    const loaded = await runtimeApi.loadBoard(workspaceId, boardId);
    expect(loaded.board.viewport).toEqual({ x: 12, y: -8, zoom: 0.75 });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "http://127.0.0.1:43120/api/rpc/boards/load",
    );
  });

  it("删除画布允许空响应体", async () => {
    const fetchMock = stubJson({});

    await expect(
      runtimeApi.deleteBoard(workspaceId, boardId),
    ).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:43120/api/rpc/boards/delete");
    expect(init.method).toBe("POST");
    expect(bodyOf(fetchMock)).toMatchObject({
      json: { workspaceId, boardId },
    });
  });

  it("别人持有租约：保存与拿租约答 423，isLeaseHeld 认得", async () => {
    stubJson(
      { code: "canvas_lease_held", message: "Another client holds it" },
      false,
      423,
    );
    const saved = await runtimeApi
      .saveBoard(workspaceId, boardId, boardDocument, "tab-aaaaaaaaaaaa")
      .catch((cause: unknown) => cause);
    expect(isLeaseHeld(saved)).toBe(true);
    expect(saved).toMatchObject({ status: 423 });
    const asked = await runtimeApi
      .acquireLease(workspaceId, boardId, {
        clientId: "tab-aaaaaaaaaaaa",
        deviceName: "Mac",
        takeover: false,
      })
      .catch((cause: unknown) => cause);
    expect(isLeaseHeld(asked)).toBe(true);
  });

  it("实时状态按给定的源发，缺省发往当前源", async () => {
    const fetchMock = stubJson({
      json: { realtime: true, materializedSeq: 3, enabled: true },
    });
    await expect(
      runtimeApi.boardRealtime(workspaceId, boardId),
    ).resolves.toMatchObject({ realtime: true, materializedSeq: 3 });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "http://127.0.0.1:43120/api/rpc/boards/realtime",
    );
  });

  it("心跳、离开与拿租约各是一条 procedure", async () => {
    const snapshot = {
      boardId,
      clients: [
        {
          clientId: "tab-aaaaaaaaaaaa",
          deviceName: "Mac",
          deviceKey: "k",
          lastSeenAt: timestamp,
        },
      ],
      lease: null,
      writable: true,
    };
    const fetchMock = stubJson({ json: snapshot });
    const body = { clientId: "tab-aaaaaaaaaaaa", deviceName: "Mac" };
    await runtimeApi.presenceHeartbeat(workspaceId, boardId, {
      ...body,
      active: true,
    });
    await runtimeApi.leavePresence(workspaceId, boardId, body.clientId);
    await runtimeApi.acquireLease(workspaceId, boardId, {
      ...body,
      takeover: true,
    });
    expect(
      fetchMock.mock.calls.map(
        (call) => (call as [string])[0].split("/api/")[1],
      ),
    ).toEqual([
      "rpc/boards/heartbeat",
      "rpc/boards/leave",
      "rpc/boards/acquireLease",
    ]);
    expect(bodyOf(fetchMock, 0)).toMatchObject({
      json: { workspaceId, boardId, ...body, active: true },
    });
    expect(bodyOf(fetchMock, 2)).toMatchObject({
      json: { workspaceId, boardId, ...body, takeover: true },
    });
  });

  it("从列表移除工作空间调 workspaces.delete（契约 §34.4）", async () => {
    const fetchMock = stubJson({});

    await expect(
      runtimeApi.deleteWorkspace(workspaceId),
    ).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:43120/api/rpc/workspaces/delete");
    expect(init.method).toBe("POST");
    expect(bodyOf(fetchMock)).toMatchObject({ json: { workspaceId } });
  });
});

describe("会话、Agent 与审批", () => {
  it("Agent 列表保留 resolvedPath 为 null 的未安装项", async () => {
    stubJson([
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
    expect(agents[0]).toMatchObject({ id: "codex", installed: false });
    expect(agents[0]?.resolvedPath).toBeNull();
  });

  it("回答审批时只发 decision", async () => {
    const fetchMock = stubJson({
      id: "p1",
      nodeId: "node-1",
      answer: "allow",
      answeredAt: timestamp,
      revision: 1,
      route: "file",
    });

    await runtimeApi.answerApproval("p1", "allow");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:43120/api/approvals/p1/answer",
    );
    expect(bodyOf(fetchMock)).toEqual({ decision: "allow" });
  });

  // core 答的是审批那一行本身加 `route`（`core/agent/routes.ts`）。页面照旧的
  // `{ pendingId, decision }` 去校验，决定已经记下、答案文件也写了，页面却抛
  // 一个没人接的 ZodError——2026-09-26 端到端里每点一次「允许 / 拒绝」控制台
  // 就多一条。
  it("审批答复按 core 真正答的形状读", async () => {
    stubJson({
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
  });

  it("写上下文链接是整表替换", async () => {
    const fetchMock = stubJson({
      nodeId: boardId,
      links: [],
      updatedAt: timestamp,
    });

    await runtimeApi.putContextLinks(workspaceId, boardId, [
      { id: sessionId, title: "构建", kind: "terminal" },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://127.0.0.1:43120/api/workspaces/${workspaceId}/context-links/${boardId}`,
    );
    expect(init.method).toBe("PUT");
    expect(bodyOf(fetchMock)).toEqual({
      links: [{ id: sessionId, title: "构建", kind: "terminal" }],
    });
  });
});

describe("白板资产与导出", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  it("Blob 原样上传，Content-Type 就是它自己的 MIME", async () => {
    const fetchMock = stubJson({
      id: "0011223344556677.png",
      path: ".armadra/assets/0011223344556677.png",
      url: `/api/workspaces/${workspaceId}/assets/0011223344556677.png`,
      mimeType: "image/png",
      bytes: 12,
    });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

    const asset = await runtimeApi.uploadAsset(workspaceId, blob);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://127.0.0.1:43120/api/workspaces/${workspaceId}/assets`,
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(blob);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "image/png",
    );
    expect(asset.id).toBe("0011223344556677.png");
  });

  it("data URL 走 JSON 体", async () => {
    const fetchMock = stubJson({
      id: "0011223344556677.png",
      path: ".armadra/assets/0011223344556677.png",
      url: `/api/workspaces/${workspaceId}/assets/0011223344556677.png`,
      mimeType: "image/png",
      bytes: 12,
    });

    await runtimeApi.uploadAsset(workspaceId, png);

    expect(bodyOf(fetchMock)).toEqual({ dataUrl: png });
  });

  it("按路径导入把路径发给 import 端点", async () => {
    const fetchMock = stubJson({
      id: "0011223344556677.png",
      path: ".armadra/assets/0011223344556677.png",
      url: `/api/workspaces/${workspaceId}/assets/0011223344556677.png`,
      mimeType: "image/png",
      bytes: 12,
    });

    const asset = await runtimeApi.importAsset(
      workspaceId,
      "/Users/me/Downloads/shot.png",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://127.0.0.1:43120/api/workspaces/${workspaceId}/assets/import`,
    );
    expect(init.method).toBe("POST");
    expect(bodyOf(fetchMock)).toEqual({ path: "/Users/me/Downloads/shot.png" });
    expect(asset.path).toBe(".armadra/assets/0011223344556677.png");
  });

  it("空路径在发请求前就被拦下", () => {
    const fetchMock = stubJson({});
    expect(() => runtimeApi.importAsset(workspaceId, "")).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolve 用的地址带上 Runtime 源", () => {
    expect(runtimeApi.assetUrl(workspaceId, "0011223344556677.png")).toBe(
      `http://127.0.0.1:43120/api/workspaces/${workspaceId}/assets/0011223344556677.png`,
    );
  });

  it("导出不再挂在节点下，返回工作区相对路径", async () => {
    const fetchMock = stubJson({
      path: "/tmp/one/.armadra/exports/" + sessionId + ".png",
      relativePath: `.armadra/exports/${sessionId}.png`,
      bytes: 12,
    });

    const exported = await runtimeApi.exportPng(workspaceId, sessionId, png);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://127.0.0.1:43120/api/workspaces/${workspaceId}/exports/${sessionId}/png`,
    );
    expect(bodyOf(fetchMock)).toEqual({ dataUrl: png });
    expect(exported.relativePath).toBe(`.armadra/exports/${sessionId}.png`);
  });

  it("非 PNG 的 data URL 在发请求前就被拦下", () => {
    stubJson({});
    expect(() =>
      runtimeApi.exportPng(workspaceId, sessionId, "data:image/svg+xml,<svg/>"),
    ).toThrow();
  });
});

describe("写文件", () => {
  it("PUT 携带已读内容版本", async () => {
    const fetchMock = stubJson({
      json: { path: "src/a.ts", size: 7, sha256: "b".repeat(64) },
    });

    const result = await runtimeApi.writeFile(
      workspaceId,
      "src/a.ts",
      "content",
      3,
      "a".repeat(64),
    );

    expect(result).toEqual({
      path: "src/a.ts",
      size: 7,
      sha256: "b".repeat(64),
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:43120/api/rpc/files/write");
    expect(init.method).toBe("POST");
    expect(bodyOf(fetchMock)).toEqual({
      json: {
        workspaceId,
        path: "src/a.ts",
        content: "content",
        expectedSize: 3,
        expectedSha256: "a".repeat(64),
      },
    });
  });

  it("不传 expectedSize 时不发这个键", async () => {
    const fetchMock = stubJson({
      json: { path: "a.ts", size: 1, sha256: "b".repeat(64) },
    });

    await runtimeApi.writeFile(workspaceId, "a.ts", "x");

    expect(bodyOf(fetchMock)).toEqual({
      json: { workspaceId, path: "a.ts", content: "x" },
    });
  });

  it("409 变成可判别的冲突错误", async () => {
    stubJson(
      { code: "conflict", message: "The file changed on disk" },
      false,
      409,
    );

    const error = await runtimeApi
      .writeFile(workspaceId, "a.ts", "x", 1)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RuntimeRequestError);
    expect(isConflict(error)).toBe(true);
    expect((error as RuntimeRequestError).code).toBe("conflict");
    // 其它状态码不算冲突。
    expect(isConflict(new Error("boom"))).toBe(false);
  });
});

describe("集成安装", () => {
  /** 一份装好的集成状态（设计 agent-integration §5）。 */
  function installed(overrides: Record<string, unknown> = {}) {
    return {
      agentId: "claude",
      mode: "launch",
      hook: {
        installed: true,
        path: "/data/integration/claude/settings.json",
        revision: 4,
      },
      skill: {
        installed: true,
        path: "/home/u/.claude/skills/armadra/SKILL.md",
        revision: 6,
      },
      legacy: { found: [] },
      revision: 406,
      installedRevision: 406,
      stale: false,
      launchArgs: ["--settings", "/data/integration/claude/settings.json"],
      ...overrides,
    };
  }

  it("读状态是 GET，装 / 卸是 POST，两半一起答", async () => {
    const fetchMock = stubJson(installed());
    const state = await runtimeApi.agentIntegration("claude");
    expect(state.mode).toBe("launch");
    expect(state.hook.installed && state.skill.installed).toBe(true);
    expect(state.launchArgs).toEqual([
      "--settings",
      "/data/integration/claude/settings.json",
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:43120/api/agents/claude/integration");
    expect(init?.method ?? "GET").toBe("GET");

    const installMock = stubJson(installed());
    await expect(
      runtimeApi.installAgentIntegration("claude"),
    ).resolves.toMatchObject({ stale: false });
    const [installUrl, installInit] = installMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(installUrl).toBe(
      "http://127.0.0.1:43120/api/agents/claude/integration/install",
    );
    expect(installInit.method).toBe("POST");

    stubJson(
      installed({
        agentId: "custom:x",
        hook: { installed: false, revision: 0 },
        skill: { installed: false, revision: 0 },
        launchArgs: [],
      }),
    );
    const removed = await runtimeApi.uninstallAgentIntegration("custom:x");
    expect(removed.hook.installed || removed.skill.installed).toBe(false);
  });

  /** 装了旧版本：两半都在，但修订不是这一版的。 */
  it("旧修订读出来就是 stale，旧残留原样带回来", async () => {
    stubJson(
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

  it("修复报告说清删了什么、留了什么、备份在哪", async () => {
    const fetchMock = stubJson({
      agentId: "claude",
      found: [
        {
          kind: "codex_unknown_key",
          path: "/home/u/.codex/hooks.json",
          detail: "version",
        },
      ],
      removed: ["/home/u/.codex/hooks.json: version"],
      kept: ["/home/u/.codex/hooks.json: session_start → /opt/audit.sh"],
      backup: "/home/u/.codex/hooks.json.armadra-backup-20260913101500",
      backups: ["/home/u/.codex/hooks.json.armadra-backup-20260913101500"],
    });
    const report = await runtimeApi.repairAgentIntegration("claude");
    expect(report.removed).toHaveLength(1);
    expect(report.kept[0]).toContain("/opt/audit.sh");
    expect(report.backup).toContain(".armadra-backup-");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://127.0.0.1:43120/api/agents/claude/integration/repair",
    );
  });

  it("清未读标记打到 agent-status 路由", async () => {
    const fetchMock = stubJson({
      nodeId: workspaceId,
      workspaceId,
      agentId: "claude",
      unread: false,
      verified: true,
      restored: false,
      updatedAt: timestamp,
    });

    const status = await runtimeApi.markAgentRead(workspaceId);

    expect(status.unread).toBe(false);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://127.0.0.1:43120/api/agent-status/${workspaceId}/read`,
    );
    expect(init.method).toBe("POST");
  });
});

describe("设置（契约 §34.5，经 RPC）", () => {
  it("补齐缺失的终端段默认值", async () => {
    stubJson({ json: {} });

    await expect(runtimeApi.settings()).resolves.toMatchObject({
      terminal: { backend: "auto", detachedGraceMinutes: 1440 },
    });
  });

  it("透传 Runtime 写入的未知键", async () => {
    stubJson({
      json: {
        terminal: { backend: "tmux", detachedGraceMinutes: 60 },
        future: { key: 1 },
      },
    });

    const settings = await runtimeApi.settings();
    expect(settings.terminal.backend).toBe("tmux");
    expect(settings).toMatchObject({ future: { key: 1 } });
  });

  it("update 只发改动的段，值为 undefined 的键不发", async () => {
    const fetchMock = stubJson({
      json: { terminal: { backend: "direct", detachedGraceMinutes: 1440 } },
    });

    await runtimeApi.updateSettings({
      terminal: { backend: "direct", ecoMode: undefined },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:43120/api/rpc/settings/update");
    expect(init.method).toBe("POST");
    expect((bodyOf(fetchMock) as { json: unknown }).json).toEqual({
      terminal: { backend: "direct" },
    });
  });
});

describe("WebSocket 地址", () => {
  it("保留 Runtime origin 并升级协议", () => {
    expect(terminalWebSocketUrl("abc")).toBe(
      "ws://127.0.0.1:43120/api/terminals/abc/ws",
    );
    expect(workspaceEventsUrl(workspaceId)).toBe(
      `ws://127.0.0.1:43120/api/workspaces/${workspaceId}/events`,
    );
  });
});

describe("Git execution permission errors", () => {
  it("uses the stable server code for actionable text and preserves unrelated errors", async () => {
    stubJson(
      { code: "git_execution_required", message: "Internal Git stage label" },
      false,
      403,
    );
    try {
      await runtimeApi.listWorkspaces();
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeRequestError);
      expect((error as RuntimeRequestError).code).toBe(
        "git_execution_required",
      );
      expect((error as Error).message).not.toBe("Internal Git stage label");
      expect((error as Error).message).toMatch(/工作区|Workspace/);
    }
    // `forbidden` 在映射表里，所以原话让位给那句界面文案；原话没有丢。
    const refused = new RuntimeRequestError(403, "plain", "forbidden");
    expect(refused.message).toBe(translate("zh-CN", "error.forbidden"));
    expect(refused.coreMessage).toBe("plain");
  });
});
