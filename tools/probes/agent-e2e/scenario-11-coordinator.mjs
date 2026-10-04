// 场景 11：协调者 `ama`（docs/design/coordinator-agent.md §4、§8 第 1–4 步）。
//
// 不用真模型、不用真密钥：本地起一个 OpenAI 兼容的脚本化模型服务
// （`mock-model.mjs::mockModelServer`），临时 HOME 下 ama 的 `config.json` 把内置的
// `deepseek` 指到它；key 经 `PUT /api/agents/ama/credentials/deepseek` 存进 core，
// 由画布启动器 `run/ama` 凭节点 token 经 hook 通道兑换、只设给 ama 进程
// （`AMA_API_KEY_DEEPSEEK`，契约 §12.4）。和场景 9 一样自己起一套 core，不起
// 页面与 Chrome，`--only 11` 单跑。
//
// 闭环（脚本化模型按对话走）：
//   1. 用户的话进协调者 → 模型调 `canvas_team`（两个成员）→ core 建两个节点与两
//      条边 → 模型回一句话，这一轮结束（`agent_settled`）。
//   2. 两个成员（场景自己给它们开终端、拿节点令牌）各 `canvas post` 一条结论。
//   3. 收件箱唤醒把提示送进协调者终端 → 模型调 `canvas_inbox` → 每条 `canvas_ack`
//      → `canvas_sticky` 写汇总 → 回一句话。
//
// 断言：`agent_status` 有 ama 行且 `stateSource = extension`；两个成员节点与两条
// 边；便签出现、内容是汇总；key 到了模型服务（请求头）却不在任何落盘文件、
// 核心日志与节点 shell 的环境里；
// 画布外对照：同一个 profile 不带 `ARMADRA_NODE_ID` 时工具表里没有画布工具。
// `workflow_propose` 不在本包（B2）。
//
// 派任务（`HostApi.runners` + `wait`，契约 §15.5）：
//   4. 一个成员 post 一条「派任务」→ 唤醒 → 模型读信后调 ama 的
//      `task(agent="custom:taskecho")` → 适配器的 runner 经 `open-agent
//      --task-id` 在画布上起一个成员（假 CLI，自定义 Agent，core 起终端、投任务）
//      → runner 长轮询 `wait` → 假 CLI 按任务末尾的键 `post` 结果 → `task`
//      的结果回到模型 → 模型 ack 并把结果汇总进便签。
//   断言：成员节点与连线、`workflow_task_runs` 一行 done 且带结果、task 结果与
//   便签里是假 CLI 回报的正文。
//
// ama → ama（`@armadra/agent` ≥ 0.6.7 调宿主注入的 `ama` runner）：
//   5. 再 post 一条「交给 ama」→ 唤醒 → 模型调 `task(agent="ama")` → 适配器的
//      `ama` runner 经 `open-agent --agent ama --task-id` 在画布上起第二个 ama
//      节点（同一个脚本化模型服务，凭它自己的节点兑换 key）→ 那个 ama 读到任务，
//      调 `canvas_post` 按任务末尾的键回报 → 协调者的 `task` 拿到结果写进便签。
//   断言：`workflow_task_runs` 有一行 `runner_id = ama`、done 且带结果；成员节点
//   是 ama、从协调者连线；便签里是第二个 ama 回报的正文。
//
// 成员停在审批上（契约 §15.5 `wait` 的 `blocked`）：
//   6. 再 post 一条「派审批任务」→ 唤醒 → 模型调 `task(agent="custom:taskecho")`
//      → 假 CLI 收到带「需要审批」的任务，先经 `armadra-hook claude` 报一条
//      `PermissionRequest` 并挂着等答复 → 成员 `blocked`。
//   断言：以协调者身份调 `wait` 答 `blocked`、`approvalId` 是那条审批；页面那条
//   路（`POST /api/approvals/{id}/answer`）答「允许」→ 假 CLI 拿到允许、按键回报
//   → 任务行 done、便签里是审批之后的结果。只在脚本化模型时跑。
//
// 真模型（`--real-model`，C 档，`ARMADRA_E2E_REAL=1`）：同一条闭环交给真模型走。
// 供应商与 key 从环境变量读（`ARMADRA_E2E_AMA_PROVIDER`，缺省 deepseek；
// `ARMADRA_E2E_AMA_MODEL`，缺省 deepseek-chat；`ARMADRA_E2E_AMA_KEY` 必填；可选
// `ARMADRA_E2E_AMA_BASE_URL`），key 照样只经 core 的密钥后端兑换给 ama。用户的话
// 写成明确的指令（成员一律用假 CLI `custom:taskecho`），断言放宽到画布上的结果：
// 两个成员与边、两条结论都 ack、汇总便签、`task` 跑完一行、第 5 步的第二个 ama（同一个真模型）回报了非空结果；看不到模型请求的那
// 几条（工具表、请求头、画布外对照）不判。成员与派任务都不是真 CLI：这套 core
// 的 PATH 最前面是一组替身（`blockRealClis`），任何节点想起 claude / codex 等都
// 会被拦下并记进报告。`--real-model --self-test` 用脚本化模型冒充真供应商，走一
// 遍这条路径本身。
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CREDENTIAL_VARIABLES, probeHome } from "../probe-home.mjs";
import { mockModelServer } from "./mock-model.mjs";
import {
  blockRealClis,
  canvasAsIn,
  cleanups,
  note,
  output,
  realModel,
  report,
  requireReal,
  root,
  scenario,
  selfTest,
  sleep,
  startIsolatedCore,
  waitFor,
} from "./lib.mjs";

const FAKE_KEY = "sk-agent-e2e-fake-key";
const DISPATCH = "派任务：请 taskecho 检查 src/z";
const TASK_PROMPT = "检查 src/z，结论按任务末尾的键回报";
const TASK_RESULT = "taskecho 回报：src/z 没有问题";
const DISPATCH_AMA = "交给 ama：请另一个 ama 复核 src/w";
const AMA_TASK_PROMPT = "复核 src/w，结论按任务末尾的键回报";
const AMA_RESULT = "第二个 ama 回报：src/w 已复核";
const DISPATCH_APPROVAL = "派审批任务：请 taskecho 检查 src/v";
const APPROVAL_TASK_PROMPT = "需要审批：检查 src/v，结论按任务末尾的键回报";
const APPROVAL_RESULT = "taskecho 回报：审批之后 src/v 也没有问题";

