import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLOSE_EXPIRED, CLOSE_SOURCE_OFFLINE } from "./managed-socket";
import { createSourceRegistry } from "./registry";
import {
  ME_STREAM_PING_MS,
  type RemoteStreamOptions,
  applyMeStreamEvent,
  attachRemoteStreams,
  createRemoteStream,
  meStreamUrl,
  parseMeStreamEvent,
  resyncTargets,
} from "./remote-stream";
import { RELAY_PROTOCOL, WS_TICKET_PROTOCOL } from "./transport";
import type {
  CloudAuth,
  CredentialProvider,
  SourceDescriptor,
  SourceState,
  Via,
} from "./types";

/**
 * 远程服务的事件流（客户端包 §5）：假中继答 4404 → 等待；推 `sourceOnline` →
 * 1 秒内重连；撤销；流重开时补上错过的上线；4401 换会话。
 */

const ISSUER = "https://relay.example";
const SOURCE = "b".repeat(32);
const OTHER = "c".repeat(32);
const RELAY_BASE = `${ISSUER}/s/${SOURCE}`;

class FakeSocket extends EventTarget {
  static made: FakeSocket[] = [];
  readyState = 0;
  binaryType: BinaryType = "blob";
  sent: string[] = [];
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
  push(event: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(event) }),
    );
  }
  drop(code: number) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
  close() {
    this.readyState = 3;
  }
  send(data: string) {
    this.sent.push(data);
  }
}

const streamSockets = () =>
  FakeSocket.made.filter((socket) => socket.url.endsWith("/v1/me/stream"));
const sourceSockets = () =>
  FakeSocket.made.filter((socket) => socket.url.includes("/s/"));

let calls: { url: string; headers: Headers }[];

/** 假中继：`me.stream` 的票、源的 hello 与 ws-ticket。 */
const fakeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : String(input);
  const headers = new Headers(init?.headers);
  calls.push({ url, headers });
  if (url === `${ISSUER}/v1/me/stream/ticket`)
    return new Response(
      JSON.stringify({
        ticket: `st-${headers.get("authorization")}`,
        expiresAtMs: 0,
      }),
    );
  if (url.endsWith("/api/rpc/system/hello"))
    return new Response(
      JSON.stringify({
        json: {
          protocol: { major: 1, minor: 3 },
          procedures: [],
          capabilities: [],
          heartbeatMs: 25_000,
          maxFrameBytes: 1 << 20,
          sessionExpiresAtMs: null,
          instanceId: "i",
          sourceId: url.includes(OTHER) ? OTHER : SOURCE,
          version: "0",
        },
      }),
    );
  if (url.endsWith("/api/identity/ws-ticket"))
    return new Response(JSON.stringify({ ticket: "src-ticket" }));
  return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
};

function cloudAuth(): CloudAuth & { issued: number } {
  const auth = {
    issued: 0,
    access: vi.fn(async () => `cloud-${auth.issued || (auth.issued = 1)}`),
    invalidate: vi.fn(() => {
      auth.issued += 1;
    }),
  };
  return auth;
}

const provider = (): CredentialProvider => ({
  getAccess: vi.fn(async (sourceId: string, _via: Via) => ({
    accessToken: "tok",
    expiresAtMs: 0,
    httpBase: `${ISSUER}/s/${sourceId}`,
    wsBase: `wss://relay.example/s/${sourceId}`,
    relayToken: "RT",
  })),
  refresh: vi.fn(async (sourceId: string) => ({
    accessToken: "tok2",
    expiresAtMs: 0,
    httpBase: `${ISSUER}/s/${sourceId}`,
    wsBase: `wss://relay.example/s/${sourceId}`,
    relayToken: "RT",
  })),
  invalidate: vi.fn(),
});

const relayed = (sourceId: string): SourceDescriptor => ({
  sourceId,
  kind: "relayed",
  label: "",
  baseUrl: "",
  relayOrigin: ISSUER,
  cloudIssuer: ISSUER,
  fingerprint: "",
  orderIndex: 1,
});

