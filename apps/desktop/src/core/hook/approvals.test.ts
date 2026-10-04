import {
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { permissionWaitEnvironment, sweepOrphans } from "./approvals";

/**
 * 只有 Claude 的 Hook 会等画布的答复。自定义 Agent 按它借用的内置 CLI 判：底层
 * 是 Claude 的 `custom:` 条目以前拿到的是原始 id，于是没有画布审批。
 */
describe("the approval wait variable", () => {
  it("is set for Claude when replying on the canvas is on", () => {
    expect(permissionWaitEnvironment("claude", true)).toHaveLength(1);
    expect(permissionWaitEnvironment("claude", false)).toEqual([]);
    expect(permissionWaitEnvironment("codex", true)).toEqual([]);
  });

  it("is set for ama, whose adapter answers through the same files", () => {
    expect(permissionWaitEnvironment("ama", true)).toEqual([
      ["ARMADRA_PERM_WAIT_SECS", "45"],
    ]);
    expect(permissionWaitEnvironment("ama", false)).toEqual([]);
  });

  it("follows a custom entry to the built-in it borrows", () => {
    const baseOf = (id: string) =>
      id === "custom:review" ? "claude" : id === "custom:fast" ? "codex" : id;
    expect(
      permissionWaitEnvironment("custom:review", true, baseOf),
    ).toHaveLength(1);
    expect(permissionWaitEnvironment("custom:fast", true, baseOf)).toEqual([]);
  });
});

describe("the orphan sweep", () => {
  it("judges age by the clock it is given, not the process's", () => {
    const directory = mkdtempSync(join(tmpdir(), "armadra-hook-sweep-"));
    try {
      const written = Date.UTC(2026, 0, 1, 12, 0, 0);
      for (const name of ["a.json", "a.answer", "keep.txt"]) {
        const path = join(directory, name);
        writeFileSync(path, "{}");
        utimesSync(path, written / 1000, written / 1000);
      }
      expect(sweepOrphans(directory, 1_000, written + 1_000)).toBe(0);
      expect(sweepOrphans(directory, 1_000, written + 1_001)).toBe(2);
      expect(readdirSync(directory)).toEqual(["keep.txt"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
