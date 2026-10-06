// language-load-lib.mjs 的纯函数：统计、打字模型与共享瓶颈链路（假时钟）。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SharedLink,
  burstPeak,
  distribution,
  keystrokeActions,
  percentile,
  summarizeFrames,
} from "./language-load-lib.mjs";

test("百分位取最近秩，空数组答 0", () => {
  assert.equal(percentile([], 95), 0);
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 95), 95);
  assert.equal(percentile(values, 100), 100);
  assert.deepEqual(distribution([3, 1, 2]), {
    count: 3,
    p50: 2,
    p95: 3,
    max: 3,
    total: 6,
  });
});

test("突发峰值按滑动窗口算，帧数与字节各取最大", () => {
  const frames = [
    { at: 0, bytes: 10 },
    { at: 50, bytes: 10 },
    { at: 90, bytes: 10 },
    { at: 150, bytes: 1000 },
    { at: 400, bytes: 10 },
  ];
  assert.deepEqual(burstPeak(frames, 100), { frames: 3, bytes: 1010 });
  assert.deepEqual(burstPeak([], 100), { frames: 0, bytes: 0 });
});

test("帧按方向与种类分组，频率按时长折算", () => {
  const frames = [
    {
      direction: "up",
      kind: "request textDocument/completion",
      bytes: 200,
      at: 0,
    },
    {
      direction: "down",
      kind: "response textDocument/completion",
      bytes: 300_000,
      at: 20,
    },
    {
      direction: "down",
      kind: "textDocument/publishDiagnostics",
      bytes: 14_000,
      at: 30,
    },
    { direction: "up", kind: "textDocument/didChange", bytes: 900, at: 1_000 },
  ];
  const summary = summarizeFrames(frames, 2);
  assert.equal(summary.down.frames, 2);
  assert.equal(summary.down.perSecond, 1);
  assert.equal(summary.down.bytes.max, 300_000);
  assert.equal(summary.up.frames, 2);
  assert.equal(
    summary.byKind["down response textDocument/completion"].perSecond,
    0.5,
  );
  assert.deepEqual(summary.down.burst100ms, { frames: 2, bytes: 314_000 });
});

test("编辑器档：补全只在词首与 . 之后；压力档每个字符都发", () => {
  assert.deepEqual(keystrokeActions("editor", " ", "c"), {
    change: false,
    completion: true,
  });
  assert.deepEqual(keystrokeActions("editor", "c", "o"), {
    change: false,
    completion: false,
  });
  assert.deepEqual(keystrokeActions("editor", "t", "."), {
    change: false,
    completion: true,
  });
  assert.deepEqual(keystrokeActions("editor", "t", " "), {
    change: false,
    completion: false,
  });
  assert.deepEqual(keystrokeActions("stress", "c", "o"), {
    change: true,
    completion: true,
  });
  assert.deepEqual(keystrokeActions("stress", "o", " "), {
    change: true,
    completion: false,
  });
});

/** 假时钟：`schedule` 进表，`advance` 按到期先后执行。 */
function fakeClock() {
  let now = 0;
  let sequence = 0;
  const timers = [];
  return {
    clock: () => now,
    schedule: (fn, ms) => {
      timers.push({ at: now + Math.max(0, ms), fn, sequence: (sequence += 1) });
    },
    advance(until) {
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
        const next = timers[0];
        if (next === undefined || next.at > until) break;
        timers.shift();
        now = next.at;
        next.fn();
      }
      now = until;
    },
  };
}

/** 一条 100 KiB 的大帧先进链路，紧接着一条 100 字节的小帧走另一条连接。 */
function race(mode) {
  const time = fakeClock();
  const arrivals = [];
  const link = new SharedLink({
    bytesPerSecond: 1024 * 1024,
    delayMs: 20,
    mode,
    clock: time.clock,
    schedule: time.schedule,
    deliver: (connection, segment) =>
      arrivals.push({ connection, bytes: segment.length, at: time.clock() }),
  });
  link.push("language", Buffer.alloc(100 * 1024));
  link.push("events", Buffer.alloc(100));
  time.advance(10_000);
  return { arrivals, link };
}

test("fifo：小帧排在大帧后面（队头阻塞）；fair：小帧插在第二段就到", () => {
  const fifo = race("fifo");
  const fair = race("fair");
  const eventAt = (run) =>
    run.arrivals.find((entry) => entry.connection === "events").at;
  // 100 KiB 在 1 MiB/s 上是 97.7 ms，再加 20 ms 单程。
  assert.ok(eventAt(fifo) > 115, `fifo ${eventAt(fifo)}`);
  assert.ok(eventAt(fair) < 30, `fair ${eventAt(fair)}`);
  for (const run of [fifo, fair]) {
    const total = run.arrivals
      .filter((entry) => entry.connection === "language")
      .reduce((sum, entry) => sum + entry.bytes, 0);
    assert.equal(total, 100 * 1024, "字节一个不少");
    assert.ok(run.link.idle(), "排空后空闲");
    assert.equal(run.link.backlog("language"), 0);
  }
});

test("同一条连接的段按送出顺序交付", () => {
  const time = fakeClock();
  const order = [];
  const link = new SharedLink({
    bytesPerSecond: 64 * 1024,
    delayMs: 5,
    mode: "fifo",
    segmentBytes: 10,
    clock: time.clock,
    schedule: time.schedule,
    deliver: (_connection, segment) => order.push(segment.toString()),
  });
  link.push("a", Buffer.from("0123456789abcdefghij"));
  link.push("a", Buffer.from("KLMNOPQRST"));
  time.advance(1_000);
  assert.equal(order.join(""), "0123456789abcdefghijKLMNOPQRST");
});
