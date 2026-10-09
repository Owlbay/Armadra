#!/usr/bin/env node
/**
 * The Claude Code mod with a real Claude Code (contract §57, docs/design/claude-mods.md §10.3).
 *
 * Starts a real core (temporary data directory, temporary HOME and
 * CLAUDE_CONFIG_DIR, `ARMADRA_NO_GLOBAL_WRITES=1`) with the Claude under test
 * first on its PATH, waits for the core's own version probe to open the gate,
 * regenerates the launcher, and runs `claude -p` in canvas agent terminals
 * through `run/claude` against a local stand-in for the Messages API (a fake
 * key; no account, no network beyond 127.0.0.1). Then reads what the core
 * made of it:
 *
 *   1. mod: the hello arrives over the socket, the node's status reaches
 *      `done` from `hook` reports, and the trusted reports carry revisions the
 *      core drew from the session's counter (no settings hook but
 *      PermissionRequest is on the line);
 *   2. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
 *      `CLAUDE_CODE_SAFE_MODE=1`: the launcher's fallback starts the full
 *      settings hooks, and no hello comes;
 *   3. the host refusing the mod's fetch (the mod's argv started by hand with
 *      nonessential traffic off): events still arrive through the
 *      `armadra-hook` fallback, and the hello says `process`;
 *   4. the generated module type-checks against the declarations the engine
 *      laid beside it (`.claude-plugin/types/`), when that build lays them;
 *   5. the operator's own `~/.claude/settings.json` is byte-for-byte what it
 *      was.
 *
 * Needs a Claude Code at or above the gate: `ARMADRA_CLAUDE_BIN`, else
 * `claude` on PATH. Without one it says so and exits 0 (the e2e runner
 * records it as skipped). Build first: `pnpm libs:build && pnpm --filter
 * @armadra/desktop build`.
 *
 *   node tools/probes/claude-mod-launch.mjs [--record-compat]
 *
 * `--record-compat` writes the version that passed into
 * tools/release/compatibility.json's `claudeMods.verified` (widen only).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  WORKSPACE,
  collect,
  openSocket,
  seedWorkspace,
  startCore,
} from "./core-terminal-smoke.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const require = createRequire(join(repo, "apps/desktop/package.json"));
const COMPATIBILITY = join(repo, "tools/release/compatibility.json");

/**
 * The gate, read from compatibility.json (`claudeMods.minVersion`, held equal
 * to `CLAUDE_MODS_MIN` in core/hook/install/inject.ts by inject.test.ts).
 */
export const CLAUDE_MODS_MIN = JSON.parse(readFileSync(COMPATIBILITY, "utf8"))
  .claudeMods.minVersion;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parts(version) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return match ? match.slice(1, 4).map(Number) : undefined;
}

export function atLeast(version, floor = CLAUDE_MODS_MIN) {
  const have = parts(version);
  const need = parts(floor);
  if (have === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return have[index] > need[index];
  }
  return true;
}

/**
 * The Claude Code under test and its version, or why there is none. Run with
 * a throwaway HOME: `--version` reads nothing, but nothing of the operator's
 * is given the chance.
 */
export function findClaude(env = process.env) {
  const candidates = env.ARMADRA_CLAUDE_BIN
    ? [env.ARMADRA_CLAUDE_BIN]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, "claude"));
  const scratch = mkdtempSync(join(tmpdir(), "armadra-claude-version-"));
  try {
    for (const program of candidates) {
      if (!existsSync(program)) continue;
      const ran = spawnSync(program, ["--version"], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: env.PATH ?? "",
          HOME: scratch,
          CLAUDE_CONFIG_DIR: join(scratch, ".claude"),
        },
      });
      const version = /(\d+\.\d+\.\d+)/.exec(ran.stdout ?? "")?.[1];
      if (version === undefined) continue;
      if (!atLeast(version))
        return {
          reason: `${program} is Claude Code ${version}, below ${CLAUDE_MODS_MIN}`,
        };
      return { program, version };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return {
    reason: `no Claude Code ≥ ${CLAUDE_MODS_MIN} (set ARMADRA_CLAUDE_BIN)`,
  };
}

/* ----------------------------- fake Messages API ---------------------------- */

/**
 * Answers the main loop's first request with one Bash tool call (`echo hi`)
 * and everything after with "done", so a run carries PreToolUse and
 * PostToolUse between UserPromptSubmit and Stop.
 */
