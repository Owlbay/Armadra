// terminal-memory.mjs 的纯函数：参数、读数解析、Runtime 汇总、释放后恢复的比对、
// 与基线的比对规则，以及 B 档清单。真正的负载在 B 档跑（tools/ci/e2e.d/terminal-memory.json）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadManifest, validateManifest } from "../ci/e2e.mjs";
import {
  METRICS,
  baselineKey,
  compare,
  deriveMetrics,
  descendants,
  functionalFailures,
  median,
  mergeRestore,
  mergeRuns,
  normalizeScreen,
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
  sameScenario,
  summarizeDiagnostics,
  summarizePreload,
  sumByRole,
} from "./terminal-memory-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("parseArgs: 缺省是设计 §2.7 的场景，数字与枚举有校验", () => {
  const options = parseArgs([]);
  assert.equal(options.terminals, 10);
  assert.equal(options.rate, 100);
  assert.equal(options.renderer, "dom");
  assert.equal(options.backend, "tmux");
  assert.equal(options.off1, 60);
  assert.equal(options.off2, 180);
  assert.equal(options.cycles, 10);
  assert.ok(options.baseline.endsWith("terminal-memory-baseline.json"));

  const custom = parseArgs([
    "out",
    "--terminals",
    "20",
    "--rate=0",
    "--webgl",
    "--backend",
    "direct",
    "--restore-check",
    "--release-after",
    "5m",
    "--unpacked",
    "--eld-preload",
    "--no-baseline",
  ]);
  assert.equal(custom.output, "out");
  assert.equal(custom.terminals, 20);
  assert.equal(custom.rate, 0);
  assert.equal(custom.renderer, "webgl");
  assert.equal(custom.backend, "direct");
  assert.equal(custom.restoreCheck, true);
  assert.equal(custom.releaseAfter, "5m");
  assert.equal(custom.baseline, undefined);

  assert.throws(() => parseArgs(["--terminals", "0"]), /不小于 1/);
  assert.throws(() => parseArgs(["--renderer", "canvas"]), /dom \| webgl/);
  assert.throws(() => parseArgs(["--off1", "200", "--off2", "100"]), /off2/);
  assert.throws(() => parseArgs(["--eld-preload"]), /--unpacked/);
  assert.throws(() => parseArgs(["--bogus"]), /不认识/);
  assert.throws(() => parseArgs(["a", "b"]), /多余/);

  const merge = parseArgs(["--merge", "a.json", "b.json", "c.json"]);
  assert.deepEqual(merge.merge, ["a.json", "b.json", "c.json"]);
  assert.throws(() => parseArgs(["--merge"]), /至少一个/);
});

test("baselineKey 与 sameScenario：WebGL 与直连各自一份，场景不同不比", () => {
  assert.equal(
    baselineKey({ platform: "darwin", arch: "arm64" }),
    "darwin-arm64",
  );
  assert.equal(
    baselineKey({
      platform: "linux",
      arch: "x64",
      renderer: "webgl",
      backend: "direct",
    }),
    "linux-x64-webgl-direct",
  );
  const a = parseArgs([]);
  assert.equal(sameScenario(a, parseArgs(["--warm", "5"])), true);
  assert.equal(sameScenario(a, parseArgs(["--terminals", "20"])), false);
  assert.equal(sameScenario(a, undefined), false);
});

test("compare: 差 20% 以上且超过绝对容差才算退化", () => {
  const rows = compare(
    {
      rendererActiveMiB: 520,
      rendererOffscreenLongMiB: 230,
      tmuxTreeRssMiB: 40,
    },
    {
      rendererActiveMiB: 417,
      rendererOffscreenLongMiB: 207,
      tmuxTreeRssMiB: 25,
    },
  );
  const by = Object.fromEntries(rows.map((row) => [row.metric, row]));
  // 多 24.7%，差 103 MiB 超过 60。
  assert.equal(by.rendererActiveMiB.regressed, true);
  assert.equal(by.rendererActiveMiB.change, 24.7);
  // 多 11%：不到 20%。
  assert.equal(by.rendererOffscreenLongMiB.regressed, false);
  // tmux 的相对阈值是 30%：多 60% 但只差 15 MiB，不到 20 的容差。
  assert.equal(by.tmuxTreeRssMiB.regressed, false);
  // 一边不是数字的不比。
  assert.equal(compare({ rendererActiveMiB: 1 }, {}).length, 0);
  assert.equal(
    compare({ rendererActiveMiB: null }, { rendererActiveMiB: 1 }).length,
    0,
  );
});

