import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFlushScheduler } from "./flush-scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("共享灌写调度器", () => {
  it("没有数据就没有定时器", () => {
    const scheduler = createFlushScheduler(500);
    expect(scheduler.armed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("多个表面共用一个定时器，同一个任务一拍只跑一次", () => {
    const scheduler = createFlushScheduler(500);
    const a = vi.fn();
    const b = vi.fn();
    scheduler.request(a);
    scheduler.request(b);
    scheduler.request(a);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(499);
    expect(a).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    // 跑完就停：不再有空转的定时器。
    expect(scheduler.armed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("背压：任务在自己里面再登记，排到下一拍而不是这一拍", () => {
    const scheduler = createFlushScheduler(500);
    let runs = 0;
    const task = () => {
      runs += 1;
      if (runs < 3) scheduler.request(task);
    };
    scheduler.request(task);
    vi.advanceTimersByTime(500);
    expect(runs).toBe(1);
    vi.advanceTimersByTime(500);
    expect(runs).toBe(2);
    vi.advanceTimersByTime(500);
    expect(runs).toBe(3);
    vi.advanceTimersByTime(5_000);
    expect(runs).toBe(3);
  });

  it("撤掉最后一个登记时一并撤掉定时器", () => {
    const scheduler = createFlushScheduler(500);
    const task = vi.fn();
    scheduler.request(task);
    scheduler.cancel(task);
    expect(scheduler.armed).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(task).not.toHaveBeenCalled();
  });

  it("一个任务抛错不拖住其余任务", () => {
    const scheduler = createFlushScheduler(500);
    const after = vi.fn();
    scheduler.request(() => {
      throw new Error("boom");
    });
    scheduler.request(after);
    vi.advanceTimersByTime(500);
    expect(after).toHaveBeenCalledTimes(1);
  });
});
