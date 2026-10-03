#!/usr/bin/env node
/**
 * 工作流引擎端到端（补全执行计划 G1-8，A 档）：一个两步模板在真 core 里走通。
 *
 *   1. 临时数据目录、临时 HOME 里起 `apps/desktop/out/core/main.js`；
 *   2. 注册一个自定义 Agent `custom:wfecho`（借 Claude 的 hook 适配）：它是本脚
 *      本写出来的一个假 CLI——打印提示符，读一行提示词，经 `armadra-hook claude`
 *      报 `UserPromptSubmit` / `Stop`，提示词里写着 `post to <名字>` 就
 *      `armadra-hook canvas post` 一条结论；
 *   3. 经 `/api/workflows/*` 建模板（`s1` prompt → `s2` collect）并起跑；
 *   4. 不开页面：core 自己起角色节点的终端、敲启动行、投提示词、判完成；
 *   5. 断言运行 `succeeded`、`s1` 的产出是假 CLI post 的那条、`s2` 投给 lead
 *      的正文带着汇总说明、lead 的收件箱里有 `s1` 的结论。
 *
 * 不用真实账号、不碰操作员的数据目录与配置：HOME、XDG、CLAUDE_CONFIG_DIR 全
 * 指到临时目录，跑完删除。前置：`pnpm --filter @armadra/desktop build`。
 *
 *   node tools/probes/workflow-e2e.mjs [输出目录]
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const coreEntry = join(repo, "apps/desktop/out/core/main.js");
const output = resolve(process.argv[2] ?? join(repo, "target/workflow-e2e"));
const require = createRequire(join(repo, "apps/desktop/package.json"));
const { DatabaseSync } = require("node:sqlite");

if (process.platform === "win32") {
  // 假 CLI 是一个带 shebang 的脚本；Windows 上这条探针由 Windows 验收脚本覆盖。
  console.log(JSON.stringify({ skipped: "win32" }));
  process.exit(0);
}
if (!existsSync(coreEntry)) {
  console.error(`缺 ${coreEntry}：先跑 pnpm --filter @armadra/desktop build`);
  process.exit(1);
}

const FAKE_CLI = String.raw`#!/usr/bin/env node
// workflow-e2e 的假 CLI：读一行提示词，报一轮，按需 post 一条结论。
const { spawnSync } = require("node:child_process");
const readline = require("node:readline");
const hook = __HOOK__;
const session = "wfecho-" + process.pid;
const fs = require("node:fs");
const trace = (line) => {
  fs.appendFileSync(__LOG__, process.pid + " " + line + "\n");
};
trace("start " + JSON.stringify(process.argv.slice(2)) + " node=" + process.env.ARMADRA_NODE_ID);
function report(event, extra) {
  if (!hook) return;
  const answer = spawnSync(hook, ["claude"], {
    input: JSON.stringify({ hook_event_name: event, session_id: session, cwd: process.cwd(), ...(extra || {}) }),
    stdio: ["pipe", "ignore", "pipe"],
    timeout: 10000,
  });
  trace(event + " exit=" + answer.status + " " + String(answer.stderr || "").slice(0, 300));
}
report("SessionStart");
process.stdout.write("wfecho ready\n❯ \n");
const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on("line", (raw) => {
  const line = raw.replace(/\x1b\[20[01]~/g, "").trim();
  if (line === "") return;
  trace("line " + JSON.stringify(line));
  report("UserPromptSubmit", { prompt: line });
  const target = /post to (\S+)/.exec(line);
  if (target && hook) {
    spawnSync(hook, ["canvas", "post", "--to", target[1], "--key", "wf-" + Date.now(), "--body", "echo: " + line], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10000,
    });
  }
  process.stdout.write("echo: " + line + "\n");
  setTimeout(() => {
    report("Stop");
    process.stdout.write("❯ \n");
  }, 500);
});
`;

const TEMPLATE = {
  version: 1,
  title: "workflow-e2e",
  params: [{ name: "topic", type: "string" }],
  roles: [
    { id: "worker", agentId: "custom:wfecho", title: "worker" },
    { id: "lead", agentId: "custom:wfecho", title: "lead" },
  ],
  links: [{ from: "lead", to: "worker", role: "supervises" }],
  steps: [
    {
      id: "s1",
      kind: "prompt",
      role: "worker",
      prompt: "look at {{topic}} and post to lead",
    },
    {
      id: "s2",
      kind: "collect",
      role: "lead",
      from: ["s1"],
      prompt: "summarize {{topic}}",
      after: ["s1"],
    },
  ],
};

const scratch = mkdtempSync(join(tmpdir(), "armadra-workflow-e2e-"));
const data = join(scratch, "data");
const home = join(scratch, "home");
const project = join(scratch, "project");
const bin = join(scratch, "bin");
for (const dir of [data, home, project, bin])
  mkdirSync(dir, { recursive: true });
mkdirSync(output, { recursive: true });
const fake = join(bin, "wfecho");
// 路径写进脚本里：core 替节点起的终端不带自定义 Agent 的 `env`（经启动器
// 起的 CLI 只拿到终端自己的环境），假 CLI 不能靠它找 armadra-hook。
writeFileSync(
  fake,
  FAKE_CLI.replace(
    "__HOOK__",
    JSON.stringify(join(data, "bin", "armadra-hook")),
  ).replace("__LOG__", JSON.stringify(join(scratch, "wfecho.log"))),
);
chmodSync(fake, 0o755);

const environment = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(scratch, "xdg"),
  XDG_DATA_HOME: join(scratch, "xdg-data"),
  CLAUDE_CONFIG_DIR: join(scratch, "claude"),
  CODEX_HOME: join(scratch, "codex"),
  ARMADRA_SECRET_BACKEND: "file",
  PATH: `${bin}:${process.env.PATH ?? ""}`,
  SHELL: "/bin/sh",
};
delete environment.TMUX;
delete environment.TMUX_PANE;
delete environment.CLAUDECODE;

const result = { ok: false, steps: [] };
let core;
let coreLog = "";
let api;

function note(step, detail) {
  result.steps.push({ step, ...(detail === undefined ? {} : { detail }) });
  console.log(
    `· ${step}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
}

async function waitFor(what, test, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(250);
  }
}

/** 失败时各角色终端的最后几十行（只在失败时取，进 result.json）。 */
async function screens() {
  const out = {};
  try {
    const database = new DatabaseSync(join(data, "canvas.db"), {
      readOnly: true,
    });
    const rows = database
      .prepare("SELECT id, owner_node_id FROM terminal_sessions")
      .all();
    database.close();
    for (const row of rows) {
      try {
        const capture = await api(
          `/api/terminals/${row.id}/capture?lines=40&escapes=false`,
        );
        out[row.owner_node_id] = String(capture.data ?? "").split("\n");
      } catch (error) {
        out[row.owner_node_id] = String(error);
      }
    }
  } catch (error) {
    return { error: String(error) };
  }
  return out;
}

