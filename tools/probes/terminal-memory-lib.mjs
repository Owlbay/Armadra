// 终端内存探针（terminal-memory.mjs）的纯函数部分：参数、进程表与内存读数的解析、
// Runtime 事件循环与采样的汇总、释放后恢复的比对、与基线的比对规则。
//
// 不起进程、不开端口，任何平台都能导入；测试在同目录的 terminal-memory.test.mjs
// （`pnpm release:test` 里跑）。

/* --------------------------------- 参数 ---------------------------------- */

const NUMBER_FLAGS = {
  terminals: { fallback: 10, min: 1 },
  rate: { fallback: 100, min: 0 },
  warm: { fallback: 60, min: 0 },
  off1: { fallback: 60, min: 0 },
  off2: { fallback: 180, min: 0 },
  cycles: { fallback: 10, min: 0 },
  "restore-wait": { fallback: 60, min: 0 },
};
const CHOICE_FLAGS = {
  renderer: ["dom", "webgl"],
  backend: ["tmux", "direct"],
};
const BOOLEAN_FLAGS = [
  "cadence-check",
  "pressure",
  "restore-check",
  "eld-preload",
  "unpacked",
  "no-baseline",
  "vmmap",
];
const STRING_FLAGS = ["app", "baseline", "release-after", "machine"];

const camel = (name) => name.replace(/-(\w)/g, (_, c) => c.toUpperCase());

/**
 * `terminal-memory.mjs [输出目录] [--terminals 10] …`。第一个不带 `--` 的是输出目录；
 * `--merge a.json b.json c.json` 之后的位置参数全是要合并的结果文件。
 */
export function parseArgs(argv) {
  const options = {
    output: undefined,
    terminals: 10,
    rate: 100,
    warm: 60,
    off1: 60,
    off2: 180,
    cycles: 10,
    restoreWait: 60,
    renderer: "dom",
    backend: "tmux",
    cadenceCheck: false,
    pressure: false,
    restoreCheck: false,
    eldPreload: false,
    unpacked: false,
    vmmap: false,
    app: undefined,
    baseline: "tools/probes/terminal-memory-baseline.json",
    releaseAfter: undefined,
    machine: undefined,
    merge: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      if (options.merge) options.merge.push(arg);
      else if (options.output === undefined) options.output = arg;
      else throw new Error(`多余的参数 ${arg}`);
      continue;
    }
    const [flag, inline] = arg.slice(2).split(/=(.*)/s, 2);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--"))
        throw new Error(`--${flag} 要一个值`);
      index += 1;
      return next;
    };
    if (flag === "merge") options.merge = [];
    else if (flag === "webgl") options.renderer = "webgl";
    else if (flag in NUMBER_FLAGS) {
      const raw = value();
      const number = Number(raw);
      if (!Number.isInteger(number) || number < NUMBER_FLAGS[flag].min)
        throw new Error(
          `--${flag} 要不小于 ${NUMBER_FLAGS[flag].min} 的整数，拿到 ${raw}`,
        );
      options[camel(flag)] = number;
    } else if (flag in CHOICE_FLAGS) {
      const raw = value();
      if (!CHOICE_FLAGS[flag].includes(raw))
        throw new Error(`--${flag} 只认 ${CHOICE_FLAGS[flag].join(" | ")}`);
      options[flag] = raw;
    } else if (BOOLEAN_FLAGS.includes(flag)) {
      if (flag === "no-baseline") options.baseline = undefined;
      else options[camel(flag)] = true;
    } else if (STRING_FLAGS.includes(flag)) options[camel(flag)] = value();
    else throw new Error(`不认识的参数 --${flag}`);
  }
  if (options.off2 < options.off1) throw new Error("--off2 不能比 --off1 短");
  if (options.eldPreload && !options.unpacked)
    throw new Error(
      "--eld-preload 只能配 --unpacked（打包版不读 NODE_OPTIONS）",
    );
  if (options.merge && options.merge.length === 0)
    throw new Error("--merge 要至少一个结果文件");
  return options;
}

/**
 * 基线按 `<平台>-<架构>` 存一份，WebGL 与直连后端各自另起一份
 * （`darwin-arm64-webgl`、`linux-x64-direct`），终端数与输出速率记在 options 里。
 */