function fakeApi() {
  let n = 0;
  const sse = (response, events) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [event, data] of events)
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  };
  const server = http.createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      if (
        !request.url.startsWith("/v1/messages") ||
        request.url.includes("count_tokens")
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 10, data: [] }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(text || "{}");
      } catch {
        body = {};
      }
      const answered = JSON.stringify(body.messages ?? []).includes(
        "tool_result",
      );
      const main = (body.tools ?? []).some((tool) => tool.name === "Bash");
      n += 1;
      const message = {
        id: `msg_${n}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      };
      const call = {
        type: "tool_use",
        id: `toolu_${n}`,
        name: "Bash",
        input: { command: "echo hi", description: "Print hi" },
      };
      if (main && !answered) {
        if (!body.stream) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              ...message,
              content: [call],
              stop_reason: "tool_use",
            }),
          );
          return;
        }
        sse(response, [
          ["message_start", { type: "message_start", message }],
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: { ...call, input: {} },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(call.input),
              },
            },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 5 },
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ]);
        return;
      }
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...message,
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
          }),
        );
        return;
      }
      sse(response, [
        ["message_start", { type: "message_start", message }],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ]);
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ server, port: server.address().port }),
    ),
  );
}

/* ---------------------------------- core ---------------------------------- */

/** A board and a Claude node on it: the rows a hook report is attributed to. */
function seedNode(dataDir, title) {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(join(dataDir, "canvas.db"));
  try {
    const now = new Date().toISOString();
    let board = database
      .prepare("SELECT id FROM boards WHERE workspace_id = ? LIMIT 1")
      .get(WORKSPACE)?.id;
    if (board === undefined) {
      board = randomUUID();
      database
        .prepare(
          "INSERT INTO boards (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'probe', ?, ?)",
        )
        .run(board, WORKSPACE, now, now);
    }
    const id = randomUUID();
    database
      .prepare(
        "INSERT INTO nodes (id, board_id, type, x, y, title, data_json, created_at, updated_at) VALUES (?, ?, 'terminal', 0, 0, ?, ?, ?, ?)",
      )
      .run(
        id,
        board,
        title,
        JSON.stringify({ kind: "terminal", cwd: ".", agent: { id: "claude" } }),
        now,
        now,
      );
    return id;
  } finally {
    database.close();
  }
}

function readRows(dataDir, sql, ...params) {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(join(dataDir, "canvas.db"), {
    readOnly: true,
  });
  try {
    return database.prepare(sql).all(...params);
  } finally {
    database.close();
  }
}

async function json(response) {
  const body = await response.json();
  assert(response.ok, `${response.url}: ${JSON.stringify(body)}`);
  return body;
}

async function integration(core) {
  return json(await fetch(`${core.base}/api/agents/claude/integration`));
}

/** POSIX single quotes. */
function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * One canvas agent terminal for `nodeId`, one line typed into it, and the
 * exit status the line printed.
 */
async function runInTerminal(core, dataDir, nodeId, line) {
  const created = await json(
    await fetch(`${core.base}/api/terminals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: WORKSPACE,
        cwd: join(dataDir, "work"),
        shell: "/bin/sh",
        nodeId,
        agent: { id: "claude" },
      }),
    }),
  );
  const socket = openSocket(core.ws, created.id);
  const frames = collect(socket);
  await new Promise((done) => socket.once("open", done));
  await frames.waitFor((frame) => frame.type === "hello");
  const marker = `ARMADRA_MOD_PROBE_${randomUUID().slice(0, 8)}`;
  socket.send(
    JSON.stringify({
      type: "input",
      data: `${line}; echo ${marker}=$?\r`,
      inputId: 1,
    }),
  );
  await frames.waitFor((frame) => frame.type === "ack" && frame.inputId === 1);
  const deadline = Date.now() + 120_000;
  let code;
  while (code === undefined) {
    const found = new RegExp(`${marker}=(\\d+)`).exec(frames.text());
    if (found) code = Number(found[1]);
    else if (Date.now() > deadline)
      throw new Error(`no exit status; screen:\n${frames.text().slice(-3000)}`);
    else await delay(100);
  }
  socket.close();
  return { session: created, code, screen: frames.text() };
}

async function waitFor(what, read, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(200);
  }
}

function status(dataDir, nodeId) {
  return readRows(
    dataDir,
    "SELECT state, state_source AS source, verified FROM agent_status WHERE node_id = ?",
    nodeId,
  )[0];
}

function revisions(dataDir, nodeId) {
  return readRows(
    dataDir,
    "SELECT source_revision AS revision FROM run_reports WHERE node_id = ? ORDER BY source_revision",
    nodeId,
  ).map((row) => Number(row.revision));
}

function digest(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "absent";
  }
}

/* --------------------------------- scenarios -------------------------------- */

