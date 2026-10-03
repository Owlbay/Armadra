// 场景 12：六家 ACP（设计 acp-session-view §11，D13）。C 档。
//
// 六家（claude、codex、opencode、pi、omp、copilot）各起一个以 ACP 驱动的节点，
// 按这个顺序以 `peer` 连成环，然后：
//
//   1. 预检：每家的 ACP 入口装了没有（`acpAdapterInstalled`）、凭据能不能只复制
//      出来；不行的整家记 skipped，不装、不回退到真实目录。起来之后再核
//      `GET /api/agents` 的 `acp.installed`。
//   2. 每家经 `POST /api/acp/sessions` 带首条 prompt「Reply with just OK.」起会
//      话：`agent_status.state_source = 'acp'`、回合结束 `done`、镜像
//      （`GET /api/acp/sessions/{id}/log`）里有一条 assistant 记录。
//   3. Claude：会话切到 `default` 模式，发一条会写文件的 prompt，等审批卡，经**页
//      面**点「拒绝」（`reject_once`）；断言审批行 `answer = deny`、
//      `request_json.options` 的形状、审计 `route = acp`、节点回到 `done`、文件
//      没写出来。
//   4. 沿环 `canvas send` 一轮（每家第二轮）：每条 `delivered`、目标跑完一轮；下
//      游以自己的节点身份 `context summary` 读上游，读得到内容。
//   5. Claude 切到终端视图再切回：两次都 `resumed: true`、`agent_status.session_id`
//      不变；终端里起的是 `claude --resume <id> --permission-mode acceptEdits`
//      （节点是「自动编辑」：显式的模式不弹「把 auto 设成缺省？」）。Claude 进新目录
//      先问信任：经页面按「Yes」那一项的**编号**答（缺省高亮的可能是「No, exit」，
//      回车不安全）；认不出的画面一律不答，先结束终端再切回。Copilot 切过去再切回：
//      `resumed: false`，事件流里有那条 `acp.driver`。
//   6. OpenCode 休眠再唤醒（`ARMADRA_TEST_ECO_IDLE_SECONDS`）：同一行、适配器 pid
//      换了、会话 id 没变。
//   7. 用量：有 `usage_update` 的家，两轮之后的上下文用量小于 5 万 token；页面全程
//      没有控制台错误；这套 core 没有起任何没经隔离包装的真 CLI。
//
// 隔离（D13 与任务约束）：
//   * core 的 HOME、数据目录、XDG、CODEX_HOME、CLAUDE_CONFIG_DIR、COPILOT_HOME、
//     PI_CODING_AGENT_DIR 全是临时的；PATH 最前面是一个包装目录：每家的 ACP 入口
//     （与它要再起的程序，如 pi-acp → pi）是一个隔离包装脚本，其余真 CLI 名字是
//     替身（`blockRealClis`，调用即记下、以 97 退出）。core 按 PATH 顺序找程序
//     （`terminal/environment.ts::agentPath`），所以它起的任何东西都先经包装。
//   * Claude 的登录在钥匙串里，只认真实配置目录：它的包装把 HOME 换回真实的、去
//     掉 CLAUDE_CONFIG_DIR、关掉自动更新，并用最便宜的模型（`ARMADRA_E2E_CLAUDE_MODEL`，
//     缺省 haiku）。跑前跑后对 ~/.claude/settings.json、settings.local.json、
//     .credentials.json 做字节指纹，`~/.claude.json` 比顶层键摘要
//     （`claudeStateBlame`），并单独盯 `permissions.defaultMode`。ACP 下没有 TUI
//     启动对话框，core 的 ACP 驱动从不替人答 `request_permission` /
//     `elicitation/create`；探针只经页面答这一条审批。
//   * Codex：临时 CODEX_HOME 只复制 auth.json（超过 7 天没刷新就不跑），低推理强度、
//     关掉升级检查、预先信任工作目录。OpenCode / Pi / OMP / Copilot：场景 6 的
//     `prepareCliHomes`（只复制 API key 形式的凭据；Copilot 的令牌经环境变量给这一
//     个进程）。
//   * 每家限两轮（Claude 多一轮审批、OpenCode 不多：唤醒走 `/wake`），回合 90 秒
//     不结束就 `cancel`。
//
// `--self-test`：六家的包装改成 `exec -a <程序名>` 起假 ACP Agent
// （`@armadra/agent/acp` 的测试入口），终端视图里的 `claude` / `copilot` 是一个假
// TUI（没编号的箭头信任菜单、选项晚一秒出现、缺省光标在「No, exit」，光标不在
// 「Yes」上按回车就退出——证明探针认清菜单、移到「Yes」并核对后才按回车）。不读任何凭据、不联网、不需要 `ARMADRA_E2E_REAL`；其余装配与断言与
// 真跑同一份代码。
//
// `--record-compat`（只在真跑时）：通过了全部检查的那几家，把 `initialize` 报的
// 版本写进 tools/release/compatibility.json 的 `acp.adapters.<id>.verified`。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CREDENTIAL_VARIABLES, probeHome } from "../probe-home.mjs";

import { stepTrustDialog } from "./trust-dialog.mjs";
import {
  ACP_PROGRAMS,
  acpAdapterInstalled,
  blockRealClis,
  canvasAsIn,
  claudeDefaultMode,
  claudeStateDigest,
  cleanups,
  cliEnvLines,
  contextAsIn,
  note,
  prepareCliHomes,
  recordCompat,
  report,
  requireReal,
  sanitizeScreen,
  root,
  scenario,
  selfTest,
  sleep,
  startIsolatedCore,
  startPageStack,
  waitFor,
  watchWorkspaceEvents,
  which,
} from "./lib.mjs";

