// 多端加入不刷新探针（终端多端尺寸与身份通知分级的页面侧回归）。
//
// 真 core、真 Vite 页面、新 profile 的无头 Chrome（复用 `ui-features/harness.mjs`）。
// A（1440×900）打开一块有两个终端、一张便签的板，稳定之后：
//
//   1. 手机端 B（390×844）打开同一块板，终端 attach；
//   2. 第二台桌面 C（1280×800）也打开；
//   3. 再从 B 开一条终端连接，发 `resize 40x12`（手机焦点页铺满时的尺寸）。
//
// 每一步之后断言 A：
//   (a) `window.__mark` 还在（没整页重载），画布节点与 xterm 的 DOM 没被移除或
//       换掉（挂载时打的标记还在同一个元素上）；
//   (b) 终端 WS 没有关闭、没有新开；
//   (c) 3 秒内终端 output 帧为 0；tmux 里 A 的客户端尺寸与窗口尺寸都不变；
//   (d) xterm 每一行文字与之前相同（没有追加重复提示符）；
//   (e) 只有周期性的请求（`resources/subscription`、`usage`、`health`、在线心跳），没有
//       全量重取；
//   (f) 画布视口不变。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build
//   node tools/probes/join-no-refresh.mjs [输出目录]
//
// 产物默认在 target/join-no-refresh/：result.json 与每一步的截图。一切都是临时
// 的、回环的：随机端口、mktemp 出来的数据目录、HOME 与浏览器 profile，结束时
// 全部删除并停掉自己起的 tmux 服务器。
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  makeNode,
  root,
  scenario,
  sleep,
  startStack,
  writeResult,
} from "./ui-features/harness.mjs";

const output = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
    join(root, "target/join-no-refresh"),
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

/** 页面加载前装上：记 WS 开关、终端帧、请求与 DOM 移除。 */
const INSTRUMENT = `
(() => {
  const log = [];
  window.__probeLog = log;
  window.__wsUrls = [];
  const now = () => Math.round(performance.now());
  const Native = window.WebSocket;
  function Probe(url, protocols) {
    const socket = protocols === undefined ? new Native(url) : new Native(url, protocols);
    const path = String(url).replace(/^.*?\\/api/, "/api").replace(/\\?.*$/, "");
    window.__wsUrls.push(String(url));
    log.push({ t: now(), ev: "ws.open", path });
    socket.addEventListener("close", (event) => log.push({ t: now(), ev: "ws.close", path, code: event.code }));
    socket.addEventListener("message", (event) => {
      if (!path.includes("/terminals/")) return;
      let type = "?";
      try { type = JSON.parse(String(event.data)).type; } catch {}
      log.push({ t: now(), ev: "term", type, path });
    });
    return socket;
  }
  Probe.prototype = Native.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Probe[key] = Native[key];
  window.WebSocket = Probe;
  const fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const path = String(input?.url ?? input).replace(/^.*?\\/api/, "/api").replace(/\\?.*$/, "");
    log.push({ t: now(), ev: "fetch", method: init?.method ?? "GET", path });
    return fetch(input, init);
  };
  const watch = () =>
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(".react-flow, .react-flow__node, .xterm") || node.querySelector(".react-flow__node, .xterm"))
            log.push({ t: now(), ev: "dom.removed", what: node.className.toString().slice(0, 60) });
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) watch();
  else document.addEventListener("DOMContentLoaded", watch);
})();
`;

/**
 * 周期性的请求：有没有别的端加入都会发。在线心跳（`boards/heartbeat`）只报
 * 「我还在」，不重取任何数据。
 */
const PERIODIC = [
  /\/resources\/subscription$/,
  /\/api\/usage$/,
  /\/api\/health$/,
  /\/api\/rpc\/boards\/heartbeat$/,
];

const report = {
  probe: "join-no-refresh",
  startedAt: new Date().toISOString(),
  status: "failed",
  scenarios: [],
};

