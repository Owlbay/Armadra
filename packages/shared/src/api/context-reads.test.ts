import { describe, expect, it } from "vitest";

import { agents } from "../contract/agents.js";
import { contextReadsResponseSchema } from "./context-reads.js";

/**
 * 页面解析 `agents.contextReads` 的答案时用的 schema 必须和契约的输出同一个
 * 形状：最近几条叫 `reads`（`core-json-api.md` §7）。字段名各写一份，曾经写
 * 岔过一次，页面读 `recent`，清单永远是空的。
 */
const wire = {
  total: 2,
  bytes: 4096,
  reads: [
    {
      id: "r1",
      readerNodeId: "node-a",
      readerHandle: "planner",
      readerTitle: "Planner",
      verb: "context summary",
      bytes: 2048,
      atMs: 1,
    },
    {
      id: "r2",
      readerNodeId: "node-b",
      verb: "context read",
      bytes: 2048,
      atMs: 2,
    },
  ],
};

describe("contextReadsResponseSchema", () => {
  it("接受契约输出的样例并保留 reads", async () => {
    const output = agents.contextReads["~orpc"].outputSchema!;
    const contract = await output["~standard"].validate(wire);
    expect("issues" in contract && contract.issues).toBeFalsy();
    const parsed = contextReadsResponseSchema.parse(wire);
    expect(parsed.reads).toHaveLength(2);
    expect(parsed.reads[0]?.readerTitle).toBe("Planner");
  });

  it("契约输出的字段名与页面 schema 一致", () => {
    expect(Object.keys(contextReadsResponseSchema.shape).sort()).toEqual(
      Object.keys(wire).sort(),
    );
  });
});
