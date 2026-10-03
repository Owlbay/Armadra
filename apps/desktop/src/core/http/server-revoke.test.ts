import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { EventBus } from "../bus";
import type { AuthorizationSubject } from "../identity/authorize";
import {
  type RequestIdentity,
  accessChanged,
  installRouteGuard,
  requestIdentity,
  resetRouteGuard,
  runAs,
} from "../identity/gate";
import type { CorePlatform } from "../platform";
import { CLOSE_ACCESS_REVOKED, CoreServer } from "./server";

/**
 * 已经升级的流在授权变化之后复核（安全审查 2026-10 的 M3）：终端、语言服务、
 * 浏览器画面这些流自己不复核，撤销设备或收回共享之后那条 socket 不能接着读写。
 * 复核走的是同一道路由门，主体换成 `revalidate()` 给的那一个。
 */

const PATH = "/api/terminals/{sessionId}/ws";
const MEMBER: AuthorizationSubject = {
  principalId: "p-member",
  kind: "member",
  scopes: [],
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  resetRouteGuard();
});

async function serve(identity: RequestIdentity): Promise<number> {
  const log = { error() {}, warn() {}, info() {}, debug() {} };
  const core = new CoreServer({
    platform: { log } as unknown as CorePlatform,
    bus: new EventBus(),
    version: "test",
  });
  core.stream(PATH, (connection) => {
    connection.on("message", () => {});
  });
  // 和 Gateway 一样：认证完的升级在这个人的身份下转给 core。
  const delegate = core.createListener();
  const front = createServer();
  front.on("upgrade", (request, socket, head) => {
    runAs(identity, () => delegate.emit("upgrade", request, socket, head));
  });
  await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));
  cleanup.push(
    () => new Promise<void>((done) => front.close(() => done())),
    () => core.close(),
  );
  return (front.address() as AddressInfo).port;
}

function open(
  port: number,
): Promise<{ socket: WebSocket; code: Promise<number> }> {
  return new Promise((done, failed) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/s1/ws`, {
      origin: `http://127.0.0.1:${port}`,
    });
    const code = new Promise<number>((settle) =>
      socket.once("close", (value) => settle(value)),
    );
    socket.once("open", () => done({ socket, code }));
    socket.once("error", failed);
  });
}

describe("长连接在授权变化后复核", () => {
  it("会话失效（revalidate 给不出主体）就以 4403 关流", async () => {
    let live = true;
    const port = await serve({
      subject: MEMBER,
      revalidate: () => (live ? MEMBER : undefined),
    });
    installRouteGuard(() => ({ allowed: true }));
    const { socket, code } = await open(port);
    accessChanged();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    live = false;
    accessChanged();
    expect(await code).toBe(CLOSE_ACCESS_REVOKED);
  });

  it("主体还在、但路由门不再放行（收回共享）也关；判定用的是复核后的主体", async () => {
    let granted = true;
    const seen: string[] = [];
    const port = await serve({
      subject: MEMBER,
      revalidate: () => MEMBER,
    });
    installRouteGuard(() => {
      seen.push(requestIdentity()?.subject.principalId ?? "");
      return { allowed: granted };
    });
    const { code } = await open(port);
    granted = false;
    accessChanged();
    expect(await code).toBe(CLOSE_ACCESS_REVOKED);
    expect(seen.every((value) => value === "p-member")).toBe(true);
  });

  it("没有请求身份（桌面壳）的流不受影响", async () => {
    const log = { error() {}, warn() {}, info() {}, debug() {} };
    const core = new CoreServer({
      platform: { log } as unknown as CorePlatform,
      bus: new EventBus(),
      version: "test",
    });
    core.stream(PATH, () => {});
    const listener = core.createListener();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    cleanup.push(() => core.close());
    // 升级本身要过门：放行它，再在升级之后把门关上。
    let allow = true;
    installRouteGuard(() => ({ allowed: allow }));
    const { socket } = await open((listener.address() as AddressInfo).port);
    allow = false;
    accessChanged();
    await new Promise((done) => setTimeout(done, 50));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});
