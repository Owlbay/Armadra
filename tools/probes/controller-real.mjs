/** Real A16 against an ALREADY RUNNING isolated core. No fake CLI, config write or PTY implementation. */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeSession } from "./probe-session.mjs";
import {
  checkRealDirectories,
  realVersion,
  scenarioFiles,
  trustedProject,
  verifyRealReports,
  parseRealOptions,
  readRealArtifact,
} from "./controller-real-checks.mjs";
import {
  probeEnvironment,
  readCodexConfig,
} from "./controller-real-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let options;
try {
  options = parseRealOptions(process.argv.slice(2));
} catch (error) {
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      ok: false,
      level: "real-cli-preflight",
      state: "blocked",
      error: error.message,
    }),
  );
  process.exit(2);
}
const installed = resolve(
  options["plugin-root"] ??
    join(homedir(), ".codex/plugins/cache/armadra-local/armadra/0.1.0"),
);
const client = join(installed, "scripts/armadra.cjs");
const home = options["codex-home"] ?? process.env.ARMADRA_REAL_CODEX_HOME;
let dataDir = options["data-dir"],
  workspaceRoot,
  statePath,
  checkpoint,
  profileDirectory;
let calls = 0,
  argumentBytes = 0,
  inputFileBytes = 0,
  outputBytes = 0;
