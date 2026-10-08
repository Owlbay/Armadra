#!/usr/bin/env node
/**
 * 并发启动多个 Codex（界面第二波 §8、契约 §52）的端到端探针。
 *
 * 不用真 CLI、不碰任何账号：`codex` 是本脚本写进临时目录的一个假程序，模拟
 * 真 Codex 启动时的两件事——
 *
 *   * 慢启动：自举要 2.5 s；
 *   * 共享状态的并发上限：同一个 `CODEX_HOME` 上同时只容得下两个在自举（真机上
 *     是状态库迁移与账号路由探测），第三个直接以「routing discovery timed out」
 *     退出 1。
 *
 * 两段：
 *
 *   A. 不过闸门，三个终端同时敲启动行：复现「同时起 3 个、第 3 个失败」，并且
 *      `launch-result` 把那一个判成 `failed`、另两个 `started`；
 *   B. 每个终端先 `launch-slot` 再敲：闸门一个一个放（间隔 ≥ 500 ms），三个都
 *      `started`，全部自举成功。
 *
 * 隔离：临时数据目录、临时 HOME（`probe-home.mjs`）、`ARMADRA_NO_GLOBAL_WRITES=1`、
 * 明文文件密钥后端（不碰钥匙串）、自己的 tmux socket；收尾只按会话结束自己起的终端并删临时目录。
 *
 *   pnpm libs:build && pnpm --filter @armadra/desktop build
 *   node tools/probes/launch-concurrency.mjs
 *
 * 全程约 80 s（`launch-result` 看满 30 s 的窗口才答 `started`）。
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { collect, openSocket, seedWorkspace } from "./core-terminal-smoke.mjs";
import { isolatedEnv, probeHome } from "./probe-home.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const coreEntry = join(repo, "apps/desktop/out/core/main.js");
const WORKSPACE = "00000000-0000-0000-0000-0000000000ab";

/**
 * 假 Codex：自举槽两个，慢启动 2.5 s，起来之后一直在前台。共享状态目录写死在
 * 脚本里（相当于同一个 `CODEX_HOME`），不依赖终端环境怎么传变量。
 */
const fakeCodex = (home) => `#!${process.execPath}
const { mkdirSync, rmdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const home = ${JSON.stringify(home)};
const label = process.argv[2] || "anon";
let slot;
for (const name of ["bootstrap-slot-0", "bootstrap-slot-1"]) {
  try { mkdirSync(join(home, name)); slot = join(home, name); break; } catch {}
}
if (slot === undefined) {
  console.error("account/read failed during TUI bootstrap: workspace routing discovery timed out");
  process.exit(1);
}
setTimeout(() => {
  rmdirSync(slot);
  writeFileSync(join(home, "started-" + label), String(Date.now()));
  console.log("fake codex ready");
  setInterval(() => {}, 1 << 30);
}, 2500);
`;

async function startCore(dataDir, extra) {
  const home = probeHome("armadra-launch-gate-home-");
  const child = spawn(
    process.execPath,
    [coreEntry, "--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: isolatedEnv(home, {
        ARMADRA_DATA_DIR: dataDir,
        ARMADRA_NO_GLOBAL_WRITES: "1",
        // 不碰系统钥匙串：密钥落临时数据目录。
        ARMADRA_SECRET_BACKEND: "file",
        ...extra,
      }),
    },
  );
  child.once("exit", () => home.remove());
  let stderr = "";
  child.stderr.setEncoding("utf8");
  const address = await new Promise((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`core did not announce:\n${stderr}`)),
      20_000,
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const found = /Armadra core is listening .*"spec":"tcp:([^"]+)"/.exec(
        stderr,
      );
      if (found) {
        clearTimeout(timer);
        done(found[1]);
      }
    });
    child.stdout.resume();
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`core exited with ${code}:\n${stderr}`));
    });
  });
  return {
    base: `http://${address}`,
    ws: `ws://${address}`,
    stderr: () => stderr,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((done) => child.once("exit", done));
    },
  };
}

