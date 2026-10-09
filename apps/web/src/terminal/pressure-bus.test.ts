import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SAMPLE_STALE_MS,
  currentMemoryPressure,
  emitMemoryPressure,
  onMemoryPressure,
  resetMemoryPressure,
  type MemoryPressureLevel,
} from "./pressure-bus";
import { PRESSURE_RESCAN_MS } from "./pressure-policy";

let seen: MemoryPressureLevel[] = [];
let off: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  seen = [];
  off = onMemoryPressure((level) => seen.push(level));
});

afterEach(() => {
  off();
  resetMemoryPressure();
  vi.useRealTimers();
});

describe("pressure-bus", () => {
  it("warning 通知一次，20 秒内同档不再通知", () => {
    emitMemoryPressure("warning");
    emitMemoryPressure("warning", "sample");
    vi.advanceTimersByTime(PRESSURE_RESCAN_MS - 1);
    emitMemoryPressure("warning");
    expect(seen).toEqual(["warning"]);
    vi.advanceTimersByTime(1);
    emitMemoryPressure("warning");
    expect(seen).toEqual(["warning", "warning"]);
  });

  it("升档立刻通知", () => {
    emitMemoryPressure("warning");
    emitMemoryPressure("critical", "sample");
    expect(seen).toEqual(["warning", "critical"]);
  });

  it("两路取最高：壳降回 normal 时采样仍是 warning，就还是 warning", () => {
    emitMemoryPressure("warning", "sample");
    emitMemoryPressure("critical");
    emitMemoryPressure("normal");
    expect(currentMemoryPressure()).toBe("warning");
    expect(seen).toEqual(["warning", "critical"]);
  });

  it("变回 normal 只通知一次", () => {
    emitMemoryPressure("warning");
    emitMemoryPressure("normal");
    emitMemoryPressure("normal");
    expect(seen).toEqual(["warning", "normal"]);
  });

  it("一开始就是 normal 不通知", () => {
    emitMemoryPressure("normal");
    emitMemoryPressure("normal", "sample");
    expect(seen).toEqual([]);
  });

  it("采样那一路太久没报就作废", () => {
    emitMemoryPressure("warning", "sample");
    expect(currentMemoryPressure()).toBe("warning");
    vi.advanceTimersByTime(SAMPLE_STALE_MS + 1);
    expect(currentMemoryPressure()).toBe("normal");
  });

  it("一个订阅者抛错不挡另一个", () => {
    const stop = onMemoryPressure(() => {
      throw new Error("boom");
    });
    const later: MemoryPressureLevel[] = [];
    const stop2 = onMemoryPressure((level) => later.push(level));
    emitMemoryPressure("critical");
    expect(later).toEqual(["critical"]);
    stop();
    stop2();
  });
});
