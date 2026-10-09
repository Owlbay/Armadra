/**
 * 把桌面壳的 `memory:pressure` 接进页面总线（性能设计 A3）。
 *
 * 壳每 15 秒异步探一次系统压力，只在等级变化时推一条 `{ level }`（升档立刻，
 * 降档要连续两次，见 `apps/desktop/src/main/memory-pressure.ts`）。这里只做
 * 一件事：收到就转给 `pressure-bus.ts`。浏览器里跑（没有 `window.armadra`）或
 * 壳不认这条通道时什么都不装，只剩采样那一路。
 *
 * 由 `render-budget.ts` 在第一个终端登记时装上：没有终端就没有可回收的东西。
 *
 * 另外挂一个诊断把手 `window.__armadraMemoryPressure`，探针经 CDP 注入假压力
 * （`emit("warning")`）验证回收；它只是总线的两个函数，不带任何数据。
 */
import { MEMORY_PRESSURE_ENABLED, isPressureLevel } from "./pressure-policy";
import { currentMemoryPressure, emitMemoryPressure } from "./pressure-bus";

export { MEMORY_PRESSURE_ENABLED } from "./pressure-policy";

interface PressureBridge {
  readonly memory?: {
    onPressure?: (listener: (event: { level: unknown }) => void) => () => void;
  };
}

let stop: (() => void) | null = null;

function bridgeOf(): PressureBridge | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as unknown as { armadra?: PressureBridge }).armadra;
}

/** 装一次；再调用拿到同一个卸载函数。 */
export function installMemoryPressure(
  bridge: PressureBridge | undefined = bridgeOf(),
): () => void {
  if (!MEMORY_PRESSURE_ENABLED) return () => {};
  if (stop) return stop;
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__armadraMemoryPressure = {
      emit: (level: unknown) => {
        if (isPressureLevel(level)) emitMemoryPressure(level, "shell");
      },
      current: currentMemoryPressure,
    };
  }
  const subscribe = bridge?.memory?.onPressure;
  const off =
    typeof subscribe === "function"
      ? subscribe((event) => {
          const level = event?.level;
          if (isPressureLevel(level)) emitMemoryPressure(level, "shell");
        })
      : () => {};
  stop = () => {
    off();
    stop = null;
  };
  return stop;
}