export function baselineKey({
  platform,
  arch,
  renderer = "dom",
  backend = "tmux",
}) {
  return [
    `${platform}-${arch}`,
    renderer === "webgl" ? "webgl" : null,
    backend === "direct" ? "direct" : null,
  ]
    .filter(Boolean)
    .join("-");
}

/** 两次运行能不能比：规模与渲染 / 后端一致才行。 */
export const COMPARABLE_OPTIONS = [
  "terminals",
  "rate",
  "renderer",
  "backend",
  "off1",
  "off2",
  "cycles",
];

export function sameScenario(left, right) {
  return COMPARABLE_OPTIONS.every((key) => left?.[key] === right?.[key]);
}

/* ------------------------------ 进程与内存 ------------------------------- */

/** `ps -Ao pid=,ppid=,rss=,command=` 的输出。 */
export function parsePsTable(text) {
  return text
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      command: m[4],
    }));
}

/** 进程表里 `root` 的全部后代（不含它自己），广度优先。 */
export function descendants(table, root) {
  const children = new Map();
  for (const row of table) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const found = [];
  const queue = [root];
  const seen = new Set([root]);
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const row of children.get(pid) ?? []) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      found.push(row);
      queue.push(row.pid);
    }
  }
  return found;
}

/** 桌面壳进程树里每个进程的角色。 */
export function roleOf(row, mainPid) {
  const c = row.command;
  if (row.pid === mainPid) return "main";
  if (c.includes("core/main.js")) return "core";
  if (c.includes("--type=renderer")) return "renderer";
  if (c.includes("--type=gpu-process")) return "gpu";
  if (c.includes("network.mojom.NetworkService")) return "network";
  if (c.includes("--type=zygote")) return "zygote";
  if (c.includes("--type=utility")) return "utility";
  if (/\btmux\b/.test(c)) return "tmux";
  return "other";
}

const TOP_UNIT = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 };

/** top 的 `123M` / `4096K` / `1.2G` / `512B`，答 MiB（一位小数）。 */
export function topSize(value) {
  const m = /^([\d.]+)([BKMG])?\+?-?$/.exec(value ?? "");
  if (!m) return null;
  return round1(Number(m[1]) * TOP_UNIT[m[2] ?? "B"]);
}

/**
 * macOS `top -l 2 -s 1 -stats pid,mem,cmprs,cpu -pid …` 的输出：取最后一轮
 * （第一轮的 CPU 是 0）。MEM 列就是 phys_footprint。答 `{ [pid]: { mem, cmprs, cpu } }`。
 */
export function parseTop(text) {
  const blocks = text.split(/^PID\s+MEM/m);
  const last = blocks[blocks.length - 1] ?? "";
  const result = {};
  for (const line of last.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)/.exec(line);
    if (m)
      result[m[1]] = {
        mem: topSize(m[2]),
        cmprs: topSize(m[3]),
        cpu: Number(m[4]),
      };
  }
  return result;
}

/** Linux `/proc/<pid>/smaps_rollup` 的 Pss（MiB）。 */
export function parseSmapsRollup(text) {
  const m = /^Pss:\s+(\d+)\s+kB/m.exec(text ?? "");
  return m ? round1(Number(m[1]) / 1024) : null;
}

/** Linux `/proc/<pid>/status` 的 VmRSS（MiB）。 */
export function parseStatusRss(text) {
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(text ?? "");
  return m ? round1(Number(m[1]) / 1024) : null;
}

/** Linux `/proc/<pid>/stat` 的 utime + stime（时钟滴答）。comm 里可能有空格与括号。 */
export function parseProcStatTicks(text) {
  const close = (text ?? "").lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 2).split(" ");
  // fields[0] 是 state（原第 3 列），utime / stime 是原第 14 / 15 列。
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  return Number.isFinite(utime) && Number.isFinite(stime)
    ? utime + stime
    : null;
}

const VMMAP_UNIT = { K: 1 / 1024, M: 1, G: 1024 };

/**
 * macOS `vmmap -summary <pid>` 里关心的几行：dirty + swapped 才算进 footprint。
 * V8 是 Memory Tag 253，PartitionAlloc 是 Tag 255，GPU 进程的纹理在 IOSurface。
 */
