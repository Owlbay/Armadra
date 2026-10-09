/**
 * 内存压力的页面总线（性能设计 A3）。
 *
 * 两路来源往这里报：
 *
 *  - `shell`：桌面壳主进程自己探的系统压力（`memory:pressure` IPC，见
 *    `memory-pressure.ts`），三平台都有；
 *  - `sample`：core 的 `resource.sample` 里的 `host.memory.pressure`（服务器壳 /
 *    浏览器里跑时的后备；只认本机，见 `panels/resources/sampling.ts`）。
 *
 * 各记最新一档，**有效档取最高**。采样那一路超过 `SAMPLE_STALE_MS` 没再报就
 * 作废：采样停了（没有徽标在看），它最后一次说的 warning 不该一直压着。
 *
 * 订阅者收到的是有效档，只在两种时候回调：
 *
 *  1. 有效档是 warning / critical，且 `pressure-policy.ts` 的 `decide` 说这次该
 *     回收（同档 20 秒内不重复，升档立刻）；
 *  2. 有效档变回 normal 的那一次（策略上降级什么都不做，订阅者可以忽略）。
 *
 * 该回收什么由订阅者按档自己取（`actionFor`）：渲染名额那一份在
 * `render-budget.ts`，前端实例那一份在终端生命周期。
 */
import {
  MEMORY_PRESSURE_ENABLED,
  acts,
  decide,
  pressureRank,
  type MemoryPressureLevel,
  type PressureMemo,
} from "./pressure-policy";

export type { MemoryPressureLevel } from "./pressure-policy";

export type MemoryPressureSource = "shell" | "sample";

/** 采样那一路多久没报就不算数（离屏徽标 30 秒一次，留三次的余量）。 */
export const SAMPLE_STALE_MS = 90_000;

type Listener = (level: MemoryPressureLevel) => void;

const listeners = new Set<Listener>();
let shell: MemoryPressureLevel = "normal";
let sample: { level: MemoryPressureLevel; at: number } | null = null;
let memo: PressureMemo | null = null;
/** 上一次通知出去的档；只用来判断「变回 normal」。 */
let notified: MemoryPressureLevel = "normal";

function effective(now: number): MemoryPressureLevel {
  const fromSample =
    sample !== null && now - sample.at <= SAMPLE_STALE_MS
      ? sample.level
      : "normal";
  return pressureRank(fromSample) > pressureRank(shell) ? fromSample : shell;
}

function notify(level: MemoryPressureLevel): void {
  notified = level;
  for (const listener of [...listeners]) {
    try {
      listener(level);
    } catch {
      // 一个订阅者出错不该挡住另一个的回收。
    }
  }
}

/** 报一档。`source` 缺省是壳。 */
export function emitMemoryPressure(
  level: MemoryPressureLevel,
  source: MemoryPressureSource = "shell",
): void {
  if (!MEMORY_PRESSURE_ENABLED) return;
  const now = Date.now();
  if (source === "shell") shell = level;
  else sample = { level, at: now };
  const current = effective(now);
  if (current === "normal") {
    if (notified !== "normal") notify("normal");
    return;
  }
  const decision = decide(current, now, memo);
  if (!acts(decision)) return;
  memo = { level: current, nextAllowedAt: decision.nextAllowedAt };
  notify(current);
}

/** 订阅有效档；返回退订。 */
export function onMemoryPressure(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 此刻的有效档。 */
export function currentMemoryPressure(): MemoryPressureLevel {
  return effective(Date.now());
}

/** 测试用：清掉两路的档与节流记录。订阅者不动——它们各自退订。 */
export function resetMemoryPressure(): void {
  shell = "normal";
  sample = null;
  memo = null;
  notified = "normal";
}
