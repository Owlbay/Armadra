import { afterEach, describe, expect, it } from "vitest";

import {
  registerRenderClient,
  RENDER_PRIORITY_FOCUSED,
  RENDER_PRIORITY_HIDDEN,
  RENDER_PRIORITY_VISIBLE,
  resetRenderBudget,
  selectGranted,
  setRenderBudget,
} from "./render-budget";
import { resolveRenderState, type RenderInputs } from "./render-state";
import {
  AUTO_WEBGL_SLOTS,
  effectiveRenderBudget,
  isLowZoom,
  rendererGatesRender,
  rendererUsesWebgl,
  repaintThrottled,
  wantsWebgl,
} from "./renderer-policy";

afterEach(() => resetRenderBudget());

describe("渲染器三档", () => {
  it("dom 不装 WebGL；webgl / auto 有名额才装", () => {
    expect(rendererUsesWebgl("dom")).toBe(false);
    expect(wantsWebgl("dom", true)).toBe(false);
    expect(wantsWebgl("webgl", true)).toBe(true);
    expect(wantsWebgl("webgl", false)).toBe(false);
    expect(wantsWebgl("auto", true)).toBe(true);
    expect(wantsWebgl("auto", false)).toBe(false);
  });

  it("只有 webgl 档由名额决定档位；auto 下没名额的可见终端仍直写", () => {
    const base: RenderInputs = {
      connection: "live",
      collapsed: false,
      onScreen: true,
      pageVisible: true,
      focused: false,
      detached: false,
      budgeted: false,
      webgl: false,
    };
    const stateFor = (renderer: "dom" | "webgl" | "auto") =>
      resolveRenderState({ ...base, webgl: rendererGatesRender(renderer) });
    expect(stateFor("dom")).toBe("visible");
    expect(stateFor("auto")).toBe("visible");
    expect(stateFor("webgl")).toBe("offscreen");
  });

  it("auto 把协调器上限压到 AUTO_WEBGL_SLOTS，其余档照设置", () => {
    expect(AUTO_WEBGL_SLOTS).toBe(4);
    expect(effectiveRenderBudget(16, "auto")).toBe(4);
    expect(effectiveRenderBudget(2, "auto")).toBe(2);
    expect(effectiveRenderBudget(16, "webgl")).toBe(16);
    expect(effectiveRenderBudget(24, "dom")).toBe(24);
  });
});

describe("auto 的选择规则", () => {
  const limit = effectiveRenderBudget(16, "auto");

  it("20 个可见：焦点 + 先可见的 4 个用 WebGL，其余 DOM", () => {
    const claims = Array.from({ length: 20 }, (_, index) => ({
      id: `t${index}`,
      priority:
        index === 12 ? RENDER_PRIORITY_FOCUSED : RENDER_PRIORITY_VISIBLE,
      seq: index + 1,
    }));
    expect(selectGranted(claims, limit)).toEqual(
      new Set(["t12", "t0", "t1", "t2"]),
    );
  });

  it("没有焦点时正好 4 个；可见的新来者先拿隐藏持有者让出的名额", () => {
    const claims = [
      { id: "old", priority: RENDER_PRIORITY_HIDDEN, seq: 1 },
      ...["a", "b", "c", "d"].map((id, index) => ({
        id,
        priority: RENDER_PRIORITY_VISIBLE,
        seq: 10 + index,
      })),
    ];
    expect(selectGranted(claims, limit)).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("登记处按压低后的上限授予", () => {
    setRenderBudget(effectiveRenderBudget(16, "auto"));
    const granted: Record<string, boolean> = {};
    for (let index = 0; index < 8; index += 1) {
      const id = `n${index}`;
      registerRenderClient(
        id,
        { visible: true, focused: false },
        (next) => (granted[id] = next),
      );
    }
    expect(Object.values(granted).filter(Boolean)).toHaveLength(4);
  });
});

describe("缩小时限帧（E2）", () => {
  const inputs = {
    throttle: "lowZoom" as const,
    lowZoom: true,
    visible: true,
    focused: false,
    webglActive: false,
  };

  it("缩放 < 0.5 才算低", () => {
    expect(isLowZoom(0.3)).toBe(true);
    expect(isLowZoom(0.5)).toBe(false);
    expect(isLowZoom(1)).toBe(false);
    expect(isLowZoom(undefined)).toBe(false);
    expect(isLowZoom(0)).toBe(false);
  });

  it("只限看得见、没焦点、用 DOM 的终端，且开关要开", () => {
    expect(repaintThrottled(inputs)).toBe(true);
    expect(repaintThrottled({ ...inputs, throttle: "off" })).toBe(false);
    expect(repaintThrottled({ ...inputs, lowZoom: false })).toBe(false);
    expect(repaintThrottled({ ...inputs, focused: true })).toBe(false);
    expect(repaintThrottled({ ...inputs, visible: false })).toBe(false);
    expect(repaintThrottled({ ...inputs, webglActive: true })).toBe(false);
  });
});
