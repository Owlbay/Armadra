// 语言会话负载探针（工程规范化 E3-9：语言会话要不要并进控制面 `/api/ws`）。
//
// 真 core（`apps/desktop/out/core/main.js`）、真语言会话代理，语言服务器是
// `mock-lsp.mjs`（按 TypeScript 服务器的体积塑形：补全 1200 项、成员补全 80 项、
// 悬停 2 KiB、每次诊断 25 条），本机装了 clangd 时再跑一遍真服务器。客户端按
// 页面里 CodeMirror 语言客户端的节奏打字（见 language-load-lib.mjs 的
// `keystrokeActions`），统计：
//
//   A. 语言流本身：每秒帧数、单帧体积 p50 / p95 / max、100 ms 与 1 s 突发峰值、补全往返；
//   B. 与控制面事件流混跑（回环，现状：两条连接）：`board.changed` 从保存到收到的 p95；
//   C. 共享瓶颈（缺省 1 MiB/s、单程 20 ms，模拟手机或家宽上行）：同样的事件延迟，
//      `fair` = 独立连接（每条连接一个队列轮转），`fifo` = 并进一条连接（同一个队列，
//      语言帧挡在事件前面）；
//   D. `--relay`：经 armadra-cloud 的个人中转（真中继、真隧道），独立连接时的事件
//      延迟、补全往返与有没有被关流。
//
// 一切都是临时的：core 用 mktemp 的数据目录（ARMADRA_DATA_DIR）与临时 HOME
// （probe-home.mjs），SecretStore 用 file 后端，端口随机，跑完删除。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build
//   node tools/probes/language-load.mjs [--seconds=15] [--no-clangd] [--relay] [--check] [输出目录]
//
// `--check` 把 mock 档的确定性指标（帧体积）与 language-load-baseline.json 比，偏离
// 超过 20% 退出码 1；延迟随机器变，只记不比。产物默认在 target/language-load/result.json。
import { execFileSync, spawn } from "node:child_process";
import {
  X509Certificate,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findCloudSource } from "./cloud-source.mjs";
import {
  SharedLink,
  TYPING_TEXT,
  distribution,
  keystrokeActions,
  round1,
  summarizeFrames,
} from "./language-load-lib.mjs";
import { isolatedEnv, probeHome } from "./probe-home.mjs";
import { probeSession } from "./probe-session.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, "apps/desktop/package.json"));
const { WebSocket } = require("ws");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};
const SECONDS = Number(option("seconds", "15"));
/** 跑哪几段（A–D）；D 另要 `--relay`。 */
const PHASES = option("phases", "ABCD");
const phase = (name) => PHASES.includes(name);
const LINK_BYTES_PER_SECOND = Number(option("link-kib", "1024")) * 1024;
const LINK_DELAY_MS = Number(option("link-delay", "20"));
const output = resolve(
  args.find((arg) => !arg.startsWith("--")) ??
    join(root, "target/language-load"),
);
mkdirSync(output, { recursive: true });

const MOCK_LSP = join(root, "tools/probes/mock-lsp.mjs");
/** 按 TypeScript 服务器塑形的 mock（见文件头）。 */
const MOCK_ARGS = [
  MOCK_LSP,
  "--completion-items=1200",
  "--member-items=80",
  "--hover-bytes=2048",
  "--diagnostics=25",
];
const C_TYPING_TEXT =
  'size_t total = strlen(buffer); printf("%zu\\n", total); ' +
  "value = atoi(argv[1]); memset(buffer, 0, sizeof buffer); " +
  "struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now); ";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanups = [];
const report = {
  status: "failed",
  startedAt: new Date().toISOString(),
  options: {
    seconds: SECONDS,
    link: { bytesPerSecond: LINK_BYTES_PER_SECOND, delayMs: LINK_DELAY_MS },
    mock: MOCK_ARGS.slice(1),
  },
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  traffic: {},
  mixed: {},
  link: {},
  relay: null,
  notes: [],
};

/* --------------------------------- core ---------------------------------- */

