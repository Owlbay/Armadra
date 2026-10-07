/** Real core + built pure-Node client. All state and credentials are temporary. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = mkdtempSync(join(tmpdir(), "armadra-controller-probe-"));
const globalConfig = join(
  process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  "config.toml",
);
function configDigest() {
  try {
    return createHash("sha256")
      .update(readFileSync(globalConfig))
      .digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
}
const beforeConfig = configDigest();
const client = resolve(
  process.argv[2] ?? join(root, "target/plugins/armadra/scripts/armadra.cjs"),
);
const child = spawn(
  process.execPath,
  [
    join(root, "apps/desktop/out/core/main.js"),
    "--data-dir",
    directory,
    "--listen",
    "tcp:127.0.0.1:0",
  ],
  {
    cwd: directory,
    env: { ...process.env, ARMADRA_NO_GLOBAL_WRITES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let diagnostics = "";
child.stderr.on("data", (bytes) => {
  diagnostics = (diagnostics + bytes).slice(-8192);
});
child.stdout.resume();
let calls = 0,
  inputBytes = 0,
  outputBytes = 0;
const replies = [];
function cli(args, expected = 0) {
  calls++;
  inputBytes += Buffer.byteLength(JSON.stringify(args));
  const result = spawnSync(
    process.execPath,
    [client, ...args, "--data-dir", directory, "--json"],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        ...process.env,
        ARMADRA_CONTROLLER_PROFILES_DIR: join(directory, "private profiles"),
      },
      timeout: 15000,
    },
  );
  outputBytes += Buffer.byteLength(result.stdout ?? "");
  assert.equal(result.status, expected, result.stderr + result.stdout);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.ok, expected === 0);
  replies.push(reply);
  return reply.data ?? reply.error;
}
try {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("core exited: " + diagnostics);
    try {
      if (
        JSON.parse(readFileSync(join(directory, "endpoints.json"))).controller
      )
        break;
    } catch {
      /* startup */
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(cli(["doctor"]).protocolVersion, 1);
  const workspace = cli(["workspaces", "list"]).workspaces[0];
  assert.ok(workspace?.id);
  const connected = cli([
    "connect",
    "--workspace",
    workspace.id,
    "--profile",
    "probe",
  ]);
  assert.equal(
    connected.credential,
    undefined,
    "connect stdout must never contain credentials",
  );
  const board = cli(["boards", "list", "--profile", "probe"]).boards[0];
  const snapshot = cli([
    "board",
    "get",
    "--board",
    board.id,
    "--profile",
    "probe",
  ]);
  const file = join(directory, "batch graph.json");
  const graph = {
    schemaVersion: 1,
    expectedUpdatedAt: snapshot.updatedAt,
    operations: [
      {
        op: "createNode",
        key: "implement",
        type: "terminal",
        title: "Codex implementation",
        data: { kind: "terminal", agent: { id: "codex" } },
      },
      {
        op: "createNode",
        key: "review",
        type: "terminal",
        title: "Claude review",
        data: { kind: "terminal", agent: { id: "claude" } },
      },
      {
        op: "createContextLink",
        source: { key: "implement" },
        target: { key: "review" },
        role: "peer",
      },
    ],
  };
  writeFileSync(file, JSON.stringify(graph));
  inputBytes += Buffer.byteLength(JSON.stringify(graph));
  assert.equal(
    cli(["graph", "validate", "--board", board.id, "--file", file]).valid,
    true,
  );
  const command = [
    "graph",
    "apply",
    "--board",
    board.id,
    "--file",
    file,
    "--key",
    "probe-graph",
  ];
  const first = cli(command);
  const repeated = cli(command);
  assert.deepEqual(repeated, first);
  assert.equal(cli(["board", "get", "--board", board.id]).nodeCount, 2);
  const credential = JSON.parse(
    readFileSync(join(directory, "private profiles/probe.json")),
  ).credential;
  assert.equal(JSON.stringify(replies).includes(credential), false);
  cli(["disconnect", "--profile", "probe"]);
  cli(["boards", "list", "--profile", "probe"], 4);
  assert.equal(
    configDigest(),
    beforeConfig,
    "isolated core must not change the global CLI configuration",
  );
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      ok: true,
      level: "real-core-client",
      platform: process.platform,
      calls,
      inputBytes,
      outputBytes,
      assertions: [
        "doctor",
        "explicit workspace",
        "private credential",
        "incremental graph",
        "same-key replay",
        "disconnect",
      ],
      agentExecution: false,
      installedHostPlugin: false,
      globalConfigUnchanged: true,
    }),
  );
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((done) => child.once("exit", done)),
      new Promise((done) =>
        setTimeout(() => {
          child.kill("SIGKILL");
          done();
        }, 5000),
      ),
    ]);
  }
  rmSync(directory, { recursive: true, force: true });
}