test("compare: 只看绝对差的项、下限、精确断言与只记录的平台", () => {
  const by = (rows) => Object.fromEntries(rows.map((row) => [row.metric, row]));
  // 强制 GC 的差值只看绝对容差 40：−67 → −20 差 47。
  assert.equal(
    by(
      compare(
        { rendererAfterGcDeltaMiB: -20 },
        { rendererAfterGcDeltaMiB: -67 },
      ),
    ).rendererAfterGcDeltaMiB.regressed,
    true,
  );
  assert.equal(
    by(
      compare(
        { rendererAfterGcDeltaMiB: -30 },
        { rendererAfterGcDeltaMiB: -67 },
      ),
    ).rendererAfterGcDeltaMiB.regressed,
    false,
  );
  // 事件循环最大延迟：差 50 以上、并且这次超过 100 ms 才算。
  assert.equal(
    by(compare({ runtimeEldMaxMs: 95 }, { runtimeEldMaxMs: 20 }))
      .runtimeEldMaxMs.regressed,
    false,
  );
  assert.equal(
    by(compare({ runtimeEldMaxMs: 140 }, { runtimeEldMaxMs: 20 }))
      .runtimeEldMaxMs.regressed,
    true,
  );
  assert.equal(
    by(compare({ runtimeEldMaxMs: 140 }, { runtimeEldMaxMs: 100 }))
      .runtimeEldMaxMs.regressed,
    false,
  );
  // p99 中位数：50% / 10 ms。
  assert.equal(
    by(compare({ runtimeEldP99MedianMs: 22 }, { runtimeEldP99MedianMs: 10 }))
      .runtimeEldP99MedianMs.regressed,
    true,
  );
  assert.equal(
    by(compare({ runtimeEldP99MedianMs: 19 }, { runtimeEldP99MedianMs: 10 }))
      .runtimeEldP99MedianMs.regressed,
    false,
  );
  // 基线是 0 的只看绝对差。
  assert.equal(
    by(
      compare(
        { runtimeSyncBlockedMsPerSec: 6 },
        { runtimeSyncBlockedMsPerSec: 0 },
      ),
    ).runtimeSyncBlockedMsPerSec.regressed,
    true,
  );
  assert.equal(
    by(compare({ cadencePsPer65s: 4 }, { cadencePsPer65s: 3 })).cadencePsPer65s
      .regressed,
    false,
  );
  // 进程数精确：多一个少一个都算。
  assert.equal(
    by(compare({ tmuxProcs: 21 }, { tmuxProcs: 21 })).tmuxProcs.regressed,
    false,
  );
  assert.equal(
    by(compare({ tmuxProcs: 31 }, { tmuxProcs: 21 })).tmuxProcs.regressed,
    true,
  );
  assert.equal(
    by(compare({ tmuxProcs: 11 }, { tmuxProcs: 21 })).tmuxProcs.regressed,
    true,
  );
  // GPU 只在 macOS 比，Linux 软件 GL 只记录。
  const gpu = { gpuOffscreenLongMiB: 400 };
  const gpuBase = { gpuOffscreenLongMiB: 130 };
  assert.equal(
    by(compare(gpu, gpuBase, { platform: "darwin" })).gpuOffscreenLongMiB
      .regressed,
    true,
  );
  const onLinux = by(
    compare(gpu, gpuBase, { platform: "linux" }),
  ).gpuOffscreenLongMiB;
  assert.equal(onLinux.regressed, false);
  assert.equal(onLinux.note, "只记录");
});

const phase = (stage, renderer, extra = {}) => ({
  stage,
  byRole: { renderer: { mem: renderer }, gpu: { mem: 100 } },
  tmuxRssMb: 30,
  tmuxProcs: 21,
  ...extra,
});

test("deriveMetrics: 按阶段取 Renderer / GPU / tmux，Runtime 与节奏取汇总", () => {
  const report = {
    options: { renderer: "dom", backend: "tmux" },
    phases: [
      phase("active", 400),
      phase("offscreen-short", 300),
      phase("offscreen-long", 210),
      phase("back-visible", 380),
      phase("switch", 390),
      phase("after-gc", 320),
    ],
    runtime: { eldMaxMs: 40, eldP99MedianMs: 9, syncBlockedMsPerSec: null },
    cadence: { psPer65s: 2.5 },
  };
  const metrics = deriveMetrics(report);
  assert.equal(metrics.rendererActiveMiB, 400);
  assert.equal(metrics.rendererOffscreenLongMiB, 210);
  assert.equal(metrics.rendererAfterGcDeltaMiB, -60);
  assert.equal(metrics.gpuOffscreenLongMiB, null, "DOM 档不记 GPU");
  assert.equal(metrics.runtimeEldMaxMs, 40);
  assert.equal(metrics.runtimeSyncBlockedMsPerSec, null);
  assert.equal(metrics.cadencePsPer65s, 2.5);
  assert.equal(metrics.tmuxProcs, 21);
  assert.deepEqual(Object.keys(metrics).sort(), Object.keys(METRICS).sort());

  const webgl = deriveMetrics({
    ...report,
    options: { renderer: "webgl", backend: "direct" },
  });
  assert.equal(webgl.gpuOffscreenLongMiB, 100);
  assert.equal(webgl.tmuxTreeRssMiB, null, "直连后端没有 tmux");
  assert.equal(webgl.tmuxProcs, null);
});

