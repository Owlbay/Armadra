/** Deterministic test CLI, never a real model. Uses the real injected Hook client. */
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const agent =
  process.env.ARMADRA_AGENT_ID ||
  (process.argv[1].includes("claude") ? "claude" : "codex");
if (process.argv.includes("--version")) {
  process.stdout.write(
    agent === "codex"
      ? "codex-cli 0.159.0 (fixture)\n"
      : "2.1.0 (Claude Code fixture)\n",
  );
  process.exit(0);
}
process.title = agent;
const root = process.cwd(),
  reports = join(root, "reports");
mkdirSync(reports, { recursive: true });
appendFileSync(
  join(reports, "launches.jsonl"),
  JSON.stringify({
    agent,
    nodeId: process.env.ARMADRA_NODE_ID,
    sessionId: process.env.ARMADRA_SESSION_ID,
    generation: process.env.ARMADRA_SESSION_GENERATION,
  }) + "\n",
);
function hook(payload) {
  const result = spawnSync(process.env.ARMADRA_HOOK_BIN, [agent], {
    input: JSON.stringify({
      session_id: "fixture-" + process.env.ARMADRA_SESSION_ID,
      ...payload,
    }),
    encoding: "utf8",
    timeout: 5000,
    env: process.env,
  });
  if (result.status !== 0 || result.error)
    process.stderr.write("fixture Hook transport failed\n");
}
if (agent === "claude") hook({ hook_event_name: "SessionStart" });
process.stdout.write(
  "deterministic fixture ready\n" +
    (agent === "claude"
      ? "❯\n? for shortcuts\n"
      : "› Ask Codex to do anything\n"),
);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let bytes = "",
  busy = false;
process.stdin.on("data", (chunk) => {
  bytes += chunk.toString("utf8");
  const begin = bytes.indexOf("\x1b[200~"),
    end = bytes.indexOf("\x1b[201~\r");
  if (begin < 0 || end < begin || busy) return;
  const prompt = bytes.slice(begin + 6, end);
  bytes = bytes.slice(end + 7);
  busy = true;
  appendFileSync(
    join(reports, "submissions.jsonl"),
    JSON.stringify({
      agent,
      sessionId: process.env.ARMADRA_SESSION_ID,
      generation: process.env.ARMADRA_SESSION_GENERATION,
    }) + "\n",
  );
  hook({ hook_event_name: "UserPromptSubmit", prompt });
  if (prompt.includes("FIXTURE_HOLD")) {
    process.stdout.write("fixture holding\n");
    return;
  }
  function finishTurn() {
    if (prompt.includes("FIXTURE_IMPLEMENT")) {
      writeFileSync(
        join(reports, "change.md"),
        "Deterministic fixture implementation; no model was called.\n",
      );
    } else if (prompt.includes("FIXTURE_REVIEW")) {
      const { existsSync } = require("node:fs");
      if (!existsSync(join(reports, "change.md"))) {
        hook({ hook_event_name: "Stop", errored: true });
        busy = false;
        return;
      }
      writeFileSync(
        join(reports, "review.md"),
        "Deterministic fixture review saw reports/change.md; no model was called.\n",
      );
    }
    process.stdout.write("fixture turn finished\n");
    hook({
      hook_event_name: "Stop",
      last_agent_message: "deterministic fixture finished",
    });
    busy = false;
  }
  if (prompt.includes("FIXTURE_LOG_BYTES=2097152")) {
    const output = Buffer.from(
      "RAW_LOG_MARKER " + "x".repeat(2097152 - 16) + "\n",
    );
    if (output.length !== 2097152)
      throw new Error("fixture output length mismatch");
    writeFileSync(join(reports, "log-bytes.txt"), String(output.length));
    process.stdout.write(output, finishTurn);
  } else finishTurn();
});
