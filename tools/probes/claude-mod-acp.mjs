#!/usr/bin/env node
/**
 * The Claude Code mod under ACP with a real adapter (contract §59,
 * docs/design/claude-mods.md §5.2).
 *
 * Starts a real core (temporary data directory, temporary HOME and
 * CLAUDE_CONFIG_DIR, `ARMADRA_NO_GLOBAL_WRITES=1`) with the
 * `claude-agent-acp` under test first on its PATH and a local stand-in for
 * the Messages API (a fake key; no account, no network beyond 127.0.0.1),
 * opens an ACP-driven Claude node through `POST /api/acp/sessions`, and
 * reads what the core made of it:
 *
 *   1. the mod loaded in the CLI the adapter started: its hello arrives with
 *      `profile: "acp"`;
 *   2. the adapter lists the `/armadra-*` commands in its
 *      `available_commands_update` (the session log's snapshot);
 *   3. a `/armadra-list` prompt is answered by the mod — the canvas list
 *      reaches the session — without a model turn;
 *   4. the node's state stays the ACP session's (`state_source = 'acp'`):
 *      the mod forwards no hook event under ACP;
 *   5. the operator's own `~/.claude/settings.json` is byte-for-byte what it
 *      was.
 *
 * Needs a `claude-agent-acp` whose bundled Claude Code is at or above the
 * gate: `ARMADRA_CLAUDE_ACP_BIN`, else `claude-agent-acp` on PATH. Without
 * one it says so and exits 0 (the e2e runner records it as skipped). Build
 * first: `pnpm libs:build && pnpm --filter @armadra/desktop build`.
 *
 *   node tools/probes/claude-mod-acp.mjs
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CLAUDE_MODS_MIN, atLeast, fakeApi } from "./claude-mod-launch.mjs";
import { WORKSPACE, seedWorkspace, startCore } from "./core-terminal-smoke.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const require = createRequire(join(repo, "apps/desktop/package.json"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * The Claude Code a `claude-agent-acp` ships: the SDK's manifest next to the
 * platform package, found the way the core finds it
 * (`core/acp/prestart.ts::bundledClaudeCodeVersion`).
 */
export function bundledClaudeCode(program) {
  let dir;
  try {
    dir = dirname(realpathSync(program));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(
      dir,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "package.json",
    );
    if (existsSync(manifest)) {
      try {
        return JSON.parse(readFileSync(manifest, "utf8")).claudeCodeVersion;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** The adapter under test, or why there is none. */
export function findAdapter(env = process.env) {
  const candidates = env.ARMADRA_CLAUDE_ACP_BIN
    ? [env.ARMADRA_CLAUDE_ACP_BIN]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, "claude-agent-acp"));
  for (const program of candidates) {
    if (!existsSync(program)) continue;
    const version = bundledClaudeCode(program);
    if (version === undefined || !atLeast(version)) {
      return {
        reason: `${program} ships Claude Code ${version ?? "unknown"}, below ${CLAUDE_MODS_MIN}`,
      };
    }
    return { program, version };
  }
  return {
    reason: `no claude-agent-acp (set ARMADRA_CLAUDE_ACP_BIN)`,
  };
}

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
        JSON.stringify({
          kind: "terminal",
          cwd: ".",
          agent: { id: "claude", driver: "acp" },
        }),
        now,
        now,
      );
    return id;
  } finally {
    database.close();
  }
}

function status(dataDir, nodeId) {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(join(dataDir, "canvas.db"), {
    readOnly: true,
  });
  try {
    return database
      .prepare(
        "SELECT state, state_source AS source, last_event_at AS at FROM agent_status WHERE node_id = ?",
      )
      .get(nodeId);
  } finally {
    database.close();
  }
}

async function waitFor(what, read, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(250);
  }
}

function digest(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "absent";
  }
}