/**
 * 派任务用的假 CLI（自定义 Agent `custom:taskecho`，借 Claude 的 hook 适配）：
 * 打印提示符、读一行，经 `armadra-hook claude` 报 `UserPromptSubmit` / `Stop`；
 * 行里有 `--to <节点> --key task:…:result` 就照着 `canvas post` 结果。行里有
 * 「需要审批」时先报一条 `PermissionRequest`，挂着等画布上的答复（与 Claude 的
 * Hook 同一条路，`ARMADRA_PERM_WAIT_SECS` 由 core 注入），答复到了再回报。
 */
const TASK_CLI = String.raw`#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const hook = __HOOK__;
const trace = (line) => fs.appendFileSync(__LOG__, process.pid + " " + line + "\n");
const session = "taskecho-" + process.pid;
function report(event, extra) {
  const answer = spawnSync(hook, ["claude"], {
    input: JSON.stringify({ hook_event_name: event, session_id: session, cwd: process.cwd(), ...(extra || {}) }),
    stdio: ["pipe", "ignore", "pipe"],
    timeout: 10000,
  });
  trace(event + " exit=" + answer.status);
}
trace("start node=" + process.env.ARMADRA_NODE_ID);
report("SessionStart");
process.stdout.write("taskecho ready\n❯ \n");
const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on("line", (raw) => {
  const line = raw.replace(/\x1b\[20[01]~/g, "").trim();
  if (line === "") return;
  trace("line " + JSON.stringify(line.slice(0, 400)));
  report("UserPromptSubmit", { prompt: line.slice(0, 200) });
  const held = line.includes("需要审批");
  if (held) {
    const asked = spawnSync(hook, ["claude"], {
      input: JSON.stringify({
        hook_event_name: "PermissionRequest",
        session_id: session,
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "echo approval-probe" },
      }),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000,
    });
    trace("permission exit=" + asked.status + " wait=" + (process.env.ARMADRA_PERM_WAIT_SECS || "") + " out=" + String(asked.stdout || "").trim().slice(0, 200));
  }
  const target = /--to (\S+) --key (task:\S+:result\S*)/.exec(line);
  if (target) {
    const posted = spawnSync(hook, ["canvas", "post", "--to", target[1], "--key", target[2], "--body", held ? __APPROVAL_RESULT__ : __RESULT__], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    trace("post " + target[2] + " exit=" + posted.status + " " + String(posted.stderr || "").slice(0, 200));
  }
  setTimeout(() => {
    report("Stop");
    process.stdout.write("❯ \n");
  }, 300);
});
`;

/** 最后一条用户消息之后的消息。 */
function sinceLastUser(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1)
    if (messages[index].role === "user") return messages.slice(index + 1);
  return messages;
}

/** 这一段里 `task` 工具的结果正文。 */
function taskResult(messages) {
  const segment = sinceLastUser(messages);
  const call = segment
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.tool_calls ?? [])
    .find((c) => c.function?.name === "task");
  if (call === undefined) return undefined;
  const answer = segment.find(
    (m) => m.role === "tool" && m.tool_call_id === call.id,
  );
  return answer === undefined ? undefined : textOf(answer);
}

/** 这一段里收件箱读到的正文（判断是不是派任务的那条）。 */
function inboxText(messages) {
  return sinceLastUser(messages)
    .filter((m) => m.role === "tool")
    .map(textOf)
    .join("\n");
}
const PROMPT = "让 A 审查 src/x，B 审查 src/y，汇总到便签";
/**
 * 真模型版的用户的话：同一件事，写成真模型照着做就能走到断言的指令。仍含「审查」
 * （`--self-test` 时脚本化模型按它起团队）。
 */
const REAL_PROMPT = [
  "让 A 审查 src/x，B 审查 src/y，汇总到便签。具体做法：",
  "1. 调一次 canvas_team 建两个成员，agent 一律用 custom:taskecho，标题分别是 reviewer-a 与 reviewer-b，任务写「审查 src/x」「审查 src/y」；建完回一句话就结束这一轮，不要等待。",
  "2. 之后你会被唤醒：调 canvas_inbox 读结论，每条用 canvas_ack 确认，再用 canvas_sticky 写一张标题是「审查汇总」、内容以「汇总：」开头的便签。",
  "3. 如果收件箱里有「派任务」的信：调 task 工具，agent=custom:taskecho，prompt 用信里给的那句，等它的结果；然后 ack 那封信，用 canvas_sticky 写一张标题是「任务汇总」、内容以「任务汇总：」开头并附上结果原文的便签。",
  "4. 如果收件箱里有「交给 ama」的信：调 task 工具，agent=ama，prompt 用信里给的那句，等它的结果；然后 ack 那封信，用 canvas_sticky 写一张标题是「复核汇总」、内容以「复核汇总：」开头并附上结果原文的便签。",
  "全程不要调用别的 Agent 或 shell 命令。",
].join(" ");
const REAL_DISPATCH_AMA = `交给 ama：请调用 task 工具，agent=ama，prompt=「${AMA_TASK_PROMPT}」，拿到结果后写进「复核汇总」便签。`;
const REAL_DISPATCH = `派任务：请调用 task 工具，agent=custom:taskecho，prompt=「${TASK_PROMPT}」，拿到结果后写进「任务汇总」便签。`;

/**
 * 真模型的配置。`--self-test` 时把脚本化模型当作「真供应商」（`baseUrl` 指到它），
 * 其余照真跑那条路走。答 `{ provider, model, key, baseUrl? }`。
 */
