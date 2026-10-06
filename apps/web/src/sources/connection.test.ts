import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { localSource } from "../api/source";
import { createLocalConnection, createRemoteConnection } from "./connection";
import {
  CLOSE_EXPIRED,
  CLOSE_FORBIDDEN,
  CLOSE_SOURCE_OFFLINE,
} from "./managed-socket";
import {
  RELAY_PROTOCOL,
  RELAY_TOKEN_HEADER,
  WS_TICKET_PROTOCOL,
} from "./transport";
import type {
  CredentialProvider,
  SourceAccess,
  SourceDescriptor,
  Via,
} from "./types";
import type { SocketEnvironment } from "./managed-socket";

/** 可手动触发 `online` / 可见性的页面环境。 */
function fakeEnvironment() {
  const listeners = new Map<string, Set<() => void>>();
  let visible = true;
  const environment: SocketEnvironment = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    visible: () => visible,
  };
  return {
    environment,
    fire(type: "online" | "visibilitychange", nextVisible = true) {
      visible = nextVisible;
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

/**
 * 一个源的连接（客户端包 §1.4）：两源并存、401 续期一次、4401 换票重连、4403
 * 失权、4404 等待 + 唤醒、`hello.sourceId` 不符。
 */

const A = "a".repeat(32);
const B = "b".repeat(32);
const BASE_A = "https://a.example:8443";
const BASE_B = "https://b.example:8443";
const RELAY_B = "https://relay.example/s/b";

const descriptor = (
  sourceId: string,
  overrides: Partial<SourceDescriptor> = {},
): SourceDescriptor => ({
  sourceId,
  kind: "direct",
  label: sourceId.slice(0, 4),
  baseUrl: sourceId === A ? BASE_A : BASE_B,
  relayOrigin: "",
  cloudIssuer: "",
  fingerprint: "",
  orderIndex: 1,
  ...overrides,
});

type Call = { url: string; headers: Headers; method: string };
let calls: Call[];
/** 每个来源的 core：答 hello 的 sourceId、某条路径要不要 401。 */
let cores: Record<
  string,
  { sourceId: string; reject?: (call: Call) => boolean; down?: boolean }
>;

const hello = (sourceId: string) => ({
  protocol: { major: 1, minor: 3 },
  procedures: ["system.hello"],
  capabilities: [],
  heartbeatMs: 25_000,
  maxFrameBytes: 1 << 20,
  sessionExpiresAtMs: null,
  instanceId: "i",
  sourceId,
  version: "0.0.0",
});

const fakeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : String(input);
  const call: Call = {
    url,
    headers: new Headers(init?.headers),
    method: init?.method ?? "GET",
  };
  calls.push(call);
  const origin = new URL(url).origin;
  const path = url.slice(origin.length);
  const core =
    cores[origin] ??
    Object.entries(cores).find(([base]) => url.startsWith(base))?.[1];
  if (!core || core.down) throw new TypeError("refused");
  if (path === "/api/identity/hello")
    return new Response(JSON.stringify({ hostId: core.sourceId }));
  if (core.reject?.(call))
    return new Response(JSON.stringify({ code: "unauthenticated" }), {
      status: 401,
    });
  if (path.endsWith("/api/rpc/system/hello"))
    return new Response(JSON.stringify({ json: hello(core.sourceId) }));
  if (path.endsWith("/api/identity/ws-ticket"))
    return new Response(
      JSON.stringify({ ticket: `ticket-${call.headers.get("authorization")}` }),
    );
  return new Response(JSON.stringify({ ok: true }));
};

class FakeSocket extends EventTarget {
  static made: FakeSocket[] = [];
  readyState = 0;
  binaryType: BinaryType = "blob";
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    super();
    FakeSocket.made.push(this);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  drop(code: number) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
  close() {
    this.readyState = 3;
  }
  send() {}
}

/** 凭据来源：每次 refresh 换一枚新令牌；可以让某条路失败。 */
function credentials(
  bases: Record<string, Partial<Record<Via, string>>>,
  fail: { refresh?: boolean; relayed?: boolean } = {},
) {
  const issued: Record<string, number> = {};
  const make = (id: string, via: Via): SourceAccess => {
    issued[id] = (issued[id] ?? 0) + 1;
    const base = bases[id]?.[via];
    if (!base)
      throw Object.assign(new Error("no"), { code: "source_unreachable" });
    return {
      accessToken: `${id.slice(0, 1)}-${issued[id]}`,
      expiresAtMs: 0,
      httpBase: base,
      wsBase: base.replace(/^https/, "wss"),
      ...(via === "relayed" ? { relayToken: "RT" } : {}),
    };
  };
  const provider: CredentialProvider = {
    getAccess: vi.fn(async (id: string, via: Via) => {
      if (via === "relayed" && fail.relayed)
        throw Object.assign(new Error("no"), { code: "source_unauthorized" });
      return make(id, via);
    }),
    refresh: vi.fn(async (id: string, via: Via) => {
      if (fail.refresh)
        throw Object.assign(new Error("no"), { code: "source_unauthorized" });
      return make(id, via);
    }),
    invalidate: vi.fn(),
  };
  return provider;
}

const options = (provider: CredentialProvider) => ({
  provider,
  fetch: fakeFetch,
  WebSocket: FakeSocket as unknown as typeof WebSocket,
  probe: { fetch: fakeFetch },
});

const flush = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  calls = [];
  FakeSocket.made = [];
  cores = {
    [BASE_A]: { sourceId: A },
    [BASE_B]: { sourceId: B },
    [RELAY_B]: { sourceId: B },
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("远程源的连接", () => {
  it("两源并存：各连各的，凭据与地址不串", async () => {
    const provider = credentials({
      [A]: { direct: BASE_A },
      [B]: { direct: BASE_B },
    });
    const a = createRemoteConnection(descriptor(A), options(provider));
    const b = createRemoteConnection(descriptor(B), options(provider));
    await Promise.all([a.connect(), b.connect()]);
    expect(a.status).toMatchObject({
      state: "ready",
      via: "direct",
      lastError: null,
    });
    expect(b.status.state).toBe("ready");
    expect(a.hello?.sourceId).toBe(A);
    expect(b.hello?.sourceId).toBe(B);

    calls = [];
    await a.request("/api/x");
    await b.request("/api/x");
    expect(
      calls.map((call) => [call.url, call.headers.get("authorization")]),
    ).toEqual([
      [`${BASE_A}/api/x`, "Bearer a-1"],
      [`${BASE_B}/api/x`, "Bearer b-1"],
    ]);
    // 两个源的 Source 各是各的，本机源不受影响。
    expect(a.source.httpBase).toBe(BASE_A);
    expect(b.source.httpBase).toBe(BASE_B);
    expect(localSource.credentials.mode).not.toBe("bearer");
  });

  it("401：续期一次再重放；续不上就是 unauthorized", async () => {
    const provider = credentials({ [A]: { direct: BASE_A } });
    const a = createRemoteConnection(descriptor(A), options(provider));
    await a.connect();
    let first = true;
    cores[BASE_A]!.reject = (call) => {
      if (!call.url.endsWith("/api/x") || !first) return false;
      first = false;
      return true;
    };
    calls = [];
    const answer = await a.request("/api/x", { method: "POST", body: "{}" });
    expect(answer.status).toBe(200);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer a-1",
      "Bearer a-2",
    ]);

    const broken = createRemoteConnection(
      descriptor(A),
      options(credentials({ [A]: { direct: BASE_A } }, { refresh: true })),
    );
    await broken.connect();
    cores[BASE_A]!.reject = (call) => call.url.endsWith("/api/x");
    expect((await broken.request("/api/x")).status).toBe(401);
    expect(broken.status).toMatchObject({
      state: "unauthorized",
      lastError: { code: "source_unauthorized" },
    });
    await expect(broken.renew()).rejects.toMatchObject({
      code: "source_unauthorized",
    });
  });

  it("经中继：refresh 失败就忘掉缓存、重取一次（远程服务重取断言）", async () => {
    const provider = credentials(
      { [B]: { relayed: RELAY_B } },
      { refresh: true },
    );
    const b = createRemoteConnection(
      descriptor(B, {
        kind: "relayed",
        baseUrl: "",
        relayOrigin: "https://relay.example",
      }),
      options(provider),
    );
    await b.connect();
    expect(b.status).toMatchObject({ state: "ready", via: "relayed" });
    calls = [];
    await b.request("/api/x");
    expect(calls[0]?.url).toBe(`${RELAY_B}/api/x`);
    expect(calls[0]?.headers.get(RELAY_TOKEN_HEADER)).toBe("RT");
    await b.renew();
    expect(provider.invalidate).toHaveBeenCalledWith(B);
    expect(provider.getAccess).toHaveBeenCalledTimes(2);
  });

  it("hello.sourceId 不符：不就绪，记 source_mismatch，丢掉访问", async () => {
    cores[BASE_A] = { sourceId: B };
    const provider = credentials({ [A]: { direct: BASE_A } });
    const a = createRemoteConnection(descriptor(A), options(provider));
    await a.connect();
    expect(a.status).toMatchObject({
      state: "offline",
      lastError: { code: "source_mismatch" },
    });
    expect(a.hello).toBeNull();
    expect(provider.invalidate).toHaveBeenCalledWith(A);
  });

  it("连不上：offline，不抛", async () => {
    delete cores[BASE_A];
    const a = createRemoteConnection(
      descriptor(A),
      options(credentials({ [A]: { direct: BASE_A } })),
    );
    await expect(a.connect()).resolves.toBeUndefined();
    expect(a.status.state).toBe("offline");
  });

  it("流：换票升级，经中继另带中继子协议", async () => {
    const provider = credentials({ [B]: { relayed: RELAY_B } });
    const b = createRemoteConnection(
      descriptor(B, {
        kind: "relayed",
        baseUrl: "",
        relayOrigin: "https://relay.example",
      }),
      options(provider),
    );
    await b.connect();
    const socket = b.socket("/api/ws", {
      protocols: ["armadra-rpc.v1"],
      environment: null,
    });
    await flush();
    const inner = FakeSocket.made.at(-1)!;
    expect(inner.url).toBe("wss://relay.example/s/b/api/ws");
    expect(inner.protocols).toEqual([
      "armadra-rpc.v1",
      `${WS_TICKET_PROTOCOL}ticket-Bearer b-1`,
      `${RELAY_PROTOCOL}RT`,
    ]);
    inner.open();
    expect(socket.state).toBe("open");
    socket.close();
  });

  it("4401 换票重连；4403 失权；4404 等源上线，再 connect 时叫醒", async () => {
    const provider = credentials({ [A]: { direct: BASE_A } });
    const a = createRemoteConnection(descriptor(A), options(provider));
    await a.connect();
    const socket = a.socket("/api/workspaces/w/events", { environment: null });
    await flush();
    FakeSocket.made.at(-1)!.open();
    FakeSocket.made.at(-1)!.drop(CLOSE_EXPIRED);
    await flush();
    await flush();
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(FakeSocket.made).toHaveLength(2);
    expect(FakeSocket.made[1]!.protocols).toEqual([
      `${WS_TICKET_PROTOCOL}ticket-Bearer a-2`,
    ]);

    FakeSocket.made[1]!.open();
    FakeSocket.made[1]!.drop(CLOSE_SOURCE_OFFLINE);
    await flush();
    expect(socket.state).toBe("waiting");
    expect(a.status).toMatchObject({
      state: "waitingForSource",
      lastError: { code: "source_offline" },
    });
    await a.connect();
    expect(a.status.state).toBe("ready");
    await flush();
    expect(FakeSocket.made).toHaveLength(3);

    FakeSocket.made[2]!.open();
    FakeSocket.made[2]!.drop(CLOSE_FORBIDDEN);
    await flush();
    expect(socket.state).toBe("unauthorized");
    expect(a.status.state).toBe("unauthorized");
  });

  it("断开：关掉流、忘掉凭据，回到 idle", async () => {
    const provider = credentials({ [A]: { direct: BASE_A } });
    const a = createRemoteConnection(descriptor(A), options(provider));
    await a.connect();
    const socket = a.socket("/api/ws", { environment: null });
    a.disconnect();
    expect(socket.state).toBe("closed");
    expect(a.status.state).toBe("idle");
    expect(provider.invalidate).toHaveBeenCalledWith(A);
  });

  it("状态可订阅", async () => {
    const a = createRemoteConnection(
      descriptor(A),
      options(credentials({ [A]: { direct: BASE_A } })),
    );
    const seen: string[] = [];
    a.subscribe(() => seen.push(a.status.state));
    await a.connect();
    expect(seen).toEqual(["connecting", "ready"]);
  });
});

