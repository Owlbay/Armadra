import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { tempDir } from "../testing/temp-dir";
import { initializeContextSequence } from "./sequences";
import { sourceRevision } from "../runs/reports";

it("creates the real generation allocator once, privately, and never resets an existing revision", () => {
  const root = tempDir("ar-seq-");
  const id = "00000000-0000-4000-8000-000000000001";
  expect(
    initializeContextSequence(join(root, "context-sequences"), id, 1),
  ).toBe(true);
  const path = join(root, "context-sequences", id + "-1.seq");
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "context-sequences")).mode & 0o777).toBe(0o700);
  }
  expect(sourceRevision(root, id, 1)).toBe(0);
  const bytes = Buffer.alloc(16);
  bytes.writeBigUInt64BE(9n, 0);
  bytes.writeBigUInt64BE(~9n & 0xffff_ffff_ffff_ffffn, 8);
  writeFileSync(path, bytes);
  expect(
    initializeContextSequence(join(root, "context-sequences"), id, 1),
  ).toBe(true);
  expect(sourceRevision(root, id, 1)).toBe(9);
  writeFileSync(path, "corrupt");
  expect(
    initializeContextSequence(join(root, "context-sequences"), id, 1),
  ).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("corrupt");
  expect(
    initializeContextSequence(join(root, "context-sequences"), "../escape", 1),
  ).toBe(false);
});
