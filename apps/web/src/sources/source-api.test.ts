import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Source, registerSource } from "../api/source";
import { useDependencyStore } from "../agent/dependency-store";
import { sessionsQuery } from "../agent/sessions";
import { withSource } from "./scope";
import { sourceApi } from "./source-api";

/**
 * 按源记账的读数发往读数所属的源（A1-2 留下的一项）：依赖等待、会话列表、
 * 实时协同复核都经 `clientFor(source)`，与此刻的当前源无关。
 */

const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const BOARD = "019ff7d1-7419-74df-89e2-b1619d36ea7d";

function rpcAnswer(json: unknown): Response {
  return new Response(JSON.stringify({ json }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeSource(sourceId: string, answer: (url: string) => unknown) {
  const calls: string[] = [];
  const source: Source = {
    sourceId,
    httpBase: `https://${sourceId}.example`,
    wsBase: `wss://${sourceId}.example`,
    credentials: {
      mode: "none",
      access: async () => null,
      renew: async () => false,
      csrf: async () => null,
      renewCsrf: async () => null,
    },
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return rpcAnswer(answer(url));
    }) as typeof fetch,
    WebSocket: globalThis.WebSocket,
  };
  return { source, calls };
}

const launch = (nodeId: string) => ({
  nodeId,
  workspaceId: WORKSPACE,
  boardId: BOARD,
  state: "waiting",
  reason: null,
  attempts: 0,
  hasTask: false,
  sessionId: null,
  createdAt: null,
  launchedAt: null,
  dependencies: [],
});

let unregister: (() => void)[] = [];
let localCalls: string[] = [];

beforeEach(() => {
  localCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      localCalls.push(String(input));
      return rpcAnswer({ launches: [launch("local-node")] });
    }),
  );
});

afterEach(() => {
  for (const drop of unregister) drop();
  unregister = [];
  useDependencyStore.getState().reset();
  vi.unstubAllGlobals();
});

function mount(sourceId: string, answer: (url: string) => unknown) {
  const fake = fakeSource(sourceId, answer);
  unregister.push(registerSource(fake.source));
  return fake;
}

describe("按源发的读数", () => {
  it("依赖读数在别的源的事件里发往那个源，本机一个请求也不发", async () => {
    const remote = mount("remote-a", () => ({
      launches: [launch("remote-node")],
    }));
    await withSource("remote-a", () =>
      useDependencyStore.getState().refresh(WORKSPACE),
    );
    expect(remote.calls).toEqual([
      "https://remote-a.example/api/rpc/agents/dependencies",
    ]);
    expect(localCalls).toEqual([]);
    const state = useDependencyStore.getState();
    expect(state.sourceId).toBe("remote-a");
    expect(Object.keys(state.launches)).toEqual(["remote-node"]);
  });

  it("两个源里同名的工作空间：读数各归各的源，不串", async () => {
    mount("remote-a", () => ({ launches: [launch("from-a")] }));
    mount("remote-b", () => ({ launches: [launch("from-b")] }));
    await withSource("remote-a", () =>
      useDependencyStore.getState().refresh(WORKSPACE),
    );
    expect(Object.keys(useDependencyStore.getState().launches)).toEqual([
      "from-a",
    ]);
    await withSource("remote-b", () =>
      useDependencyStore.getState().refresh(WORKSPACE),
    );
    const state = useDependencyStore.getState();
    expect(state.sourceId).toBe("remote-b");
    expect(Object.keys(state.launches)).toEqual(["from-b"]);
  });

  it("会话列表的键与请求绑在渲染时的源上，之后不随当前源漂走", async () => {
    const remote = mount("remote-a", () => []);
    const query = withSource("remote-a", () => sessionsQuery(WORKSPACE));
    expect(query.queryKey).toEqual(["src", "remote-a", "sessions", WORKSPACE]);
    // 请求在派发结束之后才跑（react-query 的时序），仍然发往 remote-a。
    await query.queryFn();
    expect(remote.calls).toEqual([
      "https://remote-a.example/api/rpc/terminals/sessions",
    ]);
    expect(localCalls).toEqual([]);
  });

  it("实时复核发往板所在的源", async () => {
    const remote = mount("remote-a", () => ({
      realtime: false,
      materializedSeq: 0,
      enabled: false,
    }));
    await sourceApi(remote.source).boardRealtime(WORKSPACE, BOARD);
    expect(remote.calls).toEqual([
      "https://remote-a.example/api/rpc/boards/realtime",
    ]);
    expect(localCalls).toEqual([]);
  });
});