test("mergeRuns: 三次取中位数，场景不一致拒绝", () => {
  const run = (active, eld) => ({
    options: {
      terminals: 10,
      rate: 100,
      renderer: "dom",
      backend: "tmux",
      off1: 60,
      off2: 180,
      cycles: 10,
    },
    phases: [
      phase("active", active),
      phase("offscreen-long", 200),
      phase("back-visible", 300),
      phase("after-gc", 280),
    ],
    runtime: { eldMaxMs: eld, eldP99MedianMs: 8 },
  });
  const merged = mergeRuns([run(400, 30), run(420, 900), run(410, 25)]);
  assert.equal(merged.metrics.rendererActiveMiB, 410);
  assert.equal(merged.metrics.runtimeEldMaxMs, 30, "一次离群不影响中位数");
  assert.equal(merged.metrics.cadencePsPer65s, null);
  assert.equal(merged.options.terminals, 10);
  assert.equal(merged.runs.length, 3);
  const other = run(400, 30);
  other.options = { ...other.options, terminals: 20 };
  assert.throws(() => mergeRuns([run(400, 30), other]), /场景不一致/);
  assert.throws(() => mergeRuns([]), /没有/);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null, 5]), 5);
  assert.equal(median([]), null);
});

const screen = (lines, cursor = { x: 5, y: 1 }, rows = 4) => ({
  rows,
  lines,
  cursor,
});

test("restoreCheck: 行列、文字、光标与 capture-pane 都对上才算恢复", () => {
  const lines = ["perf% printf 'restore %s\\n' s1", "restore s1", "perf% ", ""];
  const pane = {
    width: 80,
    height: 4,
    lines: ["perf% printf 'restore %s\\n' s1  ", "restore s1", "perf%", "", ""],
    cursor: { x: 5, y: 2 },
  };
  const ok = restoreCheck({
    before: screen(lines, { x: 6, y: 2 }),
    after: screen(lines, { x: 5, y: 2 }),
    paneBefore: { width: 80, height: 4 },
    pane,
  });
  // 页面前后光标差一格：画面不算恢复。
  assert.equal(ok.gridMatches, true);
  assert.equal(ok.screenMatches, false);
  assert.match(ok.problems.join(), /光标 6,2 → 5,2/);

  const good = restoreCheck({
    before: screen(lines, { x: 5, y: 2 }),
    after: screen(lines, { x: 5, y: 2 }),
    paneBefore: { width: 80, height: 4 },
    pane,
  });
  assert.deepEqual(good, {
    gridMatches: true,
    screenMatches: true,
    problems: [],
  });

  // 重建后行数变了（尺寸保险失效）。
  const shrunk = restoreCheck({
    before: screen(lines),
    after: screen(lines.slice(0, 3), { x: 5, y: 1 }, 3),
    pane: { ...pane, height: 4 },
  });
  assert.equal(shrunk.gridMatches, false);
  assert.match(shrunk.problems.join(), /页面行数 4 → 3/);

  // 重连后丢了画面：页面与 capture-pane 不同。
  const blank = restoreCheck({
    before: screen(lines),
    after: screen(["", "", "", ""]),
    pane,
  });
  assert.equal(blank.screenMatches, false);
  assert.match(blank.problems.join(), /capture-pane/);

  // tmux 窗格被改了尺寸。
  const resized = restoreCheck({
    before: screen(lines),
    after: screen(lines),
    paneBefore: { width: 80, height: 4 },
    pane: { ...pane, width: 0 },
  });
  assert.equal(resized.gridMatches, false);

  // 直连后端没有窗格：只比页面前后。
  const direct = restoreCheck({ before: screen(lines), after: screen(lines) });
  assert.equal(direct.gridMatches && direct.screenMatches, true);

  assert.equal(
    restoreCheck({ before: null, after: screen(lines) }).gridMatches,
    false,
  );
  assert.deepEqual(normalizeScreen(["a  ", "b", " ", ""]), ["a", "b"]);
});

