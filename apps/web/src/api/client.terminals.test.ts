import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeApi } from "./client";
import { RuntimeRequestError } from "./request";
import { setCurrentSourceResolver, type Source, localSource } from "./source";

/**
 * terminals 域的页面一侧（契约 §38）：HTTP 面都发 `POST /api/rpc/terminals/<动词>`，
 * 体是 `{ json: { … } }`，答案过页面自己的 schema，发往当前源。终端的 WebSocket
 * 不经这里。
 */

const timestamp = "2026-08-13T00:00:00.000Z";
const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const nodeId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";
const sessionId = "019ff7d1-ab76-728d-be18-3acfd6181af8";

const terminalSession = {
  id: sessionId,
  workspaceId,
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

describe("terminals：HTTP 面经 RPC", () => {
  it("创建终端时带上 agent 段与 nodeId，args 缺省补成空数组", async () => {
    stub(() => answer(200, { json: terminalSession }));

    await runtimeApi.createTerminal({
      workspaceId,
      cwd: "/tmp/one",
      args: [],
      nodeId,
      agent: { id: "claude", permissionMode: "plan" },
    });

    expect(procedure()).toBe("terminals/create");
    expect(sent()).toEqual({
      json: {
        workspaceId,
        cwd: "/tmp/one",
        args: [],
        nodeId,
        agent: { id: "claude", permissionMode: "plan" },
      },
    });
  });

  it("抓屏把 lines/escapes 放进入参，缺省不发", async () => {
    stub(() => answer(200, { json: { generation: 2, lines: 40, data: "$ " } }));

    const capture = await runtimeApi.captureTerminal(sessionId, {
      lines: 40,
      escapes: false,
    });
    await runtimeApi.captureTerminal(sessionId);

    expect(capture.generation).toBe(2);
    expect(procedure()).toBe("terminals/capture");
    expect(sent(0)).toEqual({
      json: { sessionId, lines: 40, escapes: false },
    });
    expect(sent(1)).toEqual({ json: { sessionId } });
  });

  it("粘贴默认不回车，答 undefined", async () => {
    stub(() => answer(200, { json: terminalSession }));

    await expect(
      runtimeApi.pasteTerminal(sessionId, "ls -al"),
    ).resolves.toBeUndefined();

    expect(procedure()).toBe("terminals/paste");
    expect(sent()).toEqual({
      json: { sessionId, text: "ls -al", enter: false },
    });
  });

  it("终止默认走 process 级别", async () => {
    stub(() => answer(200, { json: terminalSession }));

    await runtimeApi.terminateTerminal(sessionId);
    await runtimeApi.terminateTerminal(sessionId, "session");

    expect(procedure()).toBe("terminals/terminate");
    expect(sent(0)).toEqual({ json: { sessionId, mode: "process" } });
    expect(sent(1)).toEqual({ json: { sessionId, mode: "session" } });
  });

  it("回收、唤醒、读会话行各发自己的 procedure", async () => {
    stub(() => answer(200, { json: { ...terminalSession, generation: 3 } }));

    const recycled = await runtimeApi.recycleTerminal(sessionId);
    await runtimeApi.wakeTerminal(sessionId);
    await runtimeApi.getTerminal(sessionId);

    expect(recycled.generation).toBe(3);
    expect(calls.map((_, index) => procedure(index))).toEqual([
      "terminals/recycle",
      "terminals/wake",
      "terminals/get",
    ]);
    expect(sent(0)).toEqual({ json: { sessionId } });
  });

  it("接管 / 交还发 terminals.drive，答租约", async () => {
    stub(() =>
      answer(200, {
        json: { state: "humanTakeover", generation: 2, expiresAt: "" },
      }),
    );

    const lease = await runtimeApi.driveTerminal(sessionId, "takeover");

    expect(lease.state).toBe("humanTakeover");
    expect(procedure()).toBe("terminals/drive");
    expect(sent()).toEqual({ json: { sessionId, action: "takeover" } });
  });

  it("旧 Runtime 不报 pid 时补 null", async () => {
    stub(() => answer(200, { json: terminalSession }));

    const session = await runtimeApi.getTerminal(sessionId);
    expect(session.pid).toBeNull();
  });

  it("读后端信息", async () => {
    stub(() =>
      answer(200, {
        json: {
          effective: "tmux",
          configured: "auto",
          tmuxVersion: "3.4",
          tmuxSocket: "/tmp/tmux.sock",
          reason: null,
          platform: "unix",
        },
      }),
    );

    await expect(runtimeApi.terminalBackend()).resolves.toMatchObject({
      effective: "tmux",
      configured: "auto",
    });
    expect(procedure()).toBe("terminals/backend");
  });

  it("会话列表发 terminals.sessions", async () => {
    stub(() => answer(200, { json: [] }));

    await expect(runtimeApi.sessions(workspaceId)).resolves.toEqual([]);

    expect(procedure()).toBe("terminals/sessions");
    expect(sent()).toEqual({ json: { workspaceId } });
  });

  it("拒绝的 envelope 原码带出，不当成功", async () => {
    stub(() =>
      answer(409, {
        code: "not_hibernated",
        message: "This terminal does not belong to a node",
        requestId: "r1",
      }),
    );
    const error = await runtimeApi
      .wakeTerminal(sessionId)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RuntimeRequestError);
    expect((error as RuntimeRequestError).code).toBe("not_hibernated");
    expect((error as RuntimeRequestError).status).toBe(409);
  });

  it("发往当前源：换了源，请求跟着去", async () => {
    const other: Source = {
      ...localSource,
      sourceId: "remote-1",
      httpBase: "https://core.example",
      wsBase: "wss://core.example",
    };
    setCurrentSourceResolver(() => other);
    stub(() => answer(200, { json: terminalSession }));

    await runtimeApi.getTerminal(sessionId);

    expect(calls[0]?.url).toBe("https://core.example/api/rpc/terminals/get");
  });
});
