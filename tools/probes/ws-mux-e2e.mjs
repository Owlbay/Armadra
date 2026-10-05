// 控制面 WebSocket 端到端探针（工程规范化包 §2.5，契约 §35）。
//
// 真 core、真 Vite 页面、新 profile 的无头 Chrome。两个独立的 browser context
// （两台「设备」）打开同一块画布，工作空间事件流经控制面 `/api/ws` 订阅：
//
//   1. 两边都订上（收到位置帧），另一块板的保存产生的事件两边都收到；
//   2. 杀 core（SIGKILL）再在同一端口重启，期间与刚起来时产生的事件：两边重连后
//      带 lastEventId 续订，缺口由 outbox 补齐，一帧不少、一帧不重；
//   3. 第二台断网 30 秒（CDP `Network.emulateNetworkConditions`），期间的事件在
//      恢复网络后补齐；第一台照常收；
//   4. 第一台切到后台，core 停 8 秒再起（后台退避封顶 30 秒），产生几帧事件后
//      回到前台：3 秒内收齐。
//
// 页面收到了什么，看的是 CDP 的 `Network.webSocketFrameReceived`：控制面上每个
// 订阅事件带 outbox 序号作 id。真相是 outbox 本身：只读打开 core 的库，读这块
// 工作空间的全部序号。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build
//   node tools/probes/ws-mux-e2e.mjs [输出目录]
//
// 产物默认在 target/ws-mux-e2e/：result.json 与截图。一切都是临时的、回环的。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  root,
  scenario,
  sleep,
  startStack,
  until,
  writeResult,
} from "./ui-features/harness.mjs";

const output = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
    join(root, "target/ws-mux-e2e"),
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const OFFLINE_MS = Number(process.env.WS_MUX_OFFLINE_MS ?? 30_000);
const FOREGROUND_BUDGET_MS = 3_000;

/** 页面里把 `document.visibilityState` 换成探针能拨的开关。 */
const VISIBILITY_SWITCH = `
  window.__probeHidden = false;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (window.__probeHidden ? "hidden" : "visible"),
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => window.__probeHidden,
  });
  return true;
`;

async function setHidden(page, hidden) {
  await page.evaluate(`
    window.__probeHidden = ${hidden};
    document.dispatchEvent(new Event("visibilitychange"));
    return true;
  `);
}

/**
 * 一台设备收到的控制面事件：经 CDP 看这一页所有 `/api/ws` 连接上的帧。
 * 每个带 id 的订阅项记一次；位置帧单独记（它的 id 是订上那一刻的位置）。
 */
function watchFrames(stack, page) {
  const sockets = new Map();
  const seen = { events: [], cursors: [], opened: 0, closed: 0 };
  stack.browser.on((message) => {
    if (message.sessionId !== page.sessionId) return;
    const params = message.params ?? {};
    if (message.method === "Network.webSocketCreated") {
      sockets.set(params.requestId, params.url);
      if (String(params.url).includes("/api/ws")) seen.opened += 1;
      return;
    }
    if (message.method === "Network.webSocketClosed") {
      if (String(sockets.get(params.requestId)).includes("/api/ws"))
        seen.closed += 1;
      return;
    }
    if (message.method !== "Network.webSocketFrameReceived") return;
    if (!String(sockets.get(params.requestId)).includes("/api/ws")) return;
    let frame;
    try {
      frame = JSON.parse(params.response.payloadData);
    } catch {
      return;
    }
    if (frame.t !== 3 || frame.p?.e !== "message") return;
    const id = frame.p.m?.id;
    if (id === undefined) return;
    const data = frame.p.d?.json;
    const entry = { id: Number(id), type: data?.type, at: Date.now() };
    if (data?.type === "cursor") seen.cursors.push(entry);
    else seen.events.push(entry);
  });
  return seen;
}

/** outbox 里这块工作空间的全部序号：直接只读打开 core 的库（WAL，读不挡写）。 */
function outboxSeqs(stack, workspaceId) {
  const database = new DatabaseSync(join(stack.data, "canvas.db"), {
    readOnly: true,
  });
  try {
    return database
      .prepare("SELECT seq FROM events WHERE workspace_id = ? ORDER BY seq")
      .all(workspaceId)
      .map((row) => Number(row.seq));
  } finally {
    database.close();
  }
}

/** 这一页漏了哪些、重了哪些：期望是它第一次订上之后的全部序号。 */
function coverage(seen, truth) {
  const start = seen.cursors[0]?.id ?? Infinity;
  const expected = truth.filter((seq) => seq > start);
  const got = seen.events.map((entry) => entry.id);
  const have = new Set(got);
  const missing = expected.filter((seq) => !have.has(seq));
  const duplicates = got.length - have.size;
  return { start, expected: expected.length, missing, duplicates };
}

