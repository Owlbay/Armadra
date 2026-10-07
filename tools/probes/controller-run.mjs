/** Real private socket, CLI, core, PTY, queue and Hooks; deterministic fake Agents only. */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeSession } from "./probe-session.mjs";
const faultPoint = process.argv
  .find((arg) => arg.startsWith("--fault="))
  ?.slice(8);
const cancelProbe = process.argv.includes("--cancel");
const largeOutput = process.argv.includes("--large-output");
const fault = process.argv.includes("--crash") || !!faultPoint;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = mkdtempSync(join(tmpdir(), "ar-run-"));
const dataDir = join(temporary, "data"),
  bin = join(temporary, "bin");
mkdirSync(bin);
const fixture = join(root, "tools/probes/fixtures/controller-agent.cjs");
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
for (const name of ["codex", "claude"])
  writeFileSync(
    join(bin, name),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
    { mode: 0o755 },
  );
const env = {
  ...process.env,
  ARMADRA_NO_GLOBAL_WRITES: "1",
  ARMADRA_CONTROLLER_PROFILES_DIR: join(temporary, "profiles"),
  PATH: bin + ":" + process.env.PATH,
  SHELL: "/bin/sh",
  ...(faultPoint ? { ARMADRA_PROBE_FAULT: faultPoint } : {}),
};
for (const key of Object.keys(env))
  if (
    /CADK|ARMADRA_NODE_ID|ARMADRA_SESSION|CODEX_THREAD|CODEX_SESSION/.test(key)
  )
    delete env[key];
let child = startCore();
function startCore() {
  return spawn(
    process.execPath,
    [
      join(
        root,
        faultPoint
          ? "apps/desktop/out/core/fault.cjs"
          : "apps/desktop/out/core/main.js",
      ),
      "--data-dir",
      dataDir,
      "--listen",
      "tcp:127.0.0.1:0",
    ],
    { cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"] },
  );
}
let diagnostic = "";
function capture() {
  for (const output of [child.stdout, child.stderr])
    output.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-12000);
    });
}
capture();
let calls = 0,
  inputBytes = 0,
  outputBytes = 0,
  runId,
  workspaceRoot;