describe("本机源的连接", () => {
  it("一创建就 ready（经 local），connect 不发请求", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const local = createLocalConnection();
    expect(local.status).toMatchObject({ state: "ready", via: "local" });
    expect(local.source).toBe(localSource);
    await local.connect();
    expect(fetch).not.toHaveBeenCalled();
    expect(local.hello).toBeNull();
  });

  it("request 发往本机源的地址", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await createLocalConnection().request("/api/settings");
    expect(fetch).toHaveBeenCalledWith(
      `${localSource.httpBase}/api/settings`,
      undefined,
    );
  });
});

describe("经中继的源（A3-4）", () => {
  const relayedB = descriptor(B, {
    kind: "relayed",
    relayOrigin: "https://relay.example",
    cloudIssuer: "https://relay.example",
  });

  it("取访问时中继答源不在线：waitingForSource（不是 offline），再 connect 就绪", async () => {
    let offline = true;
    const provider = credentials({ [B]: { relayed: RELAY_B } });
    provider.getAccess = vi.fn(async (id: string, via: Via) => {
      if (offline)
        throw Object.assign(new Error("offline"), { code: "source_offline" });
      return {
        accessToken: "b-1",
        expiresAtMs: 0,
        httpBase: RELAY_B,
        wsBase: RELAY_B.replace(/^https/, "wss"),
        relayToken: via === "relayed" ? "RT" : "",
      };
    });
    const b = createRemoteConnection(
      { ...relayedB, baseUrl: "" },
      { ...options(provider), environment: null },
    );
    await b.connect();
    expect(b.status).toMatchObject({
      state: "waitingForSource",
      lastError: { code: "source_offline" },
    });
    offline = false;
    await b.connect();
    expect(b.status).toMatchObject({ state: "ready", via: "relayed" });
  });

  it("revoke：关流、丢访问，unauthorized 带原因；再 connect 才重连", async () => {
    const provider = credentials({ [B]: { relayed: RELAY_B } });
    const b = createRemoteConnection(
      { ...relayedB, baseUrl: "" },
      { ...options(provider), environment: null },
    );
    await b.connect();
    const socket = b.socket("/api/ws", { environment: null });
    b.revoke({ code: "source_revoked", message: "" });
    expect(socket.state).toBe("closed");
    expect(b.status).toMatchObject({
      state: "unauthorized",
      lastError: { code: "source_revoked" },
    });
    expect(provider.invalidate).toHaveBeenCalledWith(B);
    await b.connect();
    expect(b.status.state).toBe("ready");
  });

  it("D27：走中继时 online / 回到前台 / 流退避重新探直连，通了换到直连并重连流", async () => {
    cores[BASE_B]!.down = true;
    const env = fakeEnvironment();
    let clock = 1_000_000;
    const provider = credentials({
      [B]: { relayed: RELAY_B, direct: BASE_B },
    });
    const b = createRemoteConnection(relayedB, {
      ...options(provider),
      environment: env.environment,
      now: () => clock,
    });
    await b.connect();
    expect(b.status).toMatchObject({ state: "ready", via: "relayed" });
    expect(env.count("online")).toBe(1);
    const socket = b.socket("/api/ws", { environment: null });
    await flush();
    FakeSocket.made.at(-1)!.open();
    expect(socket.state).toBe("open");

    // 直连还不通：探了也留在中继。
    env.fire("online");
    await flush();
    await flush();
    expect(b.status.via).toBe("relayed");

    // 间隔之内不再探。
    cores[BASE_B]!.down = false;
    env.fire("visibilitychange");
    await flush();
    expect(b.status.via).toBe("relayed");

    clock += 6_000;
    env.fire("visibilitychange");
    for (let i = 0; i < 5; i += 1) await flush();
    expect(b.status).toMatchObject({ state: "ready", via: "direct" });
    expect(b.source.httpBase).toBe(BASE_B);
    await flush();
    const reopened = FakeSocket.made.at(-1)!;
    expect(reopened.url).toBe("wss://b.example:8443/api/ws");
    expect(
      (reopened.protocols as string[]).some((p) =>
        p.startsWith(RELAY_PROTOCOL),
      ),
    ).toBe(false);

    b.disconnect();
    expect(env.count("online")).toBe(0);
  });

  it("流在退避时也探一次直连", async () => {
    cores[BASE_B]!.down = true;
    const provider = credentials({
      [B]: { relayed: RELAY_B, direct: BASE_B },
    });
    let clock = 1_000_000;
    const b = createRemoteConnection(relayedB, {
      ...options(provider),
      environment: null,
      now: () => clock,
    });
    await b.connect();
    const socket = b.socket("/api/ws", {
      environment: null,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
    await flush();
    FakeSocket.made.at(-1)!.open();
    cores[BASE_B]!.down = false;
    clock += 6_000;
    FakeSocket.made.at(-1)!.drop(1006);
    for (let i = 0; i < 6; i += 1) await flush();
    expect(socket.state).not.toBe("closed");
    expect(b.status.via).toBe("direct");
  });
});