const report = { status: "failed", output, scenarios: [] };
let stack;
try {
  stack = await startStack({});
  report.chrome = stack.chrome;
  console.log(`core ${stack.origin}  页面 ${stack.web}`);
  const run = scenario(report, "控制面多路复用（§35）", output);

  const project = join(stack.scratch, "ws-mux-project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# ws-mux\n");
  const { workspace, board } = await stack.workspace("控制面", project);
  // 产生事件用的第二块板：每次整块保存一次就是一帧 `board.changed`（进 outbox）。
  const noise = await stack.api(`/api/workspaces/${workspace.id}/boards`, {
    method: "POST",
    body: JSON.stringify({ name: "噪声" }),
  });
  let published = 0;
  const publish = async (count) => {
    for (let index = 0; index < count; index += 1) {
      await stack.seedBoard(workspace.id, noise.id, []);
      published += 1;
    }
  };

  const devices = [];
  for (const name of ["a", "b"]) {
    const context = await stack.browser.context();
    const page = await stack.browser.page(context);
    // 杀 core 与断网时页面会报连不上：那是这个探针故意造的。
    page.allowed.push(
      /WebSocket|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError|net::|502|503|504|Runtime|连不上|核心/i,
    );
    await page.call("Network.enable", {});
    const seen = watchFrames(stack, page);
    await page.goto(stack.boardUrl(workspace.id, board.id));
    await page.settle();
    await page.evaluate(VISIBILITY_SWITCH);
    devices.push({ name, page, seen });
  }
  const [a, b] = devices;

  const truthNow = async () => outboxSeqs(stack, workspace.id);
  /** 等两台（或指定的几台）都收齐。 */
  const allCaughtUp = async (what, targets = devices, timeout = 20_000) => {
    const truth = await truthNow();
    await until(
      async () =>
        targets.every(
          (device) => coverage(device.seen, truth).missing.length === 0,
        ) || null,
      what,
      { timeout },
    );
    return truth;
  };

  /* ---------------------------- 1. 订上与扇出 ---------------------------- */
  await until(
    async () =>
      devices.every((device) => device.seen.cursors.length > 0) || null,
    "两台都订上（收到位置帧）",
    { timeout: 20_000 },
  );
  run.ok("两台都经 /api/ws 订上", {
    a: a.seen.cursors[0].id,
    b: b.seen.cursors[0].id,
  });
  await publish(5);
  await allCaughtUp("两台都收到 5 帧");
  run.ok("另一块板的保存两台都收到", { published });
  await run.shot(a.page, "ws-mux-1-a");

  /* ------------------------- 2. 杀 core，同端口重启 ------------------------ */
  await publish(3);
  await stack.killCore();
  const killedAt = Date.now();
  await sleep(3_000);
  await stack.startCore();
  // 页面还在退避里：这几帧只能靠续订补。
  await publish(4);
  await allCaughtUp("core 重启后两台都补齐", devices, 30_000);
  for (const device of devices) {
    const truth = await truthNow();
    const result = coverage(device.seen, truth);
    run.check(
      result.missing.length === 0 && result.duplicates === 0,
      `${device.name}：重启前后一帧不少、一帧不重`,
      { ...result, reconnects: device.seen.opened },
    );
  }
  run.ok("从杀掉到两台补齐", `${Date.now() - killedAt} ms（含 3 秒停机）`);

  /* ----------------------------- 3. 断网 30 秒 ---------------------------- */
  await b.page.call("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  const offlineAt = Date.now();
  const before = b.seen.events.length;
  for (let round = 0; round < 3; round += 1) {
    await sleep(OFFLINE_MS / 4);
    await publish(2);
  }
  await sleep(Math.max(0, OFFLINE_MS - (Date.now() - offlineAt)));
  const duringOffline = b.seen.events.length - before;
  await b.page.call("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  const onlineAt = Date.now();
  await publish(2);
  await allCaughtUp("断网恢复后 b 补齐", [b], 20_000);
  run.ok("断网恢复到补齐", {
    ms: Date.now() - onlineAt,
    framesDuringOffline: duringOffline,
  });
  await allCaughtUp("a 照常收齐", [a], 5_000);
  for (const device of devices) {
    const result = coverage(device.seen, await truthNow());
    run.check(
      result.missing.length === 0 && result.duplicates === 0,
      `${device.name}：断网前后一帧不少、一帧不重`,
      result,
    );
  }

  /* --------------------------- 4. 后台回到前台 --------------------------- */
  await setHidden(a.page, true);
  await stack.killCore();
  await sleep(8_000);
  await stack.startCore();
  await publish(3);
  await sleep(1_000);
  const truth = await truthNow();
  const hiddenMissing = coverage(a.seen, truth).missing.length;
  const visibleAt = Date.now();
  await setHidden(a.page, false);
  await until(
    async () => coverage(a.seen, truth).missing.length === 0 || null,
    "a 回到前台后收齐",
    { timeout: 15_000 },
  );
  const recovered = Date.now() - visibleAt;
  run.check(recovered <= FOREGROUND_BUDGET_MS, "回到前台 3 秒内恢复", {
    ms: recovered,
    missingWhileHidden: hiddenMissing,
  });
  await allCaughtUp("b 也收齐", [b], 30_000);
  for (const device of devices) {
    const result = coverage(device.seen, await truthNow());
    run.check(
      result.missing.length === 0 && result.duplicates === 0,
      `${device.name}：全程一帧不少、一帧不重`,
      { ...result, connections: device.seen.opened },
    );
  }
  await run.shot(a.page, "ws-mux-4-a");
  await run.shot(b.page, "ws-mux-4-b");

  run.consoleClean(a.page, b.page);
  report.published = published;
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
  if (stack) console.error(stack.coreLog().slice(-3000));
} finally {
  await stack?.stop();
  writeResult(output, report);
  console.log(`\n报告 ${join(output, "result.json")}：${report.status}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
