// 自己起一套 core 的场景（9、11、12）共用的装配，以及 ACP 的探测与驱动辅助。
// 由 lib.mjs 再导出（`acpAdapterInstalled`、`promptViaApi`、`canvasAsIn` …）。
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

import { opencodeBinary, which } from "./cli-homes.mjs";
import { cleanups, note, output, root, waitFor } from "./lib.mjs";

/* ------------------- 自己起一套 core 的场景（9、11、12） ------------------- */

/**
 * 在 `data` 上起一个 core（`environment` 原样给它），等 `endpoints.json`。答
 * `{ api, origin, process }`；`api(path, { method, body })` 的 body 是对象。
 */
export async function startIsolatedCore({ data, environment, logName }) {
  const binary = join(root, "apps/desktop/out/core/main.js");
  if (!existsSync(binary)) throw new Error(`core 未构建：${binary}`);
  const log = createWriteStream(join(output, logName));
  const core = spawn(
    process.execPath,
    [binary, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: environment },
  );
  cleanups.push(() => core.kill("SIGKILL"));
  cleanups.push(() => {
    try {
      execFileSync("tmux", ["-S", join(data, "tmux.sock"), "kill-server"], {
        stdio: "ignore",
      });
    } catch {}
  });
  core.stdout.pipe(log);
  core.stderr.pipe(log);
  const origin = await waitFor(
    "core 就绪",
    () => {
      if (core.exitCode !== null) throw new Error(`core 退出，见 ${logName}`);
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
  return { api, origin, process: core };
}

/**
 * 以某个节点的身份跑 `armadra-hook <argv…>`：只换 `ARMADRA_NODE_ID`，节点令牌由
 * core 在会话装起来时写好。`context` 是 `{ hook, data, home }`（hook 是
 * `out/cli/armadra-hook.js`）。答 `{ code, stdout, stderr }`。
 */
export function hookIn(context, nodeId, argv) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [context.hook, ...argv],
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
        note(`${argv.slice(0, 2).join(" ")}（${nodeId.slice(0, 8)}）`, {
          code: error ? (error.code ?? 1) : 0,
          out: (stdout || stderr).trim().slice(0, 300),
        });
        done({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}
/** `armadra-hook canvas <verb> …`，以 `nodeId` 的身份。 */
export const canvasAsIn = (context, nodeId, verb, ...args) =>
  hookIn(context, nodeId, ["canvas", verb, ...args]);
/** `armadra-hook context <verb> …`（读连线那头），以 `nodeId` 的身份。 */
export const contextAsIn = (context, nodeId, verb, ...args) =>
  hookIn(context, nodeId, ["context", verb, ...args]);

/* --------------------------------- ACP ---------------------------------- */

/** 六家的 ACP 入口（与 `core/acp/adapters.ts` 同表；`adapters.test.ts` 守着那一份）。 */
export const ACP_PROGRAMS = {
  claude: "claude-agent-acp",
  codex: "codex-acp",
  opencode: "opencode",
  pi: "pi-acp",
  omp: "omp",
  copilot: "copilot",
};

/**
 * 这一家的 ACP 入口装了没有：在探针自己的 PATH 上找（不经 core）。答
 * `{ installed, program, path? }`。OpenCode 认包里的原生二进制（npm 包装脚本没
 * 跑 postinstall 起不来，见场景 6）。
 */
export function acpAdapterInstalled(id) {
  const program = ACP_PROGRAMS[id];
  if (program === undefined) return { installed: false, program: id };
  const path = id === "opencode" ? opencodeBinary() : which(program);
  return path === undefined
    ? { installed: false, program }
    : { installed: true, program, path };
}

/** 经 `POST /api/acp/sessions/{id}/prompt` 发一句（与页面输入框同一条路）。 */
export function promptViaApi(api, sessionId, text) {
  return api(`/api/acp/sessions/${sessionId}/prompt`, {
    method: "POST",
    body: { text },
  });
}

/**
 * 订阅一个工作空间的事件流（`/api/workspaces/{id}/events`，页面用的那一条）。
 * 每帧解析成 JSON 交给 `onEvent`（事件可能包在 `event` 里，原样给）；答
 * `{ close }`，并登记进收尾。
 */
export async function watchWorkspaceEvents(origin, workspaceId, onEvent) {
  // 升级请求必须带一个回环的 Origin（`http/server.ts` 第 1 层）：Node 自带的
  // WebSocket 不带，用 desktop 依赖里的 `ws`。
  const { WebSocket } = createRequire(join(root, "apps/desktop/package.json"))(
    "ws",
  );
  const url = `${origin.replace(/^http/u, "ws")}/api/workspaces/${workspaceId}/events`;
  const socket = new WebSocket(url, { headers: { origin } });
  await new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
    socket.once("unexpected-response", (_request, response) =>
      fail(new Error(`事件流升级被拒：HTTP ${response.statusCode}`)),
    );
  });
  socket.on("message", (data) => {
    try {
      const frame = JSON.parse(String(data));
      onEvent(frame?.event ?? frame);
    } catch {}
  });
  const close = () => {
    try {
      socket.terminate();
    } catch {}
  };
  cleanups.push(close);
  return { close };
}

/* ------------------------------ 拦住真 CLI ------------------------------- */

/** 会起真模型、读真账号的程序名：终端驱动的六家与三个 ACP 适配器。 */
export const REAL_CLI_PROGRAMS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
  "claude-agent-acp",
  "codex-acp",
  "pi-acp",
];