export function parseVmmapSummary(text) {
  const size = (v) => {
    const m = /^([\d.]+)([KMG])?$/.exec(v);
    return m ? Number(m[1]) * VMMAP_UNIT[m[2] ?? "K"] : 0;
  };
  const row = (label) => {
    const escaped = label.replace(/[()]/g, "\\$&");
    const m = new RegExp(
      `^${escaped}\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)`,
      "m",
    ).exec(text);
    if (!m) return null;
    return {
      dirtyMb: round1(size(m[3])),
      swappedMb: round1(size(m[4])),
      totalMb: round1(size(m[3]) + size(m[4])),
    };
  };
  return {
    footprint: /Physical footprint:\s+(\S+)/.exec(text)?.[1] ?? null,
    v8Tag253: row("Memory Tag 253"),
    partitionAllocTag255: row("Memory Tag 255"),
    ioSurface: row("IOSurface"),
    ioAccelGraphics: row("IOAccelerator (graphics)"),
    mallocSmall: row("MALLOC_SMALL"),
  };
}

/**
 * 按角色合计：`readings` 是 `{ [pid]: { mem, cmprs?, cpu } }`，`roles` 是
 * `{ role: pid[] }`。答 `{ role: { mem, cmprs, cpu, pids } }`。
 */
export function sumByRole(roles, readings) {
  const byRole = {};
  for (const [role, pids] of Object.entries(roles)) {
    for (const pid of pids) {
      const reading = readings[pid];
      if (!reading) continue;
      const entry = (byRole[role] ??= { mem: 0, cmprs: 0, cpu: 0, pids: [] });
      entry.mem = round1(entry.mem + (reading.mem ?? 0));
      entry.cmprs = round1(entry.cmprs + (reading.cmprs ?? 0));
      entry.cpu = round1(entry.cpu + (reading.cpu ?? 0));
      entry.pids.push(pid);
    }
  }
  return byRole;
}

/* --------------------------- Runtime 的事件循环 --------------------------- */

export const round1 = (value) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Math.round(value * 10) / 10;

export function median(values) {
  const list = values
    .filter((value) => typeof value === "number")
    .sort((a, b) => a - b);
  if (list.length === 0) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 === 1
    ? list[middle]
    : (list[middle - 1] + list[middle]) / 2;
}

/**
 * `--eld-preload` 写的 JSON Lines（每 5 s 一行 `{ t, eld: { p99, max, … }, elu, sync }`）
 * 汇总成一段：最大延迟、p99 的中位数、同步子进程每秒阻塞多少毫秒、`ps` 次数。
 */
export function summarizePreload(lines, windowMs = 5000) {
  if (lines.length === 0) return null;
  const sync = {};
  for (const line of lines)
    for (const [key, value] of Object.entries(line.sync ?? {})) {
      const entry = (sync[key] ??= { count: 0, totalMs: 0, maxMs: 0 });
      entry.count += value.count;
      entry.totalMs = round1(entry.totalMs + value.totalMs);
      entry.maxMs = Math.max(entry.maxMs, value.maxMs);
    }
  const seconds = (lines.at(-1).t - lines[0].t + windowMs) / 1000;
  const blocked = Object.values(sync).reduce(
    (sum, value) => sum + value.totalMs,
    0,
  );
  const psCount = Object.entries(sync)
    .filter(([key]) => /^\w+ ps\b/.test(key))
    .reduce((sum, [, value]) => sum + value.count, 0);
  return {
    windows: lines.length,
    seconds: round1(seconds),
    eldMaxMs: Math.max(...lines.map((line) => line.eld.max)),
    eldP99MedianMs: median(lines.map((line) => line.eld.p99)),
    eluMean:
      Math.round(
        (lines.reduce((sum, line) => sum + line.elu, 0) / lines.length) * 1000,
      ) / 1000,
    coreHeapUsedMb: lines.at(-1).heapUsedMb ?? null,
    syncBlockedMsPerSec: round1(blocked / seconds),
    psCount,
    sync,
  };
}

/**
 * `GET /api/diagnostics/runtime`（契约 §54）的一串读数汇总成一段。每次读数的
 * eventLoop 是最近 60 s 的窗口，按读数取最大与 p99 的中位数；采样轮次与超时取首尾差。
 */
