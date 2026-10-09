import { describe, expect, it } from "vitest";

import {
  EventLoopMonitor,
  ROUND_HISTORY,
  RuntimeMetrics,
  SLOW_LOOP_P99_MS,
  SLOW_LOOP_ROUNDS,
  SamplingMetrics,
  type EventLoopReport,
} from "./metrics";

describe("采样计数", () => {
  it("轮数、最近一轮、窗口里的最大值与超时各自计", () => {
    const metrics = new SamplingMetrics();
    expect(metrics.report(2_000)).toEqual({
      intervalMs: 2_000,
      inFlight: false,
      rounds: 0,
      lastRoundMs: null,
      maxRoundMs: null,
      overlapsSkipped: 0,
      timeouts: { ps: 0, tmux: 0, probe: 0 },
      lastRoundAt: null,
    });
    metrics.noteRound(500, 0);
    for (let index = 0; index < ROUND_HISTORY; index += 1) {
      metrics.noteRound(10 + index / 100, 1_000 + index);
    }
    metrics.noteTimeout("ps");
    metrics.noteTimeout("tmux");
    metrics.noteTimeout("ps");
    const report = metrics.report(30_000);
    expect(report.rounds).toBe(ROUND_HISTORY + 1);
    // 500 ms 那一轮已经滚出最近 60 轮。
    expect(report.maxRoundMs).toBeLessThan(11);
    expect(report.lastRoundMs).toBe(10.6);
    expect(report.timeouts).toEqual({ ps: 2, tmux: 1, probe: 0 });
    expect(report.lastRoundAt).toBe(
      new Date(1_000 + ROUND_HISTORY - 1).toISOString(),
    );
  });
});

describe("事件循环延迟", () => {
  it("没启用时是零；启用后量得到一次阻塞", async () => {
    const monitor = new EventLoopMonitor();
    expect(monitor.report()).toEqual({
      windowMs: 60_000,
      p50Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    });
    monitor.enable();
    try {
      await new Promise((done) => setTimeout(done, 50));
      const until = Date.now() + 80;
      while (Date.now() < until) {
        // 故意挡住事件循环。
      }
      await new Promise((done) => setTimeout(done, 50));
      const blocked = monitor.report();
      expect(blocked.maxMs).toBeGreaterThanOrEqual(60);
      // 轮换之后上一段仍在读数里。
      monitor.rotate();
      expect(monitor.report().maxMs).toBe(blocked.maxMs);
      monitor.rotate();
      expect(monitor.report().maxMs).toBeLessThan(blocked.maxMs);
    } finally {
      monitor.disable();
    }
  });

  it("p99 连续 3 轮偏高才记一条 warn，回落后才会再记", () => {
    let p99Ms = 0;
    const fake = {
      report: (): EventLoopReport => ({
        windowMs: 60_000,
        p50Ms: 1,
        p99Ms,
        maxMs: p99Ms * 2,
      }),
    } as unknown as EventLoopMonitor;
    const warnings: Record<string, number>[] = [];
    const metrics = new RuntimeMetrics((_message, fields) => {
      warnings.push(fields);
    }, fake);
    p99Ms = SLOW_LOOP_P99_MS + 1;
    for (let index = 0; index < SLOW_LOOP_ROUNDS - 1; index += 1) {
      metrics.checkSlowLoop();
    }
    expect(warnings).toEqual([]);
    metrics.checkSlowLoop();
    metrics.checkSlowLoop();
    expect(warnings).toEqual([{ p99Ms, maxMs: p99Ms * 2 }]);
    p99Ms = 5;
    metrics.checkSlowLoop();
    p99Ms = SLOW_LOOP_P99_MS + 1;
    for (let index = 0; index < SLOW_LOOP_ROUNDS; index += 1) {
      metrics.checkSlowLoop();
    }
    expect(warnings).toHaveLength(2);
  });
});
