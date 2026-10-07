/** A04/A11: real canvas, core and PTY, with a deterministic inner Agent. */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = mkdtempSync(join(tmpdir(), "ar-canvas-"));
const dataDir = join(temporary, "data"),
  bin = join(temporary, "bin");
mkdirSync(bin);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
for (const name of ["codex", "claude"])
  writeFileSync(
    join(bin, name),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "tools/probes/fixtures/controller-agent.cjs"))} "$@"\n`,
    { mode: 0o755 },
  );
const env = {
  ...process.env,
  ARMADRA_NO_GLOBAL_WRITES: "1",
  ARMADRA_DATA_DIR: dataDir,
  ARMADRA_CONTROLLER_PROFILES_DIR: join(temporary, "profiles"),
  PATH: bin + ":" + process.env.PATH,
  SHELL: "/bin/sh",
};
for (const key of Object.keys(env))
  if (
    /CADK|ARMADRA_NODE_ID|ARMADRA_SESSION|CODEX_THREAD|CODEX_SESSION/.test(key)
  )
    delete env[key];
const protectedPaths = ["config.toml", "auth.json", "hooks.json"].map((name) =>
  join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), name),
);
const digest = (path) =>
  existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : "absent";
const protectedBefore = protectedPaths.map(digest);
const children = [],
  sockets = [];
const launch = (command, args, options = {}) => {
  const child = spawn(command, args, {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  children.push(child);
  child.stdout.resume();
  child.stderr.resume();
  return child;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, message, attempts = 150) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(message);
}
const client = join(root, "target/plugins/armadra/scripts/armadra.cjs");
let calls = 0,
  inputBytes = 0,
  outputBytes = 0,
  runId,
  origin,
  workspaceId;
function cli(args, expected = 0) {
  calls++;
  inputBytes += Buffer.byteLength(JSON.stringify(args));
  const result = spawnSync(
    process.execPath,
    [client, ...args, "--data-dir", dataDir, "--json"],
    { env, cwd: tmpdir(), encoding: "utf8", timeout: 15000 },
  );
  outputBytes += Buffer.byteLength(result.stdout ?? "");
  assert.equal(result.status, expected, result.stdout + result.stderr);
  const reply = JSON.parse(result.stdout);
  return reply.data ?? reply.error;
}
function file(name, data) {
  const path = join(temporary, name),
    text = JSON.stringify(data);
  inputBytes += Buffer.byteLength(text);
  writeFileSync(path, text);
  return path;
}
async function terminals() {
  const response = await fetch(
    origin + `/api/workspaces/${workspaceId}/sessions`,
  );
  assert.equal(response.status, 200);
  return response.json();
}
try {
  const core = launch(process.execPath, [
    join(root, "apps/desktop/out/core/main.js"),
    "--data-dir",
    dataDir,
    "--listen",
    "tcp:127.0.0.1:0",
  ]);
  await until(() => {
    assert.equal(core.exitCode, null);
    try {
      const hints = JSON.parse(readFileSync(join(dataDir, "endpoints.json")));
      origin = hints.runtime.http;
      return !!hints.controller;
    } catch {
      return false;
    }
  }, "core did not start");
  const workspace = cli(["workspaces", "list"]).workspaces[0];
  workspaceId = workspace.id;
  cli(["connect", "--workspace", workspace.id, "--profile", "canvas"]);
  const board = cli(["boards", "list"]).boards[0];
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((done) => reserve.close(done));
  const vite = launch("pnpm", [
    "--filter",
    "@armadra/web",
    "exec",
    "vite",
    "--port",
    String(port),
    "--strictPort",
  ]);
  const page = `http://127.0.0.1:${port}/?workspace=${workspace.id}&board=${board.id}`;
  await until(
    async () => {
      assert.equal(vite.exitCode, null);
      try {
        return (await fetch(page)).ok;
      } catch {
        return false;
      }
    },
    "Vite did not start",
    300,
  );
  const chrome =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.ok(
    existsSync(chrome),
    "Set CHROME_PATH to an existing Chromium; this probe never installs one",
  );
  const profile = join(temporary, "chrome");
  launch(chrome, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ]);
  let devtools;
  await until(() => {
    try {
      devtools = readFileSync(
        join(profile, "DevToolsActivePort"),
        "utf8",
      ).split("\n")[0];
      return !!devtools;
    } catch {
      return false;
    }
  }, "Chrome did not start");
  const target = await (
    await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  sockets.push(socket);
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map(),
    wsUrls = [],
    exceptions = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.webSocketCreated")
      wsUrls.push(message.params.url);
    if (message.method === "Runtime.exceptionThrown")
      exceptions.push(message.params.exceptionDetails);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          fail(new Error(`CDP timeout: ${method}`));
        }, 15000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        message.error
          ? fail(new Error(message.error.message))
          : done(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const reply = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(reply.exceptionDetails, undefined);
    return reply.result.value;
  };
  await call("Network.enable");
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: page });
  await until(
    async () =>
      (await evaluate("document.querySelectorAll('.react-flow').length")) > 0,
    "Canvas did not mount",
    300,
  );
  const graphFile = file("graph.json", {
    schemaVersion: 1,
    expectedUpdatedAt: board.updatedAt,
    operations: [
      {
        op: "createNode",
        key: "implement",
        type: "terminal",
        title: "Manual canvas probe",
        data: { kind: "terminal", agent: { id: "codex" } },
      },
    ],
  });
  const graphArgs = [
    "graph",
    "apply",
    "--board",
    board.id,
    "--file",
    graphFile,
    "--key",
    "graph",
  ];
  assert.equal(
    cli(graphArgs, 5).code,
    "lease_held",
    "The CLI silently took the page's lease",
  );
  // This isolated page explicitly leaves its OWN presence. Never take a
  // different user's lease or weaken graph authorization to make the test pass.
  await evaluate(`(async () => {
    const { presenceClientId } = await import('/src/store/canvas/presence.ts');
    const response = await fetch(${JSON.stringify(`/api/workspaces/${workspace.id}/boards/${board.id}/presence/`)} + presenceClientId(), {method:'DELETE'});
    if (!response.ok) throw new Error('Cannot yield own page presence');
    return true;
  })()`);
  const graph = cli(graphArgs);
  await until(
    async () =>
      (await evaluate(
        "document.querySelectorAll('.react-flow__node').length",
      )) === 1,
    "Created node did not arrive through workspace events",
  );
  await sleep(2000);
  assert.deepEqual(
    await terminals(),
    [],
    "Opening manual node created a terminal before run start",
  );
  const current = cli(["board", "get", "--board", board.id]);
  const request = file("run.json", {
    schemaVersion: 1,
    expectedUpdatedAt: current.updatedAt,
    tasks: [
      {
        key: "implement",
        nodeId: graph.nodeIds.implement,
        prompt: "FIXTURE_HOLD: verify canvas attaches only",
        after: [],
        outputs: [],
      },
    ],
  });
  runId = cli([
    "run",
    "start",
    "--board",
    board.id,
    "--file",
    request,
    "--key",
    "run",
  ]).runId;
  let snapshot;
  await until(
    () => {
      snapshot = cli(["run", "get", "--run", runId]);
      return snapshot.tasks[0]?.state === "running";
    },
    "Run did not start",
    100,
  );
  const sessionId = snapshot.tasks[0].sessionId;
  assert.ok(sessionId);
  await until(
    () => wsUrls.some((url) => url.includes(sessionId)),
    "Canvas never attached the core-started session",
  );
  assert.equal((await terminals()).filter((row) => row.alive).length, 1);
  await call("Page.navigate", { url: "about:blank" });
  await sleep(1200);
  assert.equal(
    cli(["run", "get", "--run", runId]).tasks[0].state,
    "running",
    "Closing canvas stopped the run",
  );
  const attachedBefore = wsUrls.filter((url) => url.includes(sessionId)).length;
  await call("Page.navigate", { url: page });
  await until(
    () =>
      wsUrls.filter((url) => url.includes(sessionId)).length > attachedBefore,
    "Remounted canvas did not attach existing session",
    300,
  );
  await sleep(2000);
  const launches = readFileSync(
    join(workspace.rootPath, "reports/launches.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n");
  const submissions = readFileSync(
    join(workspace.rootPath, "reports/submissions.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n");
  assert.equal(launches.length, 1, "Remount launched a second CLI");
  assert.equal(submissions.length, 1, "Remount resubmitted task");
  assert.equal((await terminals()).filter((row) => row.alive).length, 1);
  assert.equal(
    exceptions.length,
    0,
    "Canvas raised an uncaught runtime exception",
  );
  const evidence = join(root, "target/local-cli-evidence");
  mkdirSync(evidence, { recursive: true });
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(evidence, "controller-canvas.png"),
    Buffer.from(shot.data, "base64"),
  );
  assert.deepEqual(protectedPaths.map(digest), protectedBefore);
  const report = {
    schemaVersion: 1,
    ok: true,
    level: "real-canvas-fake-cli",
    platform: process.platform,
    calls,
    inputBytes,
    outputBytes,
    beforeStartSessions: 0,
    afterRemountSessions: 1,
    launches: 1,
    submissions: 1,
    canvasCloseRunState: "running",
    realModelCalls: 0,
    protectedConfigurationUnchanged: true,
  };
  writeFileSync(
    join(evidence, "controller-canvas.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  if (runId) {
    try {
      cli(["run", "cancel", "--run", runId, "--key", "cleanup"]);
    } catch {}
  }
  for (const socket of sockets) socket.close();
  for (const child of children.toReversed()) {
    // Only groups created by this probe. pnpm/Vite can outlive its wrapper.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([once(child, "exit"), sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    }
    child.stdout.destroy();
    child.stderr.destroy();
  }
  rmSync(temporary, { recursive: true, force: true, maxRetries: 20 });
}
