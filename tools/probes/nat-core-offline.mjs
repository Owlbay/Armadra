// NAT 后的 core 与中继断开 60 秒（平台计划 V2，B 档）。
//
// 一台在 NAT 后、只会往外连的 core（宿主进程）登记到容器里的个人中转，上面跑着：
//   * 一个「滴答」终端和一个「滴答」Agent 终端（脚本每 0.5 秒打一行 `tick <n> <秒>`），
//   * 一个交互 shell，用来在断线期间做「本地输入」。
// 然后 `docker pause` 把中继整个冻住 60 秒（`--outage 秒数` 可改，缺省 60）：
//
//   * 断线期间：滴答的进程没有重启（pid 不变、序号连续），core 看得到 PTY 输出
//     （`terminals.get` 的 `lastOutputAt` 一直在走），本地终端能输入、能回显；
//   * 断线之后：滴答在 tmux 里的整段输出序号连续、相邻两行的间隔不超过 3 秒
//     （PTY 输出没有缺口）；
//   * 断线期间：隧道在 50 秒内离开 ready（静默超时两个心跳周期，契约 §32.2）；
//   * 恢复之后：隧道 ≤ 10 秒回到 ready，中继的目录里这台源重新在线，经中继访问它的
//     /health 通——各自的耗时进报告。
//
// 「Agent」是脚本化的假 Agent 进程（不起真 CLI、不用真账号）：以 Agent 身份建的终端
// 里跑一段滴答脚本，核对的是 core 对长跑 Agent 进程的托管在断线期间不受影响。
//
// 中继在容器里（`docker pause` 只冻住它，NAT 后的 core 不动）；中继来自 armadra-cloud
// 的本地检出（`cloud-source.mjs`）。没有检出或没有 Docker 时退出码 2。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build && pnpm --filter @armadra/web build
//   node tools/ci/e2e.mjs --tier b --only nat-core-offline
//   node tools/probes/nat-core-offline.mjs [输出目录] [--outage 60]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { CLOUD_ENTRY, findCloudSource } from "./cloud-source.mjs";
import {
  dockerReady,
  ownerClient,
  registerSource,
  secretLedger,
  startDockerRelay,
} from "./platform-lib.mjs";
import { probeSession } from "./probe-session.mjs";
import {
  makeNode,
  root,
  scenario,
  sleep,
  startStack,
  until,
  writeResult,
} from "./ui-features/harness.mjs";

/** 恢复后各项要在这么久之内回来（规格：客户端 ≤ 10 秒）。 */
const RECOVER_LIMIT_MS = 10_000;
/**
 * 冻住中继后 core 要在这么久之内发现隧道断开：静默超时是两个心跳周期（中继缺省
 * 20 秒 → 40 秒，契约 §32.2），加采样间隔 5 秒与 5 秒余量。
 */
const DETECT_LIMIT_MS = 50_000;
/** 滴答行之间允许的最大间隔（脚本每 0.5 秒一行）。 */
const MAX_TICK_GAP_S = 3;

const args = process.argv.slice(2);
const outageIndex = args.indexOf("--outage");
const outageSeconds = outageIndex >= 0 ? Number(args[outageIndex + 1]) : 60;
const output = resolve(
  args.find(
    (arg, index) =>
      !arg.startsWith("--") && !(outageIndex >= 0 && index === outageIndex + 1),
  ) ?? join(root, "target/nat-core-offline"),
);
if (!(outageSeconds >= 5)) {
  console.error("--outage 至少 5 秒");
  process.exit(2);
}
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const cloudHome = findCloudSource();
if (!cloudHome) {
  console.error(
    `没有 armadra-cloud 的本地检出（${CLOUD_ENTRY}）：设 ARMADRA_DEV_STACK_CLOUD_SRC 或放在仓库旁的 ../armadra-cloud`,
  );
  process.exit(2);
}
if (!dockerReady()) {
  console.error("Docker 守护进程没有运行：个人中转在容器里跑");
  process.exit(2);
}
if (!existsSync(join(root, "apps/web/dist/index.html"))) {
  console.error("先 pnpm --filter @armadra/web build");
  process.exit(2);
}
if (process.platform === "win32") {
  console.error("探针要私有通道（core-control.sock），Windows 上不跑");
  process.exit(2);
}
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const report = {
  status: "failed",
  output,
  outageSeconds,
  scenarios: [],
  timings: {},
};
const started = Date.now();
const ledger = secretLedger();
const { secret } = ledger;
let relay;
let stack;

