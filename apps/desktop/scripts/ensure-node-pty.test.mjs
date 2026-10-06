import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ensurePrebuiltExecutable } from "./ensure-node-pty.mjs";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "ensure-node-pty.mjs",
);

test("spawn-helper 缺执行位时补上，再跑一次什么也不改", () => {
  const root = mkdtempSync(join(tmpdir(), "armadra-node-pty-"));
  try {
    const helpers = ["darwin-arm64", "darwin-x64"].map((platform) => {
      mkdirSync(join(root, "prebuilds", platform), { recursive: true });
      const helper = join(root, "prebuilds", platform, "spawn-helper");
      writeFileSync(helper, "");
      chmodSync(helper, 0o644);
      return helper;
    });
    // 没有 spawn-helper 的平台目录不算。
    mkdirSync(join(root, "prebuilds", "win32-x64"), { recursive: true });
    assert.deepEqual(ensurePrebuiltExecutable(root).sort(), helpers.sort());
    for (const helper of helpers)
      assert.equal(statSync(helper).mode & 0o111, 0o111);
    assert.deepEqual(ensurePrebuiltExecutable(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("没有 prebuilds 目录：什么也不做", () => {
  const root = mkdtempSync(join(tmpdir(), "armadra-node-pty-"));
  try {
    assert.deepEqual(ensurePrebuiltExecutable(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--executable-only 可重复执行，退出 0（安装后与 libs:build 都调它）", () => {
  for (let round = 0; round < 2; round += 1) {
    const result = spawnSync(process.execPath, [script, "--executable-only"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
});
