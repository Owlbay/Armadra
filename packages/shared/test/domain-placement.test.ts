import { describe, expect, it } from "vitest";
import {
  PLACEMENT_COLUMN_GAP,
  PLACEMENT_ROW_GAP,
  dispatchPlacement,
  type PlacementBox,
} from "../src/index.js";

/** 派发落点（契约 §50）：两个方向各三条，含冲突回避。 */
const SIZE = { width: 400, height: 300 };
const main: PlacementBox = {
  id: "main",
  x: 100,
  y: 100,
  width: 400,
  height: 300,
};

describe("dispatchPlacement · vertical", () => {
  it("没有从：主正下方一行、左对齐", () => {
    expect(dispatchPlacement([main], "main", SIZE, "vertical")).toEqual({
      x: 100,
      y: 400 + PLACEMENT_ROW_GAP,
    });
  });

  it("已有从：接在最右那个的右边", () => {
    const child = { id: "c1", x: 100, y: 448, width: 400, height: 300 };
    expect(
      dispatchPlacement([main, child], "main", SIZE, "vertical", ["c1"]),
    ).toEqual({ x: 500 + PLACEMENT_COLUMN_GAP, y: 448 });
  });

  it("落点被别的盒子占着就沿这一行往右让，贴边不算相交", () => {
    const blocker = { id: "b", x: 50, y: 500, width: 200, height: 100 };
    const touching = { id: "t", x: 100, y: 748, width: 50, height: 50 };
    const at = dispatchPlacement(
      [main, blocker, touching],
      "main",
      SIZE,
      "vertical",
    );
    expect(at).toEqual({ x: 100 + 400 + PLACEMENT_COLUMN_GAP, y: 448 });
  });
});

describe("dispatchPlacement · horizontal", () => {
  it("没有从：主右侧一列、顶对齐", () => {
    expect(dispatchPlacement([main], "main", SIZE, "horizontal")).toEqual({
      x: 500 + PLACEMENT_COLUMN_GAP,
      y: 100,
    });
  });

  it("已有从：接在最下那个的下面", () => {
    const child = { id: "c1", x: 560, y: 100, width: 400, height: 300 };
    expect(
      dispatchPlacement([main, child], "main", SIZE, "horizontal", ["c1"]),
    ).toEqual({ x: 560, y: 400 + PLACEMENT_ROW_GAP });
  });

  it("冲突时沿这一列往下让；让满 64 格就放到所有盒子右边", () => {
    const blocker = { id: "b", x: 600, y: 150, width: 100, height: 100 };
    expect(
      dispatchPlacement([main, blocker], "main", SIZE, "horizontal"),
    ).toEqual({ x: 560, y: 100 + 300 + PLACEMENT_ROW_GAP });
    const wall = { id: "w", x: 560, y: 0, width: 10, height: 1_000_000 };
    expect(dispatchPlacement([main, wall], "main", SIZE, "horizontal")).toEqual(
      { x: 570 + PLACEMENT_COLUMN_GAP, y: 100 },
    );
  });
});

it("主不在盒子里时返回 null", () => {
  expect(dispatchPlacement([], "main", SIZE, "vertical")).toBeNull();
});
