#!/usr/bin/env node
/**
 * 终端程序自报的状态（契约 §53）：端到端。
 *
 * 起一个真 core（临时数据目录、临时 HOME、`ARMADRA_NO_GLOBAL_WRITES=1`），
 * 按后端各跑一遍：在终端里 `printf` OSC 7501 / OSC 9;4，断言工作空间事件流上
 * 出现对应的 `terminal.program` 帧。
 *
 * 终端以 Agent 终端开（tmux 只给 Agent 会话开 tap，契约 §54）。
 *
 * - tmux：序列被 tmux 吞掉，靠 `pipe-pane` 读到；关掉终端的 socket 之后再用
 *   tmux 自己的 `send-keys` 打字，证明没有人看着的时候状态照样更新。程序发
 *   `OSC 7501 ; ?`，core 把回应写进它的输入。
 * - direct：同一组断言，pty 的每一次读都直接交给解析器。
 *
 * 用法：`node tools/probes/core-terminal-program-status.mjs [--backend tmux|direct]`
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  WORKSPACE,
  collect,
  openSocket,
  seedWorkspace,
  startCore,
} from "./core-terminal-smoke.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const require = createRequire(join(repo, "apps/desktop/package.json"));
const { WebSocket } = require("ws");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function eventsSocket(ws) {
  const socket = new WebSocket(`${ws}/api/workspaces/${WORKSPACE}/events`, {
    origin: "http://127.0.0.1:1420",
  });
  const frames = [];
  socket.on("message", (data) => {
    try {
      const frame = JSON.parse(data.toString("utf8"));
      frames.push(frame.event ?? frame);
    } catch {
      // 非 JSON 的心跳帧。
    }
  });
  return {
    socket,
    opened: new Promise((done, fail) => {
      socket.once("open", done);
      socket.once("error", fail);
    }),
    async waitFor(predicate, what, timeout = 10_000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (Date.now() > deadline)
          throw new Error(
            `等不到 ${what}；收到的 terminal.program：${JSON.stringify(
              frames.filter((frame) => frame.type === "terminal.program"),
            )}`,
          );
        await delay(50);
      }
    },
    frames,
  };
}

/**
 * 一个 Agent 终端：tmux 后端只给 Agent 会话开程序状态的 tap（契约 §54）。节点
 * 不必在画布上；`/bin/sh` 照样是 shell，只是带上了 Agent 的环境变量。
 */
const agentTerminal = (dataDir) => ({
  workspaceId: WORKSPACE,
  cwd: dataDir,
  shell: "/bin/sh",
  nodeId: randomUUID(),
  agent: { id: "claude" },
});

const programFrame = (sessionId, check) => (frame) =>
  frame.type === "terminal.program" &&
  frame.sessionId === sessionId &&
  check(frame.status);