async function startCore() {
  const home = probeHome("armadra-language-load-home-");
  cleanups.push(() => home.remove());
  const data = mkdtempSync(join(tmpdir(), "armadra-language-load-data-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const binary = join(root, "apps/desktop/out/core/main.js");
  if (!existsSync(binary))
    throw new Error(
      `core 未构建：${binary}（pnpm --filter @armadra/desktop build）`,
    );
  let log = "";
  const child = spawn(
    process.execPath,
    [binary, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: isolatedEnv(home, {
        ARMADRA_DATA_DIR: data,
        ARMADRA_LOG: "warn",
        ARMADRA_SECRET_BACKEND: "file",
      }),
    },
  );
  const take = (chunk) => {
    log = (log + chunk).slice(-200_000);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  cleanups.push(() => child.kill("SIGKILL"));
  let origin = "";
  for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`core 退出：${log.slice(-2000)}`);
    try {
      origin = JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
        .runtime.http;
    } catch {
      await sleep(100);
    }
  }
  if (!origin) throw new Error("core 没有写出 endpoints.json");
  return { origin, data, home, log: () => log };
}

/** 直连 core 的 JSON 调用（回环主人，契约 §3.2）。 */
function directApi(origin) {
  return async (path, init = {}) => {
    const answer = await fetch(new URL(path, origin), {
      ...init,
      headers: {
        "content-type": "application/json",
        origin,
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text.slice(0, 300)}`,
      );
    return text ? JSON.parse(text) : null;
  };
}

/* ------------------------------ 连接的来路 ------------------------------ */

/**
 * 一条来路：`api(path, init)` 发 JSON，`socket(path, protocols)` 开 WebSocket。
 * 直连、经塑形代理、经中继三种，探针的其余部分不分。
 */
function directRoute(origin, wsOrigin = origin) {
  const api = directApi(origin);
  return {
    name: "direct",
    api,
    socket: (path, protocols = []) =>
      new WebSocket(`${wsOrigin.replace(/^http/, "ws")}${path}`, protocols, {
        origin,
        maxPayload: 64 * 1024 * 1024,
      }),
  };
}

/* ------------------------------- 塑形代理 ------------------------------- */

/**
 * 本机 TCP 代理：下行（core → 客户端）经 {@link SharedLink} 的共享瓶颈，上行只加
 * 单程延迟。每条连接在链路上积压超过 256 KiB 就暂停读 core 那一侧，像 TCP 窗口
 * 一样把背压交回 core（core 的 SendQueue 据此暂停语言服务器的 stdout）。
 */
async function startShaper(target, mode) {
  const { hostname, port } = new URL(target);
  const sockets = new Set();
  const pairs = new Map();
  const link = new SharedLink({
    bytesPerSecond: LINK_BYTES_PER_SECOND,
    delayMs: LINK_DELAY_MS,
    mode,
    deliver: (connection, segment) => {
      const pair = pairs.get(connection);
      if (pair === undefined || pair.client.destroyed) return;
      pair.client.write(segment);
      if (pair.paused && link.backlog(connection) < 128 * 1024) {
        pair.paused = false;
        pair.upstream.resume();
      }
    },
  });
  let next = 0;
  const server = createServer((client) => {
    const id = (next += 1);
    const upstream = createConnection({ host: hostname, port: Number(port) });
    const pair = { client, upstream, paused: false };
    pairs.set(id, pair);
    sockets.add(client);
    sockets.add(upstream);
    client.on("data", (chunk) => {
      setTimeout(() => {
        if (!upstream.destroyed) upstream.write(chunk);
      }, LINK_DELAY_MS);
    });
    upstream.on("data", (chunk) => {
      link.push(id, chunk);
      if (!pair.paused && link.backlog(id) > 256 * 1024) {
        pair.paused = true;
        upstream.pause();
      }
    });
    const close = () => {
      link.forget(id);
      pairs.delete(id);
      client.destroy();
      upstream.destroy();
    };
    client.on("close", close);
    upstream.on("close", close);
    client.on("error", close);
    upstream.on("error", close);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const stop = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  cleanups.push(stop);
  /** 等链路排空：上一段的积压不算进下一段。 */
  const drained = async () => {
    while (!link.idle()) await sleep(50);
  };
  return { origin: `http://127.0.0.1:${address.port}`, stop, drained };
}

/* ------------------------------ 控制面事件 ------------------------------ */

/**
 * 控制面上订一块工作空间的事件（契约 §35.4），直接说 peer 帧。`waitFor(boardId)`
 * 在下一条这块板的 `board.changed` 到达时答到达时刻。
 */
async function subscribeEvents(route, workspaceId, extraProtocols = []) {
  const socket = route.socket("/api/ws", [...extraProtocols, "armadra-rpc.v1"]);
  await new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
    socket.once("unexpected-response", (_request, response) =>
      fail(new Error(`/api/ws 升级 ${response.statusCode}`)),
    );
  });
  const waiters = [];
  let subscribed = false;
  const closed = { code: undefined };
  socket.on("close", (code) => (closed.code = code));
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.t !== 3 || message.p?.e !== "message") return;
    const event = message.p.d?.json;
    if (event?.type === "cursor") subscribed = true;
    if (event?.type !== "board.changed") return;
    const at = performance.now();
    for (const waiter of waiters.splice(0)) waiter(at);
  });
  socket.send(
    JSON.stringify({
      i: "1",
      p: {
        u: "/workspaces/events",
        b: { json: { workspaceId, cursor: "now" } },
      },
    }),
  );
  for (let attempt = 0; attempt < 100 && !subscribed; attempt += 1)
    await sleep(50);
  if (!subscribed) throw new Error("控制面订阅没有收到位置帧");
  return {
    next: () => new Promise((done) => waiters.push(done)),
    closed,
    close: () => socket.terminate(),
  };
}

