import { describe, expect, it } from "vitest";

import { canvasEdgeSchema } from "./nodes.js";

/**
 * 连线两端的边由页面按两端相对位置现算（#211），边上不存把手。老数据里若带着
 * `sourceHandle` / `targetHandle`，读的时候丢掉，不用迁移。
 */
describe("canvasEdgeSchema", () => {
  it("读到带把手字段的旧边时丢掉把手，其余照常", () => {
    const parsed = canvasEdgeSchema.parse({
      id: "019ff7d1-0d12-7421-833d-2c5e8d64ef01",
      boardId: "019ff7d1-0d12-7421-833d-2c5e8d64ef02",
      source: "019ff7d1-0d12-7421-833d-2c5e8d64ef03",
      target: "019ff7d1-0d12-7421-833d-2c5e8d64ef04",
      sourceHandle: "right",
      targetHandle: "left",
      createdAt: "2026-10-09T00:00:00.000Z",
      updatedAt: "2026-10-09T00:00:00.000Z",
    });
    expect(parsed).not.toHaveProperty("sourceHandle");
    expect(parsed).not.toHaveProperty("targetHandle");
    expect(parsed.kind).toBe("link");
  });
});