async function runBackend(backend) {
  const dataDir = mkdtempSync(join(tmpdir(), `armadra-program-${backend}-`));
  writeFileSync(
    join(dataDir, "worker-settings.json"),
    JSON.stringify({ terminal: { backend } }, null, 2),
    "utf8",
  );
  // 探针起的 core 不写这台机器上任何全局的东西（CLI 配置、登录项）。
  process.env.ARMADRA_NO_GLOBAL_WRITES = "1";
  const core = await startCore({ dataDir });
  let failure;
  try {
    seedWorkspace(dataDir);
    const events = eventsSocket(core.ws);
    await events.opened;

    const created = await fetch(`${core.base}/api/terminals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(agentTerminal(dataDir)),
    });
    const session = await created.json();
    assert(created.ok, `create failed: ${JSON.stringify(session)}`);
    assert(
      session.backend === backend,
      `backend 是 ${session.backend}，要的是 ${backend}`,
    );

    const terminal = openSocket(core.ws, session.id);
    const frames = collect(terminal);
    await new Promise((done) => terminal.once("open", done));
    await frames.waitFor((frame) => frame.type === "hello");
    let inputId = 0;
    const type = async (line) => {
      inputId += 1;
      terminal.send(
        JSON.stringify({ type: "input", data: `${line}\r`, inputId }),
      );
      await frames.waitFor(
        (frame) => frame.type === "ack" && frame.inputId === inputId,
      );
    };

    await type(
      "printf '\\033]7501;state=working:app=probe:progress=40\\033\\\\'",
    );
    await events.waitFor(
      programFrame(
        session.id,
        (status) =>
          status?.state === "working" &&
          status.progress === 40 &&
          status.app === "probe" &&
          status.source === "osc7501",
      ),
      "working 40%",
    );
    console.log(`[${backend}] OSC 7501 working 40% → terminal.program`);

    // 程序问支不支持；core 的回应进它的输入，`dd` 读回 10 个字节，`tr` 把 ESC
    // 与 `\` 换成可见字符。查询从后台子 shell 发，读 tty 的那个留在前台。
    await type(
      "(sleep 0.5; printf '\\033]7501;?\\033\\\\') & stty -icanon -echo min 10; dd bs=10 count=1 2>/dev/null | tr '\\033\\\\' 'EB'; stty sane",
    );
    await frames.waitFor(
      (frame) => frame.type === "output" && frame.data.includes("E]7501;?EB"),
    );
    console.log(`[${backend}] OSC 7501 ; ? 得到了回应`);

    if (backend === "tmux") {
      terminal.close();
      await delay(300);
      const tmux = (...args) =>
        execFileSync("tmux", ["-S", join(dataDir, "tmux.sock"), ...args], {
          encoding: "utf8",
        }).trim();
      const name = tmux("list-sessions", "-F", "#{session_name}")
        .split("\n")
        .find((line) => line.startsWith("armadra-"));
      assert(name, "tmux 里没有这个会话");
      tmux(
        "send-keys",
        "-t",
        name,
        "printf '\\033]7501;state=blocked:kind=question\\033\\\\'",
        "Enter",
      );
      await events.waitFor(
        programFrame(
          session.id,
          (status) => status?.state === "blocked" && status.kind === "question",
        ),
        "blocked（没有附着）",
      );
      console.log("[tmux] 没有附着时 blocked 照样到了");
      tmux(
        "send-keys",
        "-t",
        name,
        "printf '\\033]7501;state=clear\\033\\\\'",
        "Enter",
      );
    } else {
      await type("printf '\\033]7501;state=blocked:kind=question\\033\\\\'");
      await events.waitFor(
        programFrame(
          session.id,
          (status) => status?.state === "blocked" && status.kind === "question",
        ),
        "blocked",
      );
      await type("printf '\\033]7501;state=clear\\033\\\\'");
      terminal.close();
    }
    await events.waitFor(
      (frame) =>
        frame.type === "terminal.program" &&
        frame.sessionId === session.id &&
        frame.status === undefined,
      "clear",
    );
    console.log(`[${backend}] clear 之后不再有记录`);

    // 没收到过 OSC 7501 的新终端里，OSC 9;4 映射到根记录。
    const second = await fetch(`${core.base}/api/terminals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(agentTerminal(dataDir)),
    }).then((answer) => answer.json());
    const progressSocket = openSocket(core.ws, second.id);
    const progressFrames = collect(progressSocket);
    await new Promise((done) => progressSocket.once("open", done));
    await progressFrames.waitFor((frame) => frame.type === "hello");
    progressSocket.send(
      JSON.stringify({
        type: "input",
        data: "printf '\\033]9;4;1;55\\007'\r",
        inputId: 1,
      }),
    );
    await events.waitFor(
      programFrame(
        second.id,
        (status) =>
          status?.state === "working" &&
          status.progress === 55 &&
          status.source === "osc9",
      ),
      "OSC 9;4 55%",
    );
    console.log(`[${backend}] OSC 9;4 55% → terminal.program`);
    progressSocket.close();
    events.socket.close();
    console.log(`[${backend}] OK`);
  } catch (error) {
    failure = new Error(
      `${error.message}\n--- core log ---\n${core.stderr().slice(-4000)}`,
    );
  } finally {
    await core.stop();
    try {
      execFileSync("tmux", ["-S", join(dataDir, "tmux.sock"), "kill-server"], {
        stdio: "ignore",
      });
    } catch {
      // `exit-empty on` usually got there first.
    }
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 20 });
    } catch {
      // Left for the OS.
    }
  }
  if (failure) throw failure;
}

async function main() {
  const flag = process.argv.indexOf("--backend");
  const only = flag === -1 ? undefined : process.argv[flag + 1];
  const backends = only ? [only] : ["tmux", "direct"];
  for (const backend of backends) await runBackend(backend);
  console.log("\nOK");
}

if (process.platform === "win32") {
  console.log("跳过：探针用 /bin/sh 与 tmux，Windows 的会话宿主另有验收。");
} else {
  main().catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}
