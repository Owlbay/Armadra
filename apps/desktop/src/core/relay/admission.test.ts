import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { signAssertion } from "../identity/cloud/fake.fixture";
import {
  ISSUER,
  LOOPBACK_ORIGIN,
  type RelayCore,
  relayCore,
  until,
} from "./core.fixture";
import type { FakeTunnel } from "./fake-relay.fixture";

/**
 * 隧道来的请求的准入（契约 §32，平台规格 core 包 §4.4）：与 Gateway 的 Bearer 模式
 * 等价——来源以 `OPEN.clientOrigin` 为准且必须可信，回环专用路径 403，没有
 * Bearer 401，升级要隧道自己签的票；会话绑在中继来源上，回环的会话进不来；
 * `cloud/login` 经隧道答原生会话。
 */

let world: RelayCore;
let tunnel: FakeTunnel;
const WORKSPACE = "ws-relay";

beforeEach(async () => {
  world = await relayCore();
  world.core.database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      WORKSPACE,
      WORKSPACE,
      world.core.directory,
      "2026-10-06T00:00:00Z",
      "2026-10-06T00:00:00Z",
    );
  await world.register();
  tunnel = await world.relay.nextTunnel(0);
  const issuer = world.cloud.registrations()[0]!.issuer;
  await until(() => world.tunnels.status(issuer).state === "ready");
});

afterEach(async () => {
  await world.close();
});

function get(
  path: string,
  headers: Record<string, string> = {},
  clientOrigin?: string | null,
) {
  return tunnel.request({
    path,
    headers,
    ...(clientOrigin === undefined ? {} : { clientOrigin }),
  });
}

