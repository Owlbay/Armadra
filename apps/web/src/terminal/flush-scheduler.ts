/**
 * 离屏输出的共享灌写调度器（性能设计 §2.4 B3）。
 *
 * 以前每个离屏终端各挂一个 500 ms 的 `setInterval`，不管有没有数据都醒；
 * 20 个终端就是每秒 40 次空转。现在全页只有一个定时器，而且只在至少一个
 * 表面有待灌数据时才排：`request` 登记，到点一次性取走全部登记并逐个调用，
 * 没有登记就没有定时器。仍有数据的表面（背压：上一批没被 xterm 消化完）
 * 由它自己再登记一次。
 */

import { OFFSCREEN_FLUSH_MS } from "./render-state";

export type FlushTask = () => void;

export interface FlushScheduler {
  /** 下一拍灌一次。同一个任务登记多次只算一次。 */
  request: (task: FlushTask) => void;
  /** 表面卸载时撤掉自己的登记。 */
  cancel: (task: FlushTask) => void;
  /** 有没有在排的定时器（测试与诊断用）。 */
  readonly armed: boolean;
  readonly size: number;
}

export function createFlushScheduler(
  intervalMs: number = OFFSCREEN_FLUSH_MS,
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): FlushScheduler {
  const tasks = new Set<FlushTask>();
  let handle: unknown = null;

  const run = () => {
    handle = null;
    const due = [...tasks];
    tasks.clear();
    for (const task of due) {
      try {
        task();
      } catch {
        // 一个表面灌坏了不能拖住其余表面。
      }
    }
  };

  return {
    request(task) {
      tasks.add(task);
      handle ??= timers.set(run, intervalMs);
    },
    cancel(task) {
      tasks.delete(task);
      if (tasks.size === 0 && handle !== null) {
        timers.clear(handle);
        handle = null;
      }
    },
    get armed() {
      return handle !== null;
    },
    get size() {
      return tasks.size;
    },
  };
}

/** 全页共用的那一个。 */
export const flushScheduler = createFlushScheduler();