const ALL_FAMILIES = ["claude", "codex", "opencode", "pi", "omp", "copilot"];
/** `ARMADRA_E2E_ACP_ONLY=claude,opencode`：只跑其中几家（其余记 skipped）。 */
const FAMILIES = ALL_FAMILIES;
const CHOSEN = new Set(
  (process.env.ARMADRA_E2E_ACP_ONLY || ALL_FAMILIES.join(","))
    .split(",")
    .map((id) => id.trim()),
);
const TASK = "Reply with just OK.";
const APPROVAL_FILE = "armadra-e2e-approval.txt";
// `[permission]` 是假 ACP Agent 的标记（真 CLI 当作普通文字）。
const APPROVAL_PROMPT = `Create a file named ${APPROVAL_FILE} in the current directory containing the single word hi, using your file writing tool. [permission]`;
const TURN_TIMEOUT = 90_000;
const TOKEN_BUDGET = 50_000;
const ECO_SECONDS = 5;
const FAKE_AGENT = join(
  root,
  "apps/desktop/node_modules/@armadra/agent/dist/drivers/acp/testing/fake-agent-main.js",
);

/**
 * 自检用的假 TUI（终端视图里的 `claude` / `copilot`）：先画一个信任对话框，缺省高
 * 亮「No, exit」——回车或 2 就退出（等于替人选了「不信任」），按 1 才进提示符；
 * 提示符下 `/exit`、`/quit` 退出，其余行答「OK」。argv 原样打出来，探针据此核
 * `--resume <id>` 与权限旗标。
 */
const FAKE_TUI = String.raw`#!/usr/bin/env node
const name = process.argv[2];
const args = process.argv.slice(3);
const out = (text) => process.stdout.write(text);
out("fake " + name + " TUI argv: " + args.join(" ") + "\r\n");
// Claude Code 2.1.287 实测的形态：没有编号的箭头菜单，缺省光标在「No, exit」，
// 选项晚一秒才画出来。回车只在光标停在「Yes」上时才算信任，否则退出。
out("Accessing workspace:\r\nQuick safety check: Is this a project you created or one you trust?\r\n");
let shown = false;
let onYes = false;
const menu = () =>
  out((onYes ? "  No, exit\r\n❯ Yes, I trust this folder\r\n" : "❯ No, exit\r\n  Yes, I trust this folder\r\n") +
    "Enter to confirm · Esc to cancel\r\n");
setTimeout(() => {
  shown = true;
  menu();
}, 1000);
let trusted = false;
let line = "";
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  let text = chunk.toString("utf8");
  if (!trusted) {
    // 选项还没出来就有按键：等于在没看清的对话框上替人答了。
    if (!shown) {
      out("\r\nanswered before the options were shown\r\n");
      process.exit(4);
    }
    if ((text.includes("\x1b[B") || text.includes("\x1bOB"))) { onYes = true; menu(); return; }
    if (text.includes("\x1b[A")) { onYes = false; menu(); return; }
    if (text.includes("\r") || text.includes("\n")) {
      if (!onYes) {
        out("\r\nexiting: not trusted\r\n");
        process.exit(3);
      }
      trusted = true;
      out("\r\nearlier conversation: OK\r\n? for shortcuts\r\n> ");
    }
    return;
  }
  for (const ch of text) {
    if (ch === "\r" || ch === "\n") {
      const said = line.replace(/\x1b\[20[01]~/g, "").trim();
      line = "";
      if (said === "/exit" || said === "/quit") process.exit(0);
      if (said !== "") out("\r\nOK\r\n? for shortcuts\r\n> ");
    } else line += ch;
  }
});
`;

const quote = (word) => `'${String(word).replaceAll("'", "'\\''")}'`;