describe("HTTP 准入", () => {
  it("可信来源 + 绑在中继来源上的 Bearer：放行，CORS 只回客户端来源", async () => {
    const token = world.session(ISSUER);
    const answer = await get("/api/workspaces", {
      origin: ISSUER,
      authorization: `Bearer ${token}`,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers["access-control-allow-origin"]).toBe(ISSUER);
  });

  it("没有 Bearer 答 401 unauthenticated", async () => {
    const answer = await get("/api/workspaces", { origin: ISSUER });
    expect(answer.status).toBe(401);
    expect(answer.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("回环上的会话进不了隧道（会话来源不同）", async () => {
    const token = world.session(LOOPBACK_ORIGIN);
    const answer = await get("/api/workspaces", {
      origin: ISSUER,
      authorization: `Bearer ${token}`,
    });
    expect(answer.status).toBe(401);
  });

  it("来源不在可信表里 403", async () => {
    const token = world.session(ISSUER);
    const answer = await get("/api/workspaces", {
      origin: "https://evil.test",
      authorization: `Bearer ${token}`,
    });
    expect(answer.status).toBe(403);
    expect(answer.json()).toMatchObject({ code: "forbidden" });
  });

  it("请求头的 Origin 与 OPEN.clientOrigin 不一致 403", async () => {
    const token = world.session(ISSUER);
    const answer = await get(
      "/api/workspaces",
      { origin: ISSUER, authorization: `Bearer ${token}` },
      "https://other.test",
    );
    expect(answer.status).toBe(403);
  });

  it("回环专用路径一律 403", async () => {
    const token = world.session(ISSUER);
    for (const path of [
      "/hook/report",
      "/control/x",
      "/context-link/a",
      "/browser/x",
      "/verify",
    ]) {
      const answer = await get(path, {
        origin: ISSUER,
        authorization: `Bearer ${token}`,
      });
      expect(answer.status, path).toBe(403);
    }
  });

  it("没有来源：只有 /health 与身份域的匿名面", async () => {
    expect((await get("/health")).status).toBe(200);
    // 这台测试 core 没装身份域的原样路由（答 501）：要看的是门放行了它。
    expect((await get("/api/identity/hello")).status).toBe(501);
    const token = world.session(ISSUER);
    const answer = await get("/api/workspaces", {
      authorization: `Bearer ${token}`,
    });
    expect(answer.status).toBe(403);
  });

  it("中继托管页面的同源 GET（不带 Origin、Sec-Fetch-Site: same-origin）按会话来源认", async () => {
    const token = world.session(ISSUER);
    const answer = await get("/api/workspaces", {
      "sec-fetch-site": "same-origin",
      authorization: `Bearer ${token}`,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers["access-control-allow-origin"]).toBeUndefined();
    // 别处的会话照样进不来：会话来源不对。
    const elsewhere = await get("/api/workspaces", {
      "sec-fetch-site": "same-origin",
      authorization: "Bearer not-a-session",
    });
    expect(elsewhere.status).toBe(401);
    // 跨站与没写的照旧 403。
    for (const site of ["cross-site", "same-site"]) {
      const refused = await get("/api/workspaces", {
        "sec-fetch-site": site,
        authorization: `Bearer ${token}`,
      });
      expect(refused.status).toBe(403);
    }
  });

  it("原生 App 的来源放行，CORS 回 App 自己的来源", async () => {
    const token = world.session(ISSUER);
    const answer = await get("/api/workspaces", {
      origin: "capacitor://localhost",
      authorization: `Bearer ${token}`,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers["access-control-allow-origin"]).toBe(
      "capacitor://localhost",
    );
  });

  it("预检只回 CORS", async () => {
    const answer = await tunnel.request({
      method: "OPTIONS",
      path: "/api/workspaces",
      headers: { origin: ISSUER },
    });
    expect(answer.status).toBe(204);
    expect(answer.headers["access-control-allow-headers"]).toContain(
      "authorization",
    );
  });
});

describe("WebSocket 准入", () => {
  async function ticket(token: string): Promise<string> {
    const answer = await tunnel.request({
      method: "POST",
      path: "/api/identity/ws-ticket",
      headers: { origin: ISSUER, authorization: `Bearer ${token}` },
    });
    expect(answer.status).toBe(200);
    return answer.json<{ ticket: string }>().ticket;
  }

  function upgrade(protocols: string[], origin: string | null = ISSUER) {
    const socket = tunnel.websocket(`/api/workspaces/${WORKSPACE}/events`, {
      protocols,
      origin,
    });
    return new Promise<{ socket: WebSocket; status: number }>((resolve) => {
      socket.once("open", () => resolve({ socket, status: 101 }));
      socket.once(
        "unexpected-response",
        (_request, response: IncomingMessage) =>
          resolve({ socket, status: response.statusCode ?? 0 }),
      );
    });
  }

  it("隧道签的票换得到事件流；同一张票第二次 401", async () => {
    const token = world.session(ISSUER);
    const t = await ticket(token);
    const first = await upgrade([`armadra-ticket.${t}`]);
    expect(first.status).toBe(101);
    first.socket.close();
    const again = await upgrade([`armadra-ticket.${t}`]);
    expect(again.status).toBe(401);
  });

  it("没有票 401；没有来源 403", async () => {
    expect((await upgrade([])).status).toBe(401);
    const token = world.session(ISSUER);
    const t = await ticket(token);
    expect((await upgrade([`armadra-ticket.${t}`], null)).status).toBe(403);
  });

  it("票只发给有 Bearer 的会话", async () => {
    const answer = await tunnel.request({
      method: "POST",
      path: "/api/identity/ws-ticket",
      headers: { origin: ISSUER },
    });
    expect(answer.status).toBe(401);
  });
});

describe("经隧道换会话", () => {
  it("cloud/login 经隧道答原生会话（不发 Cookie），换来的令牌在隧道上能用", async () => {
    const hostId = world.store.hostId();
    const owner = world.store.transaction((tx) => tx.owner())!;
    await world.cloud.bind(
      owner.principalId,
      signAssertion({ aud: hostId, nowMs: Date.now() }),
    );
    const login = await tunnel.request({
      method: "POST",
      path: "/api/identity/cloud/login",
      headers: { origin: ISSUER, "content-type": "application/json" },
      body: JSON.stringify({
        assertion: signAssertion({ aud: hostId, nowMs: Date.now() }),
      }),
    });
    expect(login.status, login.body.toString()).toBe(200);
    expect(login.headers["set-cookie"]).toBeUndefined();
    const session = login.json<{
      session: { native?: { accessToken: string } };
    }>().session;
    expect(session.native?.accessToken).toBeTruthy();
    const answer = await get("/api/workspaces", {
      origin: ISSUER,
      authorization: `Bearer ${session.native!.accessToken}`,
    });
    expect(answer.status).toBe(200);
  });
});

describe("状态事件", () => {
  it("cloud.tunnel 发给正被看着的画布", async () => {
    const issuer = world.cloud.registrations()[0]!.issuer;
    const port = new URL(world.base).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/workspaces/${WORKSPACE}/events`,
      { origin: LOOPBACK_ORIGIN },
    );
    await once(socket, "open");
    const frames: { type: string; issuer?: string; state?: string }[] = [];
    socket.on("message", (data: Buffer) => {
      frames.push(JSON.parse(data.toString("utf8")));
    });
    world.tunnels.stop(issuer);
    await until(() => frames.some((frame) => frame.type === "cloud.tunnel"));
    expect(frames.find((frame) => frame.type === "cloud.tunnel")).toEqual({
      type: "cloud.tunnel",
      issuer,
      state: "disabled",
    });
    socket.close();
  });
});