export function summarizeDiagnostics(samples) {
  const usable = samples.filter(
    (sample) => sample?.eventLoop && sample?.sampling,
  );
  if (usable.length === 0) return null;
  const first = usable[0];
  const last = usable.at(-1);
  const delta = (pick) => {
    const a = pick(first);
    const b = pick(last);
    return typeof a === "number" && typeof b === "number" ? b - a : null;
  };
  return {
    samples: usable.length,
    eldMaxMs: Math.max(...usable.map((sample) => sample.eventLoop.maxMs)),
    eldP99MedianMs: median(usable.map((sample) => sample.eventLoop.p99Ms)),
    eldP50MedianMs: median(usable.map((sample) => sample.eventLoop.p50Ms)),
    lastRoundMs: last.sampling.lastRoundMs ?? null,
    maxRoundMs: Math.max(
      ...usable.map((sample) => sample.sampling.maxRoundMs ?? 0),
    ),
    rounds: delta((sample) => sample.sampling.rounds),
    overlapsSkipped: delta((sample) => sample.sampling.overlapsSkipped),
    timeouts: Object.fromEntries(
      Object.keys(last.sampling.timeouts ?? {}).map((key) => [
        key,
        (last.sampling.timeouts[key] ?? 0) -
          (first.sampling.timeouts?.[key] ?? 0),
      ]),
    ),
  };
}

/** 一段时间里的计数折算成每 65 s 多少次（全部离屏时 `ps` 的节奏）。 */
export function per65s(count, elapsedMs) {
  if (typeof count !== "number" || !(elapsedMs > 0)) return null;
  return round1((count * 65_000) / elapsedMs);
}

/* ------------------------------ 释放后恢复 ------------------------------- */

/** 屏幕文字比对前的规范化：每行去掉行尾空白，再去掉末尾的空行。 */
export function normalizeScreen(lines) {
  const trimmed = (lines ?? []).map((line) =>
    String(line).replace(/\s+$/u, ""),
  );
  while (trimmed.length > 0 && trimmed.at(-1) === "") trimmed.pop();
  return trimmed;
}

/**
 * 一个终端释放前后的比对。`before` / `after` 是页面上读到的
 * `{ rows, lines, cursor: { x, y } | null }`；`pane` 是 tmux 读回的
 * `{ width, height, lines, cursor }`（直连后端没有，给 null）。
 *
 * - grid：页面行数前后一致；有 tmux 时页面行数等于窗格高度，窗格尺寸前后一致。
 * - screen：页面文字前后一致；有 tmux 时恢复后的页面文字等于 `capture-pane`；
 *   两边都读得到光标时位置一致。
 */
export function restoreCheck({
  before,
  after,
  paneBefore = null,
  pane = null,
}) {
  const problems = [];
  if (!before || !after)
    return {
      gridMatches: false,
      screenMatches: false,
      problems: ["没有读到页面画面"],
    };
  let gridMatches = before.rows === after.rows;
  if (!gridMatches) problems.push(`页面行数 ${before.rows} → ${after.rows}`);
  if (pane) {
    if (after.rows !== pane.height) {
      gridMatches = false;
      problems.push(`页面 ${after.rows} 行，tmux 窗格 ${pane.height} 行`);
    }
    if (
      paneBefore &&
      (paneBefore.width !== pane.width || paneBefore.height !== pane.height)
    ) {
      gridMatches = false;
      problems.push(
        `tmux 窗格 ${paneBefore.width}×${paneBefore.height} → ${pane.width}×${pane.height}`,
      );
    }
  }
  const was = normalizeScreen(before.lines);
  const now = normalizeScreen(after.lines);
  let screenMatches = sameLines(was, now);
  if (!screenMatches)
    problems.push(`页面文字前后不同：${firstDifference(was, now)}`);
  if (pane) {
    const truth = normalizeScreen(pane.lines);
    if (!sameLines(now, truth)) {
      screenMatches = false;
      problems.push(`页面与 capture-pane 不同：${firstDifference(now, truth)}`);
    }
    if (
      after.cursor &&
      pane.cursor &&
      (after.cursor.x !== pane.cursor.x || after.cursor.y !== pane.cursor.y)
    ) {
      screenMatches = false;
      problems.push(
        `光标 页面 ${after.cursor.x},${after.cursor.y}，tmux ${pane.cursor.x},${pane.cursor.y}`,
      );
    }
  }
  if (
    before.cursor &&
    after.cursor &&
    (before.cursor.x !== after.cursor.x || before.cursor.y !== after.cursor.y)
  ) {
    screenMatches = false;
    problems.push(
      `光标 ${before.cursor.x},${before.cursor.y} → ${after.cursor.x},${after.cursor.y}`,
    );
  }
  return { gridMatches, screenMatches, problems };
}

