// ACP 会话端到端（A 档，补全计划 G2-1，契约 §14.2–§14.4）。
//
// 真 core（`apps/desktop/out/core/main.js`）、真页面（Vite）、新 profile 的无头 Chrome；
// ACP Agent 是 `@armadra/agent/acp` 的假 Agent，注册成一家基础 CLI 为 OpenCode
// 的 `custom:` 条目（OpenCode 自己就是 ACP 入口，条目的启动程序顶替它）。不用
// 任何真实账号、不起任何真 CLI。走一遍 ACP 设计的主线：
//
//   1. 画布上两个以 ACP 驱动的节点 A → B，页面挂载即起会话（`POST /api/acp/sessions`），
//      会话行是 `terminal_sessions` 的 `acp` 行；
//   2. 在 A 的会话视图里发一句，回复流进来，状态来源 `acp`、回合结束 `done`；
//   3. A 要写文件 → 审批卡出现 → 在页面上点「拒绝」：审批行 `deny`、审计 `route = acp`，
//      Agent 收到的是它自己的 `reject` 选项；
//   4. A 以 `armadra-hook canvas send` 投给 B：B 收到一次 prompt（`delivered`）；
//   4b. 第三个节点 C（假 Agent 带 `--config-options`）：发 `[elicit]`，elicitation 卡出现，
//      在页面上选值提交，Agent 收到这份内容、审批行不存它；Agent 给了模型目录时在
//      输入框旁的 Select 换模型，`[model]` 答新模型、节点数据记下 `agent.model`
//      （契约 §26）。上游 `@armadra/agent` 还没有这两样能力时这一步记为跳过；
//   5. A 切到终端视图再切回：同一行、代次 +2，接回同一个 CLI 会话，之前的对话还在；
//   6. 打开 Eco（秒级阈值）让 A 休眠，再在页面上发一句把它唤醒：同一行、适配器
//      pid 换了、CLI 会话 id 没变；
//   7. 全程页面没有控制台错误。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   pnpm --filter @armadra/desktop build
//   node tools/probes/acp-e2e.mjs [输出目录]
//
// 产物：<输出目录>/result.json 与各步截图，默认 target/acp-e2e/。
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { LOOPBACK_OWNER_ENV } from "./probe-home.mjs";
import {
  child,
  harness,
  killTmux,
  sleep,
  startChrome,
  startVite,
} from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "target/acp-e2e"));
mkdirSync(output, { recursive: true });
const h = harness(output);
const { report, step } = h;
report.failures = [];

const FAKE_AGENT = "custom:fake-acp";
const FEATURE_AGENT = "custom:fake-acp-features";
const fakeAgent = join(
  root,
  "apps/desktop/node_modules/@armadra/agent/dist/drivers/acp/testing/fake-agent-main.js",
);
const hookBin = join(root, "apps/desktop/out/cli/armadra-hook.js");