/**
 * 在 `dir` 里给每个真 CLI 写一个替身：只往 `log` 追加一行 `<程序> <参数>`，以
 * 97 退出。`dir` 排在 core 的 PATH 最前面（`agentPath` 保留环境里的顺序），于是
 * 这套 core 起的任何节点、ACP 会话或依赖启动都碰不到真 CLI；`keep` 里的名字不
 * 写（场景 12 真跑时由隔离包装脚本占住）。答 `blocked()`：被拦下的调用——
 * core 开场探 `--version` 的那几次不算（它们只读版本、不起会话），其余每一次
 * 都是「有东西想起真 CLI」。
 */
export function blockRealClis(dir, log, keep = []) {
  mkdirSync(dir, { recursive: true });
  for (const program of REAL_CLI_PROGRAMS) {
    if (keep.includes(program)) continue;
    const path = join(dir, program);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s %s\\n' ${JSON.stringify(program)} "$*" >> ${JSON.stringify(log)}\necho "agent-e2e: ${program} 在这套 core 里被拦下（不起真 CLI）" >&2\nexit 97\n`,
    );
    chmodSync(path, 0o755);
  }
  return () => {
    try {
      return readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "" && !/^\S+ --version$/.test(line));
    } catch {
      return [];
    }
  };
}

/* --------------------------- 页面（Vite + Chrome） --------------------------- */

/**
 * 给自己起的那套 core 配一个页面：Vite（代理目标按 `environment` 里的
 * `ARMADRA_DATA_DIR` 读）与新 profile 的无头 Chrome（`shell-e2e-lib.mjs`）。
 * Vite 自成进程组，收尾整组杀掉（只杀 pnpm 会留下孤儿开发服务器）。答
 * `{ web, open(name) }`，`open` 给 shell-e2e-lib 的页面对象。
 */
export async function startPageStack(environment) {
  const { freePort: free, startChrome } = await import("../shell-e2e-lib.mjs");
  const port = await free();
  const vite = spawn(
    "pnpm",
    [
      "--filter",
      "@armadra/web",
      "exec",
      "vite",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
      detached: true,
    },
  );
  cleanups.push(() => {
    try {
      process.kill(-vite.pid, "SIGKILL");
    } catch {
      vite.kill("SIGKILL");
    }
  });
  let served = false;
  vite.stdout.on("data", (chunk) => {
    if (String(chunk).includes("ready in")) served = true;
  });
  await waitFor("Vite 就绪", () => served || vite.exitCode !== null, {
    timeout: 90_000,
    interval: 100,
  });
  if (vite.exitCode !== null) throw new Error("Vite 退出");
  const shots = [];
  const h = {
    cleanups,
    report: { output, shots },
    temp(prefix) {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      cleanups.push(() =>
        rmSync(directory, { recursive: true, force: true, maxRetries: 20 }),
      );
      return directory;
    },
  };
  const chrome = await startChrome(h);
  return {
    web: `http://127.0.0.1:${port}`,
    shots,
    open: (name = "page") => chrome.open({ name, width: 1600, height: 1000 }),
  };
}