const flush = async (times = 4) => {
  for (let i = 0; i < times; i += 1)
    await new Promise((done) => setTimeout(done, 0));
};

const socketOptions = {
  WebSocket: FakeSocket as unknown as typeof WebSocket,
  environment: null,
} satisfies RemoteStreamOptions["socket"];

beforeEach(() => {
  FakeSocket.made = [];
  calls = [];
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("me.stream 的帧", () => {
  it("认得出的事件解析出来，认不出的是 null", () => {
    expect(
      parseMeStreamEvent(
        JSON.stringify({
          type: "sourceOnline",
          sourceId: SOURCE,
          sinceMs: 1,
          relayOrigin: ISSUER,
        }),
      ),
    ).toMatchObject({ type: "sourceOnline", sourceId: SOURCE });
    expect(parseMeStreamEvent("{")).toBeNull();
    expect(parseMeStreamEvent(JSON.stringify({ type: "future" }))).toBeNull();
    expect(parseMeStreamEvent(new ArrayBuffer(1))).toBeNull();
  });

  it("地址：https → wss，带路径", () => {
    expect(meStreamUrl("https://relay.example/")).toBe(
      "wss://relay.example/v1/me/stream",
    );
    expect(meStreamUrl("http://127.0.0.1:8102")).toBe(
      "ws://127.0.0.1:8102/v1/me/stream",
    );
  });
});

describe("一条事件流", () => {
  it("票经远程服务会话换、走票子协议；每 30 秒 ping；4401 丢会话换票重连", async () => {
    const auth = cloudAuth();
    const timers: (() => void)[] = [];
    const stream = createRemoteStream({
      issuer: ISSUER,
      auth,
      onEvent: () => undefined,
      socket: socketOptions,
      setInterval: (run, ms) => {
        expect(ms).toBe(ME_STREAM_PING_MS);
        timers.push(run);
        return timers.length;
      },
      clearInterval: () => undefined,
    });
    await flush();
    const first = streamSockets()[0]!;
    expect(first.url).toBe("wss://relay.example/v1/me/stream");
    expect(first.protocols).toEqual([`${WS_TICKET_PROTOCOL}st-Bearer cloud-1`]);
    first.open();
    expect(stream.state).toBe("open");
    timers[0]!();
    expect(first.sent).toEqual([JSON.stringify({ type: "ping" })]);

    first.drop(CLOSE_EXPIRED);
    await flush();
    expect(auth.invalidate).toHaveBeenCalledWith(ISSUER);
    const second = streamSockets()[1]!;
    expect(second.protocols).toEqual([
      `${WS_TICKET_PROTOCOL}st-Bearer cloud-2`,
    ]);
    stream.close();
    expect(stream.state).toBe("closed");
  });
});

describe("接到源表上", () => {
  it("假中继答 4404 → waitingForSource；推 sourceOnline → 1 秒内重连", async () => {
    const registry = createSourceRegistry({
      provider: provider(),
      remote: {
        fetch: fakeFetch,
        WebSocket: FakeSocket as unknown as typeof WebSocket,
        environment: null,
      },
    });
    const connection = registry.add(relayed(SOURCE));
    await connection.connect();
    expect(connection.status.state).toBe("ready");
    const detach = attachRemoteStreams(registry, {
      auth: cloudAuth(),
      socket: socketOptions,
    });
    await flush();
    streamSockets()[0]!.open();

    const events = connection.socket("/api/workspaces/w/events", {
      environment: null,
    });
    await flush();
    const first = sourceSockets()[0]!;
    expect(first.protocols).toEqual([
      `${WS_TICKET_PROTOCOL}src-ticket`,
      `${RELAY_PROTOCOL}RT`,
    ]);
    first.open();
    first.drop(CLOSE_SOURCE_OFFLINE);
    await flush();
    expect(events.state).toBe("waiting");
    expect(connection.status.state).toBe("waitingForSource");

    const started = Date.now();
    streamSockets()[0]!.push({
      type: "sourceOnline",
      sourceId: SOURCE,
      sinceMs: started,
      relayOrigin: ISSUER,
    });
    await vi.waitFor(
      () => {
        expect(sourceSockets()).toHaveLength(2);
      },
      { timeout: 1_000, interval: 5 },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(connection.status.state).toBe("ready");
    sourceSockets()[1]!.open();
    expect(events.state).toBe("open");
    detach();
    registry.dispose();
  });

  it("sourceRevoked / accessRevoked：那个源 unauthorized 带原因，别的源不动", async () => {
    const registry = createSourceRegistry({
      provider: provider(),
      remote: { fetch: fakeFetch, environment: null },
    });
    const b = registry.add(relayed(SOURCE));
    const c = registry.add(relayed(OTHER));
    await Promise.all([b.connect(), c.connect()]);
    const detach = attachRemoteStreams(registry, {
      auth: cloudAuth(),
      socket: socketOptions,
    });
    await flush();
    const stream = streamSockets()[0]!;
    stream.open();
    stream.push({ type: "sourceRevoked", sourceId: SOURCE });
    expect(b.status).toMatchObject({
      state: "unauthorized",
      lastError: { code: "source_revoked" },
    });
    expect(c.status.state).toBe("ready");
    stream.push({ type: "accessRevoked", sourceId: OTHER });
    expect(c.status).toMatchObject({
      state: "unauthorized",
      lastError: { code: "source_access_denied" },
    });
    detach();
    registry.dispose();
  });

  it("一个签发方一条流；没有经中继的源就不开；源表空了就关", async () => {
    const registry = createSourceRegistry({
      provider: provider(),
      remote: { fetch: fakeFetch, environment: null },
    });
    const made: string[] = [];
    const closed: string[] = [];
    const detach = attachRemoteStreams(registry, {
      auth: cloudAuth(),
      createStream: (options) => {
        made.push(options.issuer);
        return {
          issuer: options.issuer,
          state: "connecting",
          close: () => closed.push(options.issuer),
        };
      },
    });
    expect(made).toEqual([]);
    registry.add({ ...relayed(SOURCE), kind: "direct", cloudIssuer: "" });
    expect(made).toEqual([]);
    registry.add(relayed(SOURCE));
    registry.add(relayed(OTHER));
    expect(made).toEqual([ISSUER]);
    registry.remove(SOURCE);
    expect(closed).toEqual([]);
    registry.remove(OTHER);
    expect(closed).toEqual([ISSUER]);
    detach();
    registry.dispose();
  });

  it("流重新打开：离线或在等的源各 connect 一次（补上错过的 sourceOnline），就绪与失权的不动", () => {
    const target = (state: SourceState) => ({
      status: { state },
      connect: vi.fn(async () => undefined),
      revoke: vi.fn(),
    });
    const waiting = target("waitingForSource");
    const offline = target("offline");
    const ready = target("ready");
    const revoked = target("unauthorized");
    resyncTargets([waiting, offline, ready, revoked]);
    expect(waiting.connect).toHaveBeenCalledTimes(1);
    expect(offline.connect).toHaveBeenCalledTimes(1);
    expect(ready.connect).not.toHaveBeenCalled();
    expect(revoked.connect).not.toHaveBeenCalled();

    // sourceOffline 不抢先改状态；sourceOnline 对就绪的不重连。
    applyMeStreamEvent({ type: "sourceOffline", sourceId: SOURCE }, ready);
    applyMeStreamEvent({ type: "sourceOnline", sourceId: SOURCE }, ready);
    expect(ready.connect).not.toHaveBeenCalled();
    expect(ready.revoke).not.toHaveBeenCalled();
  });
});