let stack;
try {
  stack = await startStack({});
  const run = scenario(report, "多端加入后已打开的一端不刷新", output);
  const project = join(stack.scratch, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# join\n");
  const { workspace, board } = await stack.workspace("join", project);
  const terminal = (title, x) =>
    makeNode(
      board.id,
      "terminal",
      title,
      { x, y: 100 },
      { width: 520, height: 320 },
      { kind: "terminal" },
    );
  const note = makeNode(
    board.id,
    "sticky",
    "note",
    { x: 80, y: 520 },
    { width: 220, height: 150 },
    { kind: "sticky", content: "hi" },
  );
  await stack.seedBoard(workspace.id, board.id, [
    terminal("one", 80),
    terminal("two", 680),
    note,
  ]);
  const url = stack.boardUrl(workspace.id, board.id);

  const tmux = (...args) =>
    execFileSync("tmux", ["-S", join(stack.data, "tmux.sock"), ...args], {
      encoding: "utf8",
    }).trim();
  const clients = () =>
    Object.fromEntries(
      tmux(
        "list-clients",
        "-F",
        "#{client_tty} #{client_width}x#{client_height}",
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ")),
    );
  const windows = () =>
    tmux(
      "list-windows",
      "-a",
      "-F",
      "#{session_name} #{window_width}x#{window_height}",
    )
      .split("\n")
      .filter(Boolean)
      .sort();

  /* ---------------------------------- A ---------------------------------- */
  const a = await stack.browser.page(await stack.browser.context());
  await a.call("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  await a.goto(url);
  await a.until(
    `return document.querySelectorAll('.xterm').length >= 2 &&
       window.__probeLog.filter((e) => e.ev === "term" && e.type === "hello").length >= 2`,
    "A 的两个终端连上",
    { timeout: 40_000 },
  );
  // 让 shell 把提示符画完、页面的尺寸对齐都落定。
  await sleep(6000);
  const aClients = clients();
  const windowsBefore = windows();
  run.check(
    Object.keys(aClients).length === 2,
    "A 在 tmux 里有两个客户端",
    aClients,
  );

  /** 在 A 上打标记、记一份现状，返回之后比对用的那一份。 */
  const snapshot = () =>
    a.evaluate(`
      window.__mark ??= "A-" + Date.now();
      let index = 0;
      for (const element of document.querySelectorAll('.react-flow__node, .xterm'))
        element.__probeMount ??= "m" + (index += 1) + "-" + Math.random().toString(36).slice(2);
      return {
        mark: window.__mark,
        mounts: [...document.querySelectorAll('.react-flow__node, .xterm')].map((e) => e.__probeMount ?? null),
        rows: [...document.querySelectorAll('.xterm-rows')].map((r) => [...r.children].map((c) => c.textContent)),
        viewport: document.querySelector('.react-flow__viewport')?.style.transform ?? "",
        logLength: window.__probeLog.length,
      };
    `);

  /** 比对 A 自 `before` 以来的变化。 */
  const assertUntouched = async (before, step) => {
    const now = await a.evaluate(`
      return {
        mark: window.__mark ?? null,
        mounts: [...document.querySelectorAll('.react-flow__node, .xterm')].map((e) => e.__probeMount ?? null),
        rows: [...document.querySelectorAll('.xterm-rows')].map((r) => [...r.children].map((c) => c.textContent)),
        viewport: document.querySelector('.react-flow__viewport')?.style.transform ?? "",
        log: window.__probeLog.slice(${before.logLength}),
      };
    `);
    run.check(now.mark === before.mark, `${step}：A 没有整页重载`);
    run.check(
      JSON.stringify(now.mounts) === JSON.stringify(before.mounts),
      `${step}：A 的画布节点与 xterm 没有重挂载`,
      { before: before.mounts.length, after: now.mounts.length },
    );
    const removed = now.log.filter((e) => e.ev === "dom.removed");
    run.check(
      removed.length === 0,
      `${step}：A 没有节点或 xterm 被移除`,
      removed,
    );
    const sockets = now.log.filter(
      (e) =>
        (e.ev === "ws.close" || e.ev === "ws.open") &&
        e.path.includes("/terminals/"),
    );
    run.check(
      sockets.length === 0,
      `${step}：A 的终端 WS 没有断开或重连`,
      sockets,
    );
    const outputs = now.log.filter(
      (e) => e.ev === "term" && e.type === "output",
    );
    run.check(outputs.length === 0, `${step}：A 的终端没有收到重绘输出`, {
      frames: outputs.length,
    });
    const after = clients();
    const moved = Object.entries(aClients).filter(
      ([tty, size]) => after[tty] !== size,
    );
    run.check(moved.length === 0, `${step}：A 的 tmux 客户端尺寸不变`, {
      before: aClients,
      after,
    });
    run.check(
      JSON.stringify(windows()) === JSON.stringify(windowsBefore),
      `${step}：tmux 窗口尺寸不变`,
      windows(),
    );
    run.check(
      JSON.stringify(now.rows) === JSON.stringify(before.rows),
      `${step}：A 的终端画面逐行相同（没有重复提示符）`,
    );
    const fetches = now.log.filter((e) => e.ev === "fetch");
    const extra = fetches.filter(
      (e) => !PERIODIC.some((pattern) => pattern.test(e.path)),
    );
    run.check(extra.length === 0, `${step}：A 没有全量重取`, {
      periodic: fetches.length - extra.length,
      extra: extra.map((e) => `${e.method} ${e.path}`),
    });
    run.check(
      now.viewport === before.viewport,
      `${step}：A 的视口不变`,
      now.viewport,
    );
  };

  /** 新开一端并等它的终端都 attach 上，再静置 3 秒。 */
  const openDevice = async (width, height, mobile) => {
    const page = await stack.browser.page(await stack.browser.context(), {
      width,
      height,
    });
    await page.call("Page.addScriptToEvaluateOnNewDocument", {
      source: INSTRUMENT,
    });
    if (mobile) await page.viewport(width, height, true);
    await page.goto(url);
    await page.until(
      `return window.__probeLog.filter((e) => e.ev === "term" && e.type === "hello").length >= 2`,
      `${width} 宽的一端终端连上`,
      { timeout: 40_000 },
    );
    await sleep(3000);
    return page;
  };

  // 1. 手机端加入。
  let before = await snapshot();
  const b = await openDevice(390, 844, true);
  await assertUntouched(before, "手机端加入");
  await run.shot(a, "join-01-a-after-phone");
  await run.shot(b, "join-01-phone");

  // 2. 第二台桌面加入。
  before = await snapshot();
  const c = await openDevice(1280, 800, false);
  await assertUntouched(before, "第二台桌面加入");
  await run.shot(c, "join-02-desktop");

  // 3. 手机焦点页铺满：从 B 新开一条终端连接，发 40×12。
  before = await snapshot();
  const resized = await b.evaluate(`
    const url = window.__wsUrls.find((u) => u.includes("/terminals/"));
    const phone = new WebSocket(url.replace(/writer=[^&]+/, "writer=phone-focus"));
    window.__phone = phone;
    await new Promise((done) => phone.addEventListener("message", (m) => {
      if (String(m.data).includes('"hello"')) done();
    }));
    phone.send(JSON.stringify({ type: "resize", cols: 40, rows: 12 }));
    return url.replace(/^.*\\/terminals\\//, "").replace(/\\/ws.*$/, "");
  `);
  await sleep(3000);
  const phoneClient = Object.values(clients()).filter(
    (size) => size === "40x12",
  );
  run.check(
    phoneClient.length === 1,
    "手机那一端自己的客户端是 40×12",
    clients(),
  );
  await assertUntouched(before, "手机端 resize 40×12");
  await b.evaluate(`window.__phone.close(); return 1`);
  await sleep(1500);
  run.ok("手机连接的会话", resized);
  await run.shot(a, "join-03-a-after-phone-resize");

  run.consoleClean(a, b, c);
  await a.close();
  await b.close();
  await c.close();
  run.entry.status = "passed";
  report.status = "ok";
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const entry = report.scenarios.at(-1);
  if (entry && entry.status === "running") {
    entry.status = "failed";
    entry.error = message;
    let index = 0;
    for (const page of entry.pages ?? []) {
      index += 1;
      try {
        entry.shots.push(
          await page.capture(join(output, `failure-${index}.png`)),
        );
        entry.problems.push(...page.unexpected());
      } catch {}
    }
  } else {
    report.error = message;
  }
  console.error(`  FAIL  ${message}`);
} finally {
  await stack?.stop();
  writeResult(output, report);
  console.log(`\n报告 ${join(output, "result.json")}：${report.status}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
