// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Box } from "../geometry";
import { linkCurve } from "./edges/link-path";
import {
  boxesExtent,
  MINIMAP_LINK_MAX_WIDTH,
  MINIMAP_LINK_MIN_WIDTH,
  minimapLinkLayer,
  minimapLinkSegment,
  minimapLinkWidth,
} from "./minimap-links";

/** 小地图连线（#216）：锚点、曲线、合并与线宽。 */

const box = (x: number, y: number, width = 100, height = 50): Box => ({
  x,
  y,
  width,
  height,
});

const edge = (
  id: string,
  source: string,
  target: string,
  role?: "supervises",
) =>
  ({
    id,
    type: "link",
    source,
    target,
    data: role ? { role } : {},
  }) as never;

describe("minimapLinkSegment", () => {
  it("和画布同一条曲线：相对边的中点之间的三次贝塞尔，坐标取整", () => {
    const source = box(0, 0);
    const target = box(300.4, 200.6);
    const curve = linkCurve(source, target, "free");
    const r = Math.round;
    expect(minimapLinkSegment(source, target, "free")).toBe(
      `M${r(curve.sourceX)},${r(curve.sourceY)}` +
        `C${r(curve.c1.x)},${r(curve.c1.y)} ${r(curve.c2.x)},${r(curve.c2.y)} ` +
        `${r(curve.targetX)},${r(curve.targetY)}`,
    );
  });

  it("横着摆走右 → 左，竖着摆走底 → 顶（四边中点，不是中心）", () => {
    expect(minimapLinkSegment(box(0, 0), box(300, 0), "free")).toMatch(
      /^M100,25C.* 300,25$/,
    );
    expect(minimapLinkSegment(box(0, 0), box(0, 300), "free")).toMatch(
      /^M50,50C.* 50,300$/,
    );
  });
});

describe("minimapLinkLayer", () => {
  const boxes: Record<string, Box> = {
    a: box(0, 0),
    b: box(300, 0),
    c: box(300, 200),
    d: box(0, 400),
  };
  const boxOf = (id: string) => boxes[id];

  it("按颜色合并：上下文一条 path、每个簇色一条，上下文在下面", () => {
    const layer = minimapLinkLayer(
      [
        edge("ab", "a", "b", "supervises"),
        edge("ac", "a", "c", "supervises"),
        edge("bc", "b", "c"),
        edge("cd", "c", "d"),
        edge("dc", "d", "c", "supervises"),
      ],
      boxOf,
      (id) => (id === "d" ? "var(--node-color-2)" : "var(--node-color-1)"),
      "vertical",
    );
    expect(layer.paths.map((p) => [p.color, p.role])).toEqual([
      ["var(--link-context)", "context"],
      ["var(--node-color-1)", "dispatch"],
      ["var(--node-color-2)", "dispatch"],
    ]);
    // 一组里每条边一段子路径。
    expect(layer.paths[0]!.d.match(/M/g)).toHaveLength(2);
    expect(layer.paths[1]!.d.match(/M/g)).toHaveLength(2);
  });

  it("派发线用 dispatchAnchor：子在下游走主底 → 子顶，被拖到上方改走就近边", () => {
    const below = minimapLinkLayer(
      [edge("ac", "a", "c", "supervises")],
      boxOf,
      () => "var(--node-color-1)",
      "vertical",
    );
    // 主底中点 (50,50) → 子顶中点 (350,200)。
    expect(below.paths[0]!.d).toMatch(/^M50,50C.* 350,200$/);

    const above = minimapLinkLayer(
      [edge("ca", "c", "a", "supervises")],
      boxOf,
      () => "var(--node-color-1)",
      "vertical",
    );
    // 子 a 在主 c 的左上方，x 方向空隙 200 = y 方向空隙 150 之上 → 左右。
    expect(above.paths[0]!.d).toMatch(/^M300,225C.* 100,25$/);
  });

  it("引用边、隐藏的边与端点不在小地图里的边都不画", () => {
    const layer = minimapLinkLayer(
      [
        { id: "r", type: "reference", source: "a", target: "b" } as never,
        { ...(edge("h", "a", "b") as object), hidden: true } as never,
        edge("gone", "a", "missing"),
      ],
      boxOf,
      () => undefined,
      "vertical",
    );
    expect(layer.paths).toEqual([]);
  });

  it("没有簇色的派发线退回品牌色", () => {
    const layer = minimapLinkLayer(
      [edge("ab", "a", "b", "supervises")],
      boxOf,
      () => undefined,
      "horizontal",
    );
    expect(layer.paths[0]!.color).toBe("var(--brand)");
  });
});

describe("线宽按缩放比例", () => {
  it("画布线宽除以 viewScale，夹在上下限之间", () => {
    // 320×240 的画布塞进 200×150：viewScale 1.6，线宽 2 / 1.6 = 1.25px。
    expect(minimapLinkWidth({ width: 320, height: 240 })).toBe(1.25);
    // 很小的画布不会比上限粗，很大的画布不会细到看不见。
    expect(minimapLinkWidth({ width: 100, height: 50 })).toBe(
      MINIMAP_LINK_MAX_WIDTH,
    );
    expect(minimapLinkWidth({ width: 20_000, height: 9_000 })).toBe(
      MINIMAP_LINK_MIN_WIDTH,
    );
    expect(minimapLinkWidth({ width: 0, height: 0 })).toBe(
      MINIMAP_LINK_MAX_WIDTH,
    );
  });

  it("给了全画布的外接尺寸就按它，不按连线两端", () => {
    const layer = minimapLinkLayer(
      [edge("ab", "a", "b")],
      (id) => ({ a: box(0, 0), b: box(300, 0) })[id],
      () => undefined,
      "vertical",
      { width: 2000, height: 1000 },
    );
    expect(layer.width).toBe(minimapLinkWidth({ width: 2000, height: 1000 }));
  });

  it("boxesExtent 是外接矩形的宽高", () => {
    expect(boxesExtent([box(-100, 0), box(300, 200)])).toEqual({
      width: 500,
      height: 250,
    });
    expect(boxesExtent([])).toEqual({ width: 0, height: 0 });
  });
});
