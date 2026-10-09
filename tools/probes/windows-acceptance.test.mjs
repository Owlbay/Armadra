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
  idleHostVerdict,
  isSessionHost,
  launchLine,
  markerLine,
  newResult,
  PAGE_HELPERS,
  parseArgs,
  probeLaunchConfig,
  responsiveAfterLoop,
  snapshot,
  summarize,
  userConfigTargets,
  validateResult,
  waitForTerminalRoute,
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
  // The probe threw half-way: everything after is skipped, and that is a failure.
  const aborted = newResult(parseArgs(["--app", "x.exe"]));
  for (const check of aborted.checks) check.status = "skip";
  aborted.error = "Error: boom";
  assert.equal(summarize(aborted), "failed");
  assert.deepEqual(aborted.failures, ["probe.error"]);
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

test("the updater watch skips the installer's own copy and still sees downloads", () => {
  const root = mkdtempSync(join(tmpdir(), "armadra-acceptance-updater-"));
  try {
    const targets = userConfigTargets({ home: root, localAppData: root });
    const before = snapshot(targets);
    // NSIS 静默安装把自己复制成 armadra-updater\installer.exe（nightly 37235828235）。
    spawnSync(process.execPath, [
      "-e",
      `const fs = require("fs"); fs.mkdirSync(${JSON.stringify(join(root, "armadra-updater"))}); fs.writeFileSync(${JSON.stringify(join(root, "armadra-updater", "installer.exe"))}, "x")`,
    ]);
    assert.deepEqual(diffSnapshots(before, snapshot(targets)), []);
    spawnSync(process.execPath, [
      "-e",
      `require("fs").mkdirSync(${JSON.stringify(join(root, "armadra-updater", "pending"))})`,
    ]);
    assert.deepEqual(
      diffSnapshots(before, snapshot(targets)).map((row) => row.path),
      [join(root, "armadra-updater", "pending")],
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

test("the idle host before the uninstall passes only when it was asked to leave", () => {
  const listening =
    "session host listening on \\\\.\\pipe\\armadra-session-x\n";
  const asked = `${listening}shutdownIfIdle on connection 1: leaving\nsession host leaving: shutdownIfIdle\n`;
  assert.equal(idleHostVerdict({ pid: 9, log: asked }).ok, true);
  // Killed by name: no reason in its own log.
  assert.equal(idleHostVerdict({ pid: 9, log: listening }).ok, false);
  // Left on its own clock rather than because it was asked.
  assert.equal(
    idleHostVerdict({
      pid: 9,
      log: `${listening}session host leaving: no live session and no client for 10000ms\n`,
    }).ok,
    false,
  );
  assert.equal(idleHostVerdict({ pid: 9, log: asked, alive: true }).ok, false);
  assert.equal(idleHostVerdict({ started: false, log: "" }).ok, false);
});

test("a session host is told apart by its bundle on the command line", () => {
  assert.equal(
    isSessionHost(
      String.raw`"C:\x\Armadra.exe" C:\x\resources\session-host\host.cjs C:\data`,
    ),
    true,
  );
  assert.equal(
    isSessionHost(String.raw`"C:\x\Armadra.exe" --type=renderer`),
    false,
  );
  assert.equal(isSessionHost(undefined), false);
});

test("after a restart the probe waits for the terminal route and keeps the first answer", async () => {
  const answers = [401, 401, 200];
  const asked = [];
  const ready = await waitForTerminalRoute(async (path) => {
    asked.push(path);
    return { status: answers.shift() ?? 200 };
  }, "s1");
  assert.equal(ready.firstAnswer, 401);
  assert.deepEqual(asked, Array(3).fill("/api/terminals/s1"));
  // 等不到不抛：后面的核对自己判失败。
  const never = await waitForTerminalRoute(
    async () => ({ status: 401 }),
    "s1",
    600,
  );
  assert.equal(never.firstAnswer, 401);
});

test("page helpers pair through the shell bridge and carry the session", async () => {
  // 回环上的 /api/ 要会话（core/identity/loopback.ts）：nightly 37541900633 的
  // terminal.backend 答 401，就是因为这里的 fetch 什么都不带。
  const calls = [];
  const sockets = [];
  let paired = 0;
  let rejectFirst = true;
  const fakeFetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, auth: init.headers?.authorization ?? null });
    const reply = (status, body) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (path === "/api/identity/pair") {
      assert.deepEqual(JSON.parse(init.body), { ticket: "id.secret" });
      paired += 1;
      return reply(200, {
        native: { accessToken: `access-${paired}`, refreshToken: "r" },
      });
    }
    if (path === "/api/terminals/backend" && rejectFirst) {
      rejectFirst = false;
      return reply(401, { code: "unauthenticated", message: "x" });
    }
    if (path === "/api/identity/ws-ticket")
      return reply(200, { ticket: "ws1" });
    return reply(200, { effective: "sessionHost" });
  };
  class FakeSocket {
    constructor(url, protocols) {
      sockets.push({ url, protocols });
      this.url = url;
    }
    close() {}
    send() {}
  }
  const window = {
    armadra: {
      transport: {
        endpointsSync: () => ({
          httpBase: "http://127.0.0.1:9",
          wsBase: "ws://127.0.0.1:9",
        }),
      },
      identity: {
        ticket: async () => ({ ok: true, ticket: { ticket: "id.secret" } }),
      },
    },
  };
  const helpers = new Function(
    "globalThis",
    "fetch",
    "WebSocket",
    "setTimeout",
    "clearTimeout",
    `return ${PAGE_HELPERS}, globalThis.__acceptance;`,
  )(
    { window },
    fakeFetch,
    FakeSocket,
    () => 0,
    () => {},
  );
  const backend = await helpers.api("GET", "/api/terminals/backend");
  assert.equal(backend.status, 200);
  assert.equal(paired, 2, "401 换一次会话再试");
  assert.equal(calls.at(-1).auth, "Bearer access-2");
  void helpers.terminal("s1", "acceptance", [], null, 1000);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sockets[0], {
    url: "ws://127.0.0.1:9/api/terminals/s1/ws?writer=acceptance",
    protocols: ["armadra-ticket.ws1"],
  });
});

