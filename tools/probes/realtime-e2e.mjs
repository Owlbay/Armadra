// 实时协同端到端探针（补全计划 G2-5，补全架构 §6.4，契约 §16）。
//
// 真 core、真 Vite 页面、新 profile 的无头 Chrome。两个独立的 browser context
// （各自一份存储，相当于两台设备）打开同一块画布：
//
//   1. 第一台打开就把板切到实时（`GET …/realtime` 答 realtime: true），在线条
//      列出对方的头像；
//   2. 两边**同时**各拖一个节点：两边都看到两处新位置，core 物化的表也一样；
//   3. 一边在画布上移动指针，另一边看到带名字的成员光标；选中一个节点，另一边
//      看到虚线选区外框；
//   4. 同一张便签两边同时输入（一个在开头、一个在结尾），提交后两边与 core
//      都收敛成同一段文字，两个人的字都在；
//   5. 断网重连：第二台的同步流被切断且连不上，顶部出现「离线编辑」、在线条
//      置灰，期间
//      拖动的节点第一台看不到；恢复网络后自动重连，第一台看到这次拖动、横幅
//      消失。
//
// 断网用页面里的 WebSocket 包装实现（`Page.addScriptToEvaluateOnNewDocument`
// 注入，只在这个探针里）：关掉 `…/sync` 的连接、拒绝新的连接；不改产品代码。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build
//   node tools/probes/realtime-e2e.mjs [输出目录]
//
// 产物默认在 target/realtime-e2e/：result.json 与每一步的截图。一切都是临时
// 的、回环的：随机端口、mktemp 出来的数据目录、HOME 与浏览器 profile，结束时
// 全部删除并停掉自己起的 tmux 服务器。
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
    join(root, "target/realtime-e2e"),
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

/** 页面加载前装上的 WebSocket 包装：`window.__probeNet.offline(true)` 断网。 */
const NETWORK_SWITCH = `
(() => {
  const Native = window.WebSocket;
  const sockets = new Set();
  let offline = false;
  function Probed(url, protocols) {
    if (offline && String(url).includes("/sync")) {
      // 断网时新连接直接失败：浏览器里就是一次没打开过的 close。
      const dead = new Native("ws://127.0.0.1:9/offline");
      return dead;
    }
    const socket = protocols === undefined ? new Native(url) : new Native(url, protocols);
    if (String(url).includes("/sync")) {
      sockets.add(socket);
      socket.addEventListener("close", () => sockets.delete(socket));
    }
    return socket;
  }
  Probed.prototype = Native.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Probed[key] = Native[key];
  window.WebSocket = Probed;
  window.__probeNet = {
    offline(next) {
      offline = next;
      if (next) for (const socket of sockets) socket.close(4000, "probe offline");
    },
    open() {
      return [...sockets].filter((socket) => socket.readyState === 1).length;
    },
  };
})();
`;

const positionOf = (page, id) =>
  page.evaluate(`
    const node = document.querySelector('.react-flow__node[data-id="${id}"]');
    if (!node) return null;
    const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(node.style.transform);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  `);

async function headerPoint(page, id) {
  return page.until(
    `const node = document.querySelector('.react-flow__node[data-id="${id}"]');
     const header = node?.querySelector('[data-slot="node-header"]');
     if (!header) return null;
     const r = header.getBoundingClientRect();
     const point = { x: r.left + 24, y: r.top + r.height / 2 };
     return header.contains(document.elementFromPoint(point.x, point.y)) ? point : null;`,
    `节点 ${id.slice(0, 8)} 的标题栏可以按到`,
  );
}

async function dragNode(page, id, dx, dy) {
  const from = await headerPoint(page, id);
  await page.drag(from, { x: from.x + dx, y: from.y + dy }, 14);
}

/** 等某个节点在这一页上到了 (x, y) 附近。 */
function waitAt(page, id, x, y, what) {
  return page.until(
    `const node = document.querySelector('.react-flow__node[data-id="${id}"]');
     const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(node?.style.transform ?? "");
     return m && Math.abs(Number(m[1]) - ${x}) < 2 && Math.abs(Number(m[2]) - ${y}) < 2;`,
    what,
    { timeout: 20_000 },
  );
}

