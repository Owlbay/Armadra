import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * 系统内存压力：主进程每 15 秒异步探一次，只在等级**变化**时经
 * `memory:pressure` 推给页面（性能设计 A3）。页面拿它把看不见的终端的渲染名额
 * 与前端实例还回去（`apps/web/src/terminal/pressure-bus.ts`）。
 *
 * 不 import core：core 的 `resources/platform-probe.ts` 有同一张 macOS 表，但壳
 * 与 core 是两个进程、两条依赖线，这里自己写一份十行的纯函数。
 *
 * 三个平台各一个来源：
 *
 *  - macOS：`sysctl -n kern.memorystatus_vm_pressure_level`，1/2/4 →
 *    normal/warning/critical（XNU `kern_memorystatus.h`）。
 *  - Linux：`/proc/pressure/memory`（PSI）。PSI 报的是停顿时间占比，不是等级，
 *    下面的阈值是**我们自己定的**：`some avg10 ≥ 10` → warning（10 秒窗口里有
 *    十分之一的时间至少一个任务在等内存），`full avg10 ≥ 5` → critical（所有
 *    非空闲任务一起等）。
 *  - Windows：`process.getSystemMemoryInfo()` 的空闲占比，`< 10%` → warning，
 *    `< 5%` → critical。
 *
 * 迟滞：升档立刻发；降档要**连续两次**探到更低档才发，压力在边界上来回跳时页面
 * 不至于反复回收。读不到（命令失败、没有 PSI）是这一轮没有读数，不改变状态。
 */

export type MemoryPressureLevel = "normal" | "warning" | "critical";

export const MEMORY_PRESSURE_INTERVAL_MS = 15_000;
/** 单次探测的上限；探不到就跳过这一轮。 */
export const MEMORY_PRESSURE_PROBE_TIMEOUT_MS = 3_000;

const RANK: Record<MemoryPressureLevel, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
};

/** macOS：`sysctl` 的输出。认不出来的值是未知，不是最接近的猜测。 */
export function darwinPressure(stdout: string): MemoryPressureLevel | null {
  const level = Number.parseInt(stdout.trim(), 10);
  if (level === 1) return "normal";
  if (level === 2) return "warning";
  if (level === 4) return "critical";
  return null;
}

/** Linux：`/proc/pressure/memory` 的正文。 */
export function linuxPressure(text: string): MemoryPressureLevel | null {
  const avg10 = (kind: "some" | "full"): number | null => {
    const line = text.split("\n").find((each) => each.startsWith(`${kind} `));
    const match = line ? /\bavg10=([\d.]+)/.exec(line) : null;
    if (!match) return null;
    const value = Number.parseFloat(match[1]!);
    return Number.isFinite(value) ? value : null;
  };
  const some = avg10("some");
  const full = avg10("full");
  if (some === null && full === null) return null;
  if (full !== null && full >= 5) return "critical";
  if (some !== null && some >= 10) return "warning";
  return "normal";
}

/** Windows：`getSystemMemoryInfo()`（单位 KB，比值与单位无关）。 */
export function windowsPressure(info: {
  total?: number;
  free?: number;
}): MemoryPressureLevel | null {
  const { total, free } = info;
  if (typeof total !== "number" || typeof free !== "number" || total <= 0) {
    return null;
  }
  const ratio = free / total;
  if (ratio < 0.05) return "critical";
  if (ratio < 0.1) return "warning";
  return "normal";
}

/**
 * 迟滞：喂一次读数，答这次要不要发、发哪档。
 *
 * 起点是 normal（页面也从 normal 起步），所以一开机就是 normal 不发任何东西。
 */
export class PressureHysteresis {
  private current: MemoryPressureLevel = "normal";
  private lower: MemoryPressureLevel[] = [];

  get level(): MemoryPressureLevel {
    return this.current;
  }

  next(reading: MemoryPressureLevel | null): MemoryPressureLevel | null {
    if (reading === null) return null;
    if (RANK[reading] >= RANK[this.current]) {
      this.lower = [];
      if (reading === this.current) return null;
      this.current = reading;
      return reading;
    }
    this.lower.push(reading);
    if (this.lower.length < 2) return null;
    // 两次都更低：落到两次里较高的那档，不一步跌到最低。
    const [a, b] = this.lower.slice(-2) as [
      MemoryPressureLevel,
      MemoryPressureLevel,
    ];
    this.lower = [];
    this.current = RANK[a] >= RANK[b] ? a : b;
    return this.current;
  }
}

export interface ProbeDeps {
  platform: NodeJS.Platform;
  sysctl: () => Promise<string>;
  readPsi: () => Promise<string>;
  systemMemory: () => { total?: number; free?: number };
}

const defaultDeps = (): ProbeDeps => ({
  platform: process.platform,
  sysctl: () =>
    new Promise((resolve, reject) => {
      execFile(
        "sysctl",
        ["-n", "kern.memorystatus_vm_pressure_level"],
        { timeout: MEMORY_PRESSURE_PROBE_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
      );
    }),
  readPsi: () => readFile("/proc/pressure/memory", "utf8"),
  systemMemory: () =>
    (
      process as NodeJS.Process & {
        getSystemMemoryInfo?: () => { total?: number; free?: number };
      }
    ).getSystemMemoryInfo?.() ?? {},
});

/** 一次读数；读不到是 `null`。从不抛。 */
export async function probeMemoryPressure(
  deps: ProbeDeps = defaultDeps(),
): Promise<MemoryPressureLevel | null> {
  try {
    if (deps.platform === "darwin") return darwinPressure(await deps.sysctl());
    if (deps.platform === "linux") return linuxPressure(await deps.readPsi());
    if (deps.platform === "win32") return windowsPressure(deps.systemMemory());
  } catch {
    // 命令失败、超时、没有 PSI：这一轮没有读数。
  }
  return null;
}

export interface MemoryPressureOptions {
  /** 发给页面；窗口没开就丢掉，页面重载后靠 `current()` 补。 */
  send: (level: MemoryPressureLevel) => void;
  probe?: () => Promise<MemoryPressureLevel | null>;
  intervalMs?: number;
}

export interface MemoryPressureWatch {
  /** 当前（迟滞之后的）档；页面重载后补发用。 */
  current(): MemoryPressureLevel;
  /** 立刻探一次（测试用，也是启动时的第一次）。 */
  tick(): Promise<void>;
  stop(): void;
}

/**
 * 开始探测。上一轮还没回来就跳过这一轮，探测永远不叠加；计时器 `unref`，不拖住
 * 退出。
 */
export function watchMemoryPressure(
  options: MemoryPressureOptions,
): MemoryPressureWatch {
  const probe = options.probe ?? (() => probeMemoryPressure());
  const hysteresis = new PressureHysteresis();
  let inFlight = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const changed = hysteresis.next(await probe());
      if (changed !== null && !stopped) options.send(changed);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(
    () => void tick(),
    options.intervalMs ?? MEMORY_PRESSURE_INTERVAL_MS,
  );
  timer.unref?.();
  return {
    current: () => hysteresis.level,
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
