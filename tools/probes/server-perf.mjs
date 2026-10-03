// 服务器壳性能基线探针（补全架构 §11，执行计划 G3-6）。
//
// 对一个真的服务器壳（`apps/server/out/main.js serve`，或 `--attach` 一个已经
// 在跑的，比如 dev-stack 的 armadra-server）按这个顺序加负载，每一段量一次：
//
//   1. 空载：配对成管理员、建一个工作空间之后的 RSS 与 CPU；
//   2. 30 个终端会话：建会话的延迟、各自接上终端流、空闲时的 RSS 与 CPU；
//   3. 6 个事件流订阅：对一块普通板反复 `PUT …/document`，量 `board.changed`
//      从发请求到每个订阅者收到的延迟（扇出）；
//   4. 终端吞吐：30 个会话同时各吐一段输出，量总字节 / 墙钟时间与各会话完成时间；
//   5. 一块 2000 个对象的实时板：一个客户端一次写入 2000 个节点，另一个在线
//      客户端收齐的时间、新客户端从零同步的时间、读文档（触发物化）的时间，
//      以及单字段更新在两个客户端之间的延迟；
//   6. 全部挂着时的稳态 RSS 与 CPU；
//   7. 同时关掉全部终端：总耗时，以及期间一个轻请求最慢等了多久（事件循环
//      被同步子进程堵住时，所有客户端都在等）。
//
// RSS 与 CPU 是服务器壳进程自己的（终端的 tmux 服务器另记一列）；`--attach`
// 时拿不到进程号就只给延迟与吞吐。
//
// 与基线比对：`--baseline <文件>`（缺省 tools/probes/server-perf-baseline.json）
// 里按 `<平台>-<架构>` 取一份数字；任何一项比基线差 20% 以上（并且超过该项的
// 绝对容差）即失败。没有这台平台的基线时只报告不判。`--write-baseline` 把这次
// 的数字写成这台平台的基线。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   pnpm --filter @armadra/desktop build
//   pnpm --filter @armadra/server build
//   node tools/probes/server-perf.mjs [输出目录] [--sessions 30] [--subscribers 6]
//     [--objects 2000] [--rounds 40] [--burst-kib 1024] [--cpu-prof 目录]
//     [--attach https://host:port/#pair=票] [--baseline 文件 | --no-baseline]
//     [--write-baseline]
//
// 一切都是临时的、回环的：随机端口，mktemp 出来的数据目录、HOME 与工作空间，
// 跑完全部删除并停掉 tmux 服务器。产物：<输出目录>/result.json、table.md。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { child, harness, killTmux, sleep } from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, "apps/desktop/package.json"));
const { WebSocket } = require("ws");
const Y = require("yjs");
const syncProtocol = require("y-protocols/sync");
const encoding = require("lib0/encoding");
const decoding = require("lib0/decoding");

/* --------------------------------- 参数 ---------------------------------- */

export function parseArgs(argv) {
  const options = {
    output: undefined,
    sessions: 30,
    subscribers: 6,
    objects: 2000,
    rounds: 40,
    burstKib: 1024,
    attach: undefined,
    baseline: join(root, "tools/probes/server-perf-baseline.json"),
    writeBaseline: false,
    cpuProf: undefined,
  };
  const numeric = new Set([
    "sessions",
    "subscribers",
    "objects",
    "rounds",
    "burst-kib",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      options.output = arg;
      continue;
    }
    const [flag, inline] = arg.slice(2).split("=", 2);
    if (flag === "no-baseline") options.baseline = undefined;
    else if (flag === "write-baseline") options.writeBaseline = true;
    else if (
      flag === "attach" ||
      flag === "baseline" ||
      flag === "cpu-prof" ||
      numeric.has(flag)
    ) {
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error(`--${flag} 缺值`);
      if (numeric.has(flag)) {
        const number = Number(value);
        if (!Number.isInteger(number) || number <= 0)
          throw new Error(`--${flag} 要正整数：${value}`);
        options[flag === "burst-kib" ? "burstKib" : flag] = number;
      } else options[flag === "cpu-prof" ? "cpuProf" : flag] = value;
    } else throw new Error(`不认识的参数 --${flag}`);
  }
  return options;
}

