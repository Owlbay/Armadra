import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useThrottledValue } from "./use-throttled-value";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useThrottledValue", () => {
  it("冷却期内的变化只在尾沿跟一次，跟的是最新值", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useThrottledValue(value, 60),
      { initialProps: { value: 0 } },
    );
    expect(result.current).toBe(0);

    rerender({ value: 1 });
    rerender({ value: 2 });
    rerender({ value: 3 });
    expect(result.current).toBe(0);

    act(() => vi.advanceTimersByTime(60));
    expect(result.current).toBe(3);
  });

  it("冷却过了就立刻跟上", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useThrottledValue(value, 60),
      { initialProps: { value: "a" } },
    );
    act(() => vi.advanceTimersByTime(100));
    rerender({ value: "b" });
    expect(result.current).toBe("b");
  });
});
