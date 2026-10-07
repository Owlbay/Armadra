import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { EventBus } from "../bus";
import { install as installEvents } from "../events";
import type { AuthorizationSubject } from "../identity/authorize";
import {
  type RequestIdentity,
  accessChanged,
  installRouteGuard,
  resetRouteGuard,
  runAs,
} from "../identity/gate";
import type { CorePlatform } from "../platform";
import { install as installSettings } from "../settings";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { connectPeer } from "./peer.fixture";
import { installContract, registerProcedures } from "./rpc";
import { type AdmissionVerdict, CoreServer } from "./server";
import {
  CLOSE_BAD_FRAME,
  CLOSE_GOING_AWAY,
  CLOSE_LIMIT,
  CLOSE_PROTOCOL,
  CLOSE_REVOKED,
  CLOSE_TOO_LARGE,
  CONTROL_PROTOCOL,
  MAX_ITERATORS,
  installControlPlane,
} from "./ws-control";

/**
 * 控制面 `/api/ws` 的升级层（工程规范化包 §2.5）：子协议、坏帧与超限的关闭码、
 * 订阅数上限、心跳、停机 1001、按身份跑每一帧，以及授权变化与票错。
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  resetRouteGuard();
});

/** 一台装了工作空间、设置、事件三个域的 core，`system.*` 由用例自己登记。 */
async function core(options: { front?: RequestIdentity } = {}): Promise<{
  core: Fixture;
  base: string;
  workspaceId: string;
}> {
  const made = fixture([installEvents, installWorkspaces, installSettings]);
  registerProcedures(made.server, "system", {
    hello: () => {
      throw new Error("not used");
    },
    ping: ({ ts }) => ({ ts, serverTs: Date.now() }),
  });
  installContract(made.server, {
    validateOutput: true,
    platform: made.platform,
  });
  const listener = made.server.createListener();
  let port: number;
  if (options.front === undefined) {
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    port = (listener.address() as AddressInfo).port;
  } else {
    // 和 Gateway 一样：认证完的升级在这个人的身份下转给 core。
    const identity = options.front;
    const front = createServer();
    front.on("upgrade", (request, socket, head) => {
      runAs(identity, () => listener.emit("upgrade", request, socket, head));
    });
    await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));
    cleanup.push(() => new Promise<void>((done) => front.close(() => done())));
    port = (front.address() as AddressInfo).port;
  }
  cleanup.push(async () => {
    await made.server.close();
    made.close();
  });
  const created = await made.call("POST", "/api/workspaces", {
    name: "控制面",
    rootPath: made.directory,
  });
  return {
    core: made,
    base: `http://127.0.0.1:${port}`,
    workspaceId: (created.body as { id: string }).id,
  };
}

