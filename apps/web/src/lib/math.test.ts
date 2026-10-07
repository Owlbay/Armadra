import { describe, expect, it } from "vitest";
import { clamp, clampInt } from "./math";

describe("clamp", () => {
  it("范围内原样返回，越界夹到边界", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
    expect(clamp(1.25, 1, 2)).toBe(1.25);
  });

  it("非有限值回到下界", () => {
    expect(clamp(Number.NaN, 3, 9)).toBe(3);
    expect(clamp(Number.POSITIVE_INFINITY, 3, 9)).toBe(3);
  });
});

describe("clampInt", () => {
  it("取整并夹进范围", () => {
    expect(clampInt(4.6, 0, 10)).toBe(5);
    expect(clampInt(99.4, 0, 10)).toBe(10);
    expect(clampInt(Number.NaN, 200, 2560)).toBe(200);
  });
});