function realModelConfig(mock) {
  if (selfTest)
    return {
      provider: "deepseek",
      model: "mock-coordinator",
      key: FAKE_KEY,
      baseUrl: mock.baseUrl,
    };
  const key = process.env.ARMADRA_E2E_AMA_KEY;
  if (!key)
    throw new Error(
      "--real-model 要 ARMADRA_E2E_AMA_KEY（供应商的 API key，只经 core 的临时文件密钥后端兑换给 ama，跑完随临时目录删除）",
    );
  return {
    provider: process.env.ARMADRA_E2E_AMA_PROVIDER || "deepseek",
    model: process.env.ARMADRA_E2E_AMA_MODEL || "deepseek-chat",
    key,
    ...(process.env.ARMADRA_E2E_AMA_BASE_URL
      ? { baseUrl: process.env.ARMADRA_E2E_AMA_BASE_URL }
      : {}),
  };
}
const SUMMARY = "汇总：A 说 x 没问题；B 说 y 要补测试。";

/** 一条消息正文（OpenAI 的 content 可以是字符串或分段）。 */
function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((part) => part?.text ?? "").join("");
  return "";
}

/** 最后一条助手消息调的工具名。 */
function lastToolCall(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return undefined;
    if (message.role === "assistant" && Array.isArray(message.tool_calls))
      return message.tool_calls[0]?.function?.name;
  }
  return undefined;
}

/** 收件箱结果里的消息 id。 */
function inboxIds(messages) {
  const result = [...messages].reverse().find((m) => m.role === "tool");
  const text = textOf(result);
  try {
    const parsed = JSON.parse(text);
    return (parsed.messages ?? []).map((entry) => entry.id);
  } catch {
    return [...text.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  }
}

/**
 * 协调者的「模型」：只看对话走到哪一步。最后一条是用户的话时，开场那句起团队，
 * 其后（唤醒提示）去读收件箱；最后一条是工具结果时按上一个工具接下一步。
 */
function coordinatorScript(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  // 第二个 ama（成员）：任务在它的用户消息里，按末尾的键 post 回去。
  const memberTask = messages.find(
    (m) => m.role === "user" && textOf(m).includes(AMA_TASK_PROMPT),
  );
  if (memberTask !== undefined) {
    if (lastToolCall(messages) === "canvas_post") return { text: "已回报。" };
    const target = /--to (\S+) --key (\S+)/.exec(textOf(memberTask));
    if (target === null) return { text: "任务里没有回报的键。" };
    return {
      toolCalls: [
        {
          name: "canvas_post",
          arguments: { to: target[1], key: target[2], body: AMA_RESULT },
        },
      ],
    };
  }
  if (last?.role === "user") {
    if (textOf(last).includes("审查"))
      return {
        toolCalls: [
          {
            name: "canvas_team",
            arguments: {
              member: [
                "claude|reviewer-a|审查 src/x，结论 post 给协调者",
                "codex|reviewer-b|审查 src/y，结论 post 给协调者",
              ],
            },
          },
        ],
      };
    return { toolCalls: [{ name: "canvas_inbox", arguments: {} }] };
  }
  switch (lastToolCall(messages)) {
    case "canvas_team":
      return { text: "两位审查者已经在画布上开始了。" };
    case "canvas_inbox": {
      const ids = inboxIds(messages);
      if (ids.length === 0) return { text: "收件箱是空的。" };
      // 交给另一个 ama 的那条：宿主注入的 `ama` runner 在画布上起一个 ama 节点。
      if (inboxText(messages).includes("交给 ama"))
        return {
          toolCalls: [
            {
              name: "task",
              arguments: {
                agent: "ama",
                prompt: AMA_TASK_PROMPT,
                background: false,
              },
            },
          ],
        };
      // 派审批任务的那条：同一个成员 CLI，任务里带「需要审批」。
      if (inboxText(messages).includes("派审批任务"))
        return {
          toolCalls: [
            {
              name: "task",
              arguments: {
                agent: "custom:taskecho",
                prompt: APPROVAL_TASK_PROMPT,
                background: false,
              },
            },
          ],
        };
      // 派任务的那条：交给画布上的成员做，等它回来再 ack。
      if (inboxText(messages).includes("派任务"))
        return {
          toolCalls: [
            {
              name: "task",
              arguments: {
                agent: "custom:taskecho",
                prompt: TASK_PROMPT,
                background: false,
              },
            },
          ],
        };
      return {
        toolCalls: ids.map((id) => ({ name: "canvas_ack", arguments: { id } })),
      };
    }
    case "task": {
      // 收件箱那次调用的结果（最后一条工具结果是 task 的）。
      const segment = sinceLastUser(messages);
      const inboxCall = segment
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.tool_calls ?? [])
        .find((c) => c.function?.name === "canvas_inbox");
      const ids = inboxIds(
        segment.filter(
          (m) => m.role === "tool" && m.tool_call_id === inboxCall?.id,
        ),
      );
      if (ids.length === 0) return { text: taskResult(messages) ?? "好的。" };
      return {
        toolCalls: ids.map((id) => ({ name: "canvas_ack", arguments: { id } })),
      };
    }
    case "canvas_ack": {
      const fromTask = taskResult(messages);
      if (fromTask !== undefined)
        return {
          toolCalls: [
            {
              name: "canvas_sticky",
              arguments: {
                title: "任务汇总",
                content: `任务汇总：${fromTask}`,
              },
            },
          ],
        };
      return {
        toolCalls: [
          {
            name: "canvas_sticky",
            arguments: { title: "审查汇总", content: SUMMARY },
          },
        ],
      };
    }
    case "canvas_sticky":
      return { text: "汇总已写到便签。" };
    default:
      return { text: "好的。" };
  }
}

/** 目录下正文含 `needle` 的文件（跳过 `skip` 里的目录与套接字）。 */
function filesContaining(root, needle, skip) {
  const found = [];
  const walk = (dir) => {
    if (skip.includes(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        try {
          if (readFileSync(path).includes(needle)) found.push(path);
        } catch {}
      }
    }
  };
  walk(root);
  return found;
}

/**
 * 协调者窗格进程（`sh -c` 那个节点 shell）的环境：Linux 读
 * `/proc/<pid>/environ`，macOS 用 `ps eww`（同一用户的进程看得到环境）。
 */