/* --------------------------------- 统计 ---------------------------------- */

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

const round1 = (value) =>
  value === null || value === undefined ? null : Math.round(value * 10) / 10;

/**
 * 比对用的指标：`better` 是方向，`slack` 是绝对容差（差值不到它的不算退化，
 * 免得 2 ms 对 3 ms 这种噪声算成 50%）。
 */
export const METRICS = {
  sessionCreateP95Ms: { better: "lower", slack: 100, unit: "ms" },
  fanoutP50Ms: { better: "lower", slack: 5, unit: "ms" },
  fanoutP95Ms: { better: "lower", slack: 10, unit: "ms" },
  terminalThroughputMiBs: { better: "higher", slack: 5, unit: "MiB/s" },
  terminalBurstP95Ms: { better: "lower", slack: 400, unit: "ms" },
  closeStallMaxMs: { better: "lower", slack: 150, unit: "ms" },
  realtimeBulkMs: { better: "lower", slack: 100, unit: "ms" },
  realtimeColdSyncMs: { better: "lower", slack: 100, unit: "ms" },
  realtimeMaterializeMs: { better: "lower", slack: 100, unit: "ms" },
  realtimeUpdateP95Ms: { better: "lower", slack: 5, unit: "ms" },
  rssPeakMiB: { better: "lower", slack: 40, unit: "MiB" },
  rssSteadyMiB: { better: "lower", slack: 40, unit: "MiB" },
  cpuIdlePercent: { better: "lower", slack: 3, unit: "%" },
};

export const REGRESSION = 0.2;

/** 这次的数字对一份基线：每项 `{ metric, baseline, current, change, regressed }`。 */
export function compare(current, baseline) {
  const rows = [];
  for (const [metric, rule] of Object.entries(METRICS)) {
    const was = baseline?.[metric];
    const now = current[metric];
    if (typeof was !== "number" || typeof now !== "number") continue;
    const worse = rule.better === "lower" ? now - was : was - now;
    const change = was === 0 ? 0 : worse / Math.abs(was);
    rows.push({
      metric,
      baseline: was,
      current: now,
      change: Math.round(change * 1000) / 10,
      regressed: change > REGRESSION && worse > rule.slack,
    });
  }
  return rows;
}

export function platformKey() {
  return `${process.platform}-${process.arch}`;
}

/* ------------------------------- 进程采样 -------------------------------- */

/** 一个进程此刻的 RSS（MiB）与累计 CPU 秒；读不到时 `null`。 */
export function processStats(pid) {
  if (!pid) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[11]) + Number(fields[12]);
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
      return { rssMiB: rssKb / 1024, cpuSeconds: ticks / 100 };
    }
    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
      const [rss, time] = out.split(/\s+/);
      return { rssMiB: Number(rss) / 1024, cpuSeconds: cpuTime(time) };
    }
  } catch {}
  return null;
}

/** `ps -o time=` 的 `[[dd-]hh:]mm:ss.ss` → 秒。 */
export function cpuTime(text) {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  return (
    rest
      .split(":")
      .map(Number)
      .reduce((total, part) => total * 60 + part, 0) +
    Number(days) * 86_400
  );
}

/** 每 200 ms 采一次 RSS 的峰值；`phase()` 量一段的 CPU 占用。 */
function sampler(pids) {
  const peaks = {};
  const timer = setInterval(() => {
    for (const [name, pid] of Object.entries(pids())) {
      const stats = processStats(pid);
      if (stats) peaks[name] = Math.max(peaks[name] ?? 0, stats.rssMiB);
    }
  }, 200);
  timer.unref();
  return {
    peaks,
    stop: () => clearInterval(timer),
    /** 量 `work` 那一段每个进程的 CPU%（单核为 100）与段末 RSS。 */
    async phase(work) {
      const started = performance.now();
      const before = Object.fromEntries(
        Object.entries(pids()).map(([name, pid]) => [name, processStats(pid)]),
      );
      const value = await work();
      const seconds = (performance.now() - started) / 1000;
      const usage = {};
      for (const [name, pid] of Object.entries(pids())) {
        const after = processStats(pid);
        const was = before[name];
        if (!after) continue;
        usage[name] = {
          rssMiB: round1(after.rssMiB),
          cpuPercent: was
            ? round1(((after.cpuSeconds - was.cpuSeconds) / seconds) * 100)
            : null,
        };
      }
      return { value, seconds: round1(seconds), usage };
    },
  };
}