test("after the soak the marker is typed only once the loop went quiet, and retyped", async () => {
  // nightly 37906434287：5.1 的记号在固定两秒后敲进去被吞掉，同一会话后来照常回显。
  const calls = [];
  const replies = [
    { ok: true, reason: "quiet" },
    { ok: false, reason: "timeout", tail: "tick-OK" },
    { ok: true, reason: "matched" },
  ];
  const answer = await responsiveAfterLoop(
    async (lines, waitFor, timeoutMs) => {
      calls.push({ lines, waitFor, timeoutMs });
      return replies.shift();
    },
    "powershell",
    "ACC-after-x-OK",
  );
  assert.deepEqual(answer, { ok: true, attempts: 2, settled: "quiet" });
  assert.deepEqual(calls[0].lines, ["\u0003"]);
  assert.deepEqual(calls[0].waitFor, { quietMs: 3_000 });
  assert.equal(
    calls[1].lines[1],
    `${markerLine("powershell", "ACC-after-x-OK")}\r`,
  );
  assert.equal(calls[1].waitFor, "ACC-after-x-OK");

  // 一直不静就再按一次 Ctrl+C；都敲不出来时带上最后的输出尾巴。
  const sent = [];
  const never = await responsiveAfterLoop(
    async (lines) => {
      sent.push(lines[0]);
      return { ok: false, reason: "timeout", tail: "tick-OK" };
    },
    "powershell",
    "ACC-after-y-OK",
    { attempts: 2 },
  );
  assert.equal(never.ok, false);
  assert.equal(never.settled, "timeout");
  assert.equal(never.tail, "tick-OK");
  assert.deepEqual(sent, ["\u0003", "\u0003", "\r", "\r"]);
});

test("the quiet wait ignores the snapshot and restarts on every output frame", async () => {
  const timers = new Map();
  let nextTimer = 0;
  let socket;
  class FakeSocket {
    constructor() {
      socket = this;
      this.sent = [];
    }
    close() {}
    send(data) {
      this.sent.push(JSON.parse(data));
    }
  }
  const fakeFetch = async (url) => {
    const path = new URL(url).pathname;
    const body =
      path === "/api/identity/pair"
        ? { native: { accessToken: "a", refreshToken: "r" } }
        : { ticket: "ws1" };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  const helpers = new Function(
    "globalThis",
    "fetch",
    "WebSocket",
    "setTimeout",
    "clearTimeout",
    `return ${PAGE_HELPERS}, globalThis.__acceptance;`,
  )(
    {
      window: {
        armadra: {
          transport: {
            endpointsSync: () => ({
              httpBase: "http://127.0.0.1:9",
              wsBase: "ws://127.0.0.1:9",
            }),
          },
          identity: {
            ticket: async () => ({ ok: true, ticket: { ticket: "t" } }),
          },
        },
      },
    },
    fakeFetch,
    FakeSocket,
    (fn, ms) => {
      nextTimer += 1;
      timers.set(nextTimer, { fn, ms });
      return nextTimer;
    },
    (id) => timers.delete(id),
  );
  const quietTimers = () => [...timers.values()].filter((t) => t.ms === 3_000);
  const pending = helpers.terminal(
    "s1",
    "acceptance",
    ["\u0003"],
    { quietMs: 3_000 },
    30_000,
  );
  for (let i = 0; i < 5 && socket === undefined; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
  const frame = (value) => socket.onmessage({ data: JSON.stringify(value) });
  frame({ type: "snapshot", data: "old ACC-after-x-OK" });
  assert.equal(quietTimers().length, 0, "快照不开始计静");
  frame({ type: "hello" });
  assert.deepEqual(
    socket.sent.map((m) => m.data),
    ["\u0003"],
  );
  const first = quietTimers()[0];
  frame({ type: "output", data: "tick-OK" });
  assert.equal(quietTimers().length, 1);
  assert.notEqual(quietTimers()[0], first, "有输出就重新计");
  quietTimers()[0].fn();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.reason, "quiet");
});
