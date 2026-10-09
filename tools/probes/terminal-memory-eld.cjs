// terminal-memory.mjs --unpacked --eld-preload 的测量垫片：只在 core 进程里生效（经 NODE_OPTIONS=--require 注入）。
//
// 1. 事件循环延迟：perf_hooks.monitorEventLoopDelay，每 BENCH_ELD_MS 写一行 JSON 后重置。
// 2. 同步子进程：包一层 child_process.execFileSync / spawnSync，按命令统计次数与耗时
//    （core 的 bundle 用 `(0, node_child_process.execFileSync)(...)` 每次取属性，所以替换模块导出即可）。
//
// 输出：BENCH_ELD_FILE（JSON Lines）。非 core 进程（Electron 主进程等）什么都不做。
"use strict";
const argv = process.argv.join(" ");
if (!argv.includes("core/main.js") || !process.env.BENCH_ELD_FILE) return;

const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const childProcess = require("node:child_process");
const { appendFileSync } = require("node:fs");

const file = process.env.BENCH_ELD_FILE;
const interval = Number(process.env.BENCH_ELD_MS || 5000);
const histogram = monitorEventLoopDelay({ resolution: 1 });
histogram.enable();

const spawns = new Map();
function track(name, original) {
  return function wrapped(command, ...rest) {
    const started = performance.now();
    try {
      return original.call(this, command, ...rest);
    } finally {
      const elapsed = performance.now() - started;
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      const key =
        `${name} ${String(command).split("/").pop()} ${args.slice(0, 2).join(" ")}`.slice(
          0,
          80,
        );
      const entry = spawns.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
      entry.count += 1;
      entry.totalMs += elapsed;
      entry.maxMs = Math.max(entry.maxMs, elapsed);
      spawns.set(key, entry);
    }
  };
}
childProcess.execFileSync = track("execFileSync", childProcess.execFileSync);
childProcess.spawnSync = track("spawnSync", childProcess.spawnSync);
childProcess.execSync = track("execSync", childProcess.execSync);

const ms = (ns) => Math.round((ns / 1e6) * 100) / 100;
let last = performance.eventLoopUtilization();
const timer = setInterval(() => {
  const now = performance.eventLoopUtilization();
  const elu = performance.eventLoopUtilization(now, last);
  last = now;
  const sync = {};
  for (const [key, entry] of spawns) {
    sync[key] = {
      count: entry.count,
      totalMs: Math.round(entry.totalMs * 10) / 10,
      maxMs: Math.round(entry.maxMs * 10) / 10,
    };
  }
  spawns.clear();
  const memory = process.memoryUsage();
  appendFileSync(
    file,
    `${JSON.stringify({
      t: Date.now(),
      pid: process.pid,
      eld: {
        min: ms(histogram.min),
        mean: ms(histogram.mean),
        p50: ms(histogram.percentile(50)),
        p99: ms(histogram.percentile(99)),
        max: ms(histogram.max),
      },
      elu: Math.round(elu.utilization * 1000) / 1000,
      rssMb: Math.round(memory.rss / 1048576),
      heapUsedMb: Math.round(memory.heapUsed / 1048576),
      sync,
    })}\n`,
  );
  histogram.reset();
}, interval);
timer.unref();
