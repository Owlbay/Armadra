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
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
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
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { mockModelServer } from "./mock-model.mjs";
import {
  cleanups,
  note,
  output,
  root,
  scenario,
  sleep,
  waitFor,
} from "./lib.mjs";

const FAKE_KEY = "sk-agent-e2e-fake-key";
const PROMPT = "让 A 审查 src/x，B 审查 src/y，汇总到便签";
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
      return {
        toolCalls: ids.map((id) => ({ name: "canvas_ack", arguments: { id } })),
      };
    }
    case "canvas_ack":
      return {
        toolCalls: [
          {
            name: "canvas_sticky",
            arguments: { title: "审查汇总", content: SUMMARY },
          },
        ],
      };
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

/** 自己的一套 core：临时 HOME、文件密钥后端、不写全局。 */
async function setupCore(scratch, home) {
  const project = join(scratch, "project");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# probe\n");
  const data = join(scratch, "rt");
  mkdirSync(data);
  const binary = join(root, "apps/desktop/out/core/main.js");
  const hook = join(root, "apps/desktop/out/cli/armadra-hook.js");
  const ama = join(root, "apps/desktop/out/agent/ama.cjs");
  const host = join(root, "apps/desktop/out/agent-host/ama-armadra.cjs");
  for (const file of [binary, hook, ama, host])
    if (!existsSync(file)) throw new Error(`未构建：${file}`);
  const environment = {
    ...process.env,
    HOME: home,
    ARMADRA_DATA_DIR: data,
    ARMADRA_SECRET_BACKEND: "file",
    ARMADRA_NO_GLOBAL_WRITES: "1",
  };
  for (const name of [
    "TMUX",
    "TMUX_PANE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "AMA_CONFIG_DIR",
    "AMA_DATA_DIR",
  ])
    delete environment[name];
  const log = createWriteStream(join(output, "core-coordinator.log"));
  const core = spawn(
    process.execPath,
    [binary, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: environment },
  );
  cleanups.push(() => core.kill("SIGKILL"));
  cleanups.push(() => {
    try {
      execFile("tmux", ["-S", join(data, "tmux.sock"), "kill-server"]);
    } catch {}
  });
  core.stdout.pipe(log);
  core.stderr.pipe(log);
  const origin = await waitFor(
    "协调者场景的 core 就绪",
    () => {
      try {
        return JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
          .runtime.http;
      } catch {
        return undefined;
      }
    },
    { timeout: 30_000, interval: 100 },
  );
  const api = async (path, init = {}) => {
    const answer = await fetch(new URL(path, origin), {
      headers: { "Content-Type": "application/json" },
      ...init,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text}`,
      );
    return text === "" ? null : JSON.parse(text);
  };
  return { api, data, project, hook, home };
}

/** 以某个节点的身份跑一次 `armadra-hook canvas …`。 */
function canvasAs(context, nodeId, verb, ...args) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [context.hook, "canvas", verb, ...args],
      {
        env: {
          PATH: process.env.PATH,
          HOME: context.home,
          ARMADRA_NODE_ID: nodeId,
          ARMADRA_ENDPOINT_FILE: join(context.data, "hook-endpoint.env"),
          ARMADRA_DATA_DIR: context.data,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        note(`canvas ${verb}（${nodeId.slice(0, 8)}）`, {
          code: error ? (error.code ?? 1) : 0,
          out: (stdout || stderr).trim().slice(0, 300),
        });
        done({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

export default async function run() {
  const s = scenario("11-coordinator");
  try {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "armadra-ama-")));
    cleanups.push(() =>
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
    );
    const mock = await mockModelServer(coordinatorScript);
    const home = join(scratch, "home");
    mkdirSync(join(home, ".config", "ama"), { recursive: true });
    writeFileSync(
      join(home, ".config", "ama", "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          defaultModel: "deepseek/mock-coordinator",
          providers: { deepseek: { baseUrl: mock.baseUrl } },
        },
        null,
        2,
      )}\n`,
    );
    const context = await setupCore(scratch, home);
    const { api, data, project } = context;

    // 假 key 经 core 存：页面「Armadra Agent 的模型密钥」走的就是这一条。
    const stored = await api("/api/agents/ama/credentials/deepseek", {
      method: "PUT",
      body: { apiKey: FAKE_KEY },
    });
    s.check(
      "密钥只答「已设」，不回显",
      stored.providers.some((p) => p.id === "deepseek" && p.isSet) &&
        !JSON.stringify(stored).includes(FAKE_KEY),
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
      PROMPT,
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
      pane !== undefined && !pane.includes(FAKE_KEY),
      pane === undefined ? "读不到窗格进程的环境" : undefined,
    );
    s.check(
      "agent_status 有 ama 行，来源是 extension",
      statusRow.agent_id === "ama" && statusRow.state_source === "extension",
      statusRow,
    );
    const firstTools = (mock.requests[0]?.tools ?? []).map(
      (tool) => tool.function?.name,
    );
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
        const found = doc.nodes.filter((node) =>
          ["reviewer-a", "reviewer-b"].includes(node.title),
        );
        return found.length === 2 ? { doc, found } : undefined;
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
      const posted = await canvasAs(
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
    const called = mock.requests
      .flatMap((request) => request.messages ?? [])
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.function?.name);
    s.check(
      "收到唤醒后依次 inbox → ack → sticky",
      ["canvas_inbox", "canvas_ack", "canvas_sticky"].every((name) =>
        called.includes(name),
      ),
      [...new Set(called)],
    );
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

    const leaked = filesContaining(data, FAKE_KEY, [join(data, "secrets")]);
    s.check(
      "数据目录里除密钥后端外没有文件含这把 key",
      leaked.length === 0,
      leaked,
    );
    const coreLog = join(output, "core-coordinator.log");
    s.check(
      "core 日志里没有这把 key",
      !existsSync(coreLog) || !readFileSync(coreLog, "utf8").includes(FAKE_KEY),
    );

    /* -------------------- 4. 画布外对照：同一 profile -------------------- */

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
            AMA_API_KEY_DEEPSEEK: FAKE_KEY,
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
