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
});