async function post(core, path, body) {
  const response = await fetch(`${core.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok)
    throw new Error(`${path} → ${response.status} ${JSON.stringify(json)}`);
  return json;
}

/** 给一个节点开终端、连上、等提示符安静。 */
async function openNode(core, dataDir, nodeId) {
  const session = await post(core, "/api/terminals", {
    workspaceId: WORKSPACE,
    cwd: dataDir,
    shell: "/bin/sh",
    nodeId,
    agentId: "codex",
  });
  const socket = openSocket(core.ws, session.id, `probe-${nodeId}`);
  const frames = collect(socket);
  await new Promise((done) => socket.once("open", done));
  await frames.waitFor((frame) => frame.type === "hello");
  await delay(600);
  let input = 0;
  return {
    nodeId,
    sessionId: session.id,
    screen: () => frames.text(),
    type(line) {
      input += 1;
      socket.send(
        JSON.stringify({ type: "input", data: `${line}\r`, inputId: input }),
      );
    },
    async close() {
      socket.close();
      await post(core, `/api/terminals/${session.id}/terminate`, {
        mode: "session",
      }).catch(() => undefined);
    },
  };
}

function clearSlots(codexHome) {
  for (const entry of readdirSync(codexHome)) {
    if (entry.startsWith("bootstrap-slot-"))
      rmSync(join(codexHome, entry), { recursive: true, force: true });
  }
}

async function main() {
  if (!existsSync(coreEntry)) {
    throw new Error(
      `${coreEntry} 不存在：先跑 pnpm libs:build && pnpm --filter @armadra/desktop build`,
    );
  }
  const root = mkdtempSync(join(tmpdir(), "armadra-launch-gate-"));
  const dataDir = join(root, "data");
  const codexHome = join(root, "codex-home");
  const bin = join(root, "bin");
  for (const directory of [dataDir, codexHome, bin]) mkdirSync(directory);
  const fake = join(bin, "codex");
  writeFileSync(fake, fakeCodex(codexHome));
  chmodSync(fake, 0o755);

  const core = await startCore(dataDir, { CODEX_HOME: codexHome });
  const nodes = [];
  let failure;
  try {
    seedWorkspace(dataDir, WORKSPACE);
    const target = (nodeId) => ({
      workspaceId: WORKSPACE,
      nodeId,
      agentId: "codex",
    });

    /* ------------------------- A：同时敲，第 3 个失败 ------------------------ */
    const plain = [];
    for (let index = 0; index < 3; index += 1) {
      plain.push(await openNode(core, dataDir, randomUUID()));
    }
    nodes.push(...plain);
    plain.forEach((node, index) => node.type(`'${fake}' a${index + 1}`));
    const before = await Promise.all(
      plain.map((node) =>
        post(core, "/api/agents/launch-result", {
          ...target(node.nodeId),
          attempt: 1,
        }),
      ),
    );
    const verdicts = before.map((answer) => answer.verdict).sort();
    if (process.env.PROBE_DEBUG)
      for (const node of plain) console.log(JSON.stringify(node.screen()));
    console.log("A 不过闸门：", verdicts.join(", "));
    assert(
      JSON.stringify(verdicts) ===
        JSON.stringify(["failed", "started", "started"]),
      `不过闸门时应当恰好一个失败，实际 ${verdicts}`,
    );
    const startedA = readdirSync(codexHome).filter((name) =>
      name.startsWith("started-a"),
    );
    assert(startedA.length === 2, `A 段起来的应当是 2 个，实际 ${startedA}`);
    for (const node of plain) await node.close();
    clearSlots(codexHome);

    /* --------------------------- B：过闸门，全部成功 -------------------------- */
    const gated = [];
    for (let index = 0; index < 3; index += 1) {
      gated.push(await openNode(core, dataDir, randomUUID()));
    }
    nodes.push(...gated);
    const grants = [];
    const after = await Promise.all(
      gated.map(async (node, index) => {
        const slot = await post(
          core,
          "/api/agents/launch-slot",
          target(node.nodeId),
        );
        assert(slot.granted === true, `b${index + 1} 没拿到位置`);
        grants.push(Date.now());
        node.type(`'${fake}' b${index + 1}`);
        return post(core, "/api/agents/launch-result", {
          ...target(node.nodeId),
          attempt: 1,
        });
      }),
    );
    grants.sort((x, y) => x - y);
    const gaps = grants.slice(1).map((at, index) => at - grants[index]);
    console.log("B 过闸门：", after.map((answer) => answer.verdict).join(", "));
    console.log("B 放行间隔（ms）：", gaps.join(", "));
    assert(
      after.every((answer) => answer.verdict === "started"),
      `过闸门后应当全部 started，实际 ${after.map((a) => a.verdict)}`,
    );
    assert(
      gaps.every((gap) => gap >= 500),
      `放行间隔应当 ≥ 500 ms，实际 ${gaps}`,
    );
    const startedB = readdirSync(codexHome).filter((name) =>
      name.startsWith("started-b"),
    );
    assert(startedB.length === 3, `B 段应当 3 个都起来，实际 ${startedB}`);
    console.log("\nOK");
  } catch (error) {
    failure = new Error(
      `${error.message}\n--- core log ---\n${core.stderr().slice(-4000)}`,
    );
  } finally {
    for (const node of nodes) await node.close().catch(() => undefined);
    await core.stop();
    try {
      execFileSync("tmux", ["-S", join(dataDir, "tmux.sock"), "kill-server"], {
        stdio: "ignore",
      });
    } catch {
      // 已经随最后一个会话退出了。
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 20 });
    } catch {
      // 留给系统清。
    }
  }
  if (failure) {
    console.error(String(failure));
    process.exit(1);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