/** 一项检查没过：记下来，跑完整条线再判失败。 */
function check(ok, name, detail = "") {
  if (ok) step(name, detail);
  else {
    report.failures.push({ name, detail });
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

await h.run(async () => {
  for (const [what, file] of [
    ["core", "apps/desktop/out/core/main.js"],
    ["armadra-hook", "apps/desktop/out/cli/armadra-hook.js"],
    ["假 ACP Agent", fakeAgent.slice(root.length)],
  ]) {
    if (!existsSync(join(root, file)))
      throw new Error(`${what}未构建：${file}（见文件头的构建命令）`);
  }

  /* -------------------------------- core --------------------------------- */

  const data = h.temp("armadra-acp-e2e-");
  const home = h.temp("armadra-acp-e2e-home-");
  h.cleanups.push(() => killTmux(data));
  const environment = {
    ...process.env,
    HOME: home,
    ARMADRA_DATA_DIR: data,
    ARMADRA_LOG: process.env.ARMADRA_LOG ?? "warn",
    // 探针不碰操作员的 CLI 配置与系统钥匙串。
    ARMADRA_NO_GLOBAL_WRITES: "1",
    ARMADRA_SECRET_BACKEND: "file",
    // Eco 的秒级阈值；开关仍听设置，第 6 步才打开。
    ARMADRA_TEST_ECO_IDLE_SECONDS: "3",
    // 裸 core 显式打开回环匿名按主人（契约 §3.2）：探针的页面不在壳里、拿不到票。
    ...LOOPBACK_OWNER_ENV,
  };
  const runtime = child(
    h,
    process.execPath,
    [
      join(root, "apps/desktop/out/core/main.js"),
      "--listen",
      "tcp:127.0.0.1:0",
      "--data-dir",
      data,
    ],
    { cwd: root, env: environment },
  );
  let origin = "";
  for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
    if (runtime.process.exitCode !== null)
      throw new Error(`core 退出：${runtime.tail()}`);
    try {
      origin = JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
        .runtime.http;
    } catch {
      await sleep(100);
    }
  }
  if (!origin) throw new Error("core 没有写出 endpoints.json");
  step("core 已启动", origin);
  const api = async (path, init = {}) => {
    const answer = await fetch(new URL(path, origin), {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text}`,
      );
    return text ? JSON.parse(text) : null;
  };
  const web = await startVite(h, root, environment);
  const chrome = await startChrome(h);
  const page = await chrome.open({ name: "page", width: 1600, height: 1000 });

  const database = () =>
    new DatabaseSync(join(data, "canvas.db"), { readOnly: true });
  const query = (sql, ...args) => {
    const db = database();
    try {
      return db.prepare(sql).all(...args);
    } finally {
      db.close();
    }
  };

  /* ---------------------------- 画布与三个节点 ---------------------------- */

  const projectRoot = h.temp("armadra-acp-e2e-project-");
  writeFileSync(join(projectRoot, "README.md"), "# ACP\n");
  await api("/api/settings", {
    method: "PATCH",
    body: {
      agents: {
        custom: [
          {
            id: FAKE_AGENT,
            label: "Fake ACP",
            launchCmd: process.execPath,
            args: [fakeAgent],
            baseAgent: "opencode",
          },
          {
            id: FEATURE_AGENT,
            label: "Fake ACP features",
            launchCmd: process.execPath,
            args: [fakeAgent, "--config-options"],
            baseAgent: "opencode",
          },
        ],
      },
      terminal: { ecoMode: false },
    },
  });
  const workspace = await api("/api/workspaces", {
    method: "POST",
    body: { name: "ACP", rootPath: projectRoot },
  });
  const board = (await api(`/api/workspaces/${workspace.id}/boards`))[0];
  const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
  const current = await api(documentPath);
  const stamp = new Date().toISOString();
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const agentNode = (
    id,
    title,
    x,
    { agentId = FAKE_AGENT, y = 80, height = 520 } = {},
  ) => ({
    id,
    boardId: board.id,
    type: "terminal",
    title,
    color: "#0a84ff",
    position: { x, y },
    size: { width: 560, height },
    labels: [],
    note: "",
    data: {
      kind: "terminal",
      cwd: projectRoot,
      agent: { id: agentId, driver: "acp" },
    },
    createdAt: stamp,
    updatedAt: stamp,
  });
  await api(documentPath, {
    method: "PUT",
    body: {
      expectedUpdatedAt: current.board.updatedAt,
      nodes: [
        agentNode(A, "Agent A", 40),
        agentNode(B, "Agent B", 680),
        // 放在 A 下方、窗口之内：页面上的点击要落在看得见的元素上。
        agentNode(C, "Agent C", 40, {
          agentId: FEATURE_AGENT,
          y: 620,
          height: 360,
        }),
      ],
      edges: [
        {
          id: randomUUID(),
          boardId: board.id,
          source: A,
          target: B,
          kind: "link",
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
    },
  });
  step("画布上放好两个以 ACP 驱动的节点 A → B");

  /* ------------------------- 1. 挂载即起会话 ------------------------- */

  page.drain();
  await page.navigate(`${web}/?workspace=${workspace.id}&board=${board.id}`);
  await page.settle();
  const node = (id) => `.react-flow__node[data-id="${id}"]`;
  const nodeText = (id) =>
    page.evaluate(
      `return document.querySelector(${JSON.stringify(node(id))})?.innerText ?? "";`,
    );
  const sessionRow = (nodeId) =>
    query(
      "SELECT id, backend_kind, generation, status, termination_intent FROM terminal_sessions WHERE owner_node_id = ? ORDER BY (status = 'running') DESC, generation DESC LIMIT 1",
      nodeId,
    )[0];
  const status = (nodeId) =>
    query(
      "SELECT state, state_source, session_id, interrupted FROM agent_status WHERE node_id = ?",
      nodeId,
    )[0];
  const waitUntil = async (what, test, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await test();
      if (last) return last;
      await sleep(200);
    }
    throw new Error(`等待超时：${what}；最后一次：${JSON.stringify(last)}`);
  };
  const rowA = await waitUntil("A 的会话行", () => {
    const row = sessionRow(A);
    return row?.status === "running" ? row : undefined;
  });
  await waitUntil("B 的会话行", () => sessionRow(B)?.status === "running");
  check(
    rowA.backend_kind === "acp",
    "页面挂载即起会话：terminal_sessions 的 acp 行",
    rowA.id,
  );
  await page.waitFor(
    `return !!document.querySelector(${JSON.stringify(`${node(A)} [data-slot="acp-session-view"] textarea`)});`,
    { what: "A 的会话视图与输入框" },
  );
  await sleep(500);
  await page.capture("01-sessions-open");
  report.trafficAtOpen = [...page.traffic];
  report.errorsAtOpen = [...page.errors];

  /* ------------------------- 2. 一个回合 ------------------------- */

  const say = async (nodeId, text) => {
    await page.click(`${node(nodeId)} textarea`);
    await page.call("Input.insertText", { text });
    await sleep(100);
    await page.key("Enter");
  };
  await say(A, "hello from the page [plan]");
  await page.waitFor(
    `return document.querySelector(${JSON.stringify(node(A))})?.innerText.includes("echo: hello from the page");`,
    { what: "A 的回复流进会话视图" },
  );
  await waitUntil("A 回合结束", () => status(A)?.state === "done");
  const afterTurn = status(A);
  check(
    afterTurn.state_source === "acp",
    "状态来源是 acp，回合结束是 done",
    JSON.stringify(afterTurn),
  );
  await page.capture("02-first-turn");

  /* ------------------------- 3. 审批经页面答 ------------------------- */

  await say(A, "write the note [permission]");
  await page.waitFor(
    `return !!document.querySelector(${JSON.stringify(`${node(A)} [data-slot="acp-permission"]`)});`,
    { what: "A 的审批卡" },
  );
  check(status(A)?.state === "blocked", "request_permission → blocked");
  await page.capture("03-permission-card");
  await page.click(`${node(A)} [data-slot="acp-permission"] button`, "拒绝", {
    exact: true,
  });
  await page.waitFor(
    `return document.querySelector(${JSON.stringify(node(A))})?.innerText.includes("write rejected");`,
    { what: "Agent 收到拒绝" },
  );
  const approval = query(
    "SELECT id, answer, answered_by, request_json FROM agent_approvals WHERE node_id = ? ORDER BY created_at DESC LIMIT 1",
    A,
  )[0];
  const audit = query(
    "SELECT route, accepted FROM agent_approval_audit WHERE approval_id = ? AND accepted = 1",
    approval.id,
  )[0];
  const request = JSON.parse(approval.request_json);
  check(
    approval.answer === "deny" &&
      audit?.route === "acp" &&
      request.protocol === "acp" &&
      request.options.length === 4,
    "页面答的审批：deny、route=acp、request_json 带全部选项",
    JSON.stringify({ answer: approval.answer, route: audit?.route }),
  );
  await waitUntil("A 回到 done", () => status(A)?.state === "done");
  await page.capture("04-permission-rejected");

  /* ------------- 3b. 会话里的东西点得动、选得中（会话视图 §5）------------- */

  // 剪贴板换成记录器：无头 Chrome 的剪贴板要权限，这里只验「点了复制写了什么」。
  await page.evaluate(`
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => { window.__copied.push(text); } },
    });
    return true;
  `);
  const tool = `${node(A)} [data-tool-call]`;
  await page.click(`${tool} button`, "详情", { exact: true });
  await page.waitFor(
    `return !!document.querySelector(${JSON.stringify(`${tool} pre`)});`,
    { what: "工具行展开出入参" },
  );
  await page.click(`${tool} button`, "复制入参", { exact: true });
  const copied = await page.waitFor(
    `return (window.__copied ?? []).find((text) => text.includes("note.txt")) ?? null;`,
    { what: "复制入参写进剪贴板" },
  );
  const surface = await page.evaluate(`
    const root = document.querySelector(${JSON.stringify(`${node(A)} [data-slot="acp-session-view"]`)});
    return {
      userSelect: root ? getComputedStyle(root).userSelect : null,
      nopan: root?.classList.contains("nopan") ?? false,
      plan: !!document.querySelector(${JSON.stringify(`${node(A)} [data-slot="acp-plan"]`)}),
      tone: document.querySelector(${JSON.stringify(`${tool} [data-slot="status-pill"]`)})?.dataset.tone ?? null,
    };
  `);
  report.sessionSurface = { ...surface, copied };
  check(
    surface.userSelect === "text" && surface.nopan && surface.plan,
    "会话视图字可选、不平移画布，计划卡画出来了",
    JSON.stringify(surface),
  );
  check(
    surface.tone === "failed",
    "被拒的工具调用是 failed 胶囊",
    String(surface.tone),
  );
  await page.capture("04b-tool-expanded-copied");

  /* ------------------------- 4. send 投给 B ------------------------- */

  const canvasAs = (nodeId, ...argv) =>
    new Promise((done) => {
      execFile(
        process.execPath,
        [hookBin, "canvas", ...argv],
        {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            ARMADRA_NODE_ID: nodeId,
            ARMADRA_ENDPOINT_FILE: join(data, "hook-endpoint.env"),
          },
          timeout: 60_000,
        },
        (error, stdout, stderr) =>
          done({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
      );
    });
  const sent = await canvasAs(A, "send", "--to", B, "--body", "ping from A");
  report.send = {
    code: sent.code,
    stdout: sent.stdout.slice(0, 400),
    stderr: sent.stderr.slice(0, 400),
  };
  check(
    sent.code === 0,
    "armadra-hook canvas send 回执",
    sent.stdout.trim().slice(0, 200),
  );
  await page.waitFor(
    `return document.querySelector(${JSON.stringify(node(B))})?.innerText.includes("ping from A");`,
    { what: "B 的会话视图里出现投来的消息", timeout: 45_000 },
  );
  const delivered = await waitUntil(
    "投递记录 delivered",
    () =>
      query(
        "SELECT outcome FROM agent_deliveries WHERE target_node_id = ? AND outcome = 'delivered' LIMIT 1",
        B,
      )[0],
    30_000,
  );
  report.delivery = delivered;
  check(
    delivered.outcome === "delivered",
    "send 在 ACP 下就是一次 prompt：delivered",
  );
  await waitUntil("B 回合结束", () => status(B)?.state === "done", 30_000);
  await page.capture("05-send-delivered");

  /* ------------------- 4b. elicitation 与模型（契约 §26）------------------- */

  report.skipped = [];
  const rowC = await waitUntil("C 的会话行", () => {
    const row = sessionRow(C);
    return row?.status === "running" ? row : undefined;
  });
  await page.waitFor(
    `return !!document.querySelector(${JSON.stringify(`${node(C)} [data-slot="acp-session-view"] textarea`)});`,
    { what: "C 的会话视图与输入框" },
  );
  const logC = await api(`/api/acp/sessions/${rowC.id}/log`);
  report.featureModels = logC.models ?? null;
  const card = `${node(C)} [data-slot="acp-elicitation"]`;
  await say(C, "pick one [elicit]");
  // 旧的假 Agent 不认 `[elicit]`（回声），新的假 Agent 遇上没声明能力的 core 答
  // `unsupported`；两样都是「上游还没到」，不是失败。
  const outcome = await page.waitFor(
    `const text = document.querySelector(${JSON.stringify(node(C))})?.innerText ?? "";
     if (document.querySelector(${JSON.stringify(card)})) return "card";
     if (text.includes("elicit: unsupported") || text.includes("echo: pick one")) return "unsupported";
     return false;`,
    { what: "C 的 elicitation 卡或「不支持」", timeout: 30_000 },
  );
  if (outcome === "unsupported") {
    report.skipped.push("elicitation：上游 @armadra/agent 尚无该能力");
    step("elicitation 跳过：上游 @armadra/agent 尚无该能力");
  } else {
    check(status(C)?.state === "waiting", "elicitation/create → waiting");
    await page.capture("10-elicitation-card");
    await page.click(`${card} [role="combobox"]`);
    await page.click('[role="option"]', "blue", { exact: true });
    await page.fill(`${card} input[type="number"]`, "2");
    await page.click(`${card} button`, "提交", { exact: true });
    await page.waitFor(
      `return document.querySelector(${JSON.stringify(node(C))})?.innerText.includes('elicit: accept {"color":"blue","count":2}');`,
      { what: "Agent 收到页面填的内容" },
    );
    const answered = query(
      "SELECT * FROM agent_approvals WHERE node_id = ? ORDER BY created_at DESC LIMIT 1",
      C,
    )[0];
    check(
      answered?.answer === "allow" &&
        JSON.parse(answered.request_json).elicitation?.message ===
          "Pick a color" &&
        !JSON.stringify(answered).includes('"count":2'),
      "页面答的 elicitation：allow、审批行不存答复内容",
      JSON.stringify({ answer: answered?.answer }),
    );
    await waitUntil("C 回到 done", () => status(C)?.state === "done");
    await page.capture("11-elicitation-answered");
  }

  if (!logC.models) {
    report.skipped.push("模型 Select：上游 @armadra/agent 尚无 configOptions");
    step("模型 Select 跳过：上游 @armadra/agent 尚无 configOptions");
  } else {
    await page.click(`${node(C)} [aria-label="模型"]`);
    await page.click('[role="option"]', "Large", { exact: true });
    await sleep(300);
    await say(C, "[model]");
    await page.waitFor(
      `return document.querySelector(${JSON.stringify(node(C))})?.innerText.includes("model large");`,
      { what: "换模型之后 Agent 用的是 large" },
    );
    const recorded = await waitUntil("节点数据记下 agent.model", async () => {
      const doc = await api(documentPath);
      const model = doc.nodes.find((n) => n.id === C)?.data?.agent?.model;
      return model === "large" ? model : undefined;
    });
    check(recorded === "large", "换模型写回节点数据 agent.model");
    await page.capture("12-model-switched");
  }

  /* ------------------------- 5. 切换驱动 ------------------------- */

  const before = sessionRow(A);
  const sessionBefore = status(A)?.session_id;
  const switchTo = async (label) => {
    const header = await page.evaluate(`
      const el = document.querySelector(${JSON.stringify(node(A))});
      const rect = el.getBoundingClientRect();
      return { x: rect.left + 120, y: rect.top + 14 };
    `);
    await page.rightClickAt(header);
    await page.click('[role="menuitem"], [role="menuitemradio"]', label, {
      exact: true,
    });
  };
  await switchTo("终端视图");
  const asTerminal = await waitUntil("A 换成终端驱动", () => {
    const row = sessionRow(A);
    return row?.backend_kind !== "acp" && row?.status === "running"
      ? row
      : undefined;
  });
  await page.waitFor(
    `return !!document.querySelector(${JSON.stringify(`${node(A)} .xterm`)});`,
    { what: "A 的节点体换成终端" },
  );
  // 终端驱动：shell 起来、恢复行敲进去（CLI 是假 Agent，画面上就是那一行）。
  const typed = await page
    .waitFor(
      `return (document.querySelector(${JSON.stringify(`${node(A)} .xterm-rows`)})?.innerText ?? "").includes("fake-agent-main");`,
      { what: "终端里敲了恢复行", timeout: 20_000 },
    )
    .catch(() => false);
  check(typed === true, "切到终端视图：PTY 起来并敲了 CLI 的恢复行");
  await page.capture("06-switched-to-terminal");
  await switchTo("会话视图");
  const backToAcp = await waitUntil("A 换回 ACP 驱动", () => {
    const row = sessionRow(A);
    return row?.backend_kind === "acp" && row?.status === "running"
      ? row
      : undefined;
  });
  await page.waitFor(
    `return document.querySelector(${JSON.stringify(node(A))})?.innerText.includes("echo: hello from the page");`,
    { what: "换回之后之前的对话还在" },
  );
  await waitUntil(
    "A 的 CLI 会话 id 不变",
    () => status(A)?.session_id === sessionBefore,
  );
  check(
    asTerminal.id === before.id &&
      backToAcp.id === before.id &&
      backToAcp.generation === before.generation + 2,
    "切换在同一行上起下一代（终端一代、ACP 一代），CLI 会话接回",
    `generation ${before.generation} → ${asTerminal.generation} → ${backToAcp.generation}`,
  );
  const header = await page.evaluate(
    `return document.querySelector(${JSON.stringify(`${node(A)} .react-flow__node > div, ${node(A)}`)})?.innerText.split("\\n").slice(0, 3).join(" ") ?? "";`,
  );
  check(!header.includes("已退出"), "换回之后节点头不再写「已退出」", header);
  await page.capture("07-switched-back");

  /* ------------------------- 6. 休眠与唤醒 ------------------------- */

  const pidOf = async (id) => (await api(`/api/terminals/${id}`)).pid;
  const pidBefore = await pidOf(before.id);
  // 让页面别拿着租约：焦点移出输入框。
  await page.evaluate(`document.activeElement?.blur?.(); return true;`);
  await api("/api/settings", {
    method: "PATCH",
    body: { terminal: { ecoMode: true } },
  });
  const slept = await waitUntil(
    "A 休眠",
    () => {
      const row = query(
        "SELECT status, termination_intent, generation FROM terminal_sessions WHERE id = ?",
        before.id,
      )[0];
      return row?.termination_intent === "hibernate" ? row : undefined;
    },
    60_000,
  );
  check(
    slept.status !== "running",
    "空闲的 ACP 会话按同一套判据休眠",
    JSON.stringify(slept),
  );
  await api("/api/settings", {
    method: "PATCH",
    body: { terminal: { ecoMode: false } },
  });
  await page.capture("08-hibernated");
  await say(A, "wake up");
  await page.waitFor(
    `return document.querySelector(${JSON.stringify(node(A))})?.innerText.includes("echo: wake up");`,
    { what: "唤醒之后回复照常", timeout: 45_000 },
  );
  const woke = sessionRow(A);
  const pidAfter = await pidOf(woke.id);
  check(
    woke.id === before.id &&
      woke.status === "running" &&
      typeof pidAfter === "number" &&
      pidAfter !== pidBefore &&
      status(A)?.session_id === sessionBefore,
    "唤醒：同一行、适配器 pid 换了、CLI 会话 id 没变",
    `pid ${pidBefore} → ${pidAfter}`,
  );
  await page.capture("09-woken");

  /* ------------------------- 7. 控制台 ------------------------- */

  const seen = page.drain();
  report.consoleErrors = seen.errors;
  report.failedResponses = seen.responses;
  check(
    seen.errors.length === 0,
    "全程没有控制台错误",
    seen.errors.map((e) => e.text).join(" | "),
  );
});
