#!/usr/bin/env node
// 终端内存探针（性能设计 §2.7）：桌面壳里 N 个持续输出的终端节点，量
// 「活跃 → 平移离屏 → 长时间离屏 → 回到视口 → 反复切换 → 强制 GC」各阶段的
// 主进程 / Runtime(core) / Renderer / GPU 物理占用、Renderer 的 DOM 计数 / JS 堆 /
// 各终端 data-render 与 data-lifecycle、tmux 进程树的 RSS 与进程数，以及 Runtime 的
// 事件循环延迟与采样轮次（`GET /api/diagnostics/runtime`，契约 §54；core 还没有这个
// 接口时这几项记 null）。
//
// 内存口径：macOS 是 `top` 的 MEM 列（phys_footprint），GPU 另记 `vmmap` 的 IOSurface
// （`--vmmap`）；Linux 是 `/proc/<pid>/smaps_rollup` 的 Pss 与 VmRSS，软件 GL 的 GPU
// 列只记录不比。
//
// 起法：缺省用 `pnpm --filter @armadra/desktop dist` 的产物（macOS
// apps/desktop/release/mac*/Armadra.app，Linux linux-unpacked 或 AppImage，DISPLAY 由调用
// 方给，CI 用 xvfb-run），`--remote-debugging-port` 接 CDP；`--app` 指定别的产物；
// `--unpacked` 用 apps/desktop/node_modules 里的 electron 起 apps/desktop/out（先
// `pnpm --filter @armadra/desktop build`），只有这种起法能加 `--eld-preload`
// （NODE_OPTIONS 注入 terminal-memory-eld.cjs，量同步子进程每秒阻塞多少毫秒，做对照）。
//
// 隔离：临时 HOME（probe-home.mjs）、ARMADRA_DATA_DIR、--user-data-dir、
// ARMADRA_NO_GLOBAL_WRITES=1、ARMADRA_SECRET_BACKEND=file、mock 钥匙串；只按 PID
// 结束自己起的进程，tmux 只对自己数据目录里的 socket 发 kill-server。
//
// 用法：
//   node tools/probes/terminal-memory.mjs [输出目录] [--terminals 10] [--rate 100]
//        [--renderer dom|webgl] [--backend tmux|direct] [--off1 60] [--off2 180]
//        [--cycles 10] [--warm 60] [--cadence-check] [--pressure] [--restore-check
//        [--restore-wait 60] [--release-after 5m]] [--app 产物 | --unpacked [--eld-preload]]
//        [--vmmap] [--baseline 文件 | --no-baseline]
//   node tools/probes/terminal-memory.mjs --merge r1.json r2.json r3.json [--machine 说明]
//        把三次的 result.json 取中位数写进基线文件（缺省 tools/probes/terminal-memory-baseline.json）
//
// 产物：<输出目录>/result.json、table.md、app.log；`--eld-preload` 时还有 eld.jsonl。
// 与基线里这台平台、同一场景的那份比：差 20% 以上且超过该项绝对容差即失败（各项规则见
// terminal-memory-lib.mjs 的 METRICS）；没有对应基线时只报告。
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isolatedEnv, probeHome } from "./probe-home.mjs";
import { probeSession } from "./probe-session.mjs";
import {
  METRICS,
  baselineKey,
  compare,
  deriveMetrics,
  descendants,
  functionalFailures,
  mergeRestore,
  mergeRuns,
  parseArgs,
  parseProcStatTicks,
  parsePsTable,
  parseSmapsRollup,
  parseStatusRss,
  parseTop,
  parseVmmapSummary,
  per65s,
  renderTable,
  restoreCheck,
  roleOf,
  round1,
  sameScenario,
  summarizeDiagnostics,
  summarizePreload,
  sumByRole,
} from "./terminal-memory-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const linux = process.platform === "linux";
const darwin = process.platform === "darwin";

/** 阶段名里的时长：整分钟写 `3m`，否则写秒。 */
const duration = (seconds) =>
  seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (...message) =>
  console.log(new Date().toISOString().slice(11, 19), ...message);

/* --------------------------------- CDP ---------------------------------- */

function cdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Set();
  let id = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) {
      for (const listener of listeners) listener(message);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.fail(new Error(JSON.stringify(message.error)));
    else waiter.done(message.result);
  });
  // 页面或桌面壳没了：还在等的调用一律失败，别让探针挂在那里。
  socket.addEventListener("close", () => {
    for (const waiter of pending.values())
      waiter.fail(new Error("CDP 连接断了"));
    pending.clear();
  });
  return {
    ready: new Promise((done, fail) => {
      socket.addEventListener("open", done, { once: true });
      socket.addEventListener("error", fail, { once: true });
    }),
    on: (listener) => listeners.add(listener),
    off: (listener) => listeners.delete(listener),
    send(method, params = {}) {
      id += 1;
      const mine = id;
      return new Promise((done, fail) => {
        pending.set(mine, { done, fail });
        socket.send(JSON.stringify({ id: mine, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

async function rendererTarget(port, child) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`桌面壳提前退出了（${child.exitCode}）`);
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          target.webSocketDebuggerUrl &&
          /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(target.url ?? ""),
      );
      if (page) return page;
    } catch {
      // 还在起。
    }
    await sleep(500);
  }
  throw new Error("调试端口上没有回环页面");
}

/* ------------------------------ 起哪个产物 ------------------------------ */

/** 运行时挑的空闲端口：固定端口在开发机上可能被别的 Electron 占着。 */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** 这台平台上 dist 留下的产物。 */
function packagedApp() {
  if (darwin)
    return ["mac-arm64", "mac"]
      .map((name) => join(root, "apps/desktop/release", name, "Armadra.app"))
      .find((path) => existsSync(path));
  const release = join(root, "apps/desktop/release");
  if (!existsSync(release)) return undefined;
  const unpacked = ["linux-unpacked", "linux-arm64-unpacked"]
    .map((name) => join(release, name))
    .find((path) => existsSync(join(path, "armadra")));
  if (unpacked) return unpacked;
  const image = readdirSync(release)
    .filter((name) => name.endsWith(".AppImage"))
    .sort()
    .at(-1);
  return image ? join(release, image) : undefined;
}

function launchTarget(options) {
  if (options.unpacked) {
    const appDir = join(root, "apps/desktop");
    if (!existsSync(join(appDir, "out/core/main.js")))
      throw new Error("--unpacked 要先 pnpm --filter @armadra/desktop build");
    const electron = createRequire(join(appDir, "package.json"))("electron");
    // 开发构建缺省去连已经在跑的 Runtime；探针要它自己起一个、只用临时数据目录。
    return {
      kind: "unpacked",
      binary: electron,
      args: [appDir],
      env: { ARMADRA_DESKTOP_OWNS_RUNTIME: "1" },
    };
  }
  const app = options.app ? resolve(options.app) : packagedApp();
  if (!app || !existsSync(app))
    throw new Error(
      "没有打包产物：先 pnpm --filter @armadra/desktop dist，或 --app 指定，或 --unpacked",
    );
  if (darwin)
    return {
      kind: "packaged",
      app,
      binary: join(app, "Contents/MacOS/Armadra"),
      args: [],
      env: {},
    };
  if (app.endsWith(".AppImage"))
    return {
      kind: "packaged",
      app,
      binary: app,
      args: [],
      env: { APPIMAGE_EXTRACT_AND_RUN: "1" },
    };
  return {
    kind: "packaged",
    app,
    binary: join(app, "armadra"),
    args: [],
    env: {},
  };
}

/* ------------------------------ 进程与内存 ------------------------------ */

function psTable() {
  return parsePsTable(
    execFileSync("ps", ["-Ao", "pid=,ppid=,rss=,command="], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
    }),
  );
}

/** 每个进程的物理占用（MiB）与 CPU%：macOS 用 top，Linux 读 /proc。 */
async function readings(pids) {
  if (pids.length === 0) return {};
  if (darwin) {
    const argv = ["-l", "2", "-s", "1", "-stats", "pid,mem,cmprs,cpu"];
    for (const pid of pids) argv.push("-pid", String(pid));
    return parseTop(execFileSync("top", argv, { encoding: "utf8" }));
  }
  const read = (pid, file) => {
    try {
      return readFileSync(`/proc/${pid}/${file}`, "utf8");
    } catch {
      return null;
    }
  };
  const before = Object.fromEntries(
    pids.map((pid) => [pid, parseProcStatTicks(read(pid, "stat"))]),
  );
  const started = Date.now();
  await sleep(1000);
  const seconds = (Date.now() - started) / 1000;
  const ticksPerSecond = 100;
  const result = {};
  for (const pid of pids) {
    const pss = parseSmapsRollup(read(pid, "smaps_rollup"));
    const rss = parseStatusRss(read(pid, "status"));
    const ticks = parseProcStatTicks(read(pid, "stat"));
    if (pss === null && rss === null) continue;
    result[pid] = {
      mem: pss ?? rss,
      rss,
      cpu:
        ticks !== null && before[pid] !== null
          ? round1(((ticks - before[pid]) / ticksPerSecond / seconds) * 100)
          : null,
    };
  }
  return result;
}

function vmmap(pid) {
  let text;
  try {
    text = execFileSync("vmmap", ["-summary", String(pid)], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    text = error.stdout ?? "";
  }
  return parseVmmapSummary(text);
}

/* ------------------------------- 页面脚本 -------------------------------- */

const PAGE_STATE = `
  const bodies = [...document.querySelectorAll('[data-slot="terminal-body"]')];
  const histogram = (name) => {
    const counts = {};
    for (const body of bodies) {
      const value = body.dataset[name] ?? "none";
      counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
  };
  return {
    hidden: document.hidden,
    render: histogram("render"),
    lifecycle: histogram("lifecycle"),
    domElements: document.getElementsByTagName("*").length,
    xtermRowElements: [...document.querySelectorAll(".xterm-rows")].reduce((sum, rows) => sum + rows.childElementCount, 0),
    canvases: document.querySelectorAll(".xterm canvas").length,
    visibleNodes: [...document.querySelectorAll(".react-flow__node")].filter((node) => {
      const box = node.getBoundingClientRect();
      return box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight;
    }).length,
  };
`;

/** 每个终端的可见行文字、行数与光标位置（DOM 渲染器才读得到）。 */
const PAGE_SCREENS = `
  return [...document.querySelectorAll('[data-slot="terminal-body"]')].map((body) => {
    const rows = body.querySelector(".xterm-rows");
    if (!rows) return { nodeId: body.closest(".react-flow__node")?.dataset.id ?? null, rows: 0, lines: [], cursor: null };
    const children = [...rows.children];
    let cursor = null;
    const mark = rows.querySelector(".xterm-cursor");
    if (mark) {
      const row = children.findIndex((child) => child.contains(mark));
      const range = document.createRange();
      range.setStart(children[row], 0);
      range.setEndBefore(mark);
      cursor = { x: range.toString().length, y: row };
    }
    return {
      nodeId: body.closest(".react-flow__node")?.dataset.id ?? null,
      rows: children.length,
      lines: children.map((child) => child.textContent.replace(/\\u00a0/g, " ")),
      cursor,
    };
  });
`;

const anyVisible = `
  const pane = document.querySelector(".react-flow__pane");
  const r = pane.getBoundingClientRect();
  const anyVisible = () => [...document.querySelectorAll(".react-flow__node")].some((n) => {
    const b = n.getBoundingClientRect();
    return b.right > r.left && b.bottom > r.top && b.left < r.right && b.top < r.bottom;
  });
  const wheel = (deltaY) => pane.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: 0, bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
  const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
`;

/* --------------------------------- 主流程 --------------------------------- */

async function run(options) {
  const output = resolve(
    options.output ?? join(root, "target/terminal-memory"),
  );
  mkdirSync(output, { recursive: true });
  const cleanups = [];
  // e2e.mjs 超时会给整个进程组发 SIGTERM；tmux 服务器是 daemon 不在组里，先收拾干净再退。
  let stopping = false;
  const onSignal = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.error(`收到 ${signal}，清理后退出`);
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {}
    }
    process.exit(1);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const report = {
    status: "running",
    platform: `${process.platform}-${process.arch}`,
    startedAt: new Date().toISOString(),
    options: {
      terminals: options.terminals,
      rate: options.rate,
      renderer: options.renderer,
      backend: options.backend,
      off1: options.off1,
      off2: options.off2,
      cycles: options.cycles,
      warm: options.warm,
      cadenceCheck: options.cadenceCheck,
      pressure: options.pressure,
      restoreCheck: options.restoreCheck,
      eldPreload: options.eldPreload,
      releaseAfter: options.releaseAfter ?? null,
    },
    phases: [],
    notes: [],
  };
  const save = () =>
    writeFileSync(
      join(output, "result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );

  try {
    await scenario(options, output, report, cleanups, save);
    report.metrics = deriveMetrics(report);
    const failures = functionalFailures(report);
    let rows = [];
    if (options.baseline) {
      const file = resolve(root, options.baseline);
      const baselines = existsSync(file)
        ? JSON.parse(readFileSync(file, "utf8"))
        : { platforms: {} };
      const key = baselineKey({
        platform: process.platform,
        arch: process.arch,
        renderer: options.renderer,
        backend: options.backend,
      });
      const mine = baselines.platforms?.[key];
      if (!mine) report.notes.push(`基线里没有 ${key}，只报告不判`);
      else if (!sameScenario(report.options, mine.options))
        report.notes.push(
          `基线 ${key} 的场景是 ${JSON.stringify(mine.options)}，与这次不同，只报告不判`,
        );
      else {
        rows = compare(report.metrics, mine.metrics, {
          platform: process.platform,
        });
        report.comparison = { key, rows };
        for (const row of rows.filter((row) => row.regressed))
          failures.push(
            `${row.metric} 退化：基线 ${row.baseline}，这次 ${row.current}（差 ${row.change}%）`,
          );
      }
    }
    report.failures = failures;
    report.status = failures.length === 0 ? "ok" : "failed";
    const table = renderTable(report.metrics, rows);
    writeFileSync(join(output, "table.md"), `${table}\n`);
    console.log(`\n${table}\n`);
    for (const failure of failures) console.error(`失败：${failure}`);
    for (const note of report.notes) console.log(`注：${note}`);
  } catch (error) {
    report.status = "failed";
    report.error = String(error?.stack ?? error);
    console.error(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
    if (!stopping)
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch {}
      }
  }
  return report.status === "ok" ? 0 : 1;
}

async function scenario(options, output, report, cleanups, save) {
  const target = launchTarget(options);
  report.launch = { kind: target.kind, app: target.app ?? null };
  log("产物", target.kind, target.app ?? target.binary);

  // 短前缀：数据目录里的 runtime.sock / tmux.sock 走 Unix socket，路径上限约 104 字节，
  // macOS 的 TMPDIR 本身就有 40 多个字符。
  const scratch = mkdtempSync(join(tmpdir(), "atm-"));
  cleanups.push(() =>
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10 }),
  );
  const data = join(scratch, "data");
  const profile = join(scratch, "electron");
  const project = join(scratch, "project");
  for (const dir of [data, profile, project])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "README.md"), "# terminal-memory\n");
  writeFileSync(
    join(data, "worker-settings.json"),
    `${JSON.stringify({ terminal: { backend: options.backend } }, null, 2)}\n`,
  );
  const socket = join(data, "tmux.sock");
  const home = probeHome("atm-home-");
  cleanups.push(home.remove);

  // 持续输出：每个终端一个 perl 进程，rate 行/秒，彩色前缀 + 约 100 列文本。
  // core 给终端的环境走白名单，自定义变量进不去；临时 HOME 只给探针用，shell 一起就开始输出。
  const emitter = join(home.path, "emit.pl");
  writeFileSync(
    emitter,
    `$|=1; my $i=0; my $rate=${options.rate}; my $batch=$rate/10; $batch=1 if $batch<1;\n` +
      `while(1){ for (1..$batch){ printf "\\e[3%dm%07d\\e[0m %s \\e[1mstatus\\e[0m ok\\n", ($i%7)+1, $i, "lorem ipsum dolor sit amet " x 3; $i++ } select(undef,undef,undef,0.1) }\n`,
  );
  const start = options.rate > 0 ? `perl ${emitter}\n` : "";
  writeFileSync(join(home.path, ".zshrc"), `PS1='perf%# '\n${start}`);
  writeFileSync(join(home.path, ".zshenv"), "");
  writeFileSync(join(home.path, ".bashrc"), `PS1='perf$ '\n${start}`);
  writeFileSync(join(home.path, ".bash_profile"), ". ~/.bashrc\n");
  const shell = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";

  const eldFile = join(output, "eld.jsonl");
  rmSync(eldFile, { force: true });
  const port = await freePort();
  const env = isolatedEnv(home, {
    ARMADRA_DATA_DIR: data,
    ARMADRA_NO_GLOBAL_WRITES: "1",
    ARMADRA_SECRET_BACKEND: "file",
    ARMADRA_ACP_WARMUP: "0",
    ARMADRA_LOG: "warn",
    SHELL: shell,
    ...target.env,
    ...(options.eldPreload
      ? {
          BENCH_ELD_FILE: eldFile,
          NODE_OPTIONS: `--require ${join(here, "terminal-memory-eld.cjs")}`,
        }
      : {}),
  });
  // 桌面壳的页面带票据换 Bearer；探针自己的 HTTP 调用走 probeSession 配对。
  delete env.ARMADRA_LOOPBACK_OWNER;
  delete env.ELECTRON_RUN_AS_NODE;
  const appLog = createWriteStream(join(output, "app.log"));
  const child = spawn(
    target.binary,
    [
      ...target.args,
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      linux ? "--password-store=basic" : "--use-mock-keychain",
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      // 被别的窗口完全挡住时 Chromium 会把页面当成 hidden，探针不能受操作员桌面影响。
      "--disable-backgrounding-occluded-windows",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(appLog);
  child.stderr.pipe(appLog);
  report.mainPid = child.pid;
  cleanups.push(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      for (let i = 0; i < 40 && child.exitCode === null; i += 1)
        await sleep(250);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (existsSync(socket))
      try {
        execFileSync("tmux", ["-S", socket, "kill-server"], {
          stdio: "ignore",
        });
      } catch {}
    // 被结束的 shell 会异步写回历史文件，等它写完再删临时 HOME。
    await sleep(2000);
  });
  log("桌面壳", child.pid, "调试端口", port);

  /* ---------------------------- core 与会话 ----------------------------- */

  let origin = "";
  for (let i = 0; i < 600 && !origin; i += 1) {
    if (child.exitCode !== null)
      throw new Error(`桌面壳退出了（${child.exitCode}）`);
    try {
      origin = JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
        .runtime.http;
    } catch {
      await sleep(200);
    }
  }
  if (!origin) throw new Error("endpoints.json 没出现");
  const session = await probeSession({ dataDir: data, base: origin });
  const api = async (path, init = {}) => {
    const answer = await session.fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text}`,
      );
    return text ? JSON.parse(text) : null;
  };

  // Runtime 诊断（§54）：每 10 s 读一次，接口不在（404）就停。
  const diagnostics = [];
  let diagnosticsMissing = false;
  const readDiagnostics = async () => {
    if (diagnosticsMissing) return null;
    try {
      const answer = await session.fetch("/api/diagnostics/runtime");
      if (answer.status === 404) {
        diagnosticsMissing = true;
        report.notes.push(
          "core 没有 GET /api/diagnostics/runtime（契约 §54），Runtime 事件循环与采样轮次记 null",
        );
        return null;
      }
      if (!answer.ok) return null;
      const body = await answer.json();
      const sample = { ...body, at: Date.now() };
      diagnostics.push(sample);
      return sample;
    } catch {
      return null;
    }
  };
  const poller = setInterval(readDiagnostics, 10_000);
  cleanups.push(() => clearInterval(poller));

  const workspace = await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name: "terminal-memory",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    }),
  });
  const boards = await api(`/api/workspaces/${workspace.id}/boards`);
  const board =
    boards[0] ??
    (await api(`/api/workspaces/${workspace.id}/boards`, {
      method: "POST",
      body: JSON.stringify({ name: "terminal-memory" }),
    }));

  const pageTarget = await rendererTarget(port, child);
  const page = cdp(pageTarget.webSocketDebuggerUrl);
  await page.ready;
  cleanups.push(() => page.close());
  await page.send("Runtime.enable");
  const evaluate = async (expression) => {
    const answer = await page.send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer.exceptionDetails)
      throw new Error(
        answer.exceptionDetails.exception?.description ??
          answer.exceptionDetails.text,
      );
    return answer.result.value;
  };
  const pageOrigin = new URL(pageTarget.url).origin;

  // 渲染器：新键（P4 起）与旧布尔键都写，哪一版都认得。
  await evaluate(`
    localStorage.setItem("armadra.terminal.renderer", ${JSON.stringify(options.renderer)});
    ${options.renderer === "webgl" ? `localStorage.setItem("armadra.terminal.webgl", "true");` : `localStorage.removeItem("armadra.terminal.webgl");`}
    ${options.releaseAfter ? `localStorage.setItem("armadra.terminal.releaseAfter", ${JSON.stringify(options.releaseAfter)});` : ""}
    return true;
  `);

  // 按窗口实际大小排布，让全部终端一开始都在视口里。
  const viewport = await evaluate(
    `return { width: innerWidth, height: innerHeight };`,
  );
  const docPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
  const stamp = new Date().toISOString();
  const W = 560;
  const H = 340;
  const GAP = 40;
  const cols = Math.max(1, Math.ceil(Math.sqrt(options.terminals * 1.6)));
  const rows = Math.max(1, Math.ceil(options.terminals / cols));
  const nodes = Array.from({ length: options.terminals }, (_, i) => ({
    id: randomUUID(),
    boardId: board.id,
    type: "terminal",
    title: `t${i + 1}`,
    color: "#0a84ff",
    position: {
      x: (i % cols) * (W + GAP),
      y: Math.floor(i / cols) * (H + GAP),
    },
    size: { width: W, height: H },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: stamp,
    updatedAt: stamp,
  }));
  const fit = (width, height) =>
    Math.min(
      1,
      Math.max(0.1, (width - 40) / (cols * (W + GAP))),
      Math.max(0.1, (height - 40) / (rows * (H + GAP))),
    );
  const writeDocument = async (zoom, nodesToWrite) => {
    const current = await api(docPath);
    await api(docPath, {
      method: "PUT",
      body: JSON.stringify({
        expectedUpdatedAt: current.board.updatedAt,
        nodes: nodesToWrite ?? current.nodes,
        edges: [],
        viewport: { x: 20, y: 20, zoom },
        whiteboard: "",
      }),
    });
  };
  const mount = async () => {
    let mounted = 0;
    for (let i = 0; i < 240 && mounted < options.terminals; i += 1) {
      mounted = await evaluate(
        `return document.querySelectorAll('[data-slot="terminal-body"] .xterm').length;`,
      ).catch(() => 0);
      if (mounted < options.terminals) await sleep(500);
    }
    if (mounted < options.terminals)
      throw new Error(`只挂上了 ${mounted} / ${options.terminals} 个终端`);
    return mounted;
  };
  // 画布的实际大小随侧栏与面板变：先打开一块空板量 `.react-flow__pane`，再写要测的那块板
  // （页面打开的板由它持有编辑租约，写不进去，所以量的是另一块）。
  await page.send("Page.enable");
  const measureBoard = await api(`/api/workspaces/${workspace.id}/boards`, {
    method: "POST",
    body: JSON.stringify({ name: "measure" }),
  });
  await page.send("Page.navigate", {
    url: `${pageOrigin}/?workspace=${workspace.id}&board=${measureBoard.id}`,
  });
  let pane = null;
  for (let i = 0; i < 60 && !pane; i += 1) {
    await sleep(500);
    pane = await evaluate(`
      const box = document.querySelector(".react-flow__pane")?.getBoundingClientRect();
      return box && box.width > 0 ? { width: Math.round(box.width), height: Math.round(box.height) } : null;
    `).catch(() => null);
  }
  const zoom = pane
    ? fit(pane.width, pane.height)
    : fit(viewport.width - 300, viewport.height - 120);
  await writeDocument(zoom, nodes);
  await page.send("Page.navigate", {
    url: `${pageOrigin}/?workspace=${workspace.id}&board=${board.id}`,
  });
  await sleep(3000);
  await mount();
  report.layout = {
    window: viewport,
    pane,
    cols,
    rows,
    zoom: Math.round(zoom * 1000) / 1000,
    nodeSize: [W, H],
  };
  log("终端已挂载", options.terminals, "缩放", report.layout.zoom);

  /* ------------------------------ 读数 ------------------------------ */

  const processes = () => {
    const table = psTable();
    const mine = [
      table.find((row) => row.pid === child.pid),
      ...descendants(table, child.pid),
    ].filter(Boolean);
    const roles = {};
    for (const row of mine)
      (roles[roleOf(row, child.pid)] ??= []).push(row.pid);
    // tmux 服务器是 daemon（父进程 1），按 socket 路径找。
    const servers = table.filter((row) => row.command.includes(socket));
    const tree = servers.flatMap((row) => [
      row,
      ...descendants(table, row.pid),
    ]);
    const unique = [...new Map(tree.map((row) => [row.pid, row])).values()];
    return {
      roles,
      table,
      tmuxRssMb: round1(unique.reduce((sum, row) => sum + row.rssKb, 0) / 1024),
      tmuxProcs: unique.length,
    };
  };

  let eldCursor = 0;
  const preloadSince = () => {
    if (!options.eldPreload) return null;
    let lines = [];
    try {
      lines = readFileSync(eldFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {}
    const fresh = lines.slice(eldCursor);
    eldCursor = lines.length;
    return summarizePreload(fresh);
  };
  let diagnosticsCursor = 0;
  const diagnosticsSince = () => {
    const fresh = diagnostics.slice(Math.max(0, diagnosticsCursor - 1));
    diagnosticsCursor = diagnostics.length;
    return summarizeDiagnostics(fresh);
  };

  async function snap(label, stage) {
    await readDiagnostics();
    const { roles, tmuxRssMb, tmuxProcs } = processes();
    const pidsByRole = Object.fromEntries(
      Object.entries(roles).filter(([role]) => role !== "tmux"),
    );
    const values = await readings(Object.values(pidsByRole).flat());
    const byRole = sumByRole(pidsByRole, values);
    const appTotal = Object.values(byRole).reduce(
      (sum, value) => sum + value.mem,
      0,
    );
    const heap = await page.send("Runtime.getHeapUsage").catch(() => null);
    const dom = await page.send("Memory.getDOMCounters").catch(() => null);
    const entry = {
      label,
      stage,
      at: new Date().toISOString(),
      byRole,
      appTotalMb: Math.round(appTotal),
      appNoGpuMb: Math.round(appTotal - (byRole.gpu?.mem ?? 0)),
      tmuxRssMb,
      tmuxProcs,
      rendererVmmap:
        darwin && options.vmmap && roles.renderer?.[0]
          ? vmmap(roles.renderer[0])
          : undefined,
      gpuVmmap:
        darwin && options.vmmap && roles.gpu?.[0]
          ? vmmap(roles.gpu[0])
          : undefined,
      jsHeapUsedMb: heap ? Math.round(heap.usedSize / 1048576) : null,
      jsHeapTotalMb: heap ? Math.round(heap.totalSize / 1048576) : null,
      domCounters: dom,
      page: await evaluate(PAGE_STATE).catch((error) => ({
        error: String(error),
      })),
      runtime: diagnosticsSince(),
      preload: preloadSince(),
    };
    report.phases.push(entry);
    log(
      label,
      `app=${entry.appTotalMb}`,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(byRole).map(([key, value]) => [key, value.mem]),
        ),
      ),
      `tmux=${tmuxRssMb}MiB/${tmuxProcs}`,
      `heap=${entry.jsHeapUsedMb}`,
      `render=${JSON.stringify(entry.page?.render)}`,
      `lifecycle=${JSON.stringify(entry.page?.lifecycle)}`,
      `eldMax=${entry.runtime?.eldMaxMs ?? entry.preload?.eldMaxMs ?? "—"}`,
    );
    save();
    return entry;
  }

  // 平移：在空白画布上发合成 wheel（panOnScroll），直到没有节点在视口里；回来时反向同样的步数。
  const panAway = () =>
    evaluate(`
      ${anyVisible}
      let steps = 0;
      while (anyVisible() && steps < 400) { wheel(400); steps += 1; await frame(); }
      // 再多走一段，保证在 IntersectionObserver 的边距之外。
      for (let i = 0; i < 6; i += 1) { wheel(400); steps += 1; await frame(); }
      return steps;
    `);
  const panBack = (steps) =>
    evaluate(`
      ${anyVisible}
      for (let i = 0; i < ${steps}; i += 1) { wheel(-400); await frame(); }
      return true;
    `);

  /* ------------------------------ 阶段 ------------------------------ */

  await sleep(options.warm * 1000);
  // 丢掉启动阶段的读数。
  await readDiagnostics();
  diagnosticsCursor = diagnostics.length;
  preloadSince();
  const runStart = diagnostics.length;
  const preloadAll = [];
  const keepPreload = (entry) =>
    entry.preload && preloadAll.push(entry.preload);
  await sleep(15_000);
  const active = await snap("active", "active");
  keepPreload(active);
  if (
    (active.page.render?.visible ?? 0) + (active.page.render?.focused ?? 0) ===
    0
  )
    report.notes.push("active 阶段没有 visible 终端，检查 data-render");

  if (options.cadenceCheck) {
    // 新建节点 vs 重载后：离屏 60 s 期间采样了几轮（徽标首帧挂不上观察器的那个缺陷）。
    // 有诊断接口时取轮次差，没有时取垫片里这段的 ps 次数。
    const window60 = async (label, stage) => {
      const away = await panAway();
      const a = await readDiagnostics();
      preloadSince();
      await sleep(60_000);
      const b = await readDiagnostics();
      const entry = await snap(label, stage);
      keepPreload(entry);
      await panBack(away);
      return a && b
        ? b.sampling.rounds - a.sampling.rounds
        : (entry.preload?.psCount ?? null);
    };
    const fresh = await window60("fresh-nodes-offscreen-60s", "cadence-fresh");
    // 视口按 2 s 节流存盘（save/autosave.ts）；等它存下平移回来的位置再重载，
    // 否则重载后停在离屏处。
    await sleep(5000);
    await page.send("Page.reload");
    await sleep(30_000);
    const reloaded0 = await snap("reloaded-visible", "cadence-reloaded");
    if ((reloaded0.page.visibleNodes ?? 0) < options.terminals)
      throw new Error(
        `重载后只有 ${reloaded0.page.visibleNodes} / ${options.terminals} 个节点在视口里`,
      );
    const reloaded = await window60(
      "reloaded-offscreen-60s",
      "cadence-reloaded-offscreen",
    );
    await sleep(15_000);
    report.cadenceCheck = {
      source: diagnosticsMissing ? "eld-preload" : "diagnostics",
      freshPer60s: fresh,
      reloadedPer60s: reloaded,
    };
  }

  const steps = await panAway();
  report.panSteps = steps;
  await sleep(options.off1 * 1000);
  keepPreload(
    await snap(`offscreen-${duration(options.off1)}`, "offscreen-short"),
  );
  // 全部离屏时的采样节奏：在长离屏段里量 65 s 的采样轮次（没有诊断接口时退回垫片里的 ps 次数）。
  const longRemaining = Math.max(0, options.off2 - options.off1) * 1000;
  let cadenceWindow = 0;
  if (longRemaining >= 75_000) {
    await sleep(5000);
    const first = await readDiagnostics();
    preloadSince();
    const started = Date.now();
    await sleep(65_000);
    const last = await readDiagnostics();
    const elapsed = Date.now() - started;
    const preload = preloadSince();
    if (preload) preloadAll.push(preload);
    const rounds =
      first && last ? last.sampling.rounds - first.sampling.rounds : null;
    report.cadence = {
      windowMs: elapsed,
      source: rounds !== null ? "diagnostics" : preload ? "eld-preload" : null,
      psPer65s: per65s(rounds ?? preload?.psCount ?? null, elapsed),
    };
    cadenceWindow = 5000 + elapsed;
  } else report.notes.push("--off2 − --off1 不到 75 s，没有量离屏采样节奏");
  await sleep(Math.max(0, longRemaining - cadenceWindow));
  keepPreload(
    await snap(`offscreen-${duration(options.off2)}`, "offscreen-long"),
  );

  if (options.pressure) {
    const before = await evaluate(PAGE_STATE);
    const injected = await evaluate(`
      const handle = window.__armadraMemoryPressure;
      if (!handle) return false;
      handle.emit("warning");
      return true;
    `);
    await sleep(5000);
    const after = await evaluate(PAGE_STATE);
    report.pressure = {
      injected,
      renderBefore: before.render,
      renderAfter: after.render,
      lifecycleBefore: before.lifecycle,
      lifecycleAfter: after.lifecycle,
      renderUnchanged:
        JSON.stringify(before.render) === JSON.stringify(after.render),
    };
    if (!injected)
      report.notes.push(
        "页面没有 window.__armadraMemoryPressure，--pressure 只记录",
      );
    keepPreload(await snap("after-pressure", "pressure"));
  }

  await panBack(steps);
  await sleep(15_000);
  const back = await snap("back-visible", "back-visible");
  keepPreload(back);
  if ((back.page.visibleNodes ?? 0) < options.terminals)
    report.notes.push(
      `回到视口后只有 ${back.page.visibleNodes} / ${options.terminals} 个节点可见`,
    );

  for (const round of [1, 2]) {
    for (let cycle = 0; cycle < options.cycles; cycle += 1) {
      const away = await panAway();
      await sleep(3000);
      await panBack(away);
      await sleep(3000);
    }
    await sleep(15_000);
    keepPreload(await snap(`switch-x${options.cycles * round}`, "switch"));
  }

  // 强制一次 GC 后再量：区分「可回收但没回收」与「真被持有」。
  await page.send("HeapProfiler.enable");
  await page.send("HeapProfiler.collectGarbage");
  await sleep(5000);
  keepPreload(await snap("after-forced-gc", "after-gc"));

  // 全程（预热之后）的 Runtime 读数。
  const whole = summarizeDiagnostics(diagnostics.slice(runStart));
  const preloadWhole = preloadAll.length
    ? {
        eldMaxMs: Math.max(...preloadAll.map((item) => item.eldMaxMs)),
        eldP99MedianMs: preloadAll
          .map((item) => item.eldP99MedianMs)
          .sort((x, y) => x - y)[Math.floor(preloadAll.length / 2)],
        syncBlockedMsPerSec: round1(
          preloadAll.reduce(
            (sum, item) => sum + item.syncBlockedMsPerSec * item.seconds,
            0,
          ) / preloadAll.reduce((sum, item) => sum + item.seconds, 0),
        ),
      }
    : null;
  report.runtime = {
    source: whole ? "diagnostics" : preloadWhole ? "eld-preload" : null,
    eldMaxMs: whole?.eldMaxMs ?? preloadWhole?.eldMaxMs ?? null,
    eldP99MedianMs:
      whole?.eldP99MedianMs ?? preloadWhole?.eldP99MedianMs ?? null,
    syncBlockedMsPerSec: preloadWhole?.syncBlockedMsPerSec ?? null,
    diagnostics: whole,
    preload: preloadWhole,
  };

  if (options.restoreCheck)
    report.restore = await restoreStage().catch((error) => ({
      terminals: 0,
      gridMatches: false,
      screenMatches: false,
      problems: [String(error?.message ?? error).split("\n")[0]],
    }));
  save();

  /* --------------------------- 释放后恢复 --------------------------- */

  async function restoreStage() {
    if (options.renderer !== "dom")
      return {
        gridMatches: false,
        screenMatches: false,
        problems: ["--restore-check 只认 DOM 渲染器"],
        terminals: 0,
      };
    // 先停掉输出：结束自己的发射器进程（按 PID），让画面静下来。
    const { table } = processes();
    const emitters = table.filter((row) => row.command.includes(emitter));
    for (const row of emitters)
      try {
        process.kill(row.pid, "SIGTERM");
      } catch {}
    await sleep(1000);
    const tmuxPanes = () => {
      if (options.backend !== "tmux") return [];
      const text = execFileSync(
        "tmux",
        [
          "-S",
          socket,
          "list-panes",
          "-a",
          "-F",
          // tmux 把格式里的制表符输出成 `_`，用 `|` 分隔（会话名里没有它）。
          "#{session_name}|#{pane_id}|#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}",
        ],
        { encoding: "utf8" },
      );
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, id, width, height, x, y] = line.split("|");
          return {
            name,
            id,
            width: Number(width),
            height: Number(height),
            cursor: { x: Number(x), y: Number(y) },
          };
        });
    };
    const capture = (pane) => ({
      ...pane,
      lines: execFileSync(
        "tmux",
        ["-S", socket, "capture-pane", "-p", "-t", pane.id],
        { encoding: "utf8" },
      ).split("\n"),
    });
    // 每个窗格打一行自己的名字，用来把页面上的终端对到窗格上。
    const panes = tmuxPanes();
    for (const pane of panes) {
      execFileSync("tmux", [
        "-S",
        socket,
        "send-keys",
        "-t",
        pane.id,
        "clear",
        "Enter",
      ]);
      execFileSync("tmux", [
        "-S",
        socket,
        "send-keys",
        "-t",
        pane.id,
        "-l",
        `printf 'restore %s\\n' ${pane.name}`,
      ]);
      execFileSync("tmux", ["-S", socket, "send-keys", "-t", pane.id, "Enter"]);
    }
    await sleep(3000);
    const before = await evaluate(PAGE_SCREENS);
    const panesBefore = tmuxPanes();
    const away = await panAway();
    await sleep(options.restoreWait * 1000);
    const lifecycleOffscreen = (await evaluate(PAGE_STATE)).lifecycle;
    await panBack(away);
    await sleep(10_000);
    const after = await evaluate(PAGE_SCREENS);
    const panesAfter = tmuxPanes().map(capture);
    const results = before.map((screen) => {
      const restored =
        after.find((item) => item.nodeId === screen.nodeId) ?? null;
      const text = (restored?.lines ?? []).join("\n");
      const pane =
        panesAfter.find((item) => text.includes(`restore ${item.name}`)) ??
        null;
      const paneBefore = pane
        ? (panesBefore.find((item) => item.id === pane.id) ?? null)
        : null;
      const result = restoreCheck({
        before: screen,
        after: restored,
        paneBefore,
        pane,
      });
      if (options.backend === "tmux" && !pane) {
        result.screenMatches = false;
        result.problems.push("页面上找不到对应窗格的标记行");
      }
      return { ...result, name: pane?.name ?? screen.nodeId };
    });
    return {
      ...mergeRestore(results),
      lifecycleOffscreen,
      waitSeconds: options.restoreWait,
    };
  }
}

/* ------------------------------ 合并基线 ------------------------------- */

function merge(options) {
  const reports = options.merge.map((file) =>
    JSON.parse(readFileSync(resolve(file), "utf8")),
  );
  for (const [index, report] of reports.entries())
    if (report.status !== "ok")
      throw new Error(
        `${options.merge[index]} 不是一次成功的运行（${report.status}）`,
      );
  const platform = reports[0].platform;
  if (reports.some((report) => report.platform !== platform))
    throw new Error("要合并的结果来自不同平台");
  const [os, arch] = platform.split("-");
  const merged = mergeRuns(reports);
  const key = baselineKey({
    platform: os,
    arch,
    renderer: merged.options.renderer,
    backend: merged.options.backend,
  });
  const file = resolve(
    root,
    options.baseline ?? "tools/probes/terminal-memory-baseline.json",
  );
  const baselines = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { platforms: {} };
  baselines.platforms ??= {};
  baselines.platforms[key] = {
    recordedAt: new Date().toISOString().slice(0, 10),
    machine: options.machine ?? "",
    runs: reports.length,
    options: merged.options,
    metrics: Object.fromEntries(
      Object.keys(METRICS).map((metric) => [metric, merged.metrics[metric]]),
    ),
  };
  writeFileSync(file, `${JSON.stringify(baselines, null, 2)}\n`);
  console.log(`写入 ${file} 的 ${key}`);
  console.log(
    JSON.stringify({ medians: merged.metrics, runs: merged.runs }, null, 2),
  );
  return 0;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
process.exit(options.merge ? merge(options) : await run(options));