/**
 * 每 100 ms 存一次画布（直连 core），量 `board.changed` 从发起保存到控制面上
 * 收到的时间。`stop()` 停下并答延迟分布。
 */
function eventTicker(core, workspaceId, boardId, events) {
  const latencies = [];
  let lost = 0;
  let running = true;
  const failure = { error: undefined };
  const done = (async () => {
    let state = await core(
      `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
    );
    let round = 0;
    while (running) {
      const tick = performance.now();
      const arrival = events.next();
      const started = performance.now();
      const stamp = new Date().toISOString();
      const saved = await core(
        `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
        {
          method: "PUT",
          body: {
            expectedUpdatedAt: state.board.updatedAt,
            nodes: [
              {
                id: randomUUID(),
                boardId,
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
      round += 1;
      state = saved?.board
        ? saved
        : await core(
            `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
          );
      const at = await Promise.race([
        arrival,
        sleep(5_000).then(() => undefined),
      ]);
      if (at === undefined) lost += 1;
      else latencies.push(at - started);
      const left = 100 - (performance.now() - tick);
      if (left > 0) await sleep(left);
    }
  })().catch((error) => {
    failure.error = error;
  });
  return {
    stop: async () => {
      running = false;
      await done;
      if (failure.error) throw failure.error;
      return { ...distribution(latencies.map(round1)), lost };
    },
  };
}

/* ------------------------------ 语言会话客户端 ------------------------------ */

/**
 * 一个编辑器节点的语言会话：`POST …/language/sessions` 开会话、连它的流、
 * `initialize` + `didOpen`，之后按 `profile` 打字。每一帧都记下方向、种类与字节数。
 */
async function openEditor(
  route,
  workspaceId,
  spec,
  index,
  extraProtocols = [],
) {
  const opened = await route.api(
    `/api/workspaces/${workspaceId}/language/sessions`,
    {
      method: "POST",
      body: {
        languageId: spec.sessionLanguage,
        clientId: `load-${randomBytes(4).toString("hex")}`,
      },
    },
  );
  const socket = route.socket(
    `/api/workspaces/${workspaceId}/language/sessions/${opened.sessionId}/stream`,
    extraProtocols,
  );
  await new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
    socket.once("unexpected-response", (_request, response) =>
      fail(new Error(`语言流升级 ${response.statusCode}`)),
    );
  });
  const frames = [];
  const pending = new Map();
  const completionMs = [];
  const errors = new Map();
  const closed = { code: undefined };
  let recording = false;
  let diagnostics = 0;
  socket.on("close", (code) => (closed.code = code));
  socket.on("message", (data) => {
    const text = String(data);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      errors.set("bad frame", (errors.get("bad frame") ?? 0) + 1);
      return;
    }
    let kind;
    if (message.method !== undefined) {
      kind =
        message.id === undefined ? message.method : `request ${message.method}`;
      if (message.method === "textDocument/publishDiagnostics")
        diagnostics += 1;
    } else {
      const request = pending.get(message.id);
      pending.delete(message.id);
      kind = `response ${request?.method ?? "?"}`;
      if (message.error !== undefined) {
        const key = `${request?.method ?? "?"} ${message.error.code}`;
        errors.set(key, (errors.get(key) ?? 0) + 1);
      } else if (
        request?.method === "textDocument/completion" &&
        request.recorded
      ) {
        completionMs.push(performance.now() - request.at);
      }
    }
    if (recording)
      frames.push({
        direction: "down",
        kind,
        bytes: Buffer.byteLength(text),
        at: performance.now(),
      });
  });
  let nextId = 0;
  const send = (message) => {
    const text = JSON.stringify({ jsonrpc: "2.0", ...message });
    if (recording) {
      const kind =
        message.id === undefined ? message.method : `request ${message.method}`;
      frames.push({
        direction: "up",
        kind,
        bytes: Buffer.byteLength(text),
        at: performance.now(),
      });
    }
    socket.send(text);
  };
  const request = (method, params) => {
    nextId += 1;
    pending.set(nextId, { method, at: performance.now(), recorded: recording });
    send({ id: nextId, method, params });
  };

  // 每个编辑器一个文件：同一文件的第二个会话是跟随者，收不到自己的首批诊断。
  const uri = `armadra:///${fileOf(spec, index)}`;
  let text = spec.content;
  let version = 1;
  request("initialize", { processId: null, rootUri: null, capabilities: {} });
  send({ method: "initialized", params: {} });
  send({
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: spec.documentLanguage, version, text },
    },
  });
  // 等首批诊断（真服务器要先建好预编译头），最多 20 秒。
  for (let waited = 0; waited < 20_000 && diagnostics === 0; waited += 100)
    await sleep(100);

  /** 光标：插在正文里那一行的行尾。 */
  const lines = () => text.split("\n");
  let line = lines().findIndex((value) => value.includes(spec.anchor));
  let character = lines()[line].length;
  let changes = [];
  const sync = () => {
    if (changes.length === 0) return;
    version += 1;
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri, version }, contentChanges: changes },
    });
    changes = [];
  };

  /** 打 `seconds` 秒字；每 `hoverEveryMs` 一次悬停。 */
  const type = async (
    profile,
    charsPerSecond,
    seconds,
    hoverEveryMs = 2_000,
  ) => {
    recording = true;
    const started = performance.now();
    const interval = 1000 / charsPerSecond;
    let index = 0;
    let previous = " ";
    let debounce;
    let lastHover = started;
    while (performance.now() - started < seconds * 1000) {
      const char = spec.typing[index % spec.typing.length];
      index += 1;
      const at = { line, character };
      changes.push({ range: { start: at, end: at }, text: char });
      const all = lines();
      all[line] = all[line] + char;
      text = all.join("\n");
      character += 1;
      const actions = keystrokeActions(profile, previous, char);
      previous = char;
      if (actions.change) sync();
      if (actions.completion) {
        const position = { line, character };
        const trigger =
          char === "."
            ? { triggerKind: 2, triggerCharacter: "." }
            : { triggerKind: 1 };
        const fire = () => {
          sync();
          request("textDocument/completion", {
            textDocument: { uri },
            position,
            context: trigger,
          });
        };
        if (profile === "stress") fire();
        else setTimeout(fire, 100);
      }
      clearTimeout(debounce);
      debounce = setTimeout(sync, 150);
      if (performance.now() - lastHover >= hoverEveryMs) {
        lastHover = performance.now();
        request("textDocument/hover", {
          textDocument: { uri },
          position: { line, character: Math.max(0, character - 3) },
        });
      }
      // 一行写满就换行，正文别越写越长。
      if (character > 120) {
        changes.push({
          range: { start: { line, character }, end: { line, character } },
          text: "\n  ",
        });
        const rows = lines();
        rows.splice(line + 1, 0, "  ");
        text = rows.join("\n");
        line += 1;
        character = 2;
      }
      await sleep(interval);
    }
    clearTimeout(debounce);
    sync();
    await sleep(1_000);
    recording = false;
    return (performance.now() - started) / 1000;
  };

  return {
    type,
    frames,
    completionMs,
    errors,
    closed,
    // 直接断开，不走关闭握手：握手的回帧要排在链路积压后面，几秒后才真关上，
    // 会把这一段的积压带进下一段。
    close: () => socket.terminate(),
  };
}

/* ------------------------------ 场景与汇总 ------------------------------ */

const SERVERS = {
  mock: {
    label: "mock-lsp（TypeScript 体积）",
    sessionLanguage: "markdown",
    documentLanguage: "typescript",
    file: "src/main.ts",
    anchor: "// edit here",
    content:
      Array.from(
        { length: 60 },
        (_, index) => `export const value${index} = ${index}; // TODO ${index}`,
      ).join("\n") + "\nexport async function run() {\n  // edit here\n}\n",
    typing: TYPING_TEXT,
  },
  clangd: {
    label: "clangd（真服务器）",
    sessionLanguage: "go",
    documentLanguage: "c",
    file: "main.c",
    anchor: "/* edit here */",
    content:
      "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <time.h>\n\n" +
      "int main(int argc, char **argv) {\n  char buffer[256];\n  int value = 0;\n  /* edit here */\n  return value;\n}\n",
    typing: C_TYPING_TEXT,
  },
};

/** 第 index 个编辑器打开的文件：`src/main.ts` → `src/main-1.ts`。 */
const fileOf = (spec, index) =>
  index === 0 ? spec.file : spec.file.replace(/(\.\w+)$/, `-${index}$1`);

const PROFILES = {
  editor: { profile: "editor", editors: 1, charsPerSecond: 8 },
  stress: { profile: "stress", editors: 3, charsPerSecond: 15 },
};

/**
 * 开 `workload.editors` 个编辑器、一起打 `SECONDS` 秒字。`during` 在开好之后、
 * 开始打字之前调用，答一个打完字时调用的收尾（事件计时只覆盖打字这一段）。
 */
async function runTraffic(
  route,
  workspaceId,
  spec,
  workload,
  protocols,
  during,
) {
  const editors = [];
  for (let index = 0; index < workload.editors; index += 1)
    editors.push(
      await openEditor(route, workspaceId, spec, index, await protocols()),
    );
  const finish = during?.();
  const elapsed = await Promise.all(
    editors.map((editor) =>
      editor.type(workload.profile, workload.charsPerSecond, SECONDS),
    ),
  );
  const finished = await finish?.();
  const frames = editors.flatMap((editor) => editor.frames);
  const summary = summarizeFrames(frames, Math.max(...elapsed));
  summary.completionMs = distribution(
    editors.flatMap((editor) => editor.completionMs).map(round1),
  );
  summary.errors = Object.fromEntries(
    editors.flatMap((editor) => [...editor.errors.entries()]),
  );
  summary.closeCodes = editors.map((editor) => editor.closed.code ?? null);
  for (const editor of editors) editor.close();
  await sleep(300);
  return { summary, finished };
}

function line(summary) {
  const d = summary.down;
  return (
    `下行 ${d.perSecond} 帧/s、${round1(d.bytesPerSecond / 1024)} KiB/s，单帧 p50 ${d.bytes.p50} B / p95 ${d.bytes.p95} B / max ${d.bytes.max} B，` +
    `100 ms 峰值 ${d.burst100ms.frames} 帧 ${round1(d.burst100ms.bytes / 1024)} KiB；上行 ${summary.up.perSecond} 帧/s；` +
    `补全往返 p50 ${summary.completionMs.p50} ms / p95 ${summary.completionMs.p95} ms`
  );
}

/** 事件延迟：只有事件流，或者同时跑一组语言负载。 */
async function eventLatency(
  route,
  core,
  workspaceId,
  boardId,
  protocols,
  load,
) {
  const events = await subscribeEvents(route, workspaceId, await protocols());
  let traffic = null;
  let latency;
  if (load) {
    const ran = await runTraffic(
      route,
      workspaceId,
      load.spec,
      load.workload,
      protocols,
      () => {
        const ticker = eventTicker(core, workspaceId, boardId, events);
        return () => ticker.stop();
      },
    );
    traffic = ran.summary;
    latency = ran.finished;
  } else {
    const ticker = eventTicker(core, workspaceId, boardId, events);
    await sleep(SECONDS * 1000);
    latency = await ticker.stop();
  }
  latency.closeCode = events.closed.code ?? null;
  events.close();
  await route.drained?.();
  return { events: latency, traffic };
}

/* --------------------------------- 中继 ---------------------------------- */

function relayCall(issuer, ca, method, path, { body, token, headers } = {}) {
  const url = new URL(path, issuer);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((done, fail) => {
    const request = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        ca,
        headers: {
          accept: "application/json",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(headers ?? {}),
        },
        timeout: 15_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            /* 原文 */
          }
          if ((response.statusCode ?? 0) >= 400)
            fail(
              new Error(
                `${method} ${path} → ${response.statusCode} ${text.slice(0, 200)}`,
              ),
            );
          else done(parsed);
        });
        response.on("error", fail);
      },
    );
    request.on("timeout", () => request.destroy(new Error("中继调用超时")));
    request.on("error", fail);
    request.end(payload);
  });
}