function paneEnvironment(data) {
  try {
    const pid = execFileSync(
      "tmux",
      ["-S", join(data, "tmux.sock"), "list-panes", "-a", "-F", "#{pane_pid}"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")[0];
    if (!pid) return undefined;
    if (existsSync(`/proc/${pid}/environ`))
      return readFileSync(`/proc/${pid}/environ`, "utf8");
    return execFileSync("ps", ["eww", "-o", "command=", "-p", pid], {
      encoding: "utf8",
    });
  } catch {
    return undefined;
  }
}

/**
 * 以 `nodeId` 的身份调一个控制动词（`/control/<verb>`），答 core 的 JSON。
 * `armadra-hook canvas` 只打印正文；这里要看 `wait` 答的结构（`approvalId`），
 * 所以照 hook 客户端的样子直接请求：hook 面的 bearer 与节点令牌都在数据目录里。
 */
function controlAs(data, nodeId, verb, args) {
  const endpoint = Object.fromEntries(
    readFileSync(join(data, "hook-endpoint.env"), "utf8")
      .split("\n")
      .map((line) => /^([A-Z_]+)='(.*)'$/.exec(line))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
  const token = readFileSync(
    join(endpoint.ARMADRA_NODE_TOKEN_DIR, nodeId),
    "utf8",
  ).trim();
  const body = Buffer.from(JSON.stringify({ nodeId, args }));
  return new Promise((done, fail) => {
    const call = httpRequest(
      {
        ...(endpoint.ARMADRA_HOOK_SOCK
          ? { socketPath: endpoint.ARMADRA_HOOK_SOCK }
          : { host: "127.0.0.1", port: Number(endpoint.ARMADRA_HOOK_PORT) }),
        path: `/control/${verb}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "x-armadra-hook-token": endpoint.ARMADRA_HOOK_TOKEN,
          "x-armadra-node-token": token,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== 200)
            return fail(new Error(`${verb} → ${response.statusCode} ${text}`));
          try {
            done(JSON.parse(text));
          } catch (error) {
            fail(error);
          }
        });
      },
    );
    call.on("error", fail);
    call.end(body);
  });
}

/**
 * 自己的一套 core：临时 HOME、文件密钥后端、不写全局；PATH 最前面是真 CLI 的
 * 替身目录，这套 core 起不了任何真 CLI（ama 是数据目录里随包的那份）。
 */
async function setupCore(scratch, home, probeEnv) {
  const project = join(scratch, "project");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# probe\n");
  const data = join(scratch, "rt");
  mkdirSync(data);
  const hook = join(root, "apps/desktop/out/cli/armadra-hook.js");
  const ama = join(root, "apps/desktop/out/agent/ama.cjs");
  const host = join(root, "apps/desktop/out/agent-host/ama-armadra.cjs");
  for (const file of [hook, ama, host])
    if (!existsSync(file)) throw new Error(`未构建：${file}`);
  const blockedDir = join(scratch, "blocked-bin");
  const blocked = blockRealClis(blockedDir, join(scratch, "blocked.log"));
  const environment = {
    ...process.env,
    ...probeEnv,
    HOME: home,
    PATH: `${blockedDir}:${process.env.PATH ?? ""}`,
    ARMADRA_DATA_DIR: data,
    ARMADRA_SECRET_BACKEND: "file",
    ARMADRA_NO_GLOBAL_WRITES: "1",
  };
  for (const name of [
    "TMUX",
    "TMUX_PANE",
    ...CREDENTIAL_VARIABLES,
    "AMA_CONFIG_DIR",
    "AMA_DATA_DIR",
  ])
    delete environment[name];
  // key 只经 core 的密钥后端兑换：操作员环境里的那几个变量不带进这套 core。
  for (const name of Object.keys(environment))
    if (name.startsWith("AMA_API_KEY_") || name === "ARMADRA_E2E_AMA_KEY")
      delete environment[name];
  const { api } = await startIsolatedCore({
    data,
    environment,
    logName: "core-coordinator.log",
  });
  return { api, data, project, hook, home, blocked };
}

export default async function run() {
  const real = realModel;
  const s = scenario(real ? "11-coordinator-real-model" : "11-coordinator");
  try {
    if (real) requireReal("场景 11 的 --real-model ");
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "armadra-ama-")));
    cleanups.push(() =>
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
    );
    // 真模型时没有脚本化服务；`--self-test` 时它冒充真供应商。
    const mock =
      real && !selfTest ? undefined : await mockModelServer(coordinatorScript);
    const model = real
      ? realModelConfig(mock)
      : {
          provider: "deepseek",
          model: "mock-coordinator",
          key: FAKE_KEY,
          baseUrl: mock.baseUrl,
        };
    const secret = model.key;
    report.coordinator = {
      mode: real ? (selfTest ? "real-model-self-test" : "real-model") : "mock",
      provider: model.provider,
      model: model.model,
    };
    // 临时 HOME（`probe-home.mjs`）：ama 的配置写在它的 XDG_CONFIG_HOME 下。
    const probe = probeHome("armadra-ama-home-");
    cleanups.push(probe.remove);
    const home = probe.path;
    mkdirSync(join(home, ".config", "ama"), { recursive: true });
    writeFileSync(
      join(home, ".config", "ama", "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          defaultModel: `${model.provider}/${model.model}`,
          ...(model.baseUrl === undefined
            ? {}
            : { providers: { [model.provider]: { baseUrl: model.baseUrl } } }),
        },
        null,
        2,
      )}\n`,
    );
    const context = await setupCore(scratch, home, probe.env);
    const { api, data, project } = context;

    // 派任务用的成员：一个自定义 Agent，程序是上面的假 CLI。在协调者起来之前
    // 登记——适配器启动时从 `canvas help` 读到它，为它注册一个 runner。
    const hookBin = join(data, "bin", "armadra-hook");
    await waitFor("armadra-hook 就位", () => existsSync(hookBin), {
      timeout: 30_000,
      interval: 100,
    });
    const taskCli = join(scratch, "taskecho");
    const taskLog = join(scratch, "taskecho.log");
    writeFileSync(
      taskCli,
      TASK_CLI.replace("__HOOK__", JSON.stringify(hookBin))
        .replace("__LOG__", JSON.stringify(taskLog))
        .replace("__RESULT__", JSON.stringify(TASK_RESULT))
        .replace("__APPROVAL_RESULT__", JSON.stringify(APPROVAL_RESULT)),
    );
    chmodSync(taskCli, 0o755);
    await api("/api/agents/claude/integration/install", { method: "POST" });
    await api("/api/settings", {
      method: "PATCH",
      body: {
        terminal: { ecoMode: false },
        agents: {
          custom: [
            {
              id: "custom:taskecho",
              label: "taskecho",
              launchCmd: taskCli,
              baseAgent: "claude",
            },
          ],
        },
      },
    });

    // 假 key 经 core 存：页面「Armadra Agent 的模型密钥」走的就是这一条。
    const stored = await api(`/api/agents/ama/credentials/${model.provider}`, {
      method: "PUT",
      body: { apiKey: secret },
    });
    s.check(
      "密钥只答「已设」，不回显",
      stored.providers.some((p) => p.id === model.provider && p.isSet) &&
        !JSON.stringify(stored).includes(secret),
    );

    const agents = await api("/api/agents");
    const amaRow = agents.find((agent) => agent.id === "ama");
    s.check(
      "/api/agents 有 ama 行，程序是 <数据目录>/bin/ama，带启动器",
      amaRow?.installed === true &&
        amaRow.resolvedPath === join(data, "bin", "ama") &&
        typeof amaRow.launcher === "string",
      {
        resolvedPath: amaRow?.resolvedPath,
        launcher: amaRow?.launcher,
      },
    );
    const integration = await api("/api/agents/ama/integration");
    const profilePath = join(data, "integration", "ama", "profile.json");
    s.check(
      "注入只有 --profile 一个参数",
      JSON.stringify(integration.launchArgs) ===
        JSON.stringify(["--profile", profilePath]),
      integration.launchArgs,
    );

    // 画布：一个协调者节点（ama，全自动——画布工具不在终端里等人批准）。
    const workspace = await api("/api/workspaces", {
      method: "POST",
      body: {
        name: "agent-e2e-coordinator",
        rootPath: project,
        permissions: { read: true, write: true, execute: true },
      },
    });
    const boards = await api(`/api/workspaces/${workspace.id}/boards`);
    const board =
      boards[0] ??
      (await api(`/api/workspaces/${workspace.id}/boards`, {
        method: "POST",
        body: { name: "e2e" },
      }));
    const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
    const initial = await api(documentPath);
    const stamp = new Date().toISOString();
    const lead = {
      id: randomUUID(),
      boardId: board.id,
      type: "terminal",
      title: "lead",
      color: "#0a84ff",
      position: { x: 0, y: 0 },
      size: { width: 640, height: 400 },
      labels: [],
      note: "",
      data: {
        kind: "terminal",
        agent: { id: "ama", permissionMode: "full-auto" },
      },
      createdAt: stamp,
      updatedAt: stamp,
    };
    await api(documentPath, {
      method: "PUT",
      body: {
        expectedUpdatedAt: initial.board.updatedAt,
        nodes: [lead],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 0.5 },
        whiteboard: "",
      },
    });

    // 协调者的终端：页面挂节点时也是这样起（带 agent 与 nodeId），启动行按
    // GET /api/agents 的 `launcher` 与 `resolvedPath` 拼（契约 §13.1）。
    //
    // 行交给 `sh -c "<行>; exit"` 跑，而不是敲进 shell：经粘贴路由敲进去的行
    // 会让终端的输入围栏一直以为有半截没提交（回车由后端按，不过围栏），唤醒就
    // 永远排在 TARGET_INPUT_PENDING 后面。行尾的 `exit` 让 sh 不把自己 exec 成
    // ama——窗格进程还是 sh，ama 在它的子进程里，进程名门（`ama.cjs`）认得出。
    const quote = (word) => `'${word.replace(/'/g, "'\\''")}'`;
    const line = [
      amaRow.launcher,
      amaRow.resolvedPath,
      "--permission-mode",
      "full-auto",
      real ? REAL_PROMPT : PROMPT,
    ]
      .map(quote)
      .join(" ");
    const session = await api("/api/terminals", {
      method: "POST",
      body: {
        workspaceId: workspace.id,
        cwd: project,
        nodeId: lead.id,
        agent: { id: "ama" },
        command: "/bin/sh",
        args: ["-c", `${line}; exit $?`],
      },
    });
    note("协调者已起", line);
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    s.check(
      "没有 key 文件：profile 不指 authFile，数据目录里没有 auth.json",
      profile.authFile === undefined &&
        !existsSync(join(data, "integration", "ama", "auth.json")),
      profile,
    );

    const database = new DatabaseSync(join(data, "canvas.db"), {
      readOnly: true,
    });
    cleanups.push(() => database.close());
    const one = (sql, ...params) => database.prepare(sql).get(...params);

    const capture = async () => {
      try {
        const screen = await api(`/api/terminals/${session.id}/capture`);
        return String(screen?.text ?? JSON.stringify(screen)).slice(-1500);
      } catch (error) {
        return String(error.message);
      }
    };

    /* ---------------------------- 1. 起团队 ---------------------------- */

    const statusRow = await waitFor(
      "ama 的状态上报",
      () =>
        one(
          "SELECT agent_id, state, state_source FROM agent_status WHERE node_id = ?",
          lead.id,
        ),
      { timeout: 90_000, interval: 500 },
    ).catch(async (error) => {
      note("协调者终端画面", await capture());
      throw error;
    });
    // 真模型看不到请求：这两条只在脚本化模型时判（`--self-test` 同真跑）。
    if (!real)
      s.check(
        "key 经启动器的兑换到了 ama：模型服务收到 Bearer <这把 key>",
        mock.headers[0]?.authorization === `Bearer ${FAKE_KEY}`,
        mock.headers[0]?.authorization === `Bearer ${FAKE_KEY}`
          ? undefined
          : mock.headers[0]?.authorization === undefined
            ? "请求没带 key"
            : "带的不是这把",
      );
    const pane = paneEnvironment(data);
    s.check(
      "节点 shell 的环境里没有这把 key（只在 ama 进程里）",
      pane !== undefined && !pane.includes(secret),
      pane === undefined ? "读不到窗格进程的环境" : undefined,
    );
    s.check(
      "agent_status 有 ama 行，来源是 extension",
      statusRow.agent_id === "ama" && statusRow.state_source === "extension",
      statusRow,
    );
    const firstTools = real
      ? []
      : (mock.requests[0]?.tools ?? []).map((tool) => tool.function?.name);
    if (!real)
      s.check(
        "首个请求的工具表里有画布工具",
        ["canvas_team", "canvas_inbox", "canvas_ack", "canvas_sticky"].every(
          (name) => firstTools.includes(name),
        ),
        firstTools.filter((name) => name?.startsWith("canvas_")),
      );

    const document = () => api(documentPath);
    const members = await waitFor(
      "canvas_team 建出两个成员",
      async () => {
        const doc = await document();
        // 真模型取的标题不一定照抄：认从协调者连出去的终端节点。
        const found = real
          ? doc.nodes.filter(
              (node) =>
                node.type === "terminal" &&
                node.id !== lead.id &&
                doc.edges.some(
                  (edge) => edge.source === lead.id && edge.target === node.id,
                ),
            )
          : doc.nodes.filter((node) =>
              ["reviewer-a", "reviewer-b"].includes(node.title),
            );
        return found.length >= 2
          ? { doc, found: found.slice(0, 2) }
          : undefined;
      },
      { timeout: 90_000, interval: 500 },
    ).catch(async (error) => {
      note("协调者终端画面", await capture());
      throw error;
    });
    const edges = members.doc.edges.filter(
      (edge) =>
        edge.source === lead.id &&
        members.found.some((node) => node.id === edge.target),
    );
    s.check("两个成员节点、两条从协调者出发的边", edges.length === 2, {
      members: members.found.map((node) => node.title),
      edges: edges.length,
    });

    // 这一轮结束：模型回了一句话，ama 报 agent_settled → 空闲。
    await waitFor(
      "协调者第一轮结束",
      () =>
        one("SELECT state FROM agent_status WHERE node_id = ?", lead.id)
          ?.state === "done",
      { timeout: 60_000, interval: 500 },
    ).catch(async (error) => {
      note("协调者终端画面", await capture());
      throw error;
    });

    /* ------------------------ 2. 成员 post 结论 ------------------------ */

    for (const [node, body] of [
      [members.found[0], "x 没问题"],
      [members.found[1], "y 要补测试"],
    ]) {
      const memberSession = await api("/api/terminals", {
        method: "POST",
        body: {
          workspaceId: workspace.id,
          cwd: project,
          nodeId: node.id,
          shell: "/bin/sh",
        },
      });
      await api(`/api/terminals/${memberSession.id}/node-token/refresh`, {
        method: "POST",
      });
      const posted = await canvasAsIn(
        context,
        node.id,
        "post",
        "--to",
        lead.id,
        "--key",
        `review-${node.title}`,
        "--body",
        body,
      );
      s.check(
        `${node.title} 的结论 post 成功`,
        posted.code === 0,
        posted.stderr,
      );
    }

    /* ---------------------- 3. 唤醒、读信、写汇总 ---------------------- */

    const sticky = await waitFor(
      "协调者写出汇总便签",
      async () =>
        (await document()).nodes.find(
          (node) =>
            node.type === "sticky" &&
            JSON.stringify(node.data ?? {}).includes("汇总"),
        ),
      { timeout: 150_000, interval: 1000 },
    ).catch(async (error) => {
      note("协调者终端画面", await capture());
      const all = (sql, ...params) => database.prepare(sql).all(...params);
      note("诊断", {
        status: all("SELECT * FROM agent_status WHERE node_id = ?", lead.id),
        queue: all("SELECT * FROM agent_send_queue"),
        deliveries: all("SELECT * FROM agent_deliveries"),
      });
      throw error;
    });
    s.check("协调者的便签出现，内容是汇总", sticky !== undefined, sticky?.data);
    if (!real) {
      const calledTools = () =>
        mock.requests
          .flatMap((request) => request.messages ?? [])
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.tool_calls ?? [])
          .map((call) => call.function?.name);
      // 便签一出现就查会早一步：`canvas_sticky` 那次调用要等下一次请求才进对话。
      await waitFor(
        "sticky 那次调用进了对话",
        () => calledTools().includes("canvas_sticky"),
        { timeout: 30_000, interval: 250 },
      ).catch(() => undefined);
      const called = calledTools();
      s.check(
        "收到唤醒后依次 inbox → ack → sticky",
        ["canvas_inbox", "canvas_ack", "canvas_sticky"].every((name) =>
          called.includes(name),
        ),
        [...new Set(called)],
      );
    }
    // 第一条 post 一到就唤醒了一次；第二条可能赶上那一轮，也可能等下一次唤醒。
    const unread = () =>
      Number(
        one(
          "SELECT COUNT(*) AS n FROM agent_mailbox WHERE target_node_id = ? AND message_key LIKE 'review-%' AND acknowledged_at IS NULL",
          lead.id,
        )?.n,
      );
    await waitFor("两条结论都 ack", () => unread() === 0, {
      timeout: 120_000,
      interval: 1000,
    }).catch(() => undefined);
    s.check("两条结论都 ack 了", unread() === 0, { unread: unread() });

    /* ------------- 4. 派任务：task(agent=…) → 画布成员 → wait ------------- */

    if (!real)
      s.check(
        "工具表里有 ama 的 task（画布 runner 接管它）",
        firstTools.includes("task"),
        firstTools.filter((name) => !name?.startsWith("canvas_")),
      );
    const dispatcher = members.found[0];
    const dispatched = await canvasAsIn(
      context,
      dispatcher.id,
      "post",
      "--to",
      lead.id,
      "--key",
      "dispatch-1",
      "--body",
      real ? REAL_DISPATCH : DISPATCH,
    );
    s.check("派任务的那条 post 成功", dispatched.code === 0, dispatched.stderr);

    const taskSticky = await waitFor(
      "协调者把任务结果写进便签",
      async () =>
        (await document()).nodes.find(
          (node) =>
            node.type === "sticky" &&
            JSON.stringify(node.data ?? {}).includes("任务汇总"),
        ),
      { timeout: 240_000, interval: 1000 },
    ).catch(async (error) => {
      note("协调者终端画面", await capture());
      const all = (sql, ...params) => database.prepare(sql).all(...params);
      note("派任务诊断", {
        runs: all("SELECT * FROM workflow_task_runs"),
        queue: all(
          "SELECT target_node_id, origin, state, last_reason FROM agent_send_queue",
        ),
        status: all("SELECT node_id, agent_id, state FROM agent_status"),
        launches: all(
          "SELECT node_id, state, reason, attempts FROM agent_dependency_launches",
        ),
        fake: existsSync(taskLog)
          ? readFileSync(taskLog, "utf8").split("\n").slice(-20)
          : [],
      });
      throw error;
    });
    s.check(
      "便签里是成员回报的结果",
      // 脚本化模型逐字附原文；真模型会转述（实跑：「任务汇总：src/z 没有问题」），
      // 认回报的主体与结论，不认前缀。
      real
        ? ["src/z", "没有问题"].every((part) =>
            JSON.stringify(taskSticky.data ?? {}).includes(part),
          )
        : JSON.stringify(taskSticky.data ?? {}).includes(TASK_RESULT),
      taskSticky.data,
    );
    const runs = database
      .prepare(
        "SELECT task_id, coordinator_node_id, runner_id, node_id, status, result_json FROM workflow_task_runs",
      )
      .all();
    s.check(
      "workflow_task_runs 一行：协调者、custom:taskecho、done、带结果",
      runs.length === 1 &&
        runs[0].coordinator_node_id === lead.id &&
        runs[0].runner_id === "custom:taskecho" &&
        runs[0].status === "done" &&
        String(runs[0].result_json).includes(TASK_RESULT),
      runs,
    );
    const afterTask = await document();
    const taskNode = afterTask.nodes.find(
      (node) => node.id === runs[0]?.node_id,
    );
    s.check(
      "成员节点在画布上（自定义 Agent），从协调者连了一条线",
      taskNode?.data?.agent?.id === "custom:taskecho" &&
        afterTask.edges.some(
          (edge) => edge.source === lead.id && edge.target === taskNode.id,
        ),
      { title: taskNode?.title, agent: taskNode?.data?.agent },
    );
    s.check(
      "runner 把 ama 的 cwd 经 --cwd 带过去：成员终端开在协调者的目录",
      taskNode?.data?.cwd === project,
      { cwd: taskNode?.data?.cwd, project },
    );
    if (!real) {
      const taskResults = mock.requests
        .flatMap((request) => request.messages ?? [])
        .filter(
          (message) =>
            message.role === "tool" && textOf(message).includes(TASK_RESULT),
        );
      s.check(
        "task 的结果回到了模型（成员 post 的正文）",
        taskResults.length > 0,
      );
    }
    s.check(
      "成员的终端由 core 起（页面不在），假 CLI 收到了任务",
      existsSync(taskLog) &&
        readFileSync(taskLog, "utf8").includes(TASK_PROMPT),
    );

    /* --------- 5. ama → ama：task(agent="ama") → 画布上的第二个 ama --------- */

    const amaDispatched = await canvasAsIn(
      context,
      dispatcher.id,
      "post",
      "--to",
      lead.id,
      "--key",
      "dispatch-ama",
      "--body",
      real ? REAL_DISPATCH_AMA : DISPATCH_AMA,
    );
    s.check(
      "交给 ama 的那条 post 成功",
      amaDispatched.code === 0,
      amaDispatched.stderr,
    );
    const amaSticky = await waitFor(
      "协调者把第二个 ama 的结果写进便签",
      async () =>
        (await document()).nodes.find(
          (node) =>
            node.type === "sticky" &&
            // 真模型按指令写「复核汇总」；脚本化模型（含 --self-test）附原文。
            (JSON.stringify(node.data ?? {}).includes(AMA_RESULT) ||
              (real && JSON.stringify(node.data ?? {}).includes("复核汇总"))),
        ),
      { timeout: 240_000, interval: 1000 },
    ).catch(async (error) => {
      note("协调者终端画面", await capture());
      const all = (sql, ...params) => database.prepare(sql).all(...params);
      note("ama → ama 诊断", {
        runs: all("SELECT * FROM workflow_task_runs"),
        status: all("SELECT node_id, agent_id, state FROM agent_status"),
        queue: all(
          "SELECT target_node_id, origin, state, last_reason FROM agent_send_queue",
        ),
      });
      throw error;
    });
    s.check(
      "便签里是第二个 ama 回报的结果",
      amaSticky !== undefined,
      amaSticky?.data,
    );
    const amaRun = database
      .prepare(
        "SELECT runner_id, node_id, status, result_json FROM workflow_task_runs WHERE runner_id = 'ama'",
      )
      .all();
    s.check(
      "workflow_task_runs 有一行 ama：done、带第二个 ama 的结果",
      amaRun.length === 1 &&
        amaRun[0].status === "done" &&
        (real
          ? String(amaRun[0].result_json ?? "").length > 2
          : String(amaRun[0].result_json).includes(AMA_RESULT)),
      amaRun,
    );
    const afterAma = await document();
    const amaNode = afterAma.nodes.find(
      (node) => node.id === amaRun[0]?.node_id,
    );
    s.check(
      "第二个 ama 节点在画布上，从协调者连了一条线",
      amaNode?.data?.agent?.id === "ama" &&
        amaNode.id !== lead.id &&
        afterAma.edges.some(
          (edge) => edge.source === lead.id && edge.target === amaNode.id,
        ),
      { title: amaNode?.title, agent: amaNode?.data?.agent },
    );
    // 真模型看不到请求：只在脚本化模型时判。
    if (!real)
      s.check(
        "第二个 ama 真的调了模型（脚本化服务收到带任务的请求）",
        mock.requests.some((request) =>
          (request.messages ?? []).some(
            (message) =>
              message.role === "user" &&
              textOf(message).includes(AMA_TASK_PROMPT),
          ),
        ),
      );

    /* --- 6. 成员停在审批上：wait 答 blocked → 页面答复 → 继续到 done --- */

    if (!real) {
      const approvalDispatched = await canvasAsIn(
        context,
        dispatcher.id,
        "post",
        "--to",
        lead.id,
        "--key",
        "dispatch-approval",
        "--body",
        DISPATCH_APPROVAL,
      );
      s.check(
        "派审批任务的那条 post 成功",
        approvalDispatched.code === 0,
        approvalDispatched.stderr,
      );
      const all = (sql, ...params) => database.prepare(sql).all(...params);
      const held = await waitFor(
        "派出的成员停在审批上",
        () => {
          const run = one(
            "SELECT task_id, node_id FROM workflow_task_runs WHERE runner_id = 'custom:taskecho' AND status = 'running'",
          );
          if (run === undefined) return undefined;
          const status = one(
            "SELECT state, pending_id FROM agent_status WHERE node_id = ?",
            run.node_id,
          );
          return status?.state === "blocked" && status.pending_id
            ? { ...run, pendingId: status.pending_id }
            : undefined;
        },
        { timeout: 180_000, interval: 250 },
      ).catch(async (error) => {
        note("协调者终端画面", await capture());
        note("审批诊断", {
          runs: all("SELECT * FROM workflow_task_runs"),
          status: all(
            "SELECT node_id, agent_id, state, pending_id FROM agent_status",
          ),
          fake: existsSync(taskLog)
            ? readFileSync(taskLog, "utf8").split("\n").slice(-20)
            : [],
        });
        throw error;
      });
      const waited = await controlAs(data, lead.id, "wait", {
        task: held.task_id,
        node: held.node_id,
        timeout: "0",
      });
      const answer = waited?.result ?? {};
      s.check(
        "wait 答 blocked，approvalId 是成员挂着的那条审批",
        answer.status === "blocked" &&
          answer.reason === "approval" &&
          answer.approvalId === held.pendingId,
        { status: answer.status, approvalId: answer.approvalId, held },
      );
      s.check(
        "停在审批上不算结束：任务行仍在跑",
        one(
          "SELECT status FROM workflow_task_runs WHERE task_id = ?",
          held.task_id,
        )?.status === "running",
      );
      // 页面上节点头的「允许」走的就是这一条。
      await api(`/api/approvals/${encodeURIComponent(held.pendingId)}/answer`, {
        method: "POST",
        body: { decision: "allow" },
      });
      const approvalSticky = await waitFor(
        "协调者把审批之后的结果写进便签",
        async () =>
          (await document()).nodes.find(
            (node) =>
              node.type === "sticky" &&
              JSON.stringify(node.data ?? {}).includes(APPROVAL_RESULT),
          ),
        { timeout: 180_000, interval: 1000 },
      ).catch(async (error) => {
        note("协调者终端画面", await capture());
        note("审批之后诊断", {
          runs: all("SELECT * FROM workflow_task_runs"),
          fake: existsSync(taskLog)
            ? readFileSync(taskLog, "utf8").split("\n").slice(-20)
            : [],
        });
        throw error;
      });
      s.check(
        "便签里是审批之后成员回报的结果",
        approvalSticky !== undefined,
        approvalSticky?.data,
      );
      const finished = one(
        "SELECT status, result_json FROM workflow_task_runs WHERE task_id = ?",
        held.task_id,
      );
      s.check(
        "任务行 done、带审批之后的结果",
        finished?.status === "done" &&
          String(finished.result_json).includes(APPROVAL_RESULT),
        finished,
      );
      const permissionLine = readFileSync(taskLog, "utf8")
        .split("\n")
        .find((line) => line.includes("permission exit="));
      s.check(
        "假 CLI 经 Hook 拿到的是「允许」（不是超时）",
        permissionLine !== undefined && /allow/i.test(permissionLine),
        permissionLine,
      );
    }

    const leaked = filesContaining(data, secret, [join(data, "secrets")]);
    s.check(
      "数据目录里除密钥后端外没有文件含这把 key",
      leaked.length === 0,
      leaked,
    );
    const coreLog = join(output, "core-coordinator.log");
    s.check(
      "core 日志里没有这把 key",
      !existsSync(coreLog) || !readFileSync(coreLog, "utf8").includes(secret),
    );

    const blockedCalls = context.blocked();
    s.check(
      "这套 core 没有起任何真 CLI（替身没被调用）",
      blockedCalls.length === 0,
      blockedCalls.slice(0, 5),
    );

    /* -------------------- 4. 画布外对照：同一 profile -------------------- */

    // 画布外对照要看模型请求里的工具表：只在脚本化模型时做（真模型不多花一轮）。
    if (real) {
      await sleep(200);
      s.finish();
      return;
    }
    const before = mock.requests.length;
    const outside = await new Promise((done) =>
      execFile(
        process.execPath,
        [
          join(root, "apps/desktop/out/agent/ama.cjs"),
          "--profile",
          profilePath,
          "-p",
          "hi",
        ],
        {
          // 画布外没有兑换：key 是用户自己 shell 里的，与平常一样。
          env: {
            PATH: process.env.PATH,
            HOME: home,
            AMA_API_KEY_DEEPSEEK: secret,
          },
          cwd: project,
          timeout: 60_000,
        },
        (error, stdout, stderr) =>
          done({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
      ),
    );
    const outsideRequest = mock.requests
      .slice(before)
      .find((request) =>
        (request.messages ?? []).some(
          (message) => message.role === "user" && textOf(message) === "hi",
        ),
      );
    const outsideTools = (outsideRequest?.tools ?? []).map(
      (tool) => tool.function?.name,
    );
    s.check(
      "画布外同一个 profile：跑得起来，工具表里没有画布工具",
      outside.code === 0 &&
        outsideTools.length > 0 &&
        !outsideTools.some((name) => name?.startsWith("canvas_")),
      {
        code: outside.code,
        tools: outsideTools,
        stderr: outside.stderr.slice(0, 300),
      },
    );
    await sleep(200);
  } catch (error) {
    s.fail(error);
  }
  s.finish();
}