/** 滴答脚本：先报 pid，再每 0.5 秒一行 `tick <序号> <秒>`。 */
const TICKER = `#!/bin/sh
echo "pid=$$"
i=0
while :; do
  echo "tick $i $(date +%s)"
  i=$((i+1))
  sleep 0.5
done
`;

/** core 给 tmux 会话起的名字带 sessionKey 的末 8 位（`terminal/backend.ts::sessionName`）。 */
function tmuxName(dataDir, key) {
  const names = execFileSync(
    "tmux",
    [
      "-S",
      join(dataDir, "tmux.sock"),
      "list-sessions",
      "-F",
      "#{session_name}",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const tail = key.replace(/[^A-Za-z0-9]/g, "").slice(-8);
  const found = names.find((name) => name.includes(`-${tail}-`));
  if (!found)
    throw new Error(`找不到 ${key} 对应的 tmux 会话：${names.join(",")}`);
  return found;
}

/** 把 tmux 里一个终端的整段输出取出来（含滚动缓冲）。 */
function capture(dataDir, key) {
  return execFileSync(
    "tmux",
    [
      "-S",
      join(dataDir, "tmux.sock"),
      "capture-pane",
      "-p",
      "-J",
      "-S",
      "-",
      "-t",
      tmuxName(dataDir, key),
    ],
    { encoding: "utf8" },
  );
}

/** 从一段输出里拆出 pid 与 `tick` 序列。 */
function parseTicks(text) {
  const pids = [...text.matchAll(/pid=(\d+)/g)].map((m) => m[1]);
  const ticks = [...text.matchAll(/^tick (\d+) (\d+)\s*$/gm)].map((m) => ({
    n: Number(m[1]),
    at: Number(m[2]),
  }));
  return { pids, ticks };
}

/** 序号是否从头连续、相邻间隔是否都在上限内。 */
function continuity({ pids, ticks }) {
  const problems = [];
  if (pids.length !== 1)
    problems.push(`pid 行有 ${pids.length} 条（重启过？）`);
  if (ticks.length === 0) problems.push("没有滴答行");
  let maxGap = 0;
  for (let i = 0; i < ticks.length; i += 1) {
    if (ticks[i].n !== ticks[0].n + i) {
      problems.push(`序号在第 ${i} 行断了：${ticks[i - 1]?.n} → ${ticks[i].n}`);
      break;
    }
    if (i > 0) maxGap = Math.max(maxGap, ticks[i].at - ticks[i - 1].at);
  }
  if (maxGap > MAX_TICK_GAP_S) problems.push(`相邻两行最大间隔 ${maxGap} 秒`);
  return { problems, count: ticks.length, maxGap, first: ticks[0]?.n };
}

try {
  stack = await startStack({
    log: "info",
    env: { ARMADRA_SECRET_BACKEND: "file" },
  });
  report.chrome = stack.chrome;
  const run = scenario(
    report,
    "NAT 后的 core 与中继断开（V2 nat-core-offline）",
    output,
  );

  /* ------------------------------ 准备 ------------------------------ */
  const password = secret("中继口令", randomBytes(18).toString("base64url"));
  relay = await startDockerRelay({
    cloudHome,
    webRoot: join(root, "apps/web/dist"),
    scratch: stack.scratch,
    password,
  });
  run.ok("个人中转在容器里起来", relay.issuer);

  const session = await probeSession({
    dataDir: stack.data,
    base: stack.origin,
  });
  secret("NAT core 本机会话", session.headers.authorization.slice(7));
  const nat = ownerClient(session);
  const registered = await registerSource({
    relay,
    core: nat,
    label: "nat-host",
    onSecret: secret,
  });
  const { sourceId } = registered;
  run.ok("NAT 后的 core 登记到中继、隧道 ready", sourceId);

  const project = join(stack.scratch, "nat-project");
  mkdirSync(project, { recursive: true });
  const { workspace, board } = await stack.workspace("nat-workspace", project);
  // Agent 终端要认领一个画布节点（`nodeId`）。
  const agentNode = makeNode(
    board.id,
    "terminal",
    "Agent",
    { x: 120, y: 120 },
    { width: 520, height: 300 },
    { kind: "terminal", cwd: project },
  );
  await stack.seedBoard(workspace.id, board.id, [agentNode]);
  const tickerFile = join(stack.scratch, "ticker.sh");
  writeFileSync(tickerFile, TICKER);
  chmodSync(tickerFile, 0o755);
  const create = (body) =>
    stack.api("/api/terminals", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: workspace.id,
        cwd: project,
        ...body,
      }),
    });
  const plain = await create({ shell: tickerFile });
  const agent = await create({
    shell: tickerFile,
    nodeId: agentNode.id,
    agent: { id: "claude" },
  });
  const shell = await create({});
  report.terminals = {
    plain: { id: plain.id, backend: plain.backend, key: plain.sessionKey },
    agent: {
      id: agent.id,
      backend: agent.backend,
      key: agent.sessionKey,
      agentId: agent.agentId ?? null,
    },
    shell: { id: shell.id, backend: shell.backend, key: shell.sessionKey },
  };
  run.check(
    [plain, agent, shell].every(
      (one) => one.backend === "tmux" && one.sessionKey,
    ),
    "三个终端都在 tmux 里（断线时由 tmux 托住）",
    report.terminals,
  );
  // 先让滴答走一阵、本地 shell 能回显。
  await until(
    () =>
      parseTicks(capture(stack.data, plain.sessionKey)).ticks.length >= 6 &&
      parseTicks(capture(stack.data, agent.sessionKey)).ticks.length >= 6,
    "两个滴答终端都出了输出",
    { timeout: 30_000 },
  );
  const local = async (word) => {
    await stack.api(`/api/terminals/${shell.id}/paste`, {
      method: "POST",
      body: JSON.stringify({ text: `echo $((40+2))${word}`, enter: true }),
    });
    await until(
      () => capture(stack.data, shell.sessionKey).includes(`42${word}`),
      `本地 shell 回显 42${word}`,
      { timeout: 20_000 },
    );
  };
  await local("before");
  run.ok("断线前：本地输入并回显（42before）");

  const device = registered.device;
  const relayedHealth = async () => {
    const assertion = await relay.must(
      "POST",
      `/v1/sources/${sourceId}/assertion`,
      {
        body: { device },
        token: await registered.loginOwner(),
      },
    );
    secret("中继令牌", assertion.relayToken);
    return relay.call("GET", `/s/${sourceId}/health`, {
      headers: { "armadra-relay-token": assertion.relayToken },
    });
  };
  const before = await relayedHealth();
  run.check(
    before.status === 200,
    "断线前：经中继访问源的 /health 通",
    before.status,
  );

  /* ------------------------------ 断线 ------------------------------ */
  const pausedAt = Date.now();
  relay.pause();
  run.ok(`docker pause 中继，断开 ${outageSeconds} 秒`);
  let tunnelLeftReadyMs = null;
  const samples = [];
  let localWords = 0;
  while (Date.now() - pausedAt < outageSeconds * 1000) {
    await sleep(5_000);
    const tunnelState = (await nat.owner("/api/identity/cloud"))
      .registrations?.[0]?.tunnel?.state;
    if (tunnelLeftReadyMs === null && tunnelState !== "ready")
      tunnelLeftReadyMs = Date.now() - pausedAt;
    const ticks = parseTicks(capture(stack.data, plain.sessionKey)).ticks
      .length;
    const coreStatus = (await stack.api(`/api/terminals/${plain.id}`)).status;
    samples.push({
      t: Math.round((Date.now() - pausedAt) / 1000),
      tunnel: tunnelState,
      ticks,
      coreStatus,
    });
    // 隔一轮做一次本地输入。
    if (samples.length % 2 === 1) {
      localWords += 1;
      await local(`during${localWords}`);
    }
  }
  report.outageSamples = samples;
  report.timings["tunnel-left-ready"] = tunnelLeftReadyMs;
  run.check(
    samples.every(
      (one, index) =>
        one.coreStatus === "running" &&
        (index === 0 || one.ticks > samples[index - 1].ticks),
    ),
    "断线期间终端在 core 里一直是 running、PTY 输出每个采样点都在增长",
    samples,
  );
  // 冻结时间够长时，隧道必须在静默超时内察觉断开；比检测窗口还短的冻结只记录。
  if (outageSeconds * 1000 > DETECT_LIMIT_MS) {
    run.check(
      tunnelLeftReadyMs !== null && tunnelLeftReadyMs <= DETECT_LIMIT_MS,
      `断线期间 core 在 ${DETECT_LIMIT_MS / 1000} 秒内发现隧道断开（${tunnelLeftReadyMs} ms）`,
      { tunnelLeftReadyMs, samples },
    );
  } else {
    run.ok(
      tunnelLeftReadyMs === null
        ? "断线期间 core 没有察觉隧道断开（冻结时间短于检测窗口）"
        : `断线期间 core 在 ${tunnelLeftReadyMs} ms 后发现隧道断开`,
    );
  }
  run.ok(`断线期间本地输入 ${localWords} 次都有回显`);

  /* ------------------------------ 恢复 ------------------------------ */
  const resumedAt = Date.now();
  relay.unpause();
  const sinceResume = () => Date.now() - resumedAt;
  const tunnelBack = await until(
    async () =>
      (await nat.owner("/api/identity/cloud")).registrations?.[0]?.tunnel
        ?.state === "ready"
        ? sinceResume()
        : null,
    "隧道回到 ready",
    { timeout: 60_000, every: 250 },
  );
  report.timings["recover-tunnel"] = tunnelBack;
  const sourceOnline = await until(
    async () => {
      const listed = await relay.must("GET", "/v1/me/sources", {
        token: await registered.loginOwner(),
      });
      return (listed.sources ?? []).find((row) => row.sourceId === sourceId)
        ?.online
        ? sinceResume()
        : null;
    },
    "中继目录里这台源重新在线",
    { timeout: 60_000, every: 250 },
  );
  report.timings["recover-source-online"] = sourceOnline;
  const healthBack = await until(
    async () => ((await relayedHealth()).status === 200 ? sinceResume() : null),
    "经中继访问源的 /health 又通",
    { timeout: 60_000, every: 250 },
  );
  report.timings["recover-relayed-health"] = healthBack;
  run.check(
    Math.max(tunnelBack, sourceOnline, healthBack) <= RECOVER_LIMIT_MS,
    `恢复后 ≤ ${RECOVER_LIMIT_MS / 1000} 秒：隧道 ${tunnelBack} ms、中继目录在线 ${sourceOnline} ms、经中继访问 ${healthBack} ms`,
    { tunnelBack, sourceOnline, healthBack },
  );

  /* ------------------------- PTY 输出连续 ------------------------- */
  await local("after");
  run.ok("恢复后：本地输入并回显（42after）");
  for (const [name, one] of [
    ["滴答终端", plain],
    ["滴答 Agent", agent],
  ]) {
    const text = capture(stack.data, one.sessionKey);
    writeFileSync(join(output, `pty-${one.id}.txt`), text);
    const result = continuity(parseTicks(text));
    report[`continuity-${one.id}`] = result;
    run.check(
      result.problems.length === 0 && result.count > outageSeconds,
      `${name}：整段 PTY 输出序号连续、无缺口（${result.count} 行，最大间隔 ${result.maxGap} 秒，横跨断线 ${outageSeconds} 秒）`,
      result.problems,
    );
  }
  const status = (await stack.api(`/api/terminals/${plain.id}`)).status;
  run.check(status === "running", "滴答终端自始至终在运行", status);

  const leaks = ledger.scan({
    relay: relay.logs(),
    core: stack.coreLog(),
    probe: ledger.printed(),
  });
  run.check(leaks.length === 0, "中继、core 与探针的日志里没有口令与令牌", {
    secrets: ledger.secrets.size,
    leaks,
  });
  run.entry.status = "ok";
  report.status = "ok";
} catch (error) {
  report.error =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`  FAIL  ${report.error}`);
  if (relay) report.relayLog = relay.logs().slice(-3000);
  if (stack) report.coreLog = stack.coreLog().slice(-3000);
} finally {
  report.timings.totalMs = Date.now() - started;
  // 中继停在 pause 状态时 rm -f 也能清掉，但先放开，免得留下被冻住的容器。
  try {
    if (relay?.pausedNow) relay.unpause();
  } catch {
    /* 已经不在了。 */
  }
  await relay?.stop().catch(() => {});
  await stack?.stop();
  writeResult(output, report);
  console.log(`  报告  ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
