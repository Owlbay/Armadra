import { describe, expect, it } from "vitest";

import {
  PRESSURE_RESCAN_MS,
  WARNING_RELEASE_OFFSCREEN_MS,
  acts,
  actionFor,
  decide,
  isPressureLevel,
} from "./pressure-policy";

describe("actionFor", () => {
  it("warning：还隐藏名额，释放离屏 30 秒以上的实例", () => {
    expect(actionFor("warning")).toEqual({
      releaseHiddenSlots: true,
      releaseOffscreenOlderThanMs: WARNING_RELEASE_OFFSCREEN_MS,
    });
  });

  it("critical：还隐藏名额，释放所有不可见的实例", () => {
    expect(actionFor("critical")).toEqual({
      releaseHiddenSlots: true,
      releaseOffscreenOlderThanMs: 0,
    });
  });

  it("normal 什么都不做", () => {
    expect(acts(actionFor("normal"))).toBe(false);
  });
});

describe("decide", () => {
  it("第一次 warning 立刻回收，并记下下次最早时间", () => {
    const decision = decide("warning", 1_000, null);
    expect(acts(decision)).toBe(true);
    expect(decision.nextAllowedAt).toBe(1_000 + PRESSURE_RESCAN_MS);
  });

  it("同档 20 秒内不重复扫，到点再扫", () => {
    const last = { level: "warning" as const, nextAllowedAt: 21_000 };
    expect(acts(decide("warning", 20_999, last))).toBe(false);
    expect(decide("warning", 20_999, last).nextAllowedAt).toBe(21_000);
    expect(acts(decide("warning", 21_000, last))).toBe(true);
  });

  it("升档不等节流，降档在节流期内不扫", () => {
    const warning = { level: "warning" as const, nextAllowedAt: 21_000 };
    expect(decide("critical", 2_000, warning)).toMatchObject({
      releaseOffscreenOlderThanMs: 0,
    });
    const critical = { level: "critical" as const, nextAllowedAt: 21_000 };
    expect(acts(decide("warning", 2_000, critical))).toBe(false);
  });

  it("降回 normal 不做任何事，也不清节流", () => {
    const last = { level: "warning" as const, nextAllowedAt: 21_000 };
    const decision = decide("normal", 2_000, last);
    expect(acts(decision)).toBe(false);
    expect(decision.nextAllowedAt).toBe(21_000);
  });
});

describe("isPressureLevel", () => {
  it("只认三档", () => {
    expect(isPressureLevel("warning")).toBe(true);
    expect(isPressureLevel("high")).toBe(false);
    expect(isPressureLevel(null)).toBe(false);
  });
});
