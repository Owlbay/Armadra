/** Real Codex host + installed Skill/client + deterministic fake inner Agents. Not A16. */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeSession } from "./probe-session.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const installed = resolve(
  process.argv[2] ??
    join(homedir(), ".codex/plugins/cache/armadra-local/armadra/0.1.0"),
);
const client = join(installed, "scripts/armadra.cjs");
assert.ok(
  readFileSync(join(installed, "skills/armadra/SKILL.md"), "utf8").includes(
    "name: armadra",
  ),
);
const realCodex = spawnSync("which", ["codex"], {
  encoding: "utf8",
}).stdout.trim();
assert.ok(realCodex.startsWith("/"));
const temporary = mkdtempSync(join(tmpdir(), "ar-host-")),
  dataDir = join(temporary, "data"),
  bin = join(temporary, "bin");
mkdirSync(bin);
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
for (const name of ["codex", "claude"])
  writeFileSync(
    join(bin, name),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "tools/probes/fixtures/controller-agent.cjs"))} "$@"\n`,
    { mode: 0o755 },
  );
const env = {
  ...process.env,
  ARMADRA_NO_GLOBAL_WRITES: "1",
  ARMADRA_CONTROLLER_PROFILES_DIR: join(temporary, "profiles"),
  PATH: bin + ":" + process.env.PATH,
  SHELL: "/bin/sh",
};
// Do not pass another chat's identity/context into the host process.
for (const key of Object.keys(env))
  if (
    /CADK|ARMADRA_NODE_ID|ARMADRA_SESSION|CODEX_THREAD|CODEX_SESSION/.test(key)
  )
    delete env[key];
const protectedPaths = ["config.toml", "auth.json", "hooks.json"].map((name) =>
  join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), name),
);
const digest = (path) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
};
const protectedBefore = protectedPaths.map(digest);
const core = spawn(
  process.execPath,
  [
    join(root, "apps/desktop/out/core/main.js"),
    "--data-dir",
    dataDir,
    "--listen",
    "tcp:127.0.0.1:0",
  ],
  { cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"] },
);
core.stdout.resume();
let diagnostics = "";
core.stderr.on("data", (chunk) => {
  diagnostics = (diagnostics + chunk).slice(-4000);
});
let host, result, workspaceRoot;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if (JSON.parse(readFileSync(join(dataDir, "endpoints.json"))).controller)
        break;
    } catch {}
    await new Promise((done) => setTimeout(done, 50));
  }
  const listed = spawnSync(
    process.execPath,
    [client, "workspaces", "list", "--data-dir", dataDir, "--json"],
    { env, encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  workspaceRoot = JSON.parse(listed.stdout).data.workspaces[0].rootPath;
  const prompt = `Use $armadra, the installed plugin at ${installed}, to complete this local acceptance task. This host has local Node execution. Use the installed client, not any repository client. Select the existing workspace whose root is ${workspaceRoot} and its existing board; core data directory is ${dataDir}. Connect profile host-proof. Create exactly two manual Agent nodes (Codex implementation, Claude review), one peer context link, then explicitly start a run with review after implementation. Inner CLIs in this fixture are deterministic fake Agents: implementation prompt must contain FIXTURE_IMPLEMENT and declare reports/change.md; review prompt must contain FIXTURE_REVIEW and declare reports/review.md. Use stable keys host-graph and host-run; repeat graph apply and run start once with identical input to verify original IDs. Query/wait finitely, get both artifact references, then write host-proof.json in the workspace with runId, state, and the two artifact paths. Label this fake inner-Agent validation, never real dual models. Do not modify global configurations or credentials, call any vendor login, create worktrees, commit, push, publish, use SQLite directly, or approve Agent prompts. Operate only this temporary workspace, its private controller, and its temporary profile directory. Do not start core. Preserve configured account/model/permission policy. Finish with a concise result. Use files/stdin for JSON. Keep stdout summaries bounded.`;
  const measuredPrompt =
    prompt +
    ` After reading the Skill and required references, use one batched Node script for client calls, without reading the client bundle. For measurement, prepend Node --require ${join(root, "tools/probes/fixtures/controller-client-trace.cjs")} before ${client} in every CLI subprocess; preserve env with ARMADRA_PROBE_CLIENT=${client}, ARMADRA_PROBE_TRACE=${join(temporary, "client-trace.jsonl")}, and ARMADRA_CONTROLLER_PROFILES_DIR=${join(temporary, "profiles")}. This tracer only counts calls/bytes. Do doctor, explicit selection, graph validate/apply twice, run start twice, then wait/get against a 60-second wall-clock deadline: event pages can arrive immediately before the CLI has even started, so do not stop after a small fixed page count. Keep nextCursor and use wait timeout 2 seconds until terminal/blocked/deadline, then get artifacts. Once host-proof.json is written, return a short final reply immediately.`;
  host = spawn(
    realCodex,
    [
      "exec",
      "--json",
      "--ephemeral",
      "-c",
      'default_permissions="armadra-proof"',
      "-c",
      `permissions.armadra-proof={extends=":read-only",filesystem={${JSON.stringify(temporary)}="write"},network={enabled=true,mode="limited",domains={"armadra.local.invalid"="allow"},unix_sockets={${JSON.stringify(join(dataDir, "controller.sock"))}="allow",${JSON.stringify(join(workspaceRoot, "../../controller.sock"))}="allow"}}}`,

      "-c",
      "features.network_proxy=true",
      "--skip-git-repo-check",
      "--cd",
      workspaceRoot,
      "-",
    ],
    {
      env: {
        ...env,
        NODE_OPTIONS:
          `${env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(join(root, "tools/probes/fixtures/controller-client-trace.cjs"))}`.trim(),
        ARMADRA_PROBE_CLIENT: client,
        ARMADRA_PROBE_TRACE: join(temporary, "client-trace.jsonl"),
      },
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let hostError = "";
  let events = "",
    errorBytes = 0;
  host.stdout.on("data", (chunk) => {
    events += chunk;
  });
  host.stderr.on("data", (chunk) => {
    errorBytes += chunk.length;
    hostError = (hostError + chunk).slice(-4000);
  });
  host.stdin.end(measuredPrompt);
  const timeout = setTimeout(() => host.kill("SIGTERM"), 180000);
  const status = await new Promise((done) =>
    host.once("exit", (code) => done(code)),
  );
  clearTimeout(timeout);
  const evidence = join(root, "target/local-cli-evidence");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "host-codex-events.jsonl"), events);
  writeFileSync(join(evidence, "host-codex-stderr.log"), hostError);
  // Preserve measurements even if the host's final answer is interrupted.
  try {
    writeFileSync(
      join(evidence, "host-client-trace.jsonl"),
      readFileSync(join(temporary, "client-trace.jsonl")),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    writeFileSync(
      join(evidence, "host-attempt-result.json"),
      readFileSync(join(workspaceRoot, "host-proof.json")),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert.equal(
    status,
    0,
    "Host did not complete; inspect host-codex-events.jsonl",
  );
  result = JSON.parse(
    readFileSync(join(workspaceRoot, "host-proof.json"), "utf8"),
  );
  assert.equal(result.state, "completed");
  const rows = events
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const usage = rows.findLast((row) => row.type === "turn.completed")?.usage;
  const commands = rows.filter(
    (row) =>
      row.type === "item.completed" && row.item?.type === "command_execution",
  );
  const launches = readFileSync(
    join(workspaceRoot, "reports/launches.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n");
  const submissions = readFileSync(
    join(workspaceRoot, "reports/submissions.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n");
  assert.equal(launches.length, 2);
  assert.equal(submissions.length, 2);
  const clientTrace = readFileSync(
    join(temporary, "client-trace.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(clientTrace.length > 0, "Host never executed the installed client");
  for (const method of [
    "doctor",
    "workspaces list",
    "connect",
    "boards list",
    "graph apply",
    "run start",
    "run artifacts",
  ])
    assert.ok(
      clientTrace.some((row) => row.method.startsWith(method)),
      `Host omitted ${method}`,
    );
  for (const method of ["graph apply", "run start"])
    assert.equal(
      clientTrace.filter((row) => row.method === method).length,
      2,
      `Host did not verify ${method} idempotency`,
    );
  writeFileSync(
    join(evidence, "host-client-trace.jsonl"),
    clientTrace.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  assert.deepEqual(
    protectedPaths.map(digest),
    protectedBefore,
    "Host changed protected global configuration",
  );
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      ok: true,
      level: "real-codex-host-fake-inner-agents",
      installed,
      skillBytes: readFileSync(join(installed, "skills/armadra/SKILL.md"))
        .length,
      hostPromptBytes: Buffer.byteLength(measuredPrompt),
      hostEventBytes: Buffer.byteLength(events),
      hostStderrBytes: errorBytes,
      commandExecutions: commands.length,
      cliCalls: clientTrace.length,
      cliArgumentBytes: clientTrace.reduce(
        (sum, row) => sum + row.argumentBytes,
        0,
      ),
      cliInputFileBytes: clientTrace.reduce(
        (sum, row) => sum + row.inputFileBytes,
        0,
      ),
      cliOutputBytes: clientTrace.reduce(
        (sum, row) => sum + row.outputBytes,
        0,
      ),
      usage: usage ?? null,
      result,
      launches: 2,
      submissions: 2,
      realDualAgent: false,
      protectedConfigurationUnchanged: true,
    }),
  );
} finally {
  if (host?.exitCode === null && host?.signalCode === null)
    host.kill("SIGTERM");
  try {
    if (result?.runId) {
      const profileEnv = { ...env };
      const query = spawnSync(
        process.execPath,
        [
          client,
          "run",
          "get",
          "--run",
          result.runId,
          "--profile",
          "host-proof",
          "--data-dir",
          dataDir,
          "--json",
        ],
        { env: profileEnv, encoding: "utf8" },
      );
      const tasks = JSON.parse(query.stdout).data.tasks;
      const hints = JSON.parse(readFileSync(join(dataDir, "endpoints.json")));
      const session = await probeSession({ dataDir, base: hints.runtime.http });
      for (const task of tasks)
        if (task.sessionId)
          await session.fetch(`/api/terminals/${task.sessionId}/terminate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: "session" }),
          });
    }
  } catch {}
  if (core.exitCode === null) {
    core.kill("SIGTERM");
    await new Promise((done) => core.once("exit", done));
  }
  rmSync(temporary, { recursive: true, force: true });
}
