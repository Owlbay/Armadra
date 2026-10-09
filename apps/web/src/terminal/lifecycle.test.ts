import { describe, expect, it } from "vitest";

import {
  OFFSCREEN_DETACH_MS,
  canDetach,
  canRelease,
  detachDelay,
  isSeen,
  pressureReleases,
  releaseAfterMs,
  resolveLifecycle,
  type HoldInputs,
} from "./lifecycle";
import { WARNING_RELEASE_OFFSCREEN_MS as PRESSURE_WARNING_RELEASE_MS } from "./pressure-policy";
import { HIDDEN_DETACH_MS } from "./render-state";
import { DETACH_GRACE_MS } from "./surface/constants";

const seen = { collapsed: false, onScreen: true, pageVisible: true };

function holds(patch: Partial<HoldInputs> = {}): HoldInputs {
  return {
    launchArmed: false,
    pendingLaunch: false,
    connecting: false,
    unackedInput: false,
    focusNode: false,
    blocked: false,
    ...patch,
  };
}

describe("阶段", () => {
  it("看得见是 live，看不见是 parked；断开与释放压过可见性", () => {
    expect(
      resolveLifecycle({ seen: true, detached: false, released: false }),
    ).toBe("live");
    expect(
      resolveLifecycle({ seen: false, detached: false, released: false }),
    ).toBe("parked");
    expect(
      resolveLifecycle({ seen: false, detached: true, released: false }),
    ).toBe("detached");
    expect(
      resolveLifecycle({ seen: false, detached: true, released: true }),
    ).toBe("released");
  });

  it("三种看不见各自的断开时长；看得见不计时", () => {
    expect(isSeen(seen)).toBe(true);
    expect(detachDelay(seen)).toBeNull();
    expect(detachDelay({ ...seen, collapsed: true })).toBe(DETACH_GRACE_MS);
    expect(detachDelay({ ...seen, pageVisible: false })).toBe(HIDDEN_DETACH_MS);
    // 平移离屏也进计时（以前不计）。
    expect(detachDelay({ ...seen, onScreen: false })).toBe(OFFSCREEN_DETACH_MS);
    // 折叠压过其余两种：最短的那一档。
    expect(
      detachDelay({ collapsed: true, onScreen: false, pageVisible: false }),
    ).toBe(DETACH_GRACE_MS);
  });

  it("设置项换算；never 不释放", () => {
    expect(releaseAfterMs("5m")).toBe(300_000);
    expect(releaseAfterMs("10m")).toBe(600_000);
    expect(releaseAfterMs("30m")).toBe(1_800_000);
    expect(releaseAfterMs("never")).toBeNull();
  });
});

describe("豁免", () => {
  it("没有挂着的事就能断开、能释放", () => {
    expect(canDetach(holds())).toBe(true);
    expect(canRelease(holds())).toBe(true);
  });

  it("启动序列、连接中、在途输入挡住断开与释放", () => {
    for (const patch of [
      { launchArmed: true },
      { pendingLaunch: true },
      { connecting: true },
      { unackedInput: true },
    ]) {
      expect(canDetach(holds(patch))).toBe(false);
      expect(canRelease(holds(patch))).toBe(false);
    }
  });

  it("聚焦节点与等审批的 Agent 只挡释放，不挡断开", () => {
    for (const patch of [{ focusNode: true }, { blocked: true }]) {
      expect(canDetach(holds(patch))).toBe(true);
      expect(canRelease(holds(patch))).toBe(false);
    }
  });
});

describe("内存压力提前释放", () => {
  it("看得见的一律不动", () => {
    expect(pressureReleases("critical", null)).toBe(false);
    expect(pressureReleases("warning", null)).toBe(false);
  });

  it("告警档只动离屏够久的，紧急档不限时长", () => {
    expect(pressureReleases("warning", PRESSURE_WARNING_RELEASE_MS - 1)).toBe(
      false,
    );
    expect(pressureReleases("warning", PRESSURE_WARNING_RELEASE_MS)).toBe(true);
    expect(pressureReleases("critical", 0)).toBe(true);
  });

  it("normal 什么都不做（降级不重建）", () => {
    expect(pressureReleases("normal", 10 * 60_000)).toBe(false);
  });
});
