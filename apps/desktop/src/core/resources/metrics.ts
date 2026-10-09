/**
 * Runtime 自己的健康数字（契约 §54）：事件循环延迟与资源采样循环的计数。
 *
 * 以前只有外挂的测量垫片量得到这些（打包版不读 `NODE_OPTIONS`，量不到）；现在
 * core 自己记，`GET /api/diagnostics/runtime` 读出来。**只有数字与时间戳**——没有
 * 命令行、路径、进程名。不进 `ResourceSnapshot`：那是面板的契约。
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/** 事件循环延迟报多长一段：最近 30–60 s（两段各 30 s 轮换）。 */
export const EVENT_LOOP_WINDOW_MS = 60_000;
/** 采样耗时的最大值看最近多少轮。 */
export const ROUND_HISTORY = 60;
/** p99 连续这么多轮超过 {@link SLOW_LOOP_P99_MS} 记一条 `warn`。 */
export const SLOW_LOOP_ROUNDS = 3;
export const SLOW_LOOP_P99_MS = 200;

export interface EventLoopReport {
  readonly windowMs: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

export interface SamplingReport {
  readonly intervalMs: number;
  readonly inFlight: boolean;
  readonly rounds: number;
  readonly lastRoundMs: number | null;
  readonly maxRoundMs: number | null;
  readonly overlapsSkipped: number;
  readonly timeouts: { ps: number; tmux: number; probe: number };
  readonly lastRoundAt: string | null;
}

export interface RuntimeReport {
  readonly eventLoop: EventLoopReport;
  readonly sampling: SamplingReport;
}

const ms = (nanoseconds: number): number =>
  Number.isFinite(nanoseconds) ? Math.round(nanoseconds / 1e4) / 100 : 0;

interface Segment {
  readonly count: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

function segmentOf(histogram: IntervalHistogram): Segment | undefined {
  if (histogram.count === 0) return undefined;
  return {
    count: histogram.count,
    p50: histogram.percentile(50),
    p99: histogram.percentile(99),
    max: histogram.max,
  };
}

/**
 * 事件循环延迟：`monitorEventLoopDelay` 10 ms 分辨率，两段各半个窗口轮换。读数
 * 合并上一段与当前段：`max` 与 `p99` 取两段里较大的（保守，宁可报高），`p50` 取
 * 样本多的那段。
 */
export class EventLoopMonitor {
  private current: IntervalHistogram | undefined;
  private previous: Segment | undefined;
  private rotateTimer: NodeJS.Timeout | undefined;

  constructor(private readonly windowMs = EVENT_LOOP_WINDOW_MS) {}

  enable(): void {
    if (this.current !== undefined) return;
    this.current = monitorEventLoopDelay({ resolution: 10 });
    this.current.enable();
    this.rotateTimer = setInterval(() => this.rotate(), this.windowMs / 2);
    this.rotateTimer.unref?.();
  }

  disable(): void {
    this.current?.disable();
    this.current = undefined;
    this.previous = undefined;
    if (this.rotateTimer !== undefined) clearInterval(this.rotateTimer);
    this.rotateTimer = undefined;
  }

  /** 当前段收成「上一段」，当前段清零。 */
  rotate(): void {
    if (this.current === undefined) return;
    this.previous = segmentOf(this.current);
    this.current.reset();
  }

  report(): EventLoopReport {
    const segments = [
      this.previous,
      this.current === undefined ? undefined : segmentOf(this.current),
    ].filter((one): one is Segment => one !== undefined);
    if (segments.length === 0) {
      return { windowMs: this.windowMs, p50Ms: 0, p99Ms: 0, maxMs: 0 };
    }
    const larger = segments.reduce((left, right) =>
      right.count > left.count ? right : left,
    );
    return {
      windowMs: this.windowMs,
      p50Ms: ms(larger.p50),
      p99Ms: ms(Math.max(...segments.map((one) => one.p99))),
      maxMs: ms(Math.max(...segments.map((one) => one.max))),
    };
  }
}

/** 采样循环的计数。时间只来自注入的时钟，测试能定。 */
export class SamplingMetrics {
  rounds = 0;
  overlapsSkipped = 0;
  readonly timeouts = { ps: 0, tmux: 0, probe: 0 };
  private lastRoundMs: number | null = null;
  private lastRoundAtMs: number | null = null;
  private readonly recent: number[] = [];
  inFlight = false;

  /** 一轮完成（成功的那种）用了多久。 */
  noteRound(durationMs: number, atMs: number): void {
    this.rounds += 1;
    const rounded = Math.round(durationMs * 10) / 10;
    this.lastRoundMs = rounded;
    this.lastRoundAtMs = atMs;
    this.recent.push(rounded);
    if (this.recent.length > ROUND_HISTORY) this.recent.shift();
  }

  noteTimeout(source: "ps" | "tmux" | "probe"): void {
    this.timeouts[source] += 1;
  }

  noteOverlap(): void {
    this.overlapsSkipped += 1;
  }

  report(intervalMs: number): SamplingReport {
    return {
      intervalMs,
      inFlight: this.inFlight,
      rounds: this.rounds,
      lastRoundMs: this.lastRoundMs,
      maxRoundMs: this.recent.length === 0 ? null : Math.max(...this.recent),
      overlapsSkipped: this.overlapsSkipped,
      timeouts: { ...this.timeouts },
      lastRoundAt:
        this.lastRoundAtMs === null
          ? null
          : new Date(this.lastRoundAtMs).toISOString(),
    };
  }
}

/**
 * 两样合在一起，资源域装配时建一份。`checkSlowLoop` 每轮采样后调一次：p99 连续
 * {@link SLOW_LOOP_ROUNDS} 轮超过 {@link SLOW_LOOP_P99_MS} 记一条只有数字的 `warn`，
 * 回落之后才会再记。
 */
export class RuntimeMetrics {
  readonly eventLoop: EventLoopMonitor;
  readonly sampling = new SamplingMetrics();
  private slowStreak = 0;

  constructor(
    private readonly warn: (
      message: string,
      fields: Record<string, number>,
    ) => void = () => {},
    eventLoop: EventLoopMonitor = new EventLoopMonitor(),
  ) {
    this.eventLoop = eventLoop;
  }

  checkSlowLoop(): void {
    const { p99Ms, maxMs } = this.eventLoop.report();
    if (p99Ms <= SLOW_LOOP_P99_MS) {
      this.slowStreak = 0;
      return;
    }
    this.slowStreak += 1;
    if (this.slowStreak === SLOW_LOOP_ROUNDS) {
      this.warn("runtime event loop is slow", { p99Ms, maxMs });
    }
  }

  report(intervalMs: number): RuntimeReport {
    return {
      eventLoop: this.eventLoop.report(),
      sampling: this.sampling.report(intervalMs),
    };
  }
}