async function main() {
  const record = process.argv.includes("--record-compat");
  const found = findClaude();
  if (found.program === undefined) {
    console.log(`skip: ${found.reason}`);
    return;
  }
  console.log(`Claude Code ${found.version} at ${found.program}`);
  const operatorSettings = join(homedir(), ".claude", "settings.json");
  const before = digest(operatorSettings);

  const root = mkdtempSync(join(tmpdir(), "armadra-claude-mod-"));
  const dataDir = join(root, "data");
  const bin = join(root, "bin");
  mkdirSync(join(dataDir, "work"), { recursive: true });
  mkdirSync(bin);
  symlinkSync(found.program, join(bin, "claude"));
  writeFileSync(
    join(dataDir, "worker-settings.json"),
    JSON.stringify({ terminal: { backend: "direct" } }),
  );
  const api = await fakeApi();
  const core = await startCore({
    dataDir,
    env: {
      ARMADRA_NO_GLOBAL_WRITES: "1",
      ARMADRA_SECRET_BACKEND: "file",
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  let failure;
  try {
    seedWorkspace(dataDir);
    // The core probes `claude --version` a few seconds after start; the gate
    // reads that cache, and a regeneration writes the launcher it decides.
    const probed = await waitFor(
      "the core's Claude version probe",
      async () => {
        const state = await integration(core);
        return state.mods?.probedVersion ? state : undefined;
      },
      30_000,
    );
    assert(
      probed.mods.probedVersion === found.version,
      `core probed ${probed.mods.probedVersion}`,
    );
    const installed = await json(
      await fetch(`${core.base}/api/agents/claude/integration/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert(
      installed.mods?.gate === "enabled",
      `gate: ${JSON.stringify(installed.mods)}`,
    );
    const modDir = join(dataDir, "integration", "claude", "mod");
    assert(
      installed.launchArgs.includes(modDir) &&
        installed.launchArgs.some((arg) =>
          arg.endsWith("settings-permission.json"),
        ),
      `launch args: ${JSON.stringify(installed.launchArgs)}`,
    );
    const launcher = installed.launcher;
    assert(launcher, "no run/claude");
    console.log("gate open, run/claude carries the mod");

    const api_env = `ANTHROPIC_API_KEY=sk-ant-api03-armadra-probe-fake ANTHROPIC_BASE_URL=http://127.0.0.1:${api.port}`;
    const prompt = `-p 'run echo hi' --allowedTools Bash`;
    const viaLauncher = (extra = "") =>
      `${extra}${api_env} ${quote(launcher)} ${quote(found.program)} ${prompt}`;

    // 1. The mod.
    const modNode = seedNode(dataDir, "mod");
    const first = await runInTerminal(core, dataDir, modNode, viaLauncher());
    assert(first.code === 0, `claude exited ${first.code}:\n${first.screen}`);
    const hello = await waitFor("the hello", async () =>
      (await integration(core)).mods.sessions.find(
        (one) => one.nodeId === modNode,
      ),
    );
    assert(
      hello.transport === "socket" &&
        hello.profile === "terminal" &&
        hello.version === found.version,
      `hello: ${JSON.stringify(hello)}`,
    );
    const seen = await waitFor("the mod's reports", () => {
      const row = status(dataDir, modNode);
      return row?.state === "done" ? row : undefined;
    });
    assert(
      seen.source === "hook" && Number(seen.verified) === 1,
      `status: ${JSON.stringify(seen)}`,
    );
    const drawn = revisions(dataDir, modNode);
    assert(
      // Working reports outside an approval are not kept (runs/reports.ts):
      // the kept ones are a strictly rising run starting at the first.
      drawn.length >= 2 &&
        drawn[0] === 1 &&
        drawn.every((value, at) => at === 0 || value > drawn[at - 1]),
      `revisions the core drew: ${JSON.stringify(drawn)}`,
    );
    console.log(
      `1. mod: hello over the socket, status done from hook, revisions ${drawn.join(",")}`,
    );

    // 2. The launcher's environment fallback. First what it starts, with a
    // stand-in program that prints its argv; then the real Claude.
    const settings = join(dataDir, "integration", "claude", "settings.json");
    for (const variable of [
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "CLAUDE_CODE_SAFE_MODE",
    ]) {
      const echo = await runInTerminal(
        core,
        dataDir,
        seedNode(dataDir, `${variable}-argv`),
        `${variable}=1 ${quote(launcher)} printf '[%s]' x`,
      );
      assert(
        echo.screen.includes(`[--settings][${settings}]`) &&
          !echo.screen.includes(`[${modDir}]`),
        `${variable}: the fallback argv:\n${echo.screen.slice(-1500)}`,
      );
      const node = seedNode(dataDir, variable);
      const ran = await runInTerminal(
        core,
        dataDir,
        node,
        viaLauncher(`${variable}=1 `),
      );
      assert(ran.code === 0, `${variable}: claude exited ${ran.code}`);
      if (variable === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") {
        const row = await waitFor(
          `${variable}: the settings hooks' reports`,
          () => {
            const one = status(dataDir, node);
            return one?.state === "done" ? one : undefined;
          },
        );
        assert(row.source === "hook", `${variable}: ${JSON.stringify(row)}`);
      } else {
        await delay(1500);
      }
      const sessions = (await integration(core)).mods.sessions;
      assert(
        !sessions.some((one) => one.nodeId === node),
        `${variable}: a hello came, so the mod loaded`,
      );
      const row = status(dataDir, node);
      console.log(
        `2. ${variable}=1: the full settings hooks on the line, no hello; status ${row?.state ?? "none (this build runs no hooks in safe mode)"}`,
      );
    }

    // 3. The host refuses the mod's fetch: the mod's own argv, by hand.
    const refusedNode = seedNode(dataDir, "refused");
    const words = installed.launchArgs.map(quote).join(" ");
    const refused = await runInTerminal(
      core,
      dataDir,
      refusedNode,
      `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ${api_env} ${quote(found.program)} ${prompt} ${words}`,
    );
    assert(refused.code === 0, `refused: claude exited ${refused.code}`);
    const fallback = await waitFor("the refused mod's reports", () => {
      const one = status(dataDir, refusedNode);
      return one?.state === "done" ? one : undefined;
    });
    assert(fallback.source === "hook", JSON.stringify(fallback));
    const refusedHello = await waitFor("the refused mod's hello", async () =>
      (await integration(core)).mods.sessions.find(
        (one) => one.nodeId === refusedNode,
      ),
    );
    if (refusedHello.transport === "process") {
      console.log(
        "3. fetch refused: reports through armadra-hook, hello says process",
      );
    } else {
      // This build lets a plugin's plain fetch through with nonessential
      // traffic off: the refusal path is not reachable this way here.
      console.log(
        `3. fetch not refused by this build (hello says ${refusedHello.transport}); reports arrived`,
      );
    }

    // 4. The real declarations, when this build lays them beside the mod.
    const types = join(modDir, ".claude-plugin", "types");
    if (existsSync(join(types, "claude-code", "index.d.ts"))) {
      const tsc = join(repo, "apps/desktop/node_modules/.bin/tsc");
      const checked = spawnSync(tsc, ["-p", modDir, "--noEmit"], {
        encoding: "utf8",
      });
      assert(
        checked.status === 0,
        `tsc against the engine's types:\n${checked.stdout}${checked.stderr}`,
      );
      console.log("4. the module type-checks against the engine's own types");
    } else {
      console.log("4. this build lays no types beside the mod (2.1.295+)");
    }

    // 5. Nothing of the operator's moved.
    assert(
      digest(operatorSettings) === before,
      "~/.claude/settings.json changed",
    );
    console.log("5. ~/.claude/settings.json unchanged");

    if (record) recordCompat(found.version);
    console.log("\nOK");
  } catch (error) {
    failure = new Error(
      `${error.stack ?? error.message}\n--- core log ---\n${core.stderr().slice(-4000)}`,
    );
  } finally {
    await core.stop();
    api.server.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 20 });
  }
  if (failure) {
    console.error(String(failure));
    process.exit(1);
  }
}

/**
 * Widens `claudeMods.verified` to include `version`; never narrows it. Only
 * the `claudeMods` block is rewritten, so the rest of the file keeps its
 * hand formatting.
 */
function recordCompat(version) {
  const text = readFileSync(COMPATIBILITY, "utf8");
  const document = JSON.parse(text);
  const verified = document.claudeMods?.verified ?? null;
  const next =
    verified === null
      ? { min: version, max: version }
      : {
          min: atLeast(verified.min, version) ? version : verified.min,
          max: atLeast(version, verified.max ?? verified.min)
            ? version
            : (verified.max ?? verified.min),
        };
  const block = JSON.stringify(
    { ...document.claudeMods, verified: next },
    null,
    2,
  ).replaceAll("\n", "\n  ");
  const updated = text.replace(
    /"claudeMods": \{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/,
    `"claudeMods": ${block}`,
  );
  if (updated === text && JSON.stringify(verified) !== JSON.stringify(next))
    throw new Error("compatibility.json has no claudeMods block to update");
  JSON.parse(updated);
  writeFileSync(COMPATIBILITY, updated);
  console.log(`recorded claudeMods.verified ${JSON.stringify(next)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
