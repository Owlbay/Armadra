// Windows 真机验收探针的干跑（补全计划 G3-2）：三个平台的 CI 都跑，Windows 上
// 顺带核对本机探测（三种 shell、csc）在 runner 上答得出来。真跑要装包、起应用，
// 在夜间作业与用户的真机上做。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHECKS,
  diffSnapshots,
  launchLine,
  markerLine,
  newResult,
  parseArgs,
  probeLaunchConfig,
  snapshot,
  summarize,
  validateResult,
} from "./windows-acceptance-lib.mjs";

const probe = join(
  dirname(fileURLToPath(import.meta.url)),
  "windows-acceptance.mjs",
);

test("the dry run writes a result.json every check of which is skipped", () => {
  const out = mkdtempSync(join(tmpdir(), "armadra-acceptance-test-"));
  try {
    const run = spawnSync(
      process.execPath,
      [probe, "--dry-run", "--out", out],
      {
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    assert.deepEqual(validateResult(result), []);
    assert.equal(result.status, "dryRun");
    assert.equal(result.options.mode, "dryRun");
    assert.ok(result.checks.every((check) => check.status === "skip"));
    assert.deepEqual(
      result.checks.map((check) => check.id),
      CHECKS.map((check) => check.id),
    );
    assert.ok(result.selfTest.length > 0);
    assert.ok(
      result.selfTest.every((entry) => entry.ok),
      JSON.stringify(result.selfTest),
    );
    if (process.platform === "win32") {
      // The machine probe the real run depends on: the shells and the
      // compiler every Windows has.
      assert.ok(result.machine.shells.cmd, "no cmd.exe");
      assert.ok(result.machine.shells.powershell, "no powershell.exe");
      assert.match(result.machine.shells.powershellVersion ?? "", /^5\./);
      assert.ok(result.machine.csc, "no csc.exe");
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("arguments: one of --installer / --app, or --dry-run", () => {
  assert.throws(() => parseArgs([]), /--installer 与 --app/);
  assert.throws(() => parseArgs(["--installer", "a", "--app", "b"]));
  assert.throws(() => parseArgs(["--app"]), /需要一个值/);
  assert.throws(() => parseArgs(["--soak-minutes", "-1", "--app", "a"]));
  assert.throws(() => parseArgs(["--bogus"]), /不认识/);
  const options = parseArgs([
    "--app",
    "x.exe",
    "--with-codex",
    "--soak-minutes",
    "1",
  ]);
  assert.equal(options.soakMinutes, 1);
  assert.equal(options.withCodex, true);
});

test("a failed check fails the run; a pending one leaves it incomplete", () => {
  const result = newResult(parseArgs(["--app", "x.exe"]));
  for (const check of result.checks) check.status = "pass";
  assert.equal(summarize(result), "passed");
  result.checks[3].status = "warn";
  result.checks[4].status = "skip";
  assert.equal(summarize(result), "passed");
  result.checks[5].status = "pending";
  assert.equal(summarize(result), "incomplete");
  result.checks[6].status = "fail";
  assert.equal(summarize(result), "failed");
  assert.deepEqual(result.failures, [result.checks[6].id]);
  assert.deepEqual(validateResult({ ...result, status: "failed" }), []);
  assert.ok(validateResult({ ...result, checks: [] }).length > 0);
});

test("the snapshot sees a changed file and a new directory, not an untouched one", () => {
  const root = mkdtempSync(join(tmpdir(), "armadra-acceptance-snap-"));
  try {
    const paths = [join(root, "a.toml"), join(root, "dir")];
    const before = snapshot(paths);
    assert.deepEqual(diffSnapshots(before, snapshot(paths)), []);
    spawnSync(process.execPath, [
      "-e",
      `require("fs").mkdirSync(${JSON.stringify(paths[1])}); require("fs").writeFileSync(${JSON.stringify(paths[0])}, "x")`,
    ]);
    assert.deepEqual(
      diffSnapshots(before, snapshot(paths))
        .map((row) => row.path)
        .sort(),
      [...paths].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch lines quote for each shell and the marker never appears in its own source", () => {
  assert.equal(
    launchLine("cmd", "C:\\a b\\run.exe", ["x|y"]),
    '"C:\\a b\\run.exe" "x|y"',
  );
  assert.equal(
    launchLine("powershell", "C:\\run.exe", ["it's"]),
    "& 'C:\\run.exe' 'it''s'",
  );
  assert.throws(() => launchLine("cmd", "C:\\run.exe", ['say "hi"']));
  assert.throws(() => launchLine("bash", "x", []));
  for (const dialect of ["cmd", "pwsh", "powershell"])
    assert.ok(!markerLine(dialect, "ACC-1-OK").includes("ACC-1-OK"));
  const config = probeLaunchConfig({ client: "C:\\c.cmd" }).split("\r\n");
  assert.equal(config[0], "armadra-launch 1");
  assert.ok(config.includes("gate=ARMADRA_NODE_ID"));
  assert.ok(config.includes("credential-var=ARMADRA_PROBE_TOKEN"));
});