function sameLines(left, right) {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}

function firstDifference(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1)
    if (left[index] !== right[index])
      return `第 ${index + 1} 行 ${JSON.stringify(left[index] ?? null)} ≠ ${JSON.stringify(right[index] ?? null)}`;
  return "无";
}

/** 全部终端的恢复结果并成一个：每个都对才算对。 */
export function mergeRestore(results) {
  return {
    terminals: results.length,
    gridMatches:
      results.length > 0 && results.every((result) => result.gridMatches),
    screenMatches:
      results.length > 0 && results.every((result) => result.screenMatches),
    problems: results.flatMap((result, index) =>
      result.problems.map((problem) =>
        `#${index + 1} ${result.name ?? ""} ${problem}`
          .replace(/\s+/g, " ")
          .trim(),
      ),
    ),
  };
}

/* ---------------------------------- 指标 ---------------------------------- */

/**
 * 比对用的指标（性能设计 §2.7 的表）。`relative` 是相对阈值（null = 只看绝对差），
 * `slack` 是绝对容差：差值超过相对阈值**且**超过 slack 才算退化；`floor` 是这次
 * 的值低于它时不算退化；`exact` 要求与基线相等；`compareOn` 只在这些平台比
 * （其余只记录）。
 */
export const METRICS = {
  rendererActiveMiB: {
    better: "lower",
    relative: 0.2,
    slack: 60,
    unit: "MiB",
    label: "Renderer 活跃",
  },
  rendererOffscreenLongMiB: {
    better: "lower",
    relative: 0.2,
    slack: 40,
    unit: "MiB",
    label: "Renderer 长时间离屏",
  },
  rendererAfterGcDeltaMiB: {
    better: "lower",
    relative: null,
    slack: 40,
    unit: "MiB",
    label: "Renderer 强制 GC − 回到视口",
  },
  gpuOffscreenLongMiB: {
    better: "lower",
    relative: 0.2,
    slack: 40,
    unit: "MiB",
    label: "GPU 长时间离屏",
    compareOn: ["darwin"],
  },
  runtimeEldMaxMs: {
    better: "lower",
    relative: null,
    slack: 50,
    floor: 100,
    unit: "ms",
    label: "Runtime 事件循环最大延迟",
  },
  runtimeEldP99MedianMs: {
    better: "lower",
    relative: 0.5,
    slack: 10,
    unit: "ms",
    label: "Runtime 事件循环 p99 中位数",
  },
  runtimeSyncBlockedMsPerSec: {
    better: "lower",
    relative: null,
    slack: 5,
    unit: "ms/s",
    label: "Runtime 同步子进程阻塞",
  },
  cadencePsPer65s: {
    better: "lower",
    relative: null,
    slack: 2,
    unit: "次",
    label: "全部离屏时每 65 s 采样次数",
  },
  tmuxTreeRssMiB: {
    better: "lower",
    relative: 0.3,
    slack: 20,
    unit: "MiB",
    label: "tmux 进程树 RSS",
  },
  tmuxProcs: { exact: true, unit: "个", label: "tmux 进程数" },
};

export const REGRESSION = 0.2;

/**
 * 这次的数字对一份基线：每项 `{ metric, baseline, current, change, regressed, note? }`。
 * 任一边不是数字的指标不比。
 */
export function compare(current, baseline, { platform } = {}) {
  const rows = [];
  for (const [metric, rule] of Object.entries(METRICS)) {
    const was = baseline?.[metric];
    const now = current?.[metric];
    if (typeof was !== "number" || typeof now !== "number") continue;
    if (rule.exact) {
      rows.push({
        metric,
        baseline: was,
        current: now,
        change: was === 0 ? 0 : round1(((now - was) / Math.abs(was)) * 100),
        regressed: now !== was,
      });
      continue;
    }
    const worse = rule.better === "lower" ? now - was : was - now;
    const change = was === 0 ? 0 : worse / Math.abs(was);
    const relative = rule.relative ?? null;
    let regressed =
      (relative === null || change > relative) && worse > rule.slack;
    if (rule.floor !== undefined && now <= rule.floor) regressed = false;
    const row = {
      metric,
      baseline: was,
      current: now,
      change: Math.round(change * 1000) / 10,
      regressed,
    };
    if (rule.compareOn && platform && !rule.compareOn.includes(platform)) {
      row.regressed = false;
      row.note = "只记录";
    }
    rows.push(row);
  }
  return rows;
}

