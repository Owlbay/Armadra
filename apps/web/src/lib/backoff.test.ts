import { describe, expect, it } from "vitest";
import { backoffCeiling, backoffDelay, createBackoff } from "./backoff";

const EVENTS = { baseMs: 1_000, capMs: 10_000 } as const;

describe("backoffCeiling", () => {
  it("起步值翻倍，封顶后不再增长", () => {
    const ceilings = [0, 1, 2, 3, 4, 5].map((n) => backoffCeiling(n, EVENTS));
    expect(ceilings).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });

  it("很大的次数也只是封顶，不溢出", () => {
    expect(backoffCeiling(99, EVENTS)).toBe(10_000);
    expect(backoffCeiling(10_000, EVENTS)).toBe(10_000);
  });

  it("负数与小数按第 0 次算", () => {
    expect(backoffCeiling(-3, EVENTS)).toBe(1_000);
    expect(backoffCeiling(1.9, EVENTS)).toBe(2_000);
  });

  it("各条连接的起步值与封顶值", () => {
    // 实时协同 500 ms 起；浏览器画面 250 ms 起。
    expect(backoffCeiling(5, { baseMs: 500, capMs: 10_000 })).toBe(10_000);
    expect(backoffCeiling(3, { baseMs: 500, capMs: 10_000 })).toBe(4_000);
    expect(backoffCeiling(5, { baseMs: 250, capMs: 10_000 })).toBe(8_000);
  });
});

describe("backoffDelay", () => {
  it("全抖动：随机数取 0 到接近 1，等待落在 [0, 上限) 之内", () => {
    expect(backoffDelay(2, { ...EVENTS, random: () => 0 })).toBe(0);
    expect(backoffDelay(2, { ...EVENTS, random: () => 0.5 })).toBe(2_000);
    expect(backoffDelay(2, { ...EVENTS, random: () => 0.999999 })).toBe(3_999);
  });

  it("真随机的结果永远不超过上限", () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const delay = backoffDelay(attempt, EVENTS);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(backoffCeiling(attempt, EVENTS));
    }
  });
});

describe("createBackoff", () => {
  it("next() 逐次放宽上限，reset() 回到起步值", () => {
    const backoff = createBackoff({ ...EVENTS, random: () => 0.999999 });
    expect([backoff.next(), backoff.next(), backoff.next()]).toEqual([
      999, 1_999, 3_999,
    ]);
    expect(backoff.attempt).toBe(3);
    backoff.reset();
    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(999);
  });

  it("封顶之后一直在封顶的上限里抖动", () => {
    const backoff = createBackoff({ ...EVENTS, random: () => 0.999999 });
    for (let i = 0; i < 4; i += 1) backoff.next();
    expect(backoff.next()).toBe(9_999);
    expect(backoff.next()).toBe(9_999);
  });
});