/**
 * 起个人中转（init + serve，自签 TLS）、把 core 登记上去并绑主人，再以原生
 * 客户端的身份经中继拿 core 会话。答经中继的来路。
 */
async function startRelay(core, cloudHome) {
  const scratch = mkdtempSync(join(tmpdir(), "armadra-language-load-relay-"));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  const relayData = join(scratch, "relay");
  const passwordFile = join(scratch, "relay.password");
  const password = randomBytes(18).toString("base64url");
  writeFileSync(passwordFile, password, { mode: 0o600 });
  const port = await new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => done(free));
    });
  });
  const issuer = `https://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  const relayCli = (rest) =>
    spawn(process.execPath, ["apps/relay/src/cli.ts", "personal", ...rest], {
      cwd: cloudHome,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  const common = [
    "--data-dir",
    relayData,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--tls",
    "self-signed",
  ];
  const init = relayCli([
    "init",
    ...common,
    "--account",
    "dev",
    "--password-file",
    passwordFile,
  ]);
  const initCode = await new Promise((done) => init.once("exit", done));
  if (initCode !== 0) throw new Error(`personal init 退出码 ${initCode}`);
  const serve = relayCli(["serve", ...common, "--log-level", "warn"]);
  let relayLog = "";
  serve.stdout.on(
    "data",
    (chunk) => (relayLog = (relayLog + chunk).slice(-20_000)),
  );
  serve.stderr.on(
    "data",
    (chunk) => (relayLog = (relayLog + chunk).slice(-20_000)),
  );
  cleanups.push(() => serve.kill("SIGKILL"));
  const ca = readFileSync(join(relayData, "tls", "ca.crt"), "utf8");
  const fingerprint = createHash("sha256")
    .update(new X509Certificate(ca).raw)
    .digest("hex");
  const call = (method, path, options) =>
    relayCall(issuer, ca, method, path, options);
  for (let attempt = 0; ; attempt += 1) {
    if (serve.exitCode !== null) throw new Error(`中继退出：${relayLog}`);
    try {
      await call("GET", "/.well-known/armadra-platform");
      break;
    } catch (error) {
      if (attempt > 150) throw error;
      await sleep(200);
    }
  }

  // core 侧：本机主人会话 → 登记远程服务 → 注册 → 隧道 ready → 绑主人。
  const session = await probeSession({ dataDir: core.data, base: core.origin });
  const owner = async (path, body) => {
    const answer = await session.fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(`${path} → ${answer.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  await owner("/api/rpc/sources/remoteAdd", {
    json: { kind: "personal", issuer, account: "dev", password, fingerprint },
  });
  const device = { platform: "desktop", name: "language-load" };
  const login = await call("POST", "/v1/auth/login", {
    body: { account: "dev", password, device },
  });
  const cloudToken = login.session.accessToken;
  const { registrationToken } = await call(
    "POST",
    "/v1/sources/registration-tokens",
    {
      body: {},
      token: cloudToken,
    },
  );
  await owner("/api/identity/cloud/register", {
    issuer,
    registrationToken,
    label: "language-load",
  });
  let sourceId;
  for (let attempt = 0; attempt < 150 && !sourceId; attempt += 1) {
    const status = await owner("/api/identity/cloud");
    if (status.registrations?.[0]?.tunnel?.state === "ready")
      sourceId = status.sourceId;
    else await sleep(200);
  }
  if (!sourceId) throw new Error("隧道没有 ready");
  const bound = await call("POST", `/v1/sources/${sourceId}/assertion`, {
    body: { device },
    token: cloudToken,
  });
  await owner("/api/identity/cloud/bind", { assertion: bound.assertion });

  // 客户端侧：断言 + 中继令牌 → 经中继 cloud/login 换 core 会话（原生客户端的来源）。
  const nativeOrigin = "https://localhost";
  const access = await call("POST", `/v1/sources/${sourceId}/assertion`, {
    body: { device },
    token: cloudToken,
  });
  const relayToken = access.relayToken;
  const base = `/s/${sourceId}`;
  const coreLogin = await call("POST", `${base}/api/identity/cloud/login`, {
    body: { assertion: access.assertion },
    headers: { origin: nativeOrigin, "armadra-relay-token": relayToken },
  });
  const accessToken = coreLogin.session.native.accessToken;
  const headers = { origin: nativeOrigin, "armadra-relay-token": relayToken };
  const api = (path, init = {}) =>
    call(init.method ?? "GET", `${base}${path}`, {
      body: init.body,
      token: accessToken,
      headers,
    });
  const protocols = async () => {
    const { ticket } = await api("/api/identity/ws-ticket", {
      method: "POST",
      body: {},
    });
    return [`armadra-ticket.${ticket}`, `armadra-relay.${relayToken}`];
  };
  /** 经中继的来路；`socketOrigin` 给了就让 WebSocket 先过塑形代理（TLS 原样透传）。 */
  const routeVia = (socketOrigin = issuer) => ({
    name: "relay",
    api,
    socket: (path, list = []) =>
      new WebSocket(
        `${socketOrigin.replace(/^https?/, "wss")}${base}${path}`,
        list,
        {
          ca,
          servername: "",
          origin: nativeOrigin,
          maxPayload: 64 * 1024 * 1024,
        },
      ),
  });
  return {
    issuer,
    route: routeVia(),
    routeVia,
    protocols,
    log: () => relayLog,
  };
}