/** 失败时把库里与这次运行有关的几张表读出来（不含正文以外的东西）。 */
function diagnose() {
  try {
    const database = new DatabaseSync(join(data, "canvas.db"), {
      readOnly: true,
    });
    try {
      const all = (sql) => database.prepare(sql).all();
      return {
        steps: all(
          "SELECT step_id, status, node_id, attempts, delivered, observed_busy, reason FROM workflow_run_steps",
        ),
        queue: all(
          "SELECT target_node_id, origin, state, last_reason, attempts FROM agent_send_queue",
        ),
        status: all(
          "SELECT node_id, state, state_source, session_phase, last_event_at FROM agent_status",
        ),
        launches: all(
          "SELECT node_id, state, reason, attempts FROM agent_dependency_launches",
        ),
        sessions: all(
          "SELECT owner_node_id, agent_id, status FROM terminal_sessions",
        ),
        fake: existsSync(join(scratch, "wfecho.log"))
          ? readFileSync(join(scratch, "wfecho.log"), "utf8").split("\n")
          : [],
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return { error: String(error) };
  }
}

try {
  core = spawn(
    process.execPath,
    [coreEntry, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: environment },
  );
  core.stdout.on("data", (chunk) => (coreLog += chunk));
  core.stderr.on("data", (chunk) => (coreLog += chunk));
  const origin = await waitFor("core 公布端点", () => {
    if (core.exitCode !== null) throw new Error("core 退出了");
    try {
      return JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
        .runtime.http;
    } catch {
      return undefined;
    }
  });
  note("core 已启动", origin);

  api = async (path, init = {}) => {
    const answer = await fetch(new URL(path, origin), {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const text = await answer.text();
    if (!answer.ok) {
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text}`,
      );
    }
    return text === "" ? null : JSON.parse(text);
  };

  const hookBin = join(data, "bin", "armadra-hook");
  await waitFor("armadra-hook", () => existsSync(hookBin));
  await api("/api/agents/claude/integration/install", { method: "POST" });
  await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      terminal: { ecoMode: false },
      agents: {
        custom: [
          {
            id: "custom:wfecho",
            label: "wfecho",
            launchCmd: fake,
            baseAgent: "claude",
          },
        ],
      },
    }),
  });
  note("假 CLI 已注册", { id: "custom:wfecho" });

  const workspace = await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name: "workflow-e2e",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    }),
  });
  const boards = await api(`/api/workspaces/${workspace.id}/boards`);
  const board =
    boards[0] ??
    (await api(`/api/workspaces/${workspace.id}/boards`, {
      method: "POST",
      body: JSON.stringify({ name: "e2e" }),
    }));

  const { template } = await api("/api/workflows/templates", {
    method: "POST",
    body: JSON.stringify({ template: TEMPLATE }),
  });
  const started = await api("/api/workflows/runs", {
    method: "POST",
    body: JSON.stringify({
      templateId: template.id,
      params: { topic: "README" },
      boardId: board.id,
    }),
  });
  const runId = started.run.id;
  note("已起跑", { runId, roles: started.run.roles });

  const run = await waitFor(
    "运行结束",
    async () => {
      const { run: current } = await api(`/api/workflows/runs/${runId}`);
      return ["succeeded", "failed", "cancelled"].includes(current.status)
        ? current
        : undefined;
    },
    120_000,
  );
  result.run = run;
  note("运行结束", { status: run.status, reason: run.reason });
  if (run.status !== "succeeded")
    throw new Error(`运行没有成功：${run.reason}`);

  const s1 = run.steps.find((step) => step.stepId === "s1");
  if (!s1?.outputs.some((output) => output.body.includes("look at README"))) {
    throw new Error(`s1 没有产出：${JSON.stringify(s1)}`);
  }
  const database = new DatabaseSync(join(data, "canvas.db"), {
    readOnly: true,
  });
  try {
    const lead = run.roles.lead;
    const inbox = database
      .prepare("SELECT body FROM agent_mailbox WHERE target_node_id = ?")
      .all(lead);
    if (!inbox.some((row) => row.body.includes("look at README"))) {
      throw new Error("lead 的收件箱里没有 s1 的结论");
    }
    const deliveries = database
      .prepare(
        "SELECT body, state FROM agent_send_queue WHERE target_node_id = ? ORDER BY created_at",
      )
      .all(lead);
    if (
      !deliveries.some(
        (row) => row.state === "done" && row.body.includes("summarize README"),
      )
    ) {
      throw new Error(`collect 没有投给 lead：${JSON.stringify(deliveries)}`);
    }
  } finally {
    database.close();
  }
  result.ok = true;
  note("通过");
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  console.error(result.error);
  result.diagnostics = diagnose();
  result.diagnostics.screens = await screens();
  console.error(JSON.stringify(result.diagnostics, null, 2));
} finally {
  if (core !== undefined && core.exitCode === null) {
    core.kill("SIGTERM");
    await Promise.race([
      new Promise((done) => core.once("exit", done)),
      sleep(5_000).then(() => core.kill("SIGKILL")),
    ]);
  }
  writeFileSync(join(output, "core.log"), coreLog);
  writeFileSync(
    join(output, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(result.ok ? 0 : 1);