describe("升级与子协议", () => {
  it("回选 armadra-rpc.v1；带票时票不被回选", async () => {
    const { base } = await core();
    const peer = await connectPeer(base, [
      "armadra-ticket.abc",
      CONTROL_PROTOCOL,
    ]);
    expect(peer.socket.protocol).toBe(CONTROL_PROTOCOL);
    const { response } = peer.call("system.ping", { ts: 7 });
    const answer = await response;
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ts: 7 });
    peer.socket.close();
  });

  it("没报 armadra-rpc.v1：升级完成后以 4409 关", async () => {
    const { base } = await core();
    const peer = await connectPeer(base, ["armadra-ticket.abc"]);
    expect((await peer.closed).code).toBe(CLOSE_PROTOCOL);
  });

  it("准入门拒绝（票错、没票）：升级前答 401，没有 socket", async () => {
    const { core: made, base } = await core();
    made.server.admission(
      (_request, upgrade): AdmissionVerdict =>
        upgrade
          ? {
              refusal: {
                status: 401,
                body: { code: "unauthenticated", message: "票不对" },
              },
            }
          : {},
    );
    await expect(
      connectPeer(base, ["armadra-ticket.wrong", CONTROL_PROTOCOL]),
    ).rejects.toThrow("upgrade 401");
  });

  it("二进制帧、不是 peer 消息的文本帧以 4400 关", async () => {
    const { base } = await core();
    const binary = await connectPeer(base);
    binary.socket.send(Buffer.from([1, 2, 3]));
    expect((await binary.closed).code).toBe(CLOSE_BAD_FRAME);
    const text = await connectPeer(base);
    text.socket.send("hello");
    expect((await text.closed).code).toBe(CLOSE_BAD_FRAME);
  });

  it("超过 maxFrameBytes 的帧以 4413 关", async () => {
    const { base } = await core();
    const peer = await connectPeer(base);
    peer.socket.send(
      JSON.stringify({ i: "1", p: { u: "/x", b: "a".repeat(1_100_000) } }),
    );
    expect((await peer.closed).code).toBe(CLOSE_TOO_LARGE);
  });

  it("订阅只经控制面：HTTP 上调订阅答 405", async () => {
    const { base, workspaceId } = await core();
    const answer = await fetch(`${base}/api/rpc/workspaces/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { workspaceId } }),
    });
    expect(answer.status).toBe(405);
    expect(await answer.json()).toMatchObject({ code: "method_not_allowed" });
  });

  it("core 停机时以 1001 关", async () => {
    const { core: made, base } = await core();
    const peer = await connectPeer(base);
    await made.server.close();
    expect((await peer.closed).code).toBe(CLOSE_GOING_AWAY);
  });
});

describe("订阅数上限", () => {
  it(`第 ${MAX_ITERATORS + 1} 个订阅答 limit_reached，随后以 4429 关`, async () => {
    const { base, workspaceId } = await core();
    const peer = await connectPeer(base);
    const opened = [];
    for (let index = 0; index < MAX_ITERATORS; index += 1) {
      opened.push(peer.call("workspaces.events", { workspaceId }).response);
    }
    for (const response of await Promise.all(opened)) {
      expect(response.status).toBe(200);
    }
    const extra = await peer.call("workspaces.events", { workspaceId })
      .response;
    expect(extra.status).toBe(429);
    expect(extra.body).toMatchObject({ code: "limit_reached" });
    expect((await peer.closed).code).toBe(CLOSE_LIMIT);
  });

  it("取消的订阅不占名额", async () => {
    const { base, workspaceId } = await core();
    const peer = await connectPeer(base);
    for (let index = 0; index < MAX_ITERATORS + 4; index += 1) {
      const { id, response } = peer.call("workspaces.events", { workspaceId });
      expect((await response).status).toBe(200);
      await peer.until(id, (events) => events.length >= 1);
      peer.abort(id);
    }
    const { response } = peer.call("system.ping", { ts: 1 });
    expect((await response).status).toBe(200);
    peer.socket.close();
  });
});

describe("身份与复核", () => {
  const MEMBER: AuthorizationSubject = {
    principalId: "p-member",
    kind: "member",
    scopes: [],
  };

  it("会话没了：下一帧调用不再答，以 4403 关", async () => {
    let live = true;
    installRouteGuard(() => ({ allowed: true }));
    const { base } = await core({
      front: { subject: MEMBER, revalidate: () => (live ? MEMBER : undefined) },
    });
    const peer = await connectPeer(base);
    expect((await peer.call("system.ping", { ts: 1 }).response).status).toBe(
      200,
    );
    live = false;
    peer.call("system.ping", { ts: 2 });
    expect((await peer.closed).code).toBe(CLOSE_REVOKED);
  });

  it("授权收回（路由门不再放行这条连接）：以 4403 关", async () => {
    let granted = true;
    installRouteGuard(() => ({ allowed: granted }));
    const { base } = await core({
      front: { subject: MEMBER, revalidate: () => MEMBER },
    });
    const peer = await connectPeer(base);
    granted = false;
    accessChanged();
    expect((await peer.closed).code).toBe(CLOSE_REVOKED);
  });

  it("procedure 的 scope 不放行：这次调用答 forbidden，连接不断", async () => {
    installRouteGuard((request) => ({
      allowed: !request.path.startsWith("rpc:system."),
    }));
    const { base } = await core({
      front: { subject: MEMBER, revalidate: () => MEMBER },
    });
    const peer = await connectPeer(base);
    const answer = await peer.call("system.ping", { ts: 1 }).response;
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: "forbidden" });
    expect(peer.socket.readyState).toBe(WebSocket.OPEN);
    peer.socket.close();
  });
});

describe("心跳", () => {
  it("连续两次没有 pong 就断", async () => {
    const log = { error() {}, warn() {}, info() {}, debug() {} };
    const server = new CoreServer({
      platform: { log } as unknown as CorePlatform,
      bus: new EventBus(),
      version: "test",
      heartbeatMs: 40,
    });
    installControlPlane(server, () => {});
    const listener = server.createListener();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    cleanup.push(() => server.close());
    const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    const silent = await connectPeer(base, [CONTROL_PROTOCOL], {
      autoPong: false,
    });
    const answering = await connectPeer(base);
    expect((await silent.closed).code).toBe(1006);
    expect(answering.socket.readyState).toBe(WebSocket.OPEN);
    answering.socket.close();
  });
});
