/**
 * 会话资源阈值（契约 §27.4）：越线那一下发一次 `resources.threshold`。
 *
 * 以前这件事只在页面里做（终端徽标看着样本自己判），所以只有开着画布的那台
 * 屏幕知道「这个 Agent 吃掉了 9 GB」；手机上的推送永远等不到它。现在判定在
 * core：页面开着时随采样循环判（{@link ThresholdMonitor.observe}），没人看着
 * 而有设备登记了推送时由 {@link ThresholdWatch} 慢慢地自己采一轮。
 *
 * 去重与页面原来那一份一样按 `sessionId:generation`：同一次运行里在阈值上下
 * 抖动不会反复叫人；回落到阈值的 {@link REARM_RATIO} 以下才重新上膛，下次越线
 * 再发；换代（重启会话）是新的一次运行。
 *
 * 只是提醒：不终止、不休眠、不做任何处置（设计 §8「不自动杀最高占用会话」）。
 * 事件只带标识与数字，不带命令行、cwd 与进程名。
 */

import type { SessionResources } from "./sample";

/** 回落到阈值的九成以下才算「回来了」，免得在线上抖动的会话反复叫人。 */
export const REARM_RATIO = 0.9;

/** 没人看着时多久自己采一轮。比面板慢得多：这是叫人，不是画图。 */
export const WATCH_INTERVAL_MS = 30_000;

export interface ThresholdEvent {
  readonly type: "resources.threshold";
  readonly sessionId: string;
  readonly nodeId?: string;
  readonly metric: "memory";
  readonly value: number;
  readonly threshold: number;
}

export type ThresholdSink = (
  workspaceId: string,
  event: ThresholdEvent,
) => void;

type SessionSample = Pick<
  SessionResources,
  "sessionId" | "nodeId" | "generation" | "memoryBytes"
>;

export class ThresholdMonitor {
  /** 工作空间 → 已经越线叫过人的 `sessionId:generation`。 */
  private readonly over = new Map<string, Set<string>>();

  constructor(private readonly sink: ThresholdSink) {}

  /**
   * 看一份样本，返回这次新发了几条。`null` 的内存不算越线：测不出来不是
   * 「超了」。样本里没有了的会话（结束了）一并忘掉。
   */
  observe(
    workspaceId: string,
    sessions: readonly SessionSample[],
    thresholdBytes: number,
  ): number {
    if (!(thresholdBytes > 0)) return 0;
    const seen = this.over.get(workspaceId) ?? new Set<string>();
    const present = new Set<string>();
    let emitted = 0;
    for (const session of sessions) {
      const key = `${session.sessionId}:${session.generation}`;
      present.add(key);
      const memory = session.memoryBytes;
      if (typeof memory !== "number" || !Number.isFinite(memory)) continue;
      if (memory >= thresholdBytes) {
        if (seen.has(key)) continue;
        seen.add(key);
        emitted += 1;
        this.sink(workspaceId, {
          type: "resources.threshold",
          sessionId: session.sessionId,
          ...(session.nodeId === null || session.nodeId === ""
            ? {}
            : { nodeId: session.nodeId }),
          metric: "memory",
          value: Math.round(memory),
          threshold: thresholdBytes,
        });
      } else if (memory < thresholdBytes * REARM_RATIO) {
        seen.delete(key);
      }
    }
    for (const key of seen) if (!present.has(key)) seen.delete(key);
    if (seen.size === 0) this.over.delete(workspaceId);
    else this.over.set(workspaceId, seen);
    return emitted;
  }

  /** 工作空间没了：它的记录一并丢掉。 */
  forget(workspaceId: string): void {
    this.over.delete(workspaceId);
  }
}

export interface ThresholdWatchOptions {
  readonly monitor: ThresholdMonitor;
  /** 现在有活会话的工作空间。 */
  readonly workspaces: () => readonly string[];
  /** 一个工作空间此刻的会话样本。 */
  readonly sample: (workspaceId: string) => readonly SessionSample[];
  readonly threshold: () => number;
  /**
   * 值不值得自己采：有设备登记了推送才采。没人收的提醒不值得每半分钟走一遍
   * 进程表。
   */
  readonly wanted: () => boolean;
  /** 页面开着时采样循环已经在判，这些工作空间这一轮跳过。 */
  readonly watched?: (workspaceId: string) => boolean;
  readonly intervalMs?: number;
}

/** 没人看着时的那一轮。 */
export class ThresholdWatch {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: ThresholdWatchOptions) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(
      () => this.check(),
      this.options.intervalMs ?? WATCH_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 采一轮、判一轮。返回这次新发了几条。 */
  check(): number {
    let emitted = 0;
    try {
      if (!this.options.wanted()) return 0;
      const threshold = this.options.threshold();
      for (const workspaceId of this.options.workspaces()) {
        if (this.options.watched?.(workspaceId) === true) continue;
        try {
          emitted += this.options.monitor.observe(
            workspaceId,
            this.options.sample(workspaceId),
            threshold,
          );
        } catch {
          // 一个工作空间采不出来不挡别的。
        }
      }
    } catch {
      // 判不了就等下一轮。
    }
    return emitted;
  }
}