const phaseOf = (report, stage) =>
  report.phases?.find((phase) => phase.stage === stage);
const roleMem = (phase, role) => phase?.byRole?.[role]?.mem ?? null;

/**
 * 一次运行的结果折算成比对用的指标。阶段按 `stage` 找：`active`、
 * `offscreen-long`、`back-visible`、`after-gc`。
 */
export function deriveMetrics(report) {
  const active = phaseOf(report, "active");
  const offLong = phaseOf(report, "offscreen-long");
  const back = phaseOf(report, "back-visible");
  const gc = phaseOf(report, "after-gc");
  const runtime = report.runtime ?? {};
  const backMem = roleMem(back, "renderer");
  const gcMem = roleMem(gc, "renderer");
  const tmux = report.options?.backend !== "direct";
  return {
    rendererActiveMiB: roleMem(active, "renderer"),
    rendererOffscreenLongMiB: roleMem(offLong, "renderer"),
    rendererAfterGcDeltaMiB:
      backMem !== null && gcMem !== null ? round1(gcMem - backMem) : null,
    gpuOffscreenLongMiB:
      report.options?.renderer === "webgl" ? roleMem(offLong, "gpu") : null,
    runtimeEldMaxMs: runtime.eldMaxMs ?? null,
    runtimeEldP99MedianMs: runtime.eldP99MedianMs ?? null,
    runtimeSyncBlockedMsPerSec: runtime.syncBlockedMsPerSec ?? null,
    cadencePsPer65s: report.cadence?.psPer65s ?? null,
    tmuxTreeRssMiB: tmux ? (active?.tmuxRssMb ?? null) : null,
    tmuxProcs: tmux ? (active?.tmuxProcs ?? null) : null,
  };
}

/** 功能断言（不是性能容差）：开了 `--restore-check` 时行列与画面都得对上。 */
export function functionalFailures(report) {
  const failures = [];
  if (report.options?.restoreCheck) {
    const restore = report.restore;
    if (!restore) failures.push("restore-check 没有结果");
    else {
      if (!restore.gridMatches) failures.push("restoreGridMatches 为假");
      if (!restore.screenMatches) failures.push("restoreScreenMatches 为假");
    }
  }
  if (
    report.options?.pressure &&
    report.pressure &&
    !report.pressure.renderUnchanged
  )
    failures.push("注入压力后 data-render 变了");
  return failures;
}

/** 三次（或任意次）运行的指标取中位数，作为一份基线。 */
export function mergeRuns(reports) {
  if (reports.length === 0) throw new Error("没有可合并的结果");
  const scenario = reports[0].options;
  for (const report of reports.slice(1))
    if (!sameScenario(report.options, scenario))
      throw new Error(
        "要合并的结果场景不一致（终端数、速率、渲染器、后端或时长不同）",
      );
  const runs = reports.map(deriveMetrics);
  const metrics = {};
  for (const key of Object.keys(METRICS)) {
    const value = median(runs.map((run) => run[key]));
    metrics[key] = value === null ? null : round1(value);
  }
  return {
    options: Object.fromEntries(
      COMPARABLE_OPTIONS.map((key) => [key, scenario[key]]),
    ),
    metrics,
    runs,
  };
}

/** 结果的 Markdown 表：指标、这次、基线、差。 */
export function renderTable(metrics, rows = []) {
  const byMetric = Object.fromEntries(rows.map((row) => [row.metric, row]));
  const lines = ["| 指标 | 这次 | 基线 | 差 |", "| --- | ---: | ---: | ---: |"];
  for (const [metric, rule] of Object.entries(METRICS)) {
    const value = metrics[metric];
    const row = byMetric[metric];
    const flag = row?.regressed ? " ⚠" : row?.note ? `（${row.note}）` : "";
    lines.push(
      `| ${rule.label}（\`${metric}\`）${flag} | ${value ?? "—"} ${value === null || value === undefined ? "" : rule.unit} | ${row ? row.baseline : "—"} | ${row ? `${row.change}%` : "—"} |`,
    );
  }
  return lines.join("\n");
}