/* --------------------------------- HTTP ---------------------------------- */

function client(origin) {
  const agent = new Agent({ keepAlive: true, rejectUnauthorized: false });
  let cookie = "";
  let csrf = "";
  const call = (path, { method = "GET", body } = {}) => {
    const url = new URL(path, origin);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((done, failed) => {
      const headers = { origin };
      if (cookie) headers.cookie = cookie;
      if (csrf) headers["x-armadra-csrf"] = csrf;
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(payload));
      }
      const outgoing = httpsRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers,
          agent,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {}
            done({
              status: response.statusCode ?? 0,
              headers: response.headers,
              json,
              text,
            });
          });
        },
      );
      outgoing.on("error", failed);
      if (payload !== undefined) outgoing.write(payload);
      outgoing.end();
    });
  };
  const must = async (path, init) => {
    const answer = await call(path, init);
    if (answer.status < 200 || answer.status >= 300)
      throw new Error(
        `${init?.method ?? "GET"} ${path} → ${answer.status} ${answer.text.slice(0, 300)}`,
      );
    return answer.json;
  };
  return {
    call,
    must,
    agent,
    get cookie() {
      return cookie;
    },
    async pair(ticket) {
      const answer = await call("/api/identity/pair", {
        method: "POST",
        body: { ticket },
      });
      if (answer.status !== 200)
        throw new Error(`配对失败：${answer.status} ${answer.text}`);
      cookie = (answer.headers["set-cookie"] ?? [])
        .map((value) => value.split(";")[0].trim())
        .join("; ");
      csrf = answer.json.csrfToken;
    },
    socket(path) {
      const socket = new WebSocket(`${origin.replace(/^http/u, "ws")}${path}`, {
        headers: { origin, cookie },
        rejectUnauthorized: false,
      });
      socket.binaryType = "nodebuffer";
      return new Promise((done, failed) => {
        socket.once("open", () => done(socket));
        socket.once("error", failed);
        socket.once("unexpected-response", (_request, response) =>
          failed(new Error(`${path} 升级被拒：HTTP ${response.statusCode}`)),
        );
      });
    },
  };
}

/**
 * 等 `check` 成立。不轮询：每个 socket 收到帧都 `wake()` 一次，等的人醒来再看
 * ——轮询间隔会直接加进量出来的延迟里。
 */
let sleepers = [];
function wake() {
  for (const resume of sleepers.splice(0)) resume();
}

async function until(check, what, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`等不到：${what}`);
    await new Promise((resume) => {
      const timer = setTimeout(
        () => {
          sleepers = sleepers.filter((item) => item !== done);
          resume();
        },
        Math.min(left, 250),
      );
      const done = () => {
        clearTimeout(timer);
        resume();
      };
      sleepers.push(done);
    });
  }
}

/* ------------------------------ 实时板客户端 ----------------------------- */

const MESSAGE_SYNC = 0;

function yClient(socket) {
  const doc = new Y.Doc();
  socket.on("message", (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, "remote");
    if (encoding.length(encoder) > 1)
      socket.send(encoding.toUint8Array(encoder));
    wake();
  });
  doc.on("update", (update, origin) => {
    if (origin === "remote") return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    socket.send(encoding.toUint8Array(encoder));
  });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  socket.send(encoding.toUint8Array(encoder));
  return { doc, nodes: doc.getMap("nodes"), socket };
}

/** 契约 §16.1 的节点：一张 `Y.Map`，正文在 `content` 的 `Y.Text`。 */
function stickyMap(index, stamp) {
  const map = new Y.Map();
  map.set("type", "sticky");
  map.set("title", `便签 ${index}`);
  map.set("color", "#ffd60a");
  map.set("position", {
    x: (index % 50) * 260,
    y: Math.floor(index / 50) * 220,
  });
  map.set("size", { width: 240, height: 200 });
  map.set("labels", []);
  map.set("note", "");
  map.set("data", { kind: "sticky" });
  map.set("createdAt", stamp);
  map.set("updatedAt", stamp);
  const text = new Y.Text();
  text.insert(0, `性能基线 ${index}`);
  map.set("content", text);
  return map;
}