async function main() {
  const found = findAdapter();
  if (found.program === undefined) {
    console.log(`skip: ${found.reason}`);
    return;
  }
  console.log(
    `claude-agent-acp at ${found.program}, Claude Code ${found.version}`,
  );
  const operatorSettings = join(homedir(), ".claude", "settings.json");
  const before = digest(operatorSettings);

  const root = mkdtempSync(join(tmpdir(), "armadra-claude-mod-acp-"));
  const dataDir = join(root, "data");
  const bin = join(root, "bin");
  const work = join(dataDir, "work");
  mkdirSync(work, { recursive: true });
  mkdirSync(bin);
  symlinkSync(found.program, join(bin, "claude-agent-acp"));
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
      ANTHROPIC_API_KEY: "sk-ant-api03-armadra-probe-fake",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
      // Nothing of the operator's: no plugin folder of theirs rides along.
      CLAUDE_CODE_PLUGIN_DIRS: "",
      CLAUDE_CODE_EXECUTABLE: "",
    },
  });
  let failure;
  const call = async (path, init = {}) => {
    const response = await fetch(`${core.base}${path}`, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    const body = text === "" ? undefined : JSON.parse(text);
    assert(response.ok, `${path}: ${response.status} ${text}`);
    return body;
  };
  try {
    seedWorkspace(dataDir);
    const nodeId = seedNode(dataDir, "acp");
    const session = await call("/api/acp/sessions", {
      method: "POST",
      body: { workspaceId: WORKSPACE, nodeId, cwd: work, agentId: "claude" },
    });
    assert(session.backend === "acp", JSON.stringify(session));

    // 1. The hello, from the CLI the adapter started.
    const hello = await waitFor("the mod's hello", async () =>
      (await call("/api/agents/claude/integration")).mods.sessions.find(
        (one) => one.nodeId === nodeId,
      ),
    );
    assert(
      hello.profile === "acp" && hello.version === found.version,
      `hello: ${JSON.stringify(hello)}`,
    );
    console.log(`1. hello with profile acp (${hello.transport})`);

    // 2. The commands, as the adapter lists them.
    const listed = await waitFor("the armadra commands", async () => {
      const log = await call(`/api/acp/sessions/${session.id}/log`);
      const names = (log.snapshot?.availableCommands ?? []).map(
        (one) => one.name,
      );
      return names.includes("armadra-list") ? names : undefined;
    });
    const ours = listed.filter((name) => name.startsWith("armadra"));
    assert(ours.length === 7, `commands: ${JSON.stringify(listed)}`);
    console.log(`2. the adapter lists ${ours.join(", ")}`);

    // 3. A slash command, answered by the mod.
    const turnsBefore = api.turns();
    const since = Date.now() - 1000;
    await call(`/api/acp/sessions/${session.id}/prompt`, {
      method: "POST",
      body: { text: "/armadra-list" },
    });
    await waitFor("the command's turn", () => {
      const row = status(dataDir, nodeId);
      return row?.state === "done" && Date.parse(row.at ?? "") >= since
        ? row
        : undefined;
    });
    const log = await call(`/api/acp/sessions/${session.id}/log`);
    // The canvas list names this node; the engine heads it with the mod's name.
    const answered = (log.entries ?? []).some(
      (entry) =>
        entry.role === "assistant" &&
        (entry.blocks ?? []).some(
          (block) => block.type === "text" && block.text?.includes(nodeId),
        ),
    );
    assert(answered, `log: ${JSON.stringify(log.entries ?? []).slice(-2000)}`);
    assert(
      api.turns() === turnsBefore,
      `/armadra-list asked the model (${api.turns() - turnsBefore} turns)`,
    );
    console.log(
      "3. /armadra-list answered by the mod with the canvas list, no model turn",
    );

    // 4. One writer for the node's state.
    const row = status(dataDir, nodeId);
    assert(row?.source === "acp", `status: ${JSON.stringify(row)}`);
    console.log("4. the node's state stays the ACP session's");

    assert(
      digest(operatorSettings) === before,
      "~/.claude/settings.json changed",
    );
    console.log("5. ~/.claude/settings.json unchanged");
    console.log("\nOK");
  } catch (error) {
    failure = new Error(
      `${error.stack ?? error.message}\n--- core log ---\n${core.stderr().slice(-6000)}`,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