/* --------------------------------- 主线 ---------------------------------- */

function findClangd() {
  if (flag("no-clangd")) return undefined;
  try {
    const found = execFileSync("sh", ["-c", "command -v clangd"], {
      encoding: "utf8",
    }).trim();
    return found || undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const core = await startCore();
  const api = directApi(core.origin);
  console.log(`core ${core.origin}`);
  const project = mkdtempSync(join(tmpdir(), "armadra-language-load-project-"));
  cleanups.push(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, "src"), { recursive: true });
  for (const spec of Object.values(SERVERS))
    for (let index = 0; index < PROFILES.stress.editors; index += 1)
      writeFileSync(join(project, fileOf(spec, index)), spec.content);
  const workspace = await api("/api/workspaces", {
    method: "POST",
    body: {
      name: "语言负载",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    },
  });
  const boards = await api(`/api/workspaces/${workspace.id}/boards`);
  const boardId = boards[0].id;

  const clangd = findClangd();
  await api("/api/settings", {
    method: "PATCH",
    body: {
      language: {
        servers: {
          marksman: { path: process.execPath, args: MOCK_ARGS },
          ...(clangd ? { gopls: { path: clangd, args: ["--log=error"] } } : {}),
        },
      },
    },
  });
  // 开会话只认缓存的探测结果；列表这一下会探测并写回设置。
  const listed = await api(`/api/workspaces/${workspace.id}/language-service`);
  report.services = JSON.stringify(listed).slice(0, 2000);
  report.clangd = clangd ?? null;
  if (clangd) {
    try {
      report.clangdVersion = execFileSync(clangd, ["--version"], {
        encoding: "utf8",
      }).split("\n")[0];
    } catch {
      /* 版本只是记一笔 */
    }
  }
  const direct = directRoute(core.origin);
  const none = async () => [];

  /* A. 语言流本身 */
  const servers = clangd ? ["mock", "clangd"] : ["mock"];
  for (const server of phase("A") ? servers : []) {
    for (const [name, workload] of Object.entries(PROFILES)) {
      const { summary } = await runTraffic(
        direct,
        workspace.id,
        SERVERS[server],
        workload,
        none,
      );
      report.traffic[`${server}/${name}`] = summary;
      console.log(`A ${SERVERS[server].label} ${name}：${line(summary)}`);
    }
  }

  /* B. 回环上与控制面混跑（现状：独立连接） */
  const mixed = async (key, route, protocols, load) => {
    const result = await eventLatency(
      route,
      api,
      workspace.id,
      boardId,
      protocols,
      load,
    );
    report.mixed[key] = result;
    console.log(
      `${key}：事件延迟 p50 ${result.events.p50} ms / p95 ${result.events.p95} ms / max ${result.events.max} ms（${result.events.count} 次，丢 ${result.events.lost}）` +
        (result.traffic
          ? `；补全 p95 ${result.traffic.completionMs.p95} ms`
          : ""),
    );
    return result;
  };
  if (phase("B")) {
    await mixed("B 回环 仅事件", direct, none, null);
    await mixed("B 回环 事件 + 语言 stress", direct, none, {
      spec: SERVERS.mock,
      workload: PROFILES.stress,
    });
  }

  /* C. 共享瓶颈：fair（独立连接）对 fifo（并进一条） */
  report.link = {};
  for (const mode of phase("C") ? ["fair", "fifo"] : []) {
    const shaper = await startShaper(core.origin, mode);
    const route = {
      ...directRoute(core.origin, shaper.origin),
      drained: shaper.drained,
    };
    const run = async (key, load) => {
      const result = await eventLatency(
        route,
        api,
        workspace.id,
        boardId,
        none,
        load,
      );
      report.link[`${mode} ${key}`] = result;
      console.log(
        `C ${mode} ${key}：事件延迟 p50 ${result.events.p50} ms / p95 ${result.events.p95} ms / max ${result.events.max} ms（丢 ${result.events.lost}）` +
          (result.traffic
            ? `；补全 p95 ${result.traffic.completionMs.p95} ms，下行 ${round1(result.traffic.down.bytesPerSecond / 1024)} KiB/s`
            : ""),
      );
    };
    if (mode === "fair") await run("仅事件", null);
    await run("语言 editor", { spec: SERVERS.mock, workload: PROFILES.editor });
    await run("语言 stress", { spec: SERVERS.mock, workload: PROFILES.stress });
    if (clangd) {
      await run("clangd editor", {
        spec: SERVERS.clangd,
        workload: PROFILES.editor,
      });
      await run("clangd stress", {
        spec: SERVERS.clangd,
        workload: PROFILES.stress,
      });
    }
    shaper.stop();
  }

  /* D. 经个人中转 */
  if (phase("D") && flag("relay")) {
    const cloudHome = findCloudSource();
    if (!cloudHome) {
      report.notes.push("没有 armadra-cloud 的本地检出，跳过中继一段");
      console.log("D 跳过：没有 armadra-cloud 的本地检出");
    } else {
      const relay = await startRelay(core, cloudHome);
      report.relay = {};
      for (const [key, load] of [
        ["仅事件", null],
        ["语言 editor", { spec: SERVERS.mock, workload: PROFILES.editor }],
        ["语言 stress", { spec: SERVERS.mock, workload: PROFILES.stress }],
      ]) {
        const result = await eventLatency(
          relay.route,
          api,
          workspace.id,
          boardId,
          relay.protocols,
          load,
        );
        report.relay[key] = result;
        console.log(
          `D 中继 ${key}：事件延迟 p50 ${result.events.p50} ms / p95 ${result.events.p95} ms / max ${result.events.max} ms（丢 ${result.events.lost}）` +
            (result.traffic
              ? `；${line(result.traffic)}；关流码 ${JSON.stringify(result.traffic.closeCodes)}`
              : ""),
        );
      }
      // 中继 + 共享瓶颈：客户端到中继这一段过塑形代理。
      for (const mode of ["fair", "fifo"]) {
        const shaper = await startShaper(relay.issuer, mode);
        const route = {
          ...relay.routeVia(shaper.origin),
          drained: shaper.drained,
        };
        for (const [key, load] of [
          ["仅事件", null],
          ["语言 editor", { spec: SERVERS.mock, workload: PROFILES.editor }],
        ]) {
          if (mode === "fifo" && load === null) continue;
          const result = await eventLatency(
            route,
            api,
            workspace.id,
            boardId,
            relay.protocols,
            load,
          );
          report.relay[`${mode} ${key}`] = result;
          console.log(
            `D 中继 + 瓶颈 ${mode} ${key}：事件延迟 p50 ${result.events.p50} ms / p95 ${result.events.p95} ms / max ${result.events.max} ms（丢 ${result.events.lost}）` +
              (result.traffic
                ? `；补全 p95 ${result.traffic.completionMs.p95} ms`
                : ""),
          );
        }
        shaper.stop();
      }
    }
  }

  report.status = "passed";
  if (flag("check")) check();
}

/** 与基线比 mock 档的帧体积（确定性的那部分）。 */
function check() {
  const baseline = JSON.parse(
    readFileSync(
      join(root, "tools/probes/language-load-baseline.json"),
      "utf8",
    ),
  );
  const failures = [];
  for (const [key, expected] of Object.entries(baseline.traffic)) {
    const got = report.traffic[key];
    if (!got) continue;
    for (const metric of ["p50", "p95", "max"]) {
      const want = expected.downBytes[metric];
      const have = got.down.bytes[metric];
      if (Math.abs(have - want) > want * 0.2)
        failures.push(
          `${key} 下行单帧 ${metric}：基线 ${want} B，本次 ${have} B`,
        );
    }
  }
  report.check = failures;
  if (failures.length > 0) {
    report.status = "failed";
    console.error(failures.join("\n"));
  }
}

try {
  await main();
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error(report.error);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      /* 清理尽力而为 */
    }
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(
    join(output, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`结果：${join(output, "result.json")}（${report.status}）`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
