import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { EventBus } from "../bus";
import type { CorePlatform, ErrorContext } from "../platform";
import { CoreServer } from "./server";

/**
 * 请求处理里没人接住的错误交给 `platform.reportError`（外部服务 §11.2），回给
 * 客户端的仍是那条不带细节的 500。
 */
describe("未接住的请求错误", () => {
  it("报给壳一次，来源是 http，响应里没有错误正文", async () => {
    const reported: [unknown, ErrorContext][] = [];
    const log = { error() {}, warn() {}, info() {}, debug() {} };
    const server = new CoreServer({
      platform: {
        log,
        reportError: (error: unknown, context: ErrorContext) =>
          reported.push([error, context]),
      } as unknown as CorePlatform,
      bus: new EventBus(),
      version: "test",
    });
    // 路由必须在表里；挑一条无副作用的 GET 让它抛。
    server.router.handle("GET", "/api/workspaces/{workspaceId}/events", () => {
      throw new Error("secret body text");
    });
    const listener = server.createListener();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const { port } = listener.address() as AddressInfo;
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/w1/events`,
      );
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("secret body text");
      expect(reported).toHaveLength(1);
      expect((reported[0]![0] as Error).message).toBe("secret body text");
      expect(reported[0]![1]).toEqual({ source: "http" });
    } finally {
      await server.close();
    }
  });

  it("没接住的坏 JSON 是 400，消息里引着的请求体不进日志也不上报（安全审查 L）", async () => {
    const reported: unknown[] = [];
    const logged: unknown[] = [];
    const log = {
      error: (...args: unknown[]) => logged.push(args),
      warn() {},
      info() {},
      debug() {},
    };
    const server = new CoreServer({
      platform: {
        log,
        reportError: (error: unknown) => reported.push(error),
      } as unknown as CorePlatform,
      bus: new EventBus(),
      version: "test",
    });
    server.router.handle(
      "POST",
      "/api/workspaces/{workspaceId}/boards",
      (_match, request) => ({ status: 200, body: request.json() }),
    );
    const listener = server.createListener();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const { port } = listener.address() as AddressInfo;
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/w1/boards`,
        { method: "POST", body: "sk-ant-oat01-SECRET-not-json" },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("SECRET");
      expect(reported).toEqual([]);
      expect(JSON.stringify(logged)).not.toContain("SECRET");
    } finally {
      await server.close();
    }
  });
});