test("mergeRestore 与 functionalFailures：一个终端没恢复就整体失败", () => {
  const merged = mergeRestore([
    { gridMatches: true, screenMatches: true, problems: [], name: "s1" },
    {
      gridMatches: true,
      screenMatches: false,
      problems: ["页面文字前后不同"],
      name: "s2",
    },
  ]);
  assert.equal(merged.terminals, 2);
  assert.equal(merged.gridMatches, true);
  assert.equal(merged.screenMatches, false);
  assert.deepEqual(merged.problems, ["#2 s2 页面文字前后不同"]);
  assert.equal(mergeRestore([]).gridMatches, false);

  assert.deepEqual(
    functionalFailures({ options: { restoreCheck: false } }),
    [],
  );
  assert.deepEqual(functionalFailures({ options: { restoreCheck: true } }), [
    "restore-check 没有结果",
  ]);
  assert.deepEqual(
    functionalFailures({ options: { restoreCheck: true }, restore: merged }),
    ["restoreScreenMatches 为假"],
  );
  assert.deepEqual(
    functionalFailures({
      options: { pressure: true },
      pressure: { renderUnchanged: false },
    }),
    ["注入压力后 data-render 变了"],
  );
});

test("summarizePreload: 同步子进程每秒阻塞毫秒数与 ps 次数", () => {
  const line = (t, max, p99, ps) => ({
    t,
    eld: { max, p99 },
    elu: 0.1,
    heapUsedMb: 50,
    sync: {
      "execFileSync ps -Ao pid=": { count: ps, totalMs: ps * 20, maxMs: 25 },
      "execFileSync tmux list-panes": { count: 1, totalMs: 5, maxMs: 5 },
    },
  });
  const summary = summarizePreload([
    line(0, 30, 10, 3),
    line(5000, 120, 20, 2),
    line(10_000, 40, 12, 2),
  ]);
  assert.equal(summary.windows, 3);
  assert.equal(summary.seconds, 15);
  assert.equal(summary.eldMaxMs, 120);
  assert.equal(summary.eldP99MedianMs, 12);
  assert.equal(summary.psCount, 7);
  // (7 × 20 + 3 × 5) / 15 s
  assert.equal(summary.syncBlockedMsPerSec, 10.3);
  assert.equal(summarizePreload([]), null);
});

test("summarizeDiagnostics 与 per65s：§54 读数的最大值、中位数与轮次差", () => {
  const sample = (max, p99, rounds, ps) => ({
    eventLoop: { windowMs: 60000, p50Ms: 1, p99Ms: p99, maxMs: max },
    sampling: {
      rounds,
      lastRoundMs: 80,
      maxRoundMs: 200,
      overlapsSkipped: 0,
      timeouts: { ps, tmux: 0, probe: 0 },
    },
  });
  const summary = summarizeDiagnostics([
    sample(20, 8, 100, 0),
    sample(60, 12, 130, 1),
    {},
    sample(25, 9, 160, 1),
  ]);
  assert.equal(summary.samples, 3);
  assert.equal(summary.eldMaxMs, 60);
  assert.equal(summary.eldP99MedianMs, 9);
  assert.equal(summary.rounds, 60);
  assert.deepEqual(summary.timeouts, { ps: 1, tmux: 0, probe: 0 });
  assert.equal(summarizeDiagnostics([]), null);
  assert.equal(per65s(3, 65_000), 3);
  assert.equal(per65s(2, 32_500), 4);
  assert.equal(per65s(null, 65_000), null);
  assert.equal(per65s(2, 0), null);
});