const report = { status: "failed", output, scenarios: [] };
let stack;
try {
  stack = await startStack({});
  report.chrome = stack.chrome;
  console.log(`core ${stack.origin}  页面 ${stack.web}`);
  const run = scenario(report, "实时协同（§6.4）", output);

  const project = join(stack.scratch, "realtime-project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# realtime\n");
  const { workspace, board } = await stack.workspace("实时协同", project);
  const left = makeNode(
    board.id,
    "sticky",
    "左",
    { x: 120, y: 160 },
    { width: 220, height: 150 },
    { kind: "sticky", content: "左边" },
  );
  const right = makeNode(
    board.id,
    "sticky",
    "右",
    { x: 520, y: 160 },
    { width: 220, height: 150 },
    { kind: "sticky", content: "右边" },
  );
  const shared = makeNode(
    board.id,
    "sticky",
    "共写",
    { x: 320, y: 420 },
    { width: 280, height: 160 },
    { kind: "sticky", content: "中间" },
  );
  await stack.seedBoard(workspace.id, board.id, [left, right, shared]);
  const url = stack.boardUrl(workspace.id, board.id);
  const realtimePath = `/api/workspaces/${workspace.id}/boards/${board.id}/realtime`;
  const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;

  const openDevice = async (name) => {
    const page = await stack.browser.page(await stack.browser.context());
    await page.call("Page.addScriptToEvaluateOnNewDocument", {
      source: NETWORK_SWITCH,
    });
    await page.goto(url);
    await page.settle();
    await page.until(
      `return !!document.querySelector('.react-flow__node[data-id="${shared.id}"]')`,
      `${name} 渲染出画布`,
    );
    await page.until(
      `return window.__probeNet.open() > 0`,
      `${name} 连上 …/sync`,
      { timeout: 20_000 },
    );
    return page;
  };

  /* ---------------------------- 1. 切到实时 ----------------------------- */
  const a = await openDevice("A");
  const state = await stack.api(realtimePath);
  run.check(state.realtime === true, "第一台打开就把板切到实时", state);
  const b = await openDevice("B");
  for (const [page, name] of [
    [a, "A"],
    [b, "B"],
  ]) {
    await page.until(
      `const bar = document.querySelector('[data-slot="presence-bar"][data-mode="realtime"]');
       return bar && bar.querySelectorAll('[data-peer]').length === 1;`,
      `${name} 的在线条列出对方`,
    );
  }
  run.ok("两边的在线条都列出对方（awareness）");
  await run.shot(a, "realtime-1-presence-a");

  /* ------------------------- 2. 同时各拖一个节点 ------------------------ */
  const leftStart = await positionOf(a, left.id);
  const rightStart = await positionOf(b, right.id);
  await Promise.all([
    dragNode(a, left.id, 0, 140),
    dragNode(b, right.id, 0, 180),
  ]);
  const leftEnd = await positionOf(a, left.id);
  const rightEnd = await positionOf(b, right.id);
  run.check(
    leftEnd.y > leftStart.y + 80 && rightEnd.y > rightStart.y + 100,
    "两边各自拖动生效",
    { leftEnd, rightEnd },
  );
  await waitAt(b, left.id, leftEnd.x, leftEnd.y, "B 看到 A 拖的节点");
  await waitAt(a, right.id, rightEnd.x, rightEnd.y, "A 看到 B 拖的节点");
  run.ok("两边同时拖不同的节点，谁的都不丢", { leftEnd, rightEnd });
  const materialized = await stack.api(documentPath);
  const at = (id) => materialized.nodes.find((node) => node.id === id).position;
  run.check(
    Math.abs(at(left.id).y - leftEnd.y) < 2 &&
      Math.abs(at(right.id).y - rightEnd.y) < 2,
    "core 物化的表与两边一致",
    { left: at(left.id), right: at(right.id) },
  );
  await run.shot(b, "realtime-2-concurrent-drag-b");

  /* --------------------------- 3. 光标与选区 ---------------------------- */
  const pane = await a.centerOf(
    `return document.querySelector('.react-flow__pane')`,
    "A 的画布",
  );
  for (let step = 0; step < 6; step += 1) {
    await a.mouse("mouseMoved", pane.x - 200 + step * 20, pane.y + 120);
    await sleep(60);
  }
  const label = await b.until(
    `const cursor = document.querySelector('[data-peer-cursor]:not([data-leaving])');
     return cursor ? cursor.textContent.trim() || "(无名)" : null;`,
    "B 看到 A 的光标",
  );
  run.ok("一边移动指针，另一边看到成员光标", label);
  await a.clickOn(
    `return document.querySelector('.react-flow__node[data-id="${right.id}"] [data-slot="node-header"]')`,
    "A 选中右边的便签",
  );
  await b.until(
    `return !!document.querySelector('[data-peer-selection="${right.id}"]')`,
    "B 看到 A 的选区外框",
  );
  run.ok("一边选中节点，另一边看到虚线选区外框");
  await run.shot(b, "realtime-3-cursor-selection-b");

  /* ------------------------ 4. 同一便签同时输入 ------------------------- */
  const startEditing = async (page, caret) => {
    await page.clickOn(
      `return document.querySelector('.react-flow__node[data-id="${shared.id}"] [data-slot="sticky-node"] [role="button"]')`,
      "便签正文",
    );
    await page.until(
      `return !!document.querySelector('.react-flow__node[data-id="${shared.id}"] textarea')`,
      "便签进入编辑",
    );
    await page.evaluate(`
      const area = document.querySelector('.react-flow__node[data-id="${shared.id}"] textarea');
      area.focus();
      const at = ${caret === "end" ? "area.value.length" : "0"};
      area.setSelectionRange(at, at);
      return true;
    `);
  };
  await startEditing(a, "end");
  await startEditing(b, "start");
  await a.type("·A 写的");
  await b.type("B 写的·");
  const blur = (page) =>
    page.evaluate(`
      document.querySelector('.react-flow__node[data-id="${shared.id}"] textarea')?.blur();
      return true;
    `);
  await Promise.all([blur(a), blur(b)]);
  const expected = "B 写的·中间·A 写的";
  const contentOf = (page) =>
    page.until(
      `const node = document.querySelector('.react-flow__node[data-id="${shared.id}"] [data-slot="sticky-node"]');
       const text = node?.innerText.trim() ?? "";
       return text.includes(${JSON.stringify(expected)}) ? text : null;`,
      "便签收敛",
      { timeout: 20_000 },
    );
  await contentOf(a);
  await contentOf(b);
  const afterTyping = await stack.api(documentPath);
  const sharedContent = afterTyping.nodes.find((node) => node.id === shared.id)
    .data.content;
  run.check(
    sharedContent === expected,
    "同一张便签同时输入，两边与 core 收敛成同一段、两个人的字都在",
    sharedContent,
  );
  await run.shot(a, "realtime-4-same-sticky-a");

  /* ---------------------------- 5. 断网重连 ----------------------------- */
  b.allowed.push(/WebSocket|ws:\/\/127\.0\.0\.1:9|ERR_CONNECTION_REFUSED/i);
  await b.evaluate(`window.__probeNet.offline(true); return true;`);
  await b.until(
    `return [...document.querySelectorAll('[data-slot="banner"]')].some((node) => node.innerText.includes("离线编辑"));`,
    "B 顶部出现「离线编辑」",
  );
  await b.until(
    `return !!document.querySelector('[data-slot="presence-bar"][data-offline="true"]');`,
    "B 的在线条置灰",
  );
  run.ok("断网后顶部显示「离线编辑」，在线条置灰、写「已断开」");
  const leftBefore = await positionOf(b, left.id);
  await dragNode(b, left.id, 160, 0);
  const offlineMove = await positionOf(b, left.id);
  run.check(
    offlineMove.x > leftBefore.x + 100,
    "离线时本地照常编辑",
    offlineMove,
  );
  await sleep(1500);
  const stillA = await positionOf(a, left.id);
  run.check(
    Math.abs(stillA.x - leftBefore.x) < 2,
    "离线期间的改动 A 看不到",
    stillA,
  );
  await run.shot(b, "realtime-5-offline-b");
  await b.evaluate(`window.__probeNet.offline(false); return true;`);
  await waitAt(
    a,
    left.id,
    offlineMove.x,
    offlineMove.y,
    "重连后 A 看到 B 离线时的拖动",
  );
  await b.until(
    `return ![...document.querySelectorAll('[data-slot="banner"]')].some((node) => node.innerText.includes("离线编辑"));`,
    "B 的「离线编辑」消失",
    { timeout: 20_000 },
  );
  run.ok("恢复网络后自动重连，离线期间的改动补齐");
  await run.shot(a, "realtime-6-reconnected-a");

  run.consoleClean(a, b);
  await a.close();
  await b.close();
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
