import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  chosenFamilies,
  cliPrerequisites,
  planScenarios,
} from "./preflight.mjs";

const NOW = Date.parse("2026-10-04T00:00:00Z");
const installed = (program) => `${program} 1.0.0`;

function tempHome(auth) {
  const home = mkdtempSync(join(tmpdir(), "agent-e2e-preflight-"));
  if (auth !== undefined) {
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex/auth.json"), auth);
  }
  return home;
}

test("没有 ~/.codex/auth.json：Codex 记不可用并写明原因，Claude 不受影响", (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const clis = cliPrerequisites({ home, version: installed, now: NOW });
  assert.equal(clis.claude.ok, true);
  assert.equal(clis.codex.ok, false);
  assert.match(clis.codex.reason, /没有 ~\/\.codex\/auth\.json/);
  const plan = planScenarios(["1", "2", "3", "7"], clis);
  assert.deepEqual(plan.run, ["2", "7"]);
  assert.deepEqual(Object.keys(plan.skip), ["1", "3"]);
  assert.match(plan.skip["1"], /^codex：/);
});

test("auth.json 超过 7 天没刷新、或不是 JSON：Codex 不可用", (t) => {
  const stale = tempHome(
    JSON.stringify({ last_refresh: "2026-09-01T00:00:00Z" }),
  );
  const broken = tempHome("{");
  t.after(() => {
    rmSync(stale, { recursive: true, force: true });
    rmSync(broken, { recursive: true, force: true });
  });
  const old = cliPrerequisites({ home: stale, version: installed, now: NOW });
  assert.equal(old.codex.ok, false);
  assert.match(old.codex.reason, /超过 7 天/);
  const bad = cliPrerequisites({ home: broken, version: installed, now: NOW });
  assert.equal(bad.codex.ok, false);
  assert.match(bad.codex.reason, /不是 JSON/);
});

test("新鲜的 auth.json：Codex 可用，带版本与刷新时间", (t) => {
  const home = tempHome(
    JSON.stringify({ last_refresh: "2026-10-03T00:00:00Z" }),
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const clis = cliPrerequisites({ home, version: installed, now: NOW });
  assert.equal(clis.codex.ok, true);
  assert.equal(clis.codex.version, "codex 1.0.0");
  assert.equal(clis.codex.refreshedAt, Date.parse("2026-10-03T00:00:00Z"));
});

test("没装的 CLI：--version 抛错即不可用，依赖它的场景全跳过", (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const clis = cliPrerequisites({
    home,
    version: () => {
      throw new Error("ENOENT");
    },
    now: NOW,
  });
  assert.equal(clis.claude.ok, false);
  assert.match(clis.claude.reason, /没有 claude/);
  const plan = planScenarios(["1", "2", "4", "8"], clis);
  assert.deepEqual(plan.run, []);
  assert.match(plan.skip["4"], /claude：.*；codex：/);
});

test("家名单：没设是全部，设了只取名单里的", () => {
  const all = ["claude", "codex", "pi"];
  assert.deepEqual([...chosenFamilies(undefined, all)], all);
  assert.deepEqual([...chosenFamilies(" claude, pi ,", all)], ["claude", "pi"]);
});

test("画面进报告前：去控制序列、遮长串、只留最后 40 行", async () => {
  const { sanitizeScreen } = await import("./safety.mjs");
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  lines.push(
    "\x1b[1mQuick safety check\x1b[0m",
    "token sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  );
  const out = sanitizeScreen(lines.join("\n")).split("\n");
  assert.equal(out.length, 40);
  assert.equal(out.at(-2), "Quick safety check");
  assert.equal(out.at(-1), "token <redacted>");
});