const env = probeEnvironment(process.env);
const productionHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const digest = (path) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
};
const protectedPaths = [productionHome, ...(home ? [home] : [])].flatMap(
  (directory) =>
    ["config.toml", "auth.json", "hooks.json"].map((name) =>
      join(directory, name),
    ),
);
const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
protectedPaths.push(
  join(claudeHome, "settings.json"),
  join(claudeHome, ".credentials.json"),
  join(homedir(), ".claude.json"),
);
const protectedBefore = protectedPaths.map(digest);
function save() {
  writeFileSync(statePath, JSON.stringify(checkpoint, null, 2) + "\n", {
    mode: 0o600,
  });
}
function cli(args) {
  calls++;
  argumentBytes += Buffer.byteLength(JSON.stringify(args));
  const fileIndex = args.indexOf("--file");
  if (fileIndex >= 0) inputFileBytes += statSync(args[fileIndex + 1]).size;
  const result = spawnSync(
    process.execPath,
    [client, ...args, "--data-dir", dataDir, "--json"],
    {
      env: { ...env, ARMADRA_CONTROLLER_PROFILES_DIR: profileDirectory },
      cwd: root,
      encoding: "utf8",
      timeout: 35000,
    },
  );
  outputBytes += Buffer.byteLength(result.stdout ?? "");
  assert.ok(
    Buffer.byteLength(result.stdout ?? "") <= 8192,
    "Unexpected unbounded client output",
  );
  const reply = JSON.parse(result.stdout || "{}");
  if (result.status !== 0 || !reply.ok)
    throw new Error(
      `Client ${args.slice(0, 2).join(" ")}: ${reply.error?.code ?? "unavailable"}`,
    );
  return reply.data;
}
let metadataSession;
async function getMetadata(origin, path) {
  metadataSession ??= await probeSession({ dataDir, base: origin });
  const response = await metadataSession.fetch(path, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(`Core readiness metadata unavailable (${response.status})`);
  return response.json();
}
function mutation(phase, args) {
  checkpoint.phase = phase;
  save();
  return cli(args);
}
const report = {
  schemaVersion: 1,
  ok: false,
  level: "real-cli-preflight",
  state: "blocked",
  blockers: [],
  realCliTasks: 0,
  modelApiCalls: null,
  agentTokens: null,
};
try {
  if (process.platform !== "darwin")
    report.blockers.push(
      "Real dual-CLI acceptance requires macOS; Windows controller is unsupported",
    );
  for (const name of ["data-dir", "workspace", "board"])
    if (!options[name]) report.blockers.push(`Missing explicit --${name}`);
  if (!home)
    report.blockers.push("Missing independently logged-in isolated Codex home");
  for (const name of ["codex", "claude"]) {
    const path = spawnSync("which", [name], {
      env,
      encoding: "utf8",
    }).stdout?.trim();
    if (!path) report.blockers.push(`Missing real ${name} CLI on this host`);
  }
  if (!existsSync(client))
    report.blockers.push("Installed plugin client unavailable");
  if (report.blockers.length)
    throw new Error("Real acceptance prerequisites are unavailable");
  ({ dataDir } = checkRealDirectories({
    dataDir,
    codexHome: home,
    productionHome,
  }));
  const hints = JSON.parse(
    readFileSync(join(dataDir, "endpoints.json"), "utf8"),
  );
  const origin = new URL(hints.runtime.http);
  assert.ok(
    origin.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(origin.hostname),
    "Readiness metadata must come from this isolated local core",
  );
  assert.equal(cli(["doctor"]).instanceId, hints.controller.instanceId);
  const workspaces = cli(["workspaces", "list"]).workspaces;
  const workspace = workspaces.find((row) => row.id === options.workspace);
  assert.ok(workspace, "Explicit workspace was not found");
  workspaceRoot = workspace.rootPath;
  checkRealDirectories({
    dataDir,
    codexHome: home,
    productionHome,
    workspaceRoot,
  });
  const agents = await getMetadata(origin.origin, "/api/agents");
  const versions = {};
  for (const name of ["codex", "claude"]) {
    const agent = agents.find((row) => row.id === name);
    assert.ok(
      agent?.installed && agent.resolvedPath,
      `Missing core-resolved real ${name} CLI`,
    );
    const result = spawnSync(agent.resolvedPath, ["--version"], {
      env,
      encoding: "utf8",
      timeout: 15000,
    });
    versions[name] = realVersion(
      name,
      (result.stdout ?? "") + (result.stderr ?? ""),
    );
    assert.ok(
      result.status === 0 && versions[name],
      `Core ${name} CLI is unknown or a fixture`,
    );
    const integration = await getMetadata(
      origin.origin,
      `/api/agents/${name}/integration`,
    );
    assert.ok(
      integration.hook.installed && !integration.stale,
      `${name} Hook integration is not current/trusted`,
    );
    if (name === "codex") {
      assert.equal(
        realpathSync(integration.hook.path),
        realpathSync(join(home, "config.toml")),
        "Core is using another Codex configuration",
      );
      const login = spawnSync(agent.resolvedPath, ["login", "status"], {
        env: { ...env, CODEX_HOME: home },
        encoding: "utf8",
        timeout: 15000,
      });
      assert.ok(
        login.status === 0 &&
          /Logged in/i.test((login.stdout ?? "") + (login.stderr ?? "")),
        "Isolated Codex login is unavailable",
      );
      assert.ok(
        trustedProject(
          await readCodexConfig(agent.resolvedPath, home, workspaceRoot, env),
          realpathSync(workspaceRoot),
        ),
        "Codex project trust is unavailable; the probe never answers the trust prompt",
      );
    }
  }
  report.versions = versions;
  report.prerequisitesPassed = true;
  if (!options.execute) {
    report.ok = true;
    report.state = "ready";
  } else {
    report.level = "real-cli-dual-agent-acceptance";
    const scenarioDirectory = join(dataDir, "real-acceptance");
    statePath = join(scenarioDirectory, "scenario.json");
    profileDirectory = join(scenarioDirectory, "profiles");
    if (existsSync(statePath)) {
      checkpoint = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(checkpoint.workspaceId, workspace.id);
      assert.equal(checkpoint.boardId, options.board);
      assert.ok(
        checkpoint.runId,
        "A prior mutation may have happened; reconcile its stored key/input manually before resuming",
      );
    } else {
      assert.ok(
        readdirSync(workspaceRoot).every((name) => name === ".git"),
        "The isolated workspace must be unused; existing files will not be overwritten",
      );
      mkdirSync(scenarioDirectory, { recursive: true, mode: 0o700 });
      for (const [name, text] of Object.entries(scenarioFiles())) {
        const path = join(workspaceRoot, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, { flag: "wx", mode: 0o600 });
      }
      mkdirSync(join(workspaceRoot, "reports"), { recursive: true });
      const git = spawnSync("git", ["init", workspaceRoot], {
        env,
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(
        git.status,
        0,
        "Could not initialize isolated test repository",
      );
      const baseline = spawnSync(
        process.execPath,
        ["--test", "test/slug.test.mjs"],
        { cwd: workspaceRoot, env, encoding: "utf8", timeout: 15000 },
      );
      assert.equal(
        baseline.status,
        1,
        "The acceptance tests must fail before implementation",
      );
      checkpoint = {
        schemaVersion: 1,
        workspaceId: workspace.id,
        boardId: options.board,
        phase: "prepared",
        testHash: digest(join(workspaceRoot, "test/slug.test.mjs")),
        sourceHash: digest(join(workspaceRoot, "src/slug.mjs")),
        baselineTestExit: baseline.status,
      };
      save();
      cli([
        "connect",
        "--workspace",
        workspace.id,
        "--profile",
        "real-acceptance",
      ]);
      assert.ok(
        cli(["boards", "list", "--profile", "real-acceptance"]).boards.some(
          (row) => row.id === options.board,
        ),
        "Explicit board was not found",
      );
      const board = cli([
        "board",
        "get",
        "--board",
        options.board,
        "--profile",
        "real-acceptance",
      ]);
      const graphFile = join(scenarioDirectory, "graph.json");
      writeFileSync(
        graphFile,
        JSON.stringify({
          schemaVersion: 1,
          expectedUpdatedAt: board.updatedAt,
          operations: [
            {
              op: "createNode",
              key: "implement",
              type: "terminal",
              title: "Real Codex implementation",
              data: { kind: "terminal", agent: { id: "codex" } },
            },
            {
              op: "createNode",
              key: "review",
              type: "terminal",
              title: "Real Claude review",
              data: { kind: "terminal", agent: { id: "claude" } },
            },
            {
              op: "createContextLink",
              source: { key: "implement" },
              target: { key: "review" },
              role: "peer",
            },
          ],
        }),
        { mode: 0o600 },
      );
      assert.equal(
        cli([
          "graph",
          "validate",
          "--board",
          options.board,
          "--file",
          graphFile,
          "--profile",
          "real-acceptance",
        ]).valid,
        true,
      );
      const graphArgs = [
        "graph",
        "apply",
        "--board",
        options.board,
        "--file",
        graphFile,
        "--key",
        "real-acceptance-graph",
        "--profile",
        "real-acceptance",
      ];
      const graph = mutation("graph.applying", graphArgs);
      assert.deepEqual(cli(graphArgs), graph);
      checkpoint.graph = graph;
      checkpoint.phase = "graph.applied";
      save();
      const runFile = join(scenarioDirectory, "run.json");
      writeFileSync(
        runFile,
        JSON.stringify({
          schemaVersion: 1,
          expectedUpdatedAt: graph.updatedAt,
          deadlineSeconds: 600,
          maxConcurrency: 2,
          tasks: [
            {
              key: "implement",
              nodeId: graph.nodeIds.implement,
              after: [],
              prompt:
                "Implement src/slug.mjs: export slug(text), trim/lowercase, replace runs of non-ASCII-alphanumeric characters with one hyphen, remove leading/trailing hyphens. Preserve test/slug.test.mjs byte-for-byte. Run node --test test/slug.test.mjs. Write reports/change.md describing real changes and test results. Do not commit, push, access network, edit CLI credentials/configuration or answer any approval prompt.",
              outputs: ["reports/change.md", "src/slug.mjs"],
            },
            {
              key: "review",
              nodeId: graph.nodeIds.review,
              after: ["implement"],
              prompt:
                'Review actual src/slug.mjs, immutable test/slug.test.mjs and reports/change.md. Run node --test test/slug.test.mjs. Do not modify implementation or tests, commit/push, access network, edit CLI credentials/configuration or answer approval prompts. Write reports/review.json with verdict "pass" or "issues", issues array, reviewedFiles array containing the three paths. Base the review on actual files; report defects honestly.',
              outputs: ["reports/review.json"],
            },
          ],
        }),
        { mode: 0o600 },
      );
      const runArgs = [
        "run",
        "start",
        "--board",
        options.board,
        "--file",
        runFile,
        "--key",
        "real-acceptance-run",
        "--profile",
        "real-acceptance",
      ];
      const started = mutation("run.starting", runArgs);
      checkpoint.runId = started.runId;
      checkpoint.phase = "run.started";
      save();
      assert.deepEqual(cli(runArgs), started);
    }
    const deadline = Date.now() + 600000;
    let snapshot,
      cursor = checkpoint.cursor ?? 0;
    while (Date.now() < deadline) {
      snapshot = cli([
        "run",
        "get",
        "--run",
        checkpoint.runId,
        "--profile",
        "real-acceptance",
      ]);
      checkpoint.cursor = cursor;
      checkpoint.snapshot = snapshot;
      save();
      if (
        ["completed", "failed", "cancelled", "blocked"].includes(snapshot.state)
      )
        break;
      const page = cli([
        "run",
        "wait",
        "--run",
        checkpoint.runId,
        "--cursor",
        String(cursor),
        "--timeout",
        "30",
        "--profile",
        "real-acceptance",
      ]);
      cursor = page.snapshotRequired ? snapshot.cursor : page.nextCursor;
    }
    report.runId = checkpoint.runId;
    report.state = snapshot.state;
    assert.equal(
      snapshot.state,
      "completed",
      "The real run did not complete; inspect the original run, do not resend its tasks",
    );
    const artifacts = cli([
      "run",
      "artifacts",
      "--run",
      checkpoint.runId,
      "--profile",
      "real-acceptance",
    ]);
    assert.ok(
      !artifacts.truncated &&
        artifacts.artifacts.length === 3 &&
        artifacts.artifacts.every((row) => row.exists && row.type === "file"),
      "Real outputs are missing",
    );
    const reference = (path) => {
      const value = artifacts.artifacts.find((row) => row.path === path);
      assert.ok(value, "Missing declared reference");
      return value;
    };
    const changeText = readRealArtifact(
      workspaceRoot,
      reference("reports/change.md"),
    );
    const reviewText = readRealArtifact(
      workspaceRoot,
      reference("reports/review.json"),
    );
    readRealArtifact(workspaceRoot, reference("src/slug.mjs"));
    // Refuse modified tests BEFORE executing them, and check them again after.
    readRealArtifact(workspaceRoot, {
      path: "test/slug.test.mjs",
      exists: true,
      type: "file",
      size: Buffer.byteLength(scenarioFiles()["test/slug.test.mjs"]),
      versionKind: "contentHash",
      contentVersion: "sha256:" + checkpoint.testHash,
    });
    const quality = spawnSync(
      process.execPath,
      ["--test", "test/slug.test.mjs"],
      { cwd: workspaceRoot, env, encoding: "utf8", timeout: 15000 },
    );
    writeFileSync(
      join(scenarioDirectory, "quality-test.log"),
      (quality.stdout ?? "") + (quality.stderr ?? ""),
    );
    const review = verifyRealReports({
      change: changeText,
      review: reviewText,
      testsUnchanged:
        digest(join(workspaceRoot, "test/slug.test.mjs")) ===
        checkpoint.testHash,
      testExitCode: quality.status,
    });
    assert.notEqual(
      digest(join(workspaceRoot, "src/slug.mjs")),
      checkpoint.sourceHash,
      "Implementation remained the original stub",
    );
    report.ok = true;
    report.realCliTasks = 2;
    report.qualityTestExit = quality.status;
    report.reviewVerdict = review.verdict;
    report.artifacts = artifacts.artifacts;
    checkpoint.phase = "verified";
    save();
  }
} catch (error) {
  report.error = error.message;
  if (!report.blockers.length) report.blockers.push(error.message);
  if (checkpoint) {
    report.runId = checkpoint.runId ?? null;
    report.phase = checkpoint.phase;
  }
  if (options.execute) process.exitCode = 2;
} finally {
  report.protectedConfigurationUnchanged = protectedPaths.every(
    (path, index) => digest(path) === protectedBefore[index],
  );
  if (!report.protectedConfigurationUnchanged) {
    report.ok = false;
    report.blockers.push("Protected CLI configuration/credentials changed");
    process.exitCode = 2;
  }
  report.calls = calls;
  report.cliArgumentBytes = argumentBytes;
  report.cliInputFileBytes = inputFileBytes;
  report.cliOutputBytes = outputBytes;
  const evidence = join(root, "target/local-cli-evidence");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    join(
      evidence,
      options.execute
        ? "real-acceptance.json"
        : "real-acceptance-preflight.json",
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