test("进程表、top、/proc 与 vmmap 的解析", () => {
  const table = parsePsTable(
    [
      "  10     1  1000 /Applications/Armadra.app/Contents/MacOS/Armadra --remote-debugging-port=1",
      "  11    10  2000 Armadra Helper (Renderer) --type=renderer",
      "  12    10  3000 Armadra Helper (GPU) --type=gpu-process",
      "  13    10  4000 /Applications/Armadra.app/Contents/MacOS/Armadra /x/app.asar/out/core/main.js",
      "  14    13   500 tmux -C -S /tmp/d/tmux.sock attach",
      "  15     1  9000 unrelated",
    ].join("\n"),
  );
  assert.equal(table.length, 6);
  const tree = descendants(table, 10);
  assert.deepEqual(
    tree.map((row) => row.pid),
    [11, 12, 13, 14],
  );
  assert.deepEqual(
    [table[0], ...tree].map((row) => roleOf(row, 10)),
    ["main", "renderer", "gpu", "core", "tmux"],
  );

  const top = parseTop(
    "Processes: …\nPID    MEM    CMPRS  %CPU\n11     300M   10M    0.0\n\nProcesses: …\nPID    MEM    CMPRS  %CPU\n11     412M+  12M    35.2\n12     1.5G   0B     4.1\n13     2048K  512K   1.0\n",
  );
  assert.deepEqual(top["11"], { mem: 412, cmprs: 12, cpu: 35.2 });
  assert.equal(top["12"].mem, 1536);
  assert.equal(top["13"].mem, 2);
  const byRole = sumByRole({ renderer: [11], gpu: [12, 99] }, top);
  assert.equal(byRole.renderer.mem, 412);
  assert.deepEqual(byRole.gpu.pids, [12]);

  assert.equal(parseSmapsRollup("Rss:  204800 kB\nPss:  102400 kB\n"), 100);
  assert.equal(parseSmapsRollup(null), null);
  assert.equal(parseStatusRss("Name:\tx\nVmRSS:\t  51200 kB\n"), 50);
  assert.equal(
    parseProcStatTicks(
      "42 (Armadra Helper (Re) S 1 2 3 4 5 6 7 8 9 10 120 30 0 0",
    ),
    150,
  );
  assert.equal(parseProcStatTicks("garbage"), null);

  const vm = parseVmmapSummary(
    "Physical footprint:         412.3M\nMemory Tag 253                   1.2G   300.0M   200.0M    20.0M     0K  0K  0K  10\nIOSurface                      512.0M   100.0M    64.0M       0K     0K  0K  0K  3\n",
  );
  assert.equal(vm.footprint, "412.3M");
  assert.deepEqual(vm.v8Tag253, { dirtyMb: 200, swappedMb: 20, totalMb: 220 });
  assert.equal(vm.ioSurface.totalMb, 64);
  assert.equal(vm.mallocSmall, null);
});

test("renderTable: 每个指标一行，退化与只记录有标记", () => {
  const table = renderTable({ rendererActiveMiB: 500, tmuxProcs: null }, [
    {
      metric: "rendererActiveMiB",
      baseline: 400,
      current: 500,
      change: 25,
      regressed: true,
    },
  ]);
  assert.match(table, /^\| 指标 \| 这次 \| 基线 \| 差 \|/);
  assert.match(table, /`rendererActiveMiB`） ⚠ \| 500 MiB \| 400 \| 25% \|/);
  assert.equal(table.split("\n").length, 2 + Object.keys(METRICS).length);
});

test("提交的基线：结构对，录过的平台只含比对用的指标", () => {
  const baselines = JSON.parse(
    readFileSync(
      new URL("./terminal-memory-baseline.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(typeof baselines.platforms, "object");
  for (const [key, entry] of Object.entries(baselines.platforms)) {
    assert.match(key, /^(darwin|linux)-(arm64|x64)(-webgl)?(-direct)?$/);
    assert.equal(entry.options.terminals, 10);
    assert.equal(entry.options.rate, 100);
    assert.deepEqual(
      Object.keys(entry.metrics).sort(),
      Object.keys(METRICS).sort(),
    );
    for (const value of Object.values(entry.metrics))
      assert.ok(value === null || typeof value === "number");
  }
  if (Object.keys(baselines.platforms).length === 0)
    assert.match(baselines.placeholder, /待录/, "空基线要写明是占位");
});

test("B 档清单：terminal-memory 在 darwin / linux 上跑，参数是设计 §2.7 的那组", () => {
  const manifest = loadManifest();
  assert.deepEqual(validateManifest(manifest), []);
  const entry = manifest.entries.find((item) => item.id === "terminal-memory");
  assert.ok(entry, "tools/ci/e2e.d/terminal-memory.json 不在清单里");
  assert.equal(entry.tier, "b");
  assert.deepEqual(entry.platforms, ["darwin", "linux"]);
  assert.deepEqual(entry.requires, ["tmux"]);
  assert.equal(entry.timeoutMinutes, 30);
  const options = parseArgs(
    entry.args.map((arg) => arg.replace("{out}", "out")),
  );
  assert.equal(options.terminals, 10);
  assert.equal(options.off2, 180);
  assert.equal(options.cycles, 10);
  // 清单与基线的场景一致，基线录好之后 B 档才真的会比。
  assert.equal(sameScenario(options, { ...options }), true);

  const listed = execFileSync(
    process.execPath,
    ["tools/ci/e2e.mjs", "--tier", "b", "--list"],
    { cwd: root, encoding: "utf8" },
  );
  assert.match(
    listed,
    /^terminal-memory \[darwin, linux\]  tools\/probes\/terminal-memory\.mjs$/m,
  );
});