/* --------------------------------- 主线 ---------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = resolve(options.output ?? join(root, "target/server-perf"));
  mkdirSync(output, { recursive: true });
  const h = harness(output);
  const { report, step } = h;
  report.failures = [];
  report.platform = platformKey();
  report.options = { ...options, output: undefined };

  await h.run(async () => {
    /* ------------------------------ 服务器壳 ------------------------------ */
    let pairing = options.attach ?? "";
    let serverPid;
    let tmuxSocket;
    if (!pairing) {
      for (const [what, file] of [
        ["core", "apps/desktop/out/core/main.js"],
        ["服务器壳", "apps/server/out/main.js"],
      ]) {
        if (!existsSync(join(root, file)))
          throw new Error(`${what}未构建：${file}（见文件头的构建命令）`);
      }
      const data = h.temp("armadra-server-perf-");
      const home = h.temp("armadra-server-perf-home-");
      const web = h.temp("armadra-server-perf-web-");
      writeFileSync(join(web, "index.html"), "<!doctype html>");
      tmuxSocket = join(data, "tmux.sock");
      h.cleanups.push(() => killTmux(data));
      const server = child(
        h,
        process.execPath,
        [
          // `--cpu-prof <目录>`：服务器壳退出时写 .cpuprofile，找热点用。
          ...(options.cpuProf
            ? ["--cpu-prof", "--cpu-prof-dir", resolve(options.cpuProf)]
            : []),
          join(root, "apps/server/out/main.js"),
          "serve",
          "--data-dir",
          data,
          "--web-root",
          web,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: home,
            ARMADRA_LOG: "warn",
            ARMADRA_SECRET_BACKEND: "file",
            // out/main.js 把 node-pty 留作外部模块，从桌面包的依赖里找（与
            // tools/dev-stack/Dockerfile.dev 同一个做法）。
            NODE_PATH: join(root, "apps/desktop/node_modules"),
          },
        },
      );
      for (let attempt = 0; attempt < 300 && !pairing; attempt += 1) {
        if (server.process.exitCode !== null)
          throw new Error(`服务器壳退出：${server.tail()}`);
        pairing = /armadra-server pairing (\S+)/.exec(server.tail())?.[1] ?? "";
        if (!pairing) await sleep(100);
      }
      if (!pairing) throw new Error(`启动日志里没有配对链接：${server.tail()}`);
      serverPid = server.process.pid;
      h.cleanups.push(() => {
        report.serverLog = server.tail().slice(-4000);
      });
    }
    const url = new URL(pairing);
    const ticket = new URLSearchParams(url.hash.slice(1)).get("pair");
    if (!ticket) throw new Error(`配对链接里没有票：${pairing}`);
    const api = client(url.origin);
    await api.pair(ticket);
    step("配对成管理员", url.origin);

    const tmuxPid = () => {
      if (!tmuxSocket || !existsSync(tmuxSocket)) return undefined;
      try {
        return Number(
          execFileSync("tmux", ["-S", tmuxSocket, "display", "-p", "#{pid}"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim(),
        );
      } catch {
        return undefined;
      }
    };
    const pids = () => ({ server: serverPid, tmux: tmuxPid() });
    const sample = sampler(pids);
    h.cleanups.push(() => sample.stop());
    const phases = {};

    const projectRoot = h.temp("armadra-server-perf-project-");
    writeFileSync(join(projectRoot, "README.md"), "# perf\n");
    const workspace = await api.must("/api/workspaces", {
      method: "POST",
      body: { name: "性能基线", rootPath: projectRoot },
    });
    const boards = await api.must(`/api/workspaces/${workspace.id}/boards`);
    const plainBoard = boards[0].id;

    /* ------------------------------ 1. 空载 ------------------------------- */
    phases.idle = await sample.phase(() => sleep(3000));
    step("空载", JSON.stringify(phases.idle.usage));

    /* --------------------------- 2. 终端会话 ------------------------------ */
    const terminals = [];
    const createMs = [];
    phases.sessions = await sample.phase(async () => {
      for (let index = 0; index < options.sessions; index += 1) {
        const started = performance.now();
        const session = await api.must("/api/terminals", {
          method: "POST",
          body: {
            workspaceId: workspace.id,
            cwd: projectRoot,
            shell: "/bin/sh",
          },
        });
        createMs.push(performance.now() - started);
        const socket = await api.socket(
          `/api/terminals/${session.id}/ws?writer=perf-${index}`,
        );
        const terminal = {
          id: session.id,
          socket,
          bytes: 0,
          text: "",
          hello: false,
        };
        socket.on("message", (data) => {
          const frame = JSON.parse(String(data));
          if (frame.type === "hello") terminal.hello = true;
          if (frame.type === "output" || frame.type === "snapshot") {
            terminal.bytes += Buffer.byteLength(frame.data ?? "");
            terminal.text = (terminal.text + (frame.data ?? "")).slice(-4096);
          }
          wake();
        });
        terminals.push(terminal);
      }
      await until(
        () => terminals.every((terminal) => terminal.hello),
        "每个终端流的 hello",
      );
    });
    phases.sessionsIdle = await sample.phase(() => sleep(3000));
    step(
      `${options.sessions} 个终端会话`,
      `建会话 p50 ${round1(percentile(createMs, 50))} ms / p95 ${round1(percentile(createMs, 95))} ms`,
    );

    /* --------------------------- 3. 事件扇出 ------------------------------ */
    const subscribers = [];
    for (let index = 0; index < options.subscribers; index += 1) {
      const socket = await api.socket(`/api/workspaces/${workspace.id}/events`);
      const subscriber = { socket, waiting: undefined };
      socket.on("message", (data) => {
        const text = String(data);
        if (!text.includes("board.changed") || !text.includes(plainBoard))
          return;
        subscriber.waiting?.(performance.now());
      });
      subscribers.push(subscriber);
    }
    let documentState = await api.must(
      `/api/workspaces/${workspace.id}/boards/${plainBoard}/document`,
    );
    const fanout = [];
    const saveMs = [];
    phases.fanout = await sample.phase(async () => {
      for (let round = 0; round < options.rounds; round += 1) {
        const arrivals = subscribers.map(
          (subscriber) =>
            new Promise((done) => {
              subscriber.waiting = (at) => {
                subscriber.waiting = undefined;
                done(at);
              };
            }),
        );
        const stamp = new Date().toISOString();
        const started = performance.now();
        const saved = await api.call(
          `/api/workspaces/${workspace.id}/boards/${plainBoard}/document`,
          {
            method: "PUT",
            body: {
              expectedUpdatedAt: documentState.board.updatedAt,
              nodes: [
                {
                  id: randomUUID(),
                  boardId: plainBoard,
                  type: "sticky",
                  title: `第 ${round} 轮`,
                  color: "#ffd60a",
                  position: { x: 0, y: 0 },
                  size: { width: 240, height: 200 },
                  labels: [],
                  note: "",
                  data: { kind: "sticky", content: String(round) },
                  createdAt: stamp,
                  updatedAt: stamp,
                },
              ],
              edges: [],
              viewport: { x: 0, y: 0, zoom: 1 },
              whiteboard: "",
            },
          },
        );
        saveMs.push(performance.now() - started);
        if (saved.status !== 200)
          throw new Error(
            `保存失败：${saved.status} ${saved.text.slice(0, 200)}`,
          );
        const times = await Promise.race([
          Promise.all(arrivals),
          sleep(10_000).then(() => {
            throw new Error(`第 ${round} 轮的 board.changed 没送到全部订阅者`);
          }),
        ]);
        for (const at of times) fanout.push(at - started);
        documentState = saved.json?.board
          ? saved.json
          : await api.must(
              `/api/workspaces/${workspace.id}/boards/${plainBoard}/document`,
            );
      }
    });
    step(
      `${options.subscribers} 个事件流订阅的扇出`,
      `p50 ${round1(percentile(fanout, 50))} ms / p95 ${round1(percentile(fanout, 95))} ms / 最大 ${round1(Math.max(...fanout))} ms（保存往返 p50 ${round1(percentile(saveMs, 50))} ms）`,
    );

    /* --------------------------- 4. 终端吞吐 ------------------------------ */
    const burstBytes = options.burstKib * 1024;
    const doneMs = [];
    let totalBytes = 0;
    phases.throughput = await sample.phase(async () => {
      const before = terminals.map((terminal) => terminal.bytes);
      const started = performance.now();
      await Promise.all(
        terminals.map(async (terminal, index) => {
          terminal.text = "";
          terminal.socket.send(
            JSON.stringify({
              type: "input",
              data: `head -c ${burstBytes} /dev/zero | tr '\\0' x; echo; echo "PERF""-END-${index}"\r`,
              inputId: 1,
            }),
          );
          await until(
            () => terminal.text.includes(`PERF-END-${index}`),
            `终端 ${index} 吐完：${JSON.stringify(terminal.text.slice(-300))}`,
            120_000,
          );
          doneMs.push(performance.now() - started);
        }),
      );
      const elapsed = (performance.now() - started) / 1000;
      // 送到页面的字节数随 tmux 合并重绘而变（吐得越快、重绘越少），不能当
      // 吞吐；吞吐按终端里产生的字节算，送达字节另记。
      totalBytes = terminals.reduce(
        (sum, terminal, index) => sum + terminal.bytes - before[index],
        0,
      );
      return (burstBytes * terminals.length) / 1024 / 1024 / elapsed;
    });
    step(
      "终端吞吐",
      `${round1(phases.throughput.value)} MiB/s（${round1(totalBytes / 1024 / 1024)} MiB / ${phases.throughput.seconds} s），单会话完成 p95 ${round1(percentile(doneMs, 95))} ms`,
    );

    /* ---------------------------- 5. 实时板 ------------------------------- */
    const realtimeBoard = await api.must(
      `/api/workspaces/${workspace.id}/boards`,
      { method: "POST", body: { name: "实时板" } },
    );
    const syncPath = `/api/workspaces/${workspace.id}/boards/${realtimeBoard.id}/sync`;
    const writer = yClient(await api.socket(syncPath));
    const reader = yClient(await api.socket(syncPath));
    await sleep(300);
    const realtime = {};
    const updateMs = [];
    phases.realtime = await sample.phase(async () => {
      const stamp = new Date().toISOString();
      const ids = [];
      let started = performance.now();
      writer.doc.transact(() => {
        for (let index = 0; index < options.objects; index += 1) {
          const id = randomUUID();
          ids.push(id);
          writer.nodes.set(id, stickyMap(index, stamp));
        }
      });
      await until(
        () => reader.nodes.size >= options.objects,
        "在线客户端收齐全部对象",
        120_000,
      );
      realtime.bulkMs = performance.now() - started;

      started = performance.now();
      const cold = yClient(await api.socket(syncPath));
      await until(
        () => cold.nodes.size >= options.objects,
        "新客户端从零同步",
        120_000,
      );
      realtime.coldSyncMs = performance.now() - started;
      cold.socket.close();

      for (let round = 0; round < options.rounds; round += 1) {
        const id = ids[(round * 37) % ids.length];
        const want = { x: round, y: round * 2 };
        const begin = performance.now();
        writer.nodes.get(id).set("position", want);
        await until(
          () =>
            reader.nodes.get(id)?.get("position")?.y === want.y &&
            reader.nodes.get(id)?.get("position")?.x === want.x,
          `第 ${round} 次单字段更新`,
          10_000,
        );
        updateMs.push(performance.now() - begin);
      }

      started = performance.now();
      const document = await api.must(
        `/api/workspaces/${workspace.id}/boards/${realtimeBoard.id}/document`,
      );
      realtime.materializeMs = performance.now() - started;
      realtime.materializedNodes = document.nodes.length;
    });
    if (realtime.materializedNodes !== options.objects)
      report.failures.push({
        name: "实时板物化",
        detail: `表里 ${realtime.materializedNodes} 个节点，应为 ${options.objects}`,
      });
    step(
      `${options.objects} 个对象的实时板`,
      `批量到在线客户端 ${round1(realtime.bulkMs)} ms，冷同步 ${round1(realtime.coldSyncMs)} ms，读文档（物化）${round1(realtime.materializeMs)} ms，单字段更新 p50 ${round1(percentile(updateMs, 50))} / p95 ${round1(percentile(updateMs, 95))} ms`,
    );

    /* ---------------------------- 6. 稳态 --------------------------------- */
    phases.steady = await sample.phase(() => sleep(5000));
    step("全部挂着的稳态", JSON.stringify(phases.steady.usage));

    for (const subscriber of subscribers) subscriber.socket.close();
    writer.socket.close();
    reader.socket.close();
    /* ------------------------- 7. 关掉全部终端 ---------------------------- */
    // 同时关 30 个终端，旁边每 20 ms 发一个轻请求：最慢的那个说明关终端时
    // 事件循环被堵了多久（其余客户端在这段时间里什么都收不到）。
    const stalls = [];
    let closing = true;
    const pinger = (async () => {
      while (closing) {
        const started = performance.now();
        await api.call(`/api/workspaces/${workspace.id}/boards`);
        stalls.push(performance.now() - started);
        await sleep(20);
      }
    })();
    const closeStarted = performance.now();
    await Promise.all(
      terminals.map(async (terminal) => {
        terminal.socket.close();
        const answer = await api.call(
          `/api/terminals/${terminal.id}/terminate`,
          {
            method: "POST",
          },
        );
        if (answer.status >= 300)
          throw new Error(
            `关终端失败：${answer.status} ${answer.text.slice(0, 200)}`,
          );
      }),
    );
    const closeAllMs = performance.now() - closeStarted;
    closing = false;
    await pinger;
    step(
      `同时关掉 ${terminals.length} 个终端`,
      `${round1(closeAllMs)} ms，期间轻请求最慢 ${round1(Math.max(...stalls))} ms`,
    );
    api.agent.destroy();
    sample.stop();

    /* ---------------------------- 汇总与比对 ------------------------------ */
    const metrics = {
      sessionCreateP50Ms: round1(percentile(createMs, 50)),
      sessionCreateP95Ms: round1(percentile(createMs, 95)),
      fanoutP50Ms: round1(percentile(fanout, 50)),
      fanoutP95Ms: round1(percentile(fanout, 95)),
      fanoutMaxMs: round1(Math.max(...fanout)),
      saveP50Ms: round1(percentile(saveMs, 50)),
      terminalThroughputMiBs: round1(phases.throughput.value),
      terminalBytesMiB: round1(totalBytes / 1024 / 1024),
      terminalBurstP95Ms: round1(percentile(doneMs, 95)),
      closeAllMs: round1(closeAllMs),
      closeStallMaxMs: round1(Math.max(...stalls)),
      realtimeBulkMs: round1(realtime.bulkMs),
      realtimeColdSyncMs: round1(realtime.coldSyncMs),
      realtimeMaterializeMs: round1(realtime.materializeMs),
      realtimeUpdateP50Ms: round1(percentile(updateMs, 50)),
      realtimeUpdateP95Ms: round1(percentile(updateMs, 95)),
      rssIdleMiB: phases.idle.usage.server?.rssMiB ?? null,
      rssSessionsMiB: phases.sessionsIdle.usage.server?.rssMiB ?? null,
      rssSteadyMiB: phases.steady.usage.server?.rssMiB ?? null,
      rssPeakMiB: round1(sample.peaks.server) ?? null,
      tmuxRssPeakMiB: round1(sample.peaks.tmux) ?? null,
      cpuIdlePercent: phases.idle.usage.server?.cpuPercent ?? null,
      cpuSessionsIdlePercent:
        phases.sessionsIdle.usage.server?.cpuPercent ?? null,
      cpuFanoutPercent: phases.fanout.usage.server?.cpuPercent ?? null,
      cpuThroughputPercent: phases.throughput.usage.server?.cpuPercent ?? null,
      tmuxCpuThroughputPercent:
        phases.throughput.usage.tmux?.cpuPercent ?? null,
      cpuRealtimePercent: phases.realtime.usage.server?.cpuPercent ?? null,
      cpuSteadyPercent: phases.steady.usage.server?.cpuPercent ?? null,
    };
    report.metrics = metrics;
    report.phases = phases;

    const table = renderTable(metrics);
    let comparison = [];
    if (options.baseline && existsSync(options.baseline)) {
      const baselines = JSON.parse(readFileSync(options.baseline, "utf8"));
      const mine = baselines.platforms?.[report.platform];
      if (mine) {
        comparison = compare(metrics, mine.metrics);
        report.comparison = comparison;
        for (const row of comparison.filter((item) => item.regressed))
          report.failures.push({
            name: `退化：${row.metric}`,
            detail: `基线 ${row.baseline}，这次 ${row.current}（差 ${row.change}%）`,
          });
      } else report.comparison = `没有 ${report.platform} 的基线，只报告`;
    }
    if (options.writeBaseline && options.baseline) {
      const baselines = existsSync(options.baseline)
        ? JSON.parse(readFileSync(options.baseline, "utf8"))
        : { platforms: {} };
      baselines.platforms[report.platform] = {
        recordedAt: new Date().toISOString().slice(0, 10),
        options: {
          sessions: options.sessions,
          subscribers: options.subscribers,
          objects: options.objects,
          rounds: options.rounds,
          burstKib: options.burstKib,
        },
        metrics: Object.fromEntries(
          Object.keys(METRICS).map((key) => [key, metrics[key]]),
        ),
      };
      writeFileSync(
        options.baseline,
        `${JSON.stringify(baselines, null, 2)}\n`,
      );
      step("写入基线", options.baseline);
    }
    const compared =
      Array.isArray(comparison) && comparison.length > 0
        ? `\n\n| 比对 | 基线 | 这次 | 变差 |\n| --- | ---: | ---: | ---: |\n${comparison
            .map(
              (row) =>
                `| ${row.metric}${row.regressed ? " ⚠" : ""} | ${row.baseline} | ${row.current} | ${row.change}% |`,
            )
            .join("\n")}`
        : "";
    writeFileSync(join(output, "table.md"), `${table}${compared}\n`);
    console.log(`\n${table}${compared}\n`);
  });
}