const client = resolve(
  process.argv.find((arg) => arg.startsWith("--client="))?.slice(9) ??
    join(root, "target/plugins/armadra/scripts/armadra.cjs"),
);
function cli(args, expected = 0) {
  calls++;
  inputBytes += Buffer.byteLength(JSON.stringify(args));
  const result = spawnSync(
    process.execPath,
    [client, ...args, "--data-dir", dataDir, "--json"],
    { cwd: tmpdir(), env, encoding: "utf8", timeout: 15000 },
  );
  outputBytes += Buffer.byteLength(result.stdout ?? "");
  if (largeOutput)
    assert.ok(
      Buffer.byteLength(result.stdout ?? "") <=
        (args.includes("--details") ? 32768 : 8192),
      "CLI returned raw terminal logs or exceeded the summary envelope limit",
    );
  if (Array.isArray(expected))
    assert.ok(
      expected.includes(result.status),
      (result.stderr ?? "") + (result.stdout ?? ""),
    );
  else
    assert.equal(
      result.status,
      expected,
      (result.stderr ?? "") + (result.stdout ?? ""),
    );
  const reply = JSON.parse(result.stdout);
  return reply.data ?? reply.error;
}
function file(name, data) {
  const path = join(temporary, name);
  const text = JSON.stringify(data);
  inputBytes += Buffer.byteLength(text);
  writeFileSync(path, text);
  return path;
}
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("core exited: " + diagnostic);
    try {
      if (JSON.parse(readFileSync(join(dataDir, "endpoints.json"))).controller)
        break;
    } catch {
      /* startup */
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  const workspace = cli(["workspaces", "list"]).workspaces[0];
  workspaceRoot = workspace.rootPath;
  cli(["connect", "--workspace", workspace.id, "--profile", "probe"]);
  const board = cli(["boards", "list"]).boards[0];
  const graphFile = file("graph.json", {
    schemaVersion: 1,
    expectedUpdatedAt: board.updatedAt,
    operations: [
      ...(cancelProbe
        ? [
            {
              op: "createNode",
              key: "unrelated",
              type: "terminal",
              title: "Unrelated fixture",
              data: { kind: "terminal", agent: { id: "codex" } },
            },
          ]
        : []),
      {
        op: "createNode",
        key: "implement",
        type: "terminal",
        title: "Fixture implement",
        data: { kind: "terminal", agent: { id: "codex" } },
      },
      {
        op: "createNode",
        key: "review",
        type: "terminal",
        title: "Fixture review",
        data: { kind: "terminal", agent: { id: "claude" } },
      },
      {
        op: "createContextLink",
        source: { key: "implement" },
        target: { key: "review" },
        role: "peer",
      },
    ],
  });
  const graph = cli([
    "graph",
    "apply",
    "--board",
    board.id,
    "--file",
    graphFile,
    "--key",
    "graph",
  ]);
  const runFile = file("run.json", {
    schemaVersion: 1,
    expectedUpdatedAt: graph.updatedAt,
    tasks: [
      {
        key: "implement",
        nodeId: graph.nodeIds.implement,
        prompt:
          fault || cancelProbe
            ? "FIXTURE_HOLD: test crash without replay"
            : `${largeOutput ? "FIXTURE_LOG_BYTES=2097152 " : ""}FIXTURE_IMPLEMENT: write reports/change.md. This is a deterministic test.`,
        after: [],
        outputs: ["reports/change.md"],
      },
      {
        key: "review",
        nodeId: graph.nodeIds.review,
        prompt:
          "FIXTURE_REVIEW: read reports/change.md then write reports/review.md. This is a deterministic test.",
        after: ["implement"],
        outputs: ["reports/review.md"],
      },
    ],
  });
  const args = [
    "run",
    "start",
    "--board",
    board.id,
    "--file",
    runFile,
    "--key",
    "run",
  ];
  const started = cli(args, faultPoint ? [0, 7] : 0);
  if (started.code) assert.equal(started.code, "result_unknown");
  runId = started.runId;
  if (!faultPoint) assert.deepEqual(cli(args), started);
  if (cancelProbe) {
    const current = cli(["board", "get", "--board", board.id]);
    const otherFile = file("other-run.json", {
      schemaVersion: 1,
      expectedUpdatedAt: current.updatedAt,
      tasks: [
        {
          key: "unrelated",
          nodeId: graph.nodeIds.unrelated,
          prompt: "FIXTURE_HOLD: unrelated run must survive other cancellation",
          after: [],
          outputs: [],
        },
      ],
    });
    const other = cli([
      "run",
      "start",
      "--board",
      board.id,
      "--file",
      otherFile,
      "--key",
      "unrelated-run",
    ]);
    const submissionsPath = join(workspaceRoot, "reports/submissions.jsonl");
    for (let i = 0; i < 150; i++) {
      try {
        if (
          readFileSync(submissionsPath, "utf8").trim().split("\n").length === 2
        )
          break;
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(
      readFileSync(submissionsPath, "utf8").trim().split("\n").length,
      2,
    );
    const first = cli([
      "run",
      "cancel",
      "--run",
      runId,
      "--key",
      "cancel-main",
    ]);
    assert.deepEqual(
      cli(["run", "cancel", "--run", runId, "--key", "cancel-main"]),
      first,
    );
    let main;
    for (let i = 0; i < 10; i++) {
      main = cli(["run", "get", "--run", runId]);
      if (main.state === "cancelled") break;
      cli([
        "run",
        "wait",
        "--run",
        runId,
        "--cursor",
        String(main.cursor),
        "--timeout",
        "2",
      ]);
    }
    const remaining = cli(["run", "get", "--run", other.runId]);
    assert.equal(main.state, "cancelled");
    assert.equal(remaining.state, "running");
    assert.equal(
      readFileSync(submissionsPath, "utf8").trim().split("\n").length,
      2,
    );
    cli([
      "run",
      "cancel",
      "--run",
      other.runId,
      "--key",
      "cancel-other-cleanup",
    ]);
    await new Promise((done) => setTimeout(done, 1500));
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        level: "fake-cli-scoped-cancel",
        platform: process.platform,
        calls,
        inputBytes,
        outputBytes,
        main: main.state,
        unrelated: remaining.state,
        submissions: 2,
        replayed: 0,
        realModelCalls: 0,
      }),
    );
  } else if (fault) {
    const submissionsPath = join(workspaceRoot, "reports/submissions.jsonl");
    const countSubmissions = () => {
      try {
        return readFileSync(submissionsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    const oldInstance = JSON.parse(
      readFileSync(join(dataDir, "endpoints.json")),
    ).controller.instanceId;
    if (faultPoint) {
      for (let i = 0; i < 150; i++) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      assert.equal(
        child.signalCode,
        "SIGKILL",
        "fault point was not reached: " + diagnostic,
      );
      assert.equal(
        JSON.parse(readFileSync(join(dataDir, "probe-fault.json"))).point,
        faultPoint,
      );
    } else {
      for (let i = 0; i < 150; i++) {
        if (countSubmissions()) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      assert.equal(countSubmissions(), 1);
      child.kill("SIGKILL");
      await new Promise((done) => child.once("exit", done));
    }
    const beforeSubmissions = countSubmissions();
    child = startCore();
    capture();
    for (let i = 0; i < 100; i++) {
      try {
        if (
          JSON.parse(readFileSync(join(dataDir, "endpoints.json"))).controller
            ?.instanceId !== oldInstance
        )
          break;
      } catch {}
      await new Promise((done) => setTimeout(done, 50));
    }
    await new Promise((done) => setTimeout(done, 1500));
    const replayed = cli(args);
    if (started.runId) assert.deepEqual(replayed, started);
    else assert.ok(replayed.runId);
    runId = replayed.runId;
    const recovered = cli(["run", "get", "--run", runId]);
    assert.ok(
      ["failed", "blocked"].includes(recovered.state),
      JSON.stringify(recovered),
    );
    assert.ok(
      [
        "session_lost",
        "delivery_unknown",
        "connection_lost",
        "launch_unknown",
        "launch_write_unknown",
      ].includes(recovered.tasks[0].reason),
      JSON.stringify(recovered),
    );
    assert.deepEqual(cli(args), replayed);
    await new Promise((done) => setTimeout(done, 1500));
    assert.equal(countSubmissions(), beforeSubmissions);
    let launchCount = 0;
    try {
      launchCount = readFileSync(
        join(workspaceRoot, "reports/launches.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n").length;
    } catch {}
    assert.ok(launchCount <= 1, "startup was replayed");
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        level: "fake-cli-core-crash",
        platform: process.platform,
        state: recovered.state,
        reason: recovered.tasks[0].reason,
        calls,
        inputBytes,
        outputBytes,
        faultPoint: faultPoint ?? "after-submission",
        submissions: beforeSubmissions,
        replayed: 0,
        realModelCalls: 0,
      }),
    );
  } else {
    let snapshot,
      cursor = 0;
    for (let attempt = 0; attempt < 35; attempt++) {
      const update = cli([
        "run",
        "wait",
        "--run",
        runId,
        "--cursor",
        String(cursor),
        "--timeout",
        "2",
      ]);
      cursor = update.nextCursor;
      snapshot = cli(["run", "get", "--run", runId]);
      if (
        ["completed", "failed", "blocked", "cancelled"].includes(snapshot.state)
      )
        break;
    }
    assert.equal(
      snapshot.state,
      "completed",
      JSON.stringify(snapshot) + "\n" + diagnostic,
    );
    const launches = readFileSync(
      join(workspaceRoot, "reports/launches.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    const submissions = readFileSync(
      join(workspaceRoot, "reports/submissions.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(launches.length, 2);
    assert.equal(submissions.length, 2);
    assert.deepEqual(
      submissions.map((item) => item.agent),
      ["codex", "claude"],
    );
    assert.match(
      readFileSync(join(workspaceRoot, "reports/review.md"), "utf8"),
      /saw reports\/change.md/,
    );
    const artifacts = cli(["run", "artifacts", "--run", runId]);
    assert.equal(artifacts.artifacts.length, 2);
    assert.ok(
      artifacts.artifacts.every((item) => item.exists && item.type === "file"),
    );
    let terminalOutputBytes = 0;
    if (largeOutput) {
      terminalOutputBytes = Number(
        readFileSync(join(workspaceRoot, "reports/log-bytes.txt"), "utf8"),
      );
      assert.equal(terminalOutputBytes, 2097152);
      const details = cli([
        "run",
        "wait",
        "--run",
        runId,
        "--cursor",
        "0",
        "--timeout",
        "0",
        "--details",
      ]);
      assert.ok(Buffer.byteLength(JSON.stringify(details)) <= 32768);
      assert.ok(!JSON.stringify(details).includes("RAW_LOG_MARKER"));
    }
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        level: "fake-cli-real-pty",
        platform: process.platform,
        state: snapshot.state,
        calls,
        inputBytes,
        outputBytes,
        launches: launches.length,
        submissions: submissions.length,
        realModelCalls: 0,
        installedHostPlugin: false,
        ...(largeOutput ? { terminalOutputBytes } : {}),
      }),
    );
  }
} finally {
  // Clean up only the recorded session IDs in this isolated core.
  try {
    if (runId) {
      const snapshot = cli(["run", "get", "--run", runId]);
      const hints = JSON.parse(readFileSync(join(dataDir, "endpoints.json")));
      const session = await probeSession({ dataDir, base: hints.runtime.http });
      for (const task of snapshot.tasks ?? [])
        if (task.sessionId) {
          // The normal owner terminal route is used solely to clean up this fixture's PTYs.
          await session
            .fetch(`/api/terminals/${task.sessionId}/terminate`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ mode: "session" }),
            })
            .catch(() => {});
        }
    }
  } catch {
    /* still stop the isolated core */
  }
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((done) => child.once("exit", done));
  }
  rmSync(temporary, { recursive: true, force: true });
}