function writeScript(dir, name, lines) {
  const path = join(dir, name);
  writeFileSync(path, ["#!/bin/bash", ...lines, ""].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

/** 自检：六家的 ACP 入口都是假 ACP Agent，`claude` / `copilot` 的终端视图是假 TUI。 */
function selfTestPlan(scratch, shims) {
  const tui = join(scratch, "fake-tui.cjs");
  writeFileSync(tui, FAKE_TUI);
  const acp = (program) =>
    `exec -a ${quote(program)} ${quote(process.execPath)} ${quote(FAKE_AGENT)} "$@"`;
  const plan = {};
  for (const id of FAMILIES) {
    const program = ACP_PROGRAMS[id];
    if (id === "copilot" || id === "opencode" || id === "omp") {
      // 同一个程序名两用：带 ACP 旗标时是适配器，否则是 TUI。
      writeScript(shims, program, [
        'case " $* " in *" --acp "*|*" acp "*) ' + acp(program) + " ;; esac",
        `exec -a ${quote(program)} ${quote(process.execPath)} ${quote(tui)} ${quote(program)} "$@"`,
      ]);
    } else {
      writeScript(shims, program, [acp(program)]);
    }
    plan[id] = { program, version: "1.0.0" };
  }
  writeScript(shims, "claude", [
    `exec -a claude ${quote(process.execPath)} ${quote(tui)} claude "$@"`,
  ]);
  return { plan, kept: [...Object.values(ACP_PROGRAMS), "claude"] };
}

/** 真跑：每家一个隔离包装；装不上、凭据复制不出来的整家 skipped。 */
function realPlan(scratch, shims, project) {
  const plan = {};
  const kept = [];
  const skip = (id, why) => {
    plan[id] = { skip: why };
  };
  // 没选的家连凭据都不读。
  const homes = prepareCliHomes(scratch, { only: CHOSEN });
  const found = (id) => acpAdapterInstalled(id);

  /* Claude：真实配置目录（钥匙串），最便宜的模型，关自动更新。 */
  {
    const acp = found("claude");
    const tui = which("claude");
    if (!CHOSEN.has("claude")) skip("claude", "ARMADRA_E2E_ACP_ONLY 没选这家");
    else if (!acp.installed)
      skip("claude", "没有 claude-agent-acp（npm i -g）");
    else if (tui === undefined) skip("claude", "没有 claude（终端视图要用）");
    else {
      const env = [
        `export HOME=${quote(homedir())}`,
        "unset CLAUDE_CONFIG_DIR CLAUDECODE",
        "export DISABLE_AUTOUPDATER=1",
        `export ANTHROPIC_MODEL=${quote(process.env.ARMADRA_E2E_CLAUDE_MODEL || "haiku")}`,
      ];
      writeScript(shims, "claude-agent-acp", [
        ...env,
        `exec ${quote(acp.path)} "$@"`,
      ]);
      writeScript(shims, "claude", [...env, `exec ${quote(tui)} "$@"`]);
      kept.push("claude-agent-acp", "claude");
      plan.claude = { program: acp.program };
    }
  }

  /* Codex：临时 CODEX_HOME，只复制 auth.json。 */
  {
    const acp = found("codex");
    let auth;
    if (CHOSEN.has("codex"))
      try {
        auth = JSON.parse(
          readFileSync(join(homedir(), ".codex/auth.json"), "utf8"),
        );
      } catch {}
    const refreshed = Date.parse(auth?.last_refresh ?? "");
    if (!CHOSEN.has("codex")) skip("codex", "ARMADRA_E2E_ACP_ONLY 没选这家");
    else if (!acp.installed) skip("codex", "没有 codex-acp（npm i -g）");
    else if (auth === undefined) skip("codex", "没有 ~/.codex/auth.json");
    else if (
      !Number.isFinite(refreshed) ||
      Date.now() - refreshed > 7 * 86_400_000
    )
      skip(
        "codex",
        "~/.codex/auth.json 超过 7 天没刷新：在临时目录里刷新会让真实那份失效，先在自己的终端里跑一次 codex",
      );
    else {
      const home = join(scratch, "home-codex");
      const codexHome = join(home, ".codex");
      mkdirSync(codexHome, { recursive: true });
      copyFileSync(
        join(homedir(), ".codex/auth.json"),
        join(codexHome, "auth.json"),
      );
      writeFileSync(
        join(codexHome, "config.toml"),
        `model_reasoning_effort = "low"\ncheck_for_update_on_startup = false\n\n[projects."${project}"]\ntrust_level = "trusted"\n`,
      );
      writeScript(shims, "codex-acp", [
        `export HOME=${quote(home)} CODEX_HOME=${quote(codexHome)}`,
        `exec ${quote(acp.path)} "$@"`,
      ]);
      kept.push("codex-acp");
      plan.codex = { program: acp.program };
    }
  }

  /* OpenCode：包里的原生二进制、自带的免费模型。 */
  {
    const cli = homes.opencode;
    if (cli.skip) skip("opencode", cli.skip);
    else {
      const model = process.env.ARMADRA_E2E_OPENCODE_MODEL || cli.model;
      mkdirSync(join(cli.home, ".config/opencode"), { recursive: true });
      writeFileSync(
        join(cli.home, ".config/opencode/opencode.json"),
        `${JSON.stringify({ $schema: "https://opencode.ai/config.json", model, autoupdate: false }, null, 2)}\n`,
      );
      writeScript(shims, "opencode", [
        ...cliEnvLines(scratch, "opencode", cli),
        `exec ${quote(cli.program)} "$@"`,
      ]);
      kept.push("opencode");
      plan.opencode = { program: "opencode" };
    }
  }

  /* Pi：pi-acp 再起 pi，两个都经包装。 */
  {
    const acp = found("pi");
    const cli = homes.pi;
    if (!acp.installed) skip("pi", "没有 pi-acp（npm i -g）");
    else if (cli.skip) skip("pi", cli.skip);
    else {
      writeFileSync(
        join(cli.agentDir, "settings.json"),
        `${JSON.stringify({ defaultProvider: "moonshotai-cn", defaultModel: "kimi-k2.6", defaultThinkingLevel: "off" }, null, 2)}\n`,
      );
      const env = cliEnvLines(scratch, "pi", cli);
      writeScript(shims, "pi-acp", [...env, `exec ${quote(acp.path)} "$@"`]);
      writeScript(shims, "pi", [...env, `exec ${quote(cli.program)} "$@"`]);
      kept.push("pi-acp", "pi");
      plan.pi = { program: acp.program };
    }
  }

  /* OMP：自带 `omp acp`，模型经临时 models.yml 的那一家。 */
  {
    const cli = homes.omp;
    if (cli.skip) skip("omp", cli.skip);
    else {
      writeScript(shims, "omp", [
        ...cliEnvLines(scratch, "omp", cli),
        `exec ${quote(cli.program)} "$@" ${quote(`--model=${cli.model}`)}`,
      ]);
      kept.push("omp");
      plan.omp = { program: "omp" };
    }
  }

  /* Copilot：`copilot --acp --stdio`，令牌只给这一个进程。 */
  {
    const cli = homes.copilot;
    if (cli.skip) skip("copilot", cli.skip);
    else {
      writeScript(shims, "copilot", [
        ...cliEnvLines(scratch, "copilot", cli),
        `exec ${quote(cli.program)} "$@" --model ${quote(cli.model)}`,
      ]);
      kept.push("copilot");
      plan.copilot = { program: "copilot" };
    }
  }
  return { plan, kept };
}

/** 版本号比较（只比数字段）。 */
function compareVersions(a, b) {
  const parts = (v) =>
    String(v)
      .split(/[.+-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** 把实跑通过的版本并进 `verified` 区间（只扩不缩）。 */
export function mergeVerified(current, version) {
  if (current === null || current === undefined) return { min: version };
  const min = compareVersions(version, current.min) < 0 ? version : current.min;
  const top = current.max ?? current.min;
  const max = compareVersions(version, top) > 0 ? version : top;
  return max === min ? { min } : { min, max };
}

export default async function run12() {
  const s = scenario("12-acp");
  const families = (report.acp = {
    mode: selfTest ? "self-test" : "real",
    families: {},
    versions: {},
    usage: {},
  }).families;
  const mark = (id, step, ok, detail) => {
    families[id] ??= {};
    families[id][step] = ok ? "passed" : `failed${detail ? `: ${detail}` : ""}`;
    return s.check(`${id}：${step}`, ok, detail);
  };
  try {
    requireReal("场景 12 ");
    if (!existsSync(FAKE_AGENT) && selfTest)
      throw new Error(`没有假 ACP Agent：${FAKE_AGENT}（pnpm install）`);
    const scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "armadra-acp-real-")),
    );
    cleanups.push(() =>
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
    );
    const project = join(scratch, "project");
    mkdirSync(project);
    writeFileSync(join(project, "README.md"), "# acp probe\n");
    execFileSync("git", ["init", "-q", project]);

    if (!selfTest) {
      // 开场快照：Claude 在真实配置目录里跑。
      report.safety.claudeDefaultMode ??= { before: claudeDefaultMode() };
      report.safety.claudeState = {
        before: claudeStateDigest(),
        scratchRoots: [scratch, project],
      };
    }

    /* ------------------------------ 1. 预检 ------------------------------ */

    const shims = join(scratch, "bin");
    mkdirSync(shims);
    const { plan, kept } = selfTest
      ? selfTestPlan(scratch, shims)
      : realPlan(scratch, shims, project);
    const blocked = blockRealClis(shims, join(scratch, "blocked.log"), kept);
    for (const id of FAMILIES)
      if (!CHOSEN.has(id)) plan[id] = { skip: "ARMADRA_E2E_ACP_ONLY 没选这家" };
    const active = FAMILIES.filter((id) => plan[id]?.skip === undefined);
    for (const id of FAMILIES) {
      if (plan[id]?.skip !== undefined) {
        families[id] = { skipped: plan[id].skip };
        s.check(`${id}：跳过`, true, plan[id].skip);
      }
    }
    if (active.length === 0) throw new Error("六家都没装或认证不上");

    const data = join(scratch, "rt");
    // core 的 HOME、XDG、各 CLI 配置目录与 git 全局配置：`probe-home.mjs`。
    const probe = probeHome("armadra-acp-home-");
    cleanups.push(probe.remove);
    const coreHome = probe.path;
    mkdirSync(data);
    const probeShell = writeScript(scratch, "probe-shell", [
      "unset CLAUDE_CONFIG_DIR",
      "export PS1='probe$ '",
      existsSync("/bin/zsh")
        ? 'exec /bin/zsh -f "$@"'
        : 'exec /bin/bash --noprofile --norc "$@"',
    ]);
    const environment = {
      ...process.env,
      ...probe.env,
      PATH: `${shims}:${process.env.PATH ?? ""}`,
      SHELL: probeShell,
      ARMADRA_DATA_DIR: data,
      ARMADRA_LOG: "info",
      ARMADRA_SECRET_BACKEND: "file",
      ARMADRA_NO_GLOBAL_WRITES: "1",
      ARMADRA_TEST_ECO_IDLE_SECONDS: String(ECO_SECONDS),
      PI_CODING_AGENT_DIR: join(coreHome, ".pi/agent"),
    };
    for (const name of [
      "TMUX",
      "TMUX_PANE",
      "CLAUDECODE",
      ...CREDENTIAL_VARIABLES,
    ])
      delete environment[name];
    for (const name of Object.keys(environment))
      if (/^(AMA_API_KEY_|ANTHROPIC_)/.test(name)) delete environment[name];
    const { api, origin } = await startIsolatedCore({
      data,
      environment,
      logName: "core-acp.log",
    });
    const context = {
      hook: join(root, "apps/desktop/out/cli/armadra-hook.js"),
      data,
      home: coreHome,
    };
    await api("/api/settings", {
      method: "PATCH",
      body: { terminal: { ecoMode: false } },
    });
    for (const id of active)
      await api(`/api/agents/${id}/integration/install`, {
        method: "POST",
      }).catch((error) => note(`${id} 注入产物准备失败`, error.message));
    const agentsRows = await api("/api/agents");
    for (const id of active) {
      const row = agentsRows.find((agent) => agent.id === id);
      mark(
        id,
        "installed",
        row?.acp?.installed === true && row.acp.program === plan[id].program,
        row?.acp,
      );
    }

    /* --------------------------- 画布：一圈节点 --------------------------- */

    const workspace = await api("/api/workspaces", {
      method: "POST",
      body: {
        name: "agent-e2e-acp",
        rootPath: project,
        permissions: { read: true, write: true, execute: true },
      },
    });
    const board = (await api(`/api/workspaces/${workspace.id}/boards`))[0];
    const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
    const initial = await api(documentPath);
    const stamp = new Date().toISOString();
    const nodes = Object.fromEntries(
      active.map((id, index) => [
        id,
        {
          id: randomUUID(),
          boardId: board.id,
          type: "terminal",
          title: `acp-${id}`,
          color: "#0a84ff",
          position: { x: (index % 3) * 640, y: Math.floor(index / 3) * 600 },
          size: { width: 600, height: 540 },
          labels: [],
          note: "",
          data: {
            kind: "terminal",
            cwd: project,
            agent: {
              id,
              driver: "acp",
              // Claude「自动编辑」：切到终端视图时启动行带显式模式，不弹「把
              // auto 设成缺省？」。审批那一轮临时把 ACP 会话切到 default。
              ...(id === "claude" ? { permissionMode: "auto-edit" } : {}),
            },
          },
          createdAt: stamp,
          updatedAt: stamp,
        },
      ]),
    );
    const ring = active.map((id) => nodes[id]);
    await api(documentPath, {
      method: "PUT",
      body: {
        expectedUpdatedAt: initial.board.updatedAt,
        nodes: ring,
        edges:
          ring.length < 2
            ? []
            : ring.map((node, index) => ({
                id: randomUUID(),
                boardId: board.id,
                source: node.id,
                target: ring[(index + 1) % ring.length].id,
                kind: "link",
                role: "peer",
                createdAt: stamp,
                updatedAt: stamp,
              })),
        viewport: { x: 20, y: 20, zoom: 0.5 },
        whiteboard: "",
      },
    });

    const database = new DatabaseSync(join(data, "canvas.db"), {
      readOnly: true,
    });
    cleanups.push(() => database.close());
    const one = (sql, ...params) => database.prepare(sql).get(...params);
    const status = (nodeId) =>
      one(
        "SELECT state, state_source, session_id, last_event_at FROM agent_status WHERE node_id = ?",
        nodeId,
      );
    const row = (nodeId) =>
      one(
        "SELECT id, backend_kind, generation, status, termination_intent FROM terminal_sessions WHERE owner_node_id = ? ORDER BY (status = 'running') DESC, generation DESC LIMIT 1",
        nodeId,
      );

    // 事件流：用量（`usage_update`）与驱动切换（`acp.driver`）。
    const driverEvents = [];
    const usage = report.acp.usage;
    await watchWorkspaceEvents(origin, workspace.id, (event) => {
      if (event?.type === "acp.driver") driverEvents.push(event);
      const update = event?.type === "acp.update" ? event.update : undefined;
      if (update?.sessionUpdate === "usage_update" && event.nodeId) {
        const id = active.find((family) => nodes[family].id === event.nodeId);
        if (id !== undefined)
          usage[id] = Math.max(usage[id] ?? 0, Number(update.used) || 0);
      }
    });

    /** 等一轮结束（`since` 之后状态回到 done、来源 acp）；超时就取消这一轮。 */
    const waitTurn = async (id, sessionId, since) => {
      try {
        return await waitFor(
          `${id} 回合结束`,
          () => {
            const current = status(nodes[id].id);
            return current?.state_source === "acp" &&
              current.state === "done" &&
              Date.parse(current.last_event_at ?? "") >= since
              ? current
              : undefined;
          },
          { timeout: TURN_TIMEOUT, interval: 300 },
        );
      } catch (error) {
        await api(`/api/acp/sessions/${sessionId}/cancel`, {
          method: "POST",
        }).catch(() => undefined);
        throw error;
      }
    };

    /* --------------------------- 2. 每家第一轮 --------------------------- */

    const sessions = {};
    const firstTurn = new Set();
    for (const id of active) {
      const since = Date.now() - 1000;
      try {
        const session = await api("/api/acp/sessions", {
          method: "POST",
          body: {
            workspaceId: workspace.id,
            nodeId: nodes[id].id,
            cwd: project,
            agentId: id,
            ...(id === "claude" ? { permissionMode: "auto-edit" } : {}),
            prompt: TASK,
          },
        });
        sessions[id] = session.id;
        const done = await waitTurn(id, session.id, since);
        const log = await api(`/api/acp/sessions/${session.id}/log`);
        const answered = (log.entries ?? []).some(
          (entry) =>
            entry.role === "assistant" &&
            (entry.blocks ?? []).some(
              (block) => block.type === "text" && block.text?.trim(),
            ),
        );
        if (
          mark(
            id,
            "turn",
            session.backend === "acp" &&
              done.state_source === "acp" &&
              answered,
            { backend: session.backend, state: done.state, answered },
          )
        )
          firstTurn.add(id);
      } catch (error) {
        mark(id, "turn", false, error.message);
      }
    }
    const listed = await api("/api/agents");
    for (const id of active) {
      const version = listed.find((agent) => agent.id === id)?.acp?.version;
      report.acp.versions[id] = version ?? null;
    }
    note("ACP 入口版本（initialize 报的）", report.acp.versions);

    /* ------------------------------ 页面 ------------------------------ */

    const stack = await startPageStack(environment);
    const page = await stack.open("acp");
    page.drain();
    await page.navigate(
      `${stack.web}/?workspace=${workspace.id}&board=${board.id}`,
    );
    await page.settle();
    const nodeSelector = (id) => `.react-flow__node[data-id="${nodes[id].id}"]`;
    const center = (id) =>
      page.evaluate(
        `window.dispatchEvent(new CustomEvent("armadra:canvas:center-node", { detail: { nodeId: ${JSON.stringify(nodes[id].id)} } })); return 1;`,
      );
    /**
     * 点节点里的一个元素：取它的中心，确认那一点命中的就是它（没被别的东西盖
     * 住）、两次量的位置不变，再按下去。不用页面库的 `click`：它先
     * `scrollIntoView`，画布的容器被滚动后节点位置一直在变，六个节点时永远量不
     * 稳。
     */
    const clickInNode = async (id, inner, text) => {
      await center(id);
      const point = await waitFor(
        `${id} 节点里可点的 ${inner}${text ? `「${text}」` : ""}`,
        async () => {
          const measure = () =>
            page.evaluate(`
              const all = [...document.querySelectorAll(${JSON.stringify(`${nodeSelector(id)} ${inner}`)})]
                .filter((el) => el.getClientRects().length > 0 && !el.disabled);
              const text = ${JSON.stringify(text ?? null)};
              const el = (text === null ? all : all.filter((node) => (node.innerText ?? "").trim() === text)).at(-1);
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              const hit = document.elementFromPoint(x, y);
              return hit && (hit === el || el.contains(hit)) ? { x, y } : null;
            `);
          const first = await measure();
          await sleep(120);
          const second = await measure();
          return first &&
            second &&
            Math.abs(first.x - second.x) < 0.5 &&
            Math.abs(first.y - second.y) < 0.5
            ? second
            : undefined;
        },
        { timeout: 20_000, interval: 300 },
      );
      await page.clickAt(point);
    };
    await page.capture("12-acp-ring");

    /* ---------------------- 3. Claude 的审批经页面答 ---------------------- */

    if (firstTurn.has("claude")) {
      const id = "claude";
      try {
        await api(`/api/acp/sessions/${sessions.claude}/mode`, {
          method: "POST",
          body: { modeId: "default" },
        });
        const since = Date.now() - 1000;
        // 经页面的输入框发：页面成了这个会话的驾驶者，审批卡上才有按钮
        // （没驾驶权的人看到的是「等待接管」，契约 §23）。
        await clickInNode(id, "textarea");
        await page.call("Input.insertText", { text: APPROVAL_PROMPT });
        await sleep(150);
        await page.key("Enter");
        await page.waitFor(
          `return !!document.querySelector(${JSON.stringify(`${nodeSelector(id)} [data-slot="acp-permission"]`)});`,
          { what: "Claude 的审批卡", timeout: TURN_TIMEOUT },
        );
        mark(id, "approvalBlocked", status(nodes[id].id)?.state === "blocked");
        await page.capture("12-claude-approval");
        await clickInNode(id, '[data-slot="acp-permission"] button', "拒绝");
        await waitTurn(id, sessions.claude, since);
        const approval = one(
          "SELECT id, answer, request_json FROM agent_approvals WHERE node_id = ? ORDER BY created_at DESC LIMIT 1",
          nodes[id].id,
        );
        const audit = one(
          "SELECT route FROM agent_approval_audit WHERE approval_id = ? AND accepted = 1",
          approval?.id ?? "",
        );
        const request = JSON.parse(approval?.request_json ?? "{}");
        const options = Array.isArray(request.options) ? request.options : [];
        mark(
          id,
          "approval",
          approval?.answer === "deny" &&
            audit?.route === "acp" &&
            request.protocol === "acp" &&
            options.length >= 2 &&
            options.every(
              (option) =>
                typeof option.optionId === "string" &&
                typeof option.name === "string" &&
                typeof option.kind === "string",
            ) &&
            options.some((option) => option.kind === "reject_once"),
          {
            answer: approval?.answer,
            route: audit?.route,
            kinds: options.map((option) => option.kind),
          },
        );
        mark(id, "approvalNoWrite", !existsSync(join(project, APPROVAL_FILE)));
        await api(`/api/acp/sessions/${sessions.claude}/mode`, {
          method: "POST",
          body: { modeId: "acceptEdits" },
        }).catch((error) => note("切回 acceptEdits 失败", error.message));
        // 页面松手：别让人的输入租约挡住随后沿环投来的那一条。
        await page.evaluate(`document.activeElement?.blur?.(); return true;`);
      } catch (error) {
        await page.capture("12-claude-approval-failed").catch(() => undefined);
        note(
          "审批步骤失败时的会话视图",
          await page
            .evaluate(
              `const node = document.querySelector(${JSON.stringify(nodeSelector(id))}); const area = node?.querySelector("textarea"); const rect = area?.getBoundingClientRect(); return { disabled: area?.disabled ?? null, rect: rect ? [rect.left, rect.top, rect.width, rect.height] : null, hit: rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.outerHTML?.slice(0, 200) : null, text: node?.innerText?.slice(0, 300) ?? null };`,
            )
            .catch((reason) => String(reason)),
        );
        mark(id, "approval", false, error.message);
      }
    }

    /* ----------------------- 4. 沿环 send 与读上游 ----------------------- */

    const turned = active.filter((id) => firstTurn.has(id));
    if (turned.length === 2) {
      s.check(
        "沿环 send：只有两家，成不了不回头的环（投递链会判成环），跳过",
        true,
        turned,
      );
    }
    if (turned.length >= 3) {
      // 倒着沿环发：每个发送方都在收到别人的那一条之前发，跳数最多 2（投递链
      // 的上限是 3 跳，顺着发到第五家就被拦下）。
      for (const index of [...turned.keys()].reverse()) {
        const id = turned[index];
        const next = turned[(index + 1) % turned.length];
        const since = Date.now() - 1000;
        const before = Number(
          one(
            "SELECT COUNT(*) AS n FROM agent_deliveries WHERE target_node_id = ?",
            nodes[next].id,
          )?.n,
        );
        const sent = await canvasAsIn(
          context,
          nodes[id].id,
          "send",
          "--to",
          nodes[next].id,
          "--body",
          TASK,
        );
        try {
          const delivered = await waitFor(
            `${id} → ${next} 投递`,
            () =>
              database
                .prepare(
                  "SELECT outcome FROM agent_deliveries WHERE target_node_id = ? ORDER BY created_at",
                )
                .all(nodes[next].id)
                .slice(before)
                .find((entry) => entry.outcome !== "queued"),
            { timeout: 60_000, interval: 500 },
          );
          await waitTurn(next, sessions[next], since);
          mark(
            next,
            "send",
            sent.code === 0 && delivered.outcome === "delivered",
            delivered.outcome,
          );
        } catch (error) {
          mark(next, "send", false, error.message);
        }
      }
    }
    if (turned.length >= 2) {
      for (const [index, upstream] of turned.entries()) {
        const reader = turned[(index + 1) % turned.length];
        const answer = await contextAsIn(
          context,
          nodes[reader].id,
          "summary",
          "--node",
          nodes[upstream].id,
        );
        mark(
          upstream,
          "summaryRead",
          answer.code === 0 && answer.stdout.trim().length > 0,
          answer.code === 0 ? undefined : answer.stderr.slice(0, 200),
        );
      }
    } else {
      s.check("沿环 send：能跑完首轮的不到两家，跳过", true, turned);
    }

    /* ---------------------- 5. 切换驱动：Claude / Copilot ---------------------- */

    const capture = async (sessionId) => {
      try {
        const body = await api(`/api/terminals/${sessionId}/capture?lines=60`);
        return String(body?.data ?? body?.text ?? "");
      } catch {
        return "";
      }
    };
    const processLines = () => {
      try {
        return execFileSync("ps", ["-A", "-ww", "-o", "command="], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }).split("\n");
      } catch {
        return [];
      }
    };
    /**
     * 经页面的节点菜单切驱动（「终端视图」/「会话视图」），与人点的是同一条路：
     * 页面改节点数据里的 `driver`，再调 `POST /api/acp/nodes/{id}/driver`。答事
     * 件流里那条 `acp.driver`（带 `resumed`）。
     */
    const switchDriver = async (id, driver) => {
      const seen = driverEvents.length;
      await center(id);
      await sleep(800);
      const header = await page.evaluate(`
        const el = document.querySelector(${JSON.stringify(nodeSelector(id))});
        const rect = el.getBoundingClientRect();
        return { x: rect.left + 120, y: rect.top + 10 };
      `);
      await page.rightClickAt(header);
      await page.click(
        '[role="menuitem"], [role="menuitemradio"]',
        driver === "terminal" ? "终端视图" : "会话视图",
        { exact: true },
      );
      return waitFor(
        `${id} 的 acp.driver（${driver}）事件`,
        () =>
          driverEvents
            .slice(seen)
            .find(
              (event) =>
                event.nodeId === nodes[id].id && event.driver === driver,
            ),
        { timeout: 60_000, interval: 250 },
      );
    };
    const terminalRow = (id) =>
      waitFor(
        `${id} 换成终端驱动`,
        () => {
          const current = row(nodes[id].id);
          return current?.backend_kind !== "acp" &&
            current?.status === "running"
            ? current
            : undefined;
        },
        { timeout: 30_000, interval: 300 },
      );

    if (firstTurn.has("claude")) {
      const id = "claude";
      const providerSession = status(nodes[id].id)?.session_id;
      let atPrompt = false;
      let terminal;
      try {
        const toTerminal = await switchDriver(id, "terminal");
        terminal = await terminalRow(id);
        // 先认清画面：提示符（页脚）、信任对话框，或者别的——别的一律不答。
        let lastScreen = "";
        atPrompt = await waitFor(
          "Claude 终端视图到提示符",
          async () => {
            const text = await capture(terminal.id);
            lastScreen = text;
            const footer = Math.max(
              text.lastIndexOf("? for shortcuts"),
              text.lastIndexOf("shift+tab to cycle"),
            );
            const trust = Math.max(
              text.lastIndexOf("trust this folder"),
              text.lastIndexOf("trust the files"),
              text.lastIndexOf("one you trust"),
            );
            if (footer >= 0 && footer > trust) return true;
            if (trust >= 0) {
              // 认得出的信任对话框才答（编号或箭头菜单，`trust-dialog.mjs`），
              // 认不出就等——等到超时带着画面失败，始终不盲按回车。
              const step = await stepTrustDialog(text, {
                capture: () => capture(terminal.id),
                focus: () => clickInNode(id, ".xterm"),
                down: async () => {
                  for (const type of ["rawKeyDown", "keyUp"])
                    await page.call("Input.dispatchKeyEvent", {
                      type,
                      key: "ArrowDown",
                      code: "ArrowDown",
                      windowsVirtualKeyCode: 40,
                    });
                },
                enter: () => page.key("Enter"),
                type: (value) => page.call("Input.insertText", { text: value }),
                sleep,
              });
              if (step === "answered") {
                note("Claude 问是否信任临时工作目录，经页面选「信任」");
                await sleep(1500);
              }
            }
            return false;
          },
          { timeout: 90_000, interval: 1000 },
        ).catch((error) => {
          // 认不出的画面不答（不按回车、不猜编号）：带着画面失败，结果里看得到
          // 真实的对话框长什么样。
          const screenTail = sanitizeScreen(lastScreen);
          report.acp.claudeTerminalScreen = screenTail;
          throw new Error(`${error.message}；最后的画面：\n${screenTail}`);
        });
        const argv = processLines().find(
          (line) =>
            providerSession !== undefined &&
            line.includes(`--resume ${providerSession}`),
        );
        mark(
          id,
          "switchToTerminal",
          toTerminal.resumed === true &&
            argv !== undefined &&
            argv.includes("--permission-mode acceptEdits"),
          { resumed: toTerminal.resumed, argv: argv?.slice(0, 300) },
        );
        const text = await capture(terminal.id);
        mark(id, "terminalHistory", /\bOK\b/.test(text));
        await page.capture("12-claude-terminal");
      } catch (error) {
        mark(id, "switchToTerminal", false, error.message);
      }
      try {
        // 没确认在提示符上就先结束终端：切回时 core 会敲 `/exit` + 回车，敲进
        // 一个对话框就等于替人答了它。
        if (!atPrompt && terminal !== undefined)
          await api(`/api/terminals/${terminal.id}/terminate`, {
            method: "POST",
          }).catch(() => undefined);
        const back = await switchDriver(id, "acp");
        const current = await waitFor(
          "Claude 换回 ACP",
          () => {
            const latest = row(nodes[id].id);
            return latest?.backend_kind === "acp" && latest.status === "running"
              ? latest
              : undefined;
          },
          { timeout: 60_000, interval: 300 },
        );
        await sleep(1000);
        mark(
          id,
          "switchBack",
          back.resumed === true &&
            current.id === sessions.claude &&
            status(nodes[id].id)?.session_id === providerSession,
          {
            resumed: back.resumed,
            session: status(nodes[id].id)?.session_id === providerSession,
          },
        );
      } catch (error) {
        mark(id, "switchBack", false, error.message);
      }
    }

    if (firstTurn.has("copilot")) {
      const id = "copilot";
      try {
        await switchDriver(id, "terminal");
        const terminal = await terminalRow(id);
        await sleep(3000);
        await page.capture("12-copilot-terminal");
        // Copilot 的 TUI 画面没有核实过的提示符：不等、不答，直接结束再切回。
        await api(`/api/terminals/${terminal.id}/terminate`, {
          method: "POST",
        }).catch(() => undefined);
        const back = await switchDriver(id, "acp");
        await sleep(1000);
        const event = driverEvents.find(
          (entry) =>
            entry.nodeId === nodes[id].id &&
            entry.driver === "acp" &&
            entry.resumed === false,
        );
        mark(id, "switchNotResumed", back.resumed === false && !!event, {
          resumed: back.resumed,
          event: event !== undefined,
        });
      } catch (error) {
        mark(id, "switchNotResumed", false, error.message);
      }
    }

    /* ------------------------ 6. OpenCode 休眠与唤醒 ------------------------ */

    if (firstTurn.has("opencode")) {
      const id = "opencode";
      try {
        const sessionId = sessions.opencode;
        const before = (await api(`/api/terminals/${sessionId}`)).pid;
        const providerSession = status(nodes[id].id)?.session_id;
        await page.evaluate(`document.activeElement?.blur?.(); return true;`);
        await api("/api/settings", {
          method: "PATCH",
          body: { terminal: { ecoMode: true } },
        });
        await waitFor(
          "OpenCode 休眠",
          () =>
            one(
              "SELECT termination_intent FROM terminal_sessions WHERE id = ?",
              sessionId,
            )?.termination_intent === "hibernate",
          { timeout: 120_000, interval: 500 },
        );
        await api("/api/settings", {
          method: "PATCH",
          body: { terminal: { ecoMode: false } },
        });
        const woken = await api(`/api/terminals/${sessionId}/wake`, {
          method: "POST",
        });
        const after = await waitFor(
          "OpenCode 唤醒",
          async () => {
            const current = await api(`/api/terminals/${sessionId}`);
            return current.status === "running" &&
              typeof current.pid === "number"
              ? current
              : undefined;
          },
          { timeout: 60_000, interval: 500 },
        );
        await sleep(1500);
        mark(
          id,
          "hibernateWake",
          woken.id === sessionId &&
            after.pid !== before &&
            status(nodes[id].id)?.session_id === providerSession,
          { pid: `${before} → ${after.pid}` },
        );
      } catch (error) {
        mark(id, "hibernateWake", false, error.message);
      }
    }

    /* ------------------------------ 7. 收尾判定 ------------------------------ */

    for (const id of active) {
      if (usage[id] === undefined) continue;
      mark(id, "tokenBudget", usage[id] < TOKEN_BUDGET, usage[id]);
    }
    const seen = page.drain();
    report.consoleErrors.push(
      ...seen.errors.map((error) => ({ scenario: "12-acp", ...error })),
    );
    s.check(
      "页面全程没有控制台错误",
      seen.errors.length === 0,
      seen.errors.map((error) => error.text).slice(0, 5),
    );
    const blockedCalls = blocked();
    s.check(
      "没有起任何没经隔离包装的真 CLI",
      blockedCalls.length === 0,
      blockedCalls.slice(0, 5),
    );
    report.acp.shots = stack.shots;

    /* -------------------- --record-compat：记进兼容表 -------------------- */

    const passed = active.filter((id) =>
      Object.values(families[id] ?? {}).every((value) => value === "passed"),
    );
    report.acp.passed = passed;
    if (recordCompat && !selfTest) {
      const file = join(root, "tools/release/compatibility.json");
      const table = JSON.parse(readFileSync(file, "utf8"));
      const recorded = {};
      for (const id of passed) {
        const version = report.acp.versions[id];
        const entry = table.acp?.adapters?.[id];
        if (!version || entry === undefined) continue;
        entry.verified = mergeVerified(entry.verified, version);
        recorded[id] = entry.verified;
      }
      writeFileSync(file, `${JSON.stringify(table, null, 2)}\n`);
      note("compatibility.json 已记入", recorded);
      report.acp.recorded = recorded;
    }
  } catch (error) {
    s.fail(error);
  }
  s.finish();
}