export function renderTable(metrics) {
  const rows = [
    [
      "建会话 p50 / p95",
      `${metrics.sessionCreateP50Ms} / ${metrics.sessionCreateP95Ms} ms`,
    ],
    [
      "事件扇出 p50 / p95 / 最大",
      `${metrics.fanoutP50Ms} / ${metrics.fanoutP95Ms} / ${metrics.fanoutMaxMs} ms`,
    ],
    ["保存往返 p50", `${metrics.saveP50Ms} ms`],
    ["终端吞吐（产生字节 / 墙钟）", `${metrics.terminalThroughputMiBs} MiB/s`],
    ["送到页面的终端字节", `${metrics.terminalBytesMiB} MiB`],
    ["单会话完成 p95", `${metrics.terminalBurstP95Ms} ms`],
    [
      "同时关掉全部终端 / 期间轻请求最慢",
      `${metrics.closeAllMs} / ${metrics.closeStallMaxMs} ms`,
    ],
    ["实时板批量到在线客户端", `${metrics.realtimeBulkMs} ms`],
    ["实时板冷同步", `${metrics.realtimeColdSyncMs} ms`],
    ["实时板读文档（物化）", `${metrics.realtimeMaterializeMs} ms`],
    [
      "实时单字段更新 p50 / p95",
      `${metrics.realtimeUpdateP50Ms} / ${metrics.realtimeUpdateP95Ms} ms`,
    ],
    [
      "RSS 空载 / 30 会话 / 稳态 / 峰值",
      `${metrics.rssIdleMiB} / ${metrics.rssSessionsMiB} / ${metrics.rssSteadyMiB} / ${metrics.rssPeakMiB} MiB`,
    ],
    ["tmux 服务器 RSS 峰值", `${metrics.tmuxRssPeakMiB} MiB`],
    [
      "CPU 空载 / 会话空闲 / 稳态",
      `${metrics.cpuIdlePercent} / ${metrics.cpuSessionsIdlePercent} / ${metrics.cpuSteadyPercent} %`,
    ],
    [
      "CPU 扇出 / 吞吐 / 实时板",
      `${metrics.cpuFanoutPercent} / ${metrics.cpuThroughputPercent} / ${metrics.cpuRealtimePercent} %`,
    ],
    ["tmux CPU 吞吐段", `${metrics.tmuxCpuThroughputPercent} %`],
  ];
  return `| 指标 | 数值 |\n| --- | --- |\n${rows
    .map(([name, value]) => `| ${name} | ${value} |`)
    .join("\n")}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
