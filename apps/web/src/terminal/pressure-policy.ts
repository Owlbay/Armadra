/**
 * 内存压力来了该回收什么（性能设计 A3）。纯函数，没有计时器、没有模块状态。
 *
 * 三条规矩：
 *
 *  - **可见与聚焦的一律不动。** 回收只碰看不见的终端：隐藏持有者的渲染名额
 *    （`releaseHidden()`），以及离屏已久的前端实例（终端生命周期的
 *    `released`）。从用户正盯着的终端上摘东西，是拿一次看得见的降级换内存，
 *    与渲染名额里「可见持有者不被回收」同一个理由。
 *  - **同一档 20 秒内不重复扫。** 压力会持续一阵，两路来源（壳、采样）每隔几
 *    秒都会再报一次；每报一次就扫一遍是白忙。升档（warning → critical）不等。
 *  - **降回 normal 什么也不做。** 不主动重建，等用户看到时再恢复——否则压力
 *    来回跳一次，就是一轮释放加一轮重建。
 */

export type MemoryPressureLevel = "normal" | "warning" | "critical";

/** 总开关。关掉之后两路来源都不进总线，回收一次也不发生。 */
export const MEMORY_PRESSURE_ENABLED = true;

/** 同一档（或更低档）两次回收之间的最短间隔。 */
export const PRESSURE_RESCAN_MS = 20_000;

/** warning：只释放离屏这么久以上的前端实例。 */
export const WARNING_RELEASE_OFFSCREEN_MS = 30_000;

export interface PressureAction {
  /** 把隐藏持有者的渲染名额还回去（`render-budget.ts` 的 `releaseHidden`）。 */
  releaseHiddenSlots: boolean;
  /**
   * 释放不可见且已经不可见这么久的前端实例；`0` 是「所有不可见的」，`null`
   * 是不释放。
   */
  releaseOffscreenOlderThanMs: number | null;
}

export interface PressureDecision extends PressureAction {
  /** 这次回收之后，同档最早什么时候可以再扫。没有动作时原样带回上一次的。 */
  nextAllowedAt: number;
}

/** 上一次真正回收的记录。 */
export interface PressureMemo {
  level: MemoryPressureLevel;
  nextAllowedAt: number;
}

const RANK: Record<MemoryPressureLevel, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
};

export function pressureRank(level: MemoryPressureLevel): number {
  return RANK[level];
}

export function isPressureLevel(value: unknown): value is MemoryPressureLevel {
  return value === "normal" || value === "warning" || value === "critical";
}

/** 一档对应的动作，不看节流。 */
export function actionFor(level: MemoryPressureLevel): PressureAction {
  if (level === "critical") {
    return { releaseHiddenSlots: true, releaseOffscreenOlderThanMs: 0 };
  }
  if (level === "warning") {
    return {
      releaseHiddenSlots: true,
      releaseOffscreenOlderThanMs: WARNING_RELEASE_OFFSCREEN_MS,
    };
  }
  return { releaseHiddenSlots: false, releaseOffscreenOlderThanMs: null };
}

/** 这次决定有没有任何动作。 */
export function acts(action: PressureAction): boolean {
  return (
    action.releaseHiddenSlots || action.releaseOffscreenOlderThanMs !== null
  );
}

const NOTHING: PressureAction = {
  releaseHiddenSlots: false,
  releaseOffscreenOlderThanMs: null,
};

/**
 * 这一档、此刻，要不要回收、回收什么。
 *
 * `last` 是上一次**真正回收**时记下的；没有动作的决定不更新它（调用方只在
 * `acts()` 为真时写回）。
 */
export function decide(
  level: MemoryPressureLevel,
  now: number,
  last: PressureMemo | null,
): PressureDecision {
  const previous = last?.nextAllowedAt ?? 0;
  if (level === "normal") return { ...NOTHING, nextAllowedAt: previous };
  const throttled =
    last !== null &&
    RANK[level] <= RANK[last.level] &&
    now < last.nextAllowedAt;
  if (throttled) return { ...NOTHING, nextAllowedAt: previous };
  return { ...actionFor(level), nextAllowedAt: now + PRESSURE_RESCAN_MS };
}
