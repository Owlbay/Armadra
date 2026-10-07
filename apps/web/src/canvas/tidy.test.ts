import { describe, expect, it, vi } from "vitest";

/** 只为了拿默认尺寸；节点体（xterm / CodeMirror）不该被拉进纯几何单测。 */
const nodeMetaStub = {
  labelKey: "node.terminal",
  defaultSize: { width: 240, height: 200 },
  minSize: { width: 160, height: 120 },
  defaultColor: "#0a84ff",
  hasBridgeHandles: false,
};
vi.mock("../nodes/registry", () => ({
  NODE_META: new Proxy({}, { get: () => nodeMetaStub }),
  nodeMeta: () => nodeMetaStub,
}));

import type { CanvasEdge, CanvasNode } from "@armadra/shared";
import { COLUMN_GAP, ROW_GAP, tidy, tidyPositions } from "./tidy";
import { COLLAPSED_HEIGHT } from "../store/defaults";

const box = (id: string, width = 200, height = 100) => ({ id, width, height });

/** 排完之后每个盒子的矩形，用来验「不重叠」。 */
function rects(
  boxes: { id: string; width: number; height: number }[],
  positions: Record<string, { x: number; y: number }>,
) {
  return boxes.map((item) => {
    const at = positions[item.id];
    return {
      id: item.id,
      left: at!.x,
      top: at!.y,
      right: at!.x + item.width,
      bottom: at!.y + item.height,
    };
  });
}

function overlaps(
  boxes: { id: string; width: number; height: number }[],
  positions: Record<string, { x: number; y: number }>,
) {
  const all = rects(boxes, positions);
  const hits: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      if (
        a!.left < b!.right &&
        b!.left < a!.right &&
        a!.top < b!.bottom &&
        b!.top < a!.bottom
      ) {
        hits.push(`${a!.id}×${b!.id}`);
      }
    }
  }
  return hits;
}

/** 不吸网格的原始几何：这一组断言验的是排布本身，网格另有一组。 */
const raw: typeof tidy = (boxes, links, options = {}) =>
  tidy(boxes, links, { grid: 0, ...options });

describe("tidy", () => {
  it("空画布返回空表", () => {
    expect(raw([], [])).toEqual({});
  });

  it("分量内：源节点排在目标左边，一层一列", () => {
    const positions = raw(
      [box("a"), box("b"), box("c")],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    );
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 200 + COLUMN_GAP, y: 0 });
    expect(positions.c).toEqual({ x: (200 + COLUMN_GAP) * 2, y: 0 });
  });

  it("列内按行距堆叠，列宽取该列最宽的节点", () => {
    const positions = raw(
      [box("a", 300, 120), box("b", 200, 80), box("c", 200, 80)],
      [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
      ],
    );
    expect(positions.b).toEqual({ x: 300 + COLUMN_GAP, y: 0 });
    expect(positions.c).toEqual({ x: 300 + COLUMN_GAP, y: 80 + ROW_GAP });
  });

  it("有环也不会死循环，指向未知节点的边被忽略", () => {
    const positions = raw(
      [box("a"), box("b")],
      [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
        { source: "a", target: "ghost" },
      ],
    );
    expect(Object.keys(positions).sort()).toEqual(["a", "b"]);
    // 纯环里每个节点都有入边，谁都不是根，于是一起落到同一列。
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 0, y: 100 + ROW_GAP });
  });

  it("按连通分量分组，分量按阅读顺序摆放", () => {
    // 三个独立分量：a-b、c、d。宽度小、行宽上限大 → 同一行从左到右。
    const boxes = [box("a"), box("b"), box("c"), box("d")];
    const positions = raw(boxes, [{ source: "a", target: "b" }], {
      aspect: 100, // 极端扁平：一行放得下所有分量
    });
    // 分量 1（a→b）占据 [0, 460]，接着是 c、d。
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 260, y: 0 });
    expect(positions.c!.y).toBe(0);
    expect(positions.d!.y).toBe(0);
    expect(positions.c!.x).toBeGreaterThan(positions.b!.x);
    expect(positions.d!.x).toBeGreaterThan(positions.c!.x);
    expect(overlaps(boxes, positions)).toEqual([]);
  });

  it("行放不下就换行，行高取行内最高的分量", () => {
    // 6 个 200×100 的孤立节点，宽高比 1 → 行宽上限 ≈ sqrt(60000)×1.15 ≈ 282
    // → 一行只放得下 1 个（第二个要到 x=260，右边 460 > 282）。
    const boxes = ["a", "b", "c", "d", "e", "f"].map((id) => box(id));
    const positions = raw(boxes, [], { aspect: 1 });
    const rows = new Set(boxes.map((item) => positions[item.id]!.y));
    expect(rows.size).toBeGreaterThan(1);
    // 行距 = 上一行的行高 + ROW_GAP
    expect(positions.b).toEqual({ x: 0, y: 100 + ROW_GAP });
    expect(overlaps(boxes, positions)).toEqual([]);
  });

  it("宽视口（宽高比 2）下 6 个等大节点排成 ≥2 列", () => {
    const boxes = ["a", "b", "c", "d", "e", "f"].map((id) => box(id));
    const positions = raw(boxes, [], { aspect: 2 });
    const columns = new Set(boxes.map((item) => positions[item.id]!.x));
    expect(columns.size).toBeGreaterThanOrEqual(2);
    expect(overlaps(boxes, positions)).toEqual([]);
    // 阅读顺序：第一个永远在原点。
    expect(positions.a).toEqual({ x: 0, y: 0 });
  });

  it("比整行还宽的分量独占一行，不会死循环", () => {
    const boxes = [box("wide", 4000, 100), box("a"), box("b")];
    const positions = raw(boxes, [], { aspect: 1 });
    expect(positions.wide).toEqual({ x: 0, y: 0 });
    expect(overlaps(boxes, positions)).toEqual([]);
  });

  it("同一份输入排两次结果一致（确定性）", () => {
    const boxes = ["a", "b", "c", "d"].map((id) => box(id));
    const links = [{ source: "a", target: "c" }];
    expect(raw(boxes, links, { aspect: 1.6 })).toEqual(
      raw(boxes, links, { aspect: 1.6 }),
    );
  });
});

/* ------------------------------ 文档层入口 -------------------------------- */

const timestamp = "2026-09-04T00:00:00.000Z";

function node(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    boardId: "board",
    type: "terminal",
    title: id,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  } as CanvasNode;
}

const link = (source: string, target: string): CanvasEdge =>
  ({
    id: `${source}-${target}`,
    boardId: "board",
    source,
    target,
    kind: "link",
    createdAt: timestamp,
    updatedAt: timestamp,
  }) as CanvasEdge;

describe("tidyPositions", () => {
  it("没写 size 的节点用 NODE_META 的默认尺寸", () => {
    const positions = tidyPositions([node("a"), node("b")], [link("a", "b")], {
      aspect: 100,
      grid: 0,
    });
    // 默认宽 240 → 第二列在 240 + COLUMN_GAP
    expect(positions.b).toEqual({ x: 240 + COLUMN_GAP, y: 0 });
  });

  it("折叠的节点按 COLLAPSED_HEIGHT 参与排布", () => {
    // root 分出两个折叠节点：同一列堆叠时按 40px 而不是 400px 算行距，
    // 否则折叠一排节点之后列里全是空气。
    const positions = tidyPositions(
      [
        node("root", { size: { width: 200, height: 100 } }),
        node("x", { size: { width: 200, height: 400 }, collapsed: true }),
        node("y", { size: { width: 200, height: 400 }, collapsed: true }),
      ],
      [link("root", "x"), link("root", "y")],
      { aspect: 100, grid: 0 },
    );
    expect(positions.x).toEqual({ x: 200 + COLUMN_GAP, y: 0 });
    expect(positions.y!.y).toBe(COLLAPSED_HEIGHT + ROW_GAP);
  });

  it("组框整体参与排布，组员的相对坐标不动", () => {
    const nodes = [
      node("solo", { size: { width: 200, height: 100 } }),
      node("frame", {
        type: "group",
        data: { kind: "group" },
        size: { width: 600, height: 400 },
        position: { x: 900, y: 900 },
      }),
      node("child", {
        parentId: "frame",
        size: { width: 200, height: 100 },
        position: { x: 24, y: 60 },
      }),
      node("child2", {
        parentId: "frame",
        size: { width: 200, height: 100 },
        position: { x: 260, y: 60 },
      }),
    ];
    const positions = tidyPositions(nodes, [], { aspect: 100, grid: 0 });

    // 组员不出现在结果里 → 保持相对组框的坐标，跟着组一起平移。
    expect(positions.child).toBeUndefined();
    expect(positions.child2).toBeUndefined();
    expect(Object.keys(positions).sort()).toEqual(["frame", "solo"]);

    // 组框按自己的 600×400 占位，排在 solo 右边一整个列距之外。
    expect(positions.solo).toEqual({ x: 0, y: 0 });
    expect(positions.frame).toEqual({ x: 200 + COLUMN_GAP, y: 0 });

    // 组一动，两个组员的**相对**偏移仍然是 236（= 260 - 24）。
    const frame = positions.frame;
    const absolute = (child: { x: number; y: number }) => ({
      x: frame!.x + child.x,
      y: frame!.y + child.y,
    });
    expect(absolute({ x: 260, y: 60 }).x - absolute({ x: 24, y: 60 }).x).toBe(
      236,
    );
  });
});

/* ------------------------- 刚体 / 阅读顺序 / 主从树 ------------------------- */

type At = { x: number; y: number };
const placed = (
  id: string,
  x: number,
  y: number,
  kind: "agent" | "node" | "wb" = "node",
  width = 200,
  height = 100,
) => ({ id, x, y, width, height, kind });
const supervises = (source: string, target: string) => ({
  source,
  target,
  role: "supervises" as const,
});

/** 再排一次，把结果当成新的原位置喂回去。 */
function again(
  boxes: ReturnType<typeof placed>[],
  links: Parameters<typeof tidy>[1],
  first: Record<string, At>,
  options: Parameters<typeof tidy>[2],
) {
  const moved = boxes.map((box) => ({ ...box, ...first[box.id]! }));
  return tidy(moved, links, options);
}

describe("tidy · §6.4", () => {
  it("(a) 一主三从：从在右列、顶对齐根、等距、x 相同", () => {
    const boxes = [
      placed("main", 900, 600, "agent", 300, 200),
      placed("s1", 0, 0, "agent"),
      placed("s2", 2000, 50, "agent"),
      placed("s3", 400, 1500, "agent"),
    ];
    const links = ["s1", "s2", "s3"].map((id) => supervises("main", id));
    const at = tidy(boxes, links, { aspect: 100 });

    expect(at.main).toEqual({ x: 0, y: 0 });
    const xs = new Set(["s1", "s2", "s3"].map((id) => at[id]!.x));
    expect(xs.size).toBe(1);
    expect(at.s1!.x).toBeGreaterThan(at.main!.x + 300);
    // 顶对齐根；子按原阅读顺序（s1 在最上，s2 同一行偏右，s3 最下）。
    expect(at.s1!.y).toBe(at.main!.y);
    expect(at.s2!.y - at.s1!.y).toBe(at.s3!.y - at.s2!.y);
    expect(at.s2!.y).toBeGreaterThan(at.s1!.y);
  });

  it("(b) 两棵树各自成簇，互不交错", () => {
    const boxes = [
      placed("a", 0, 0, "agent"),
      placed("a1", 0, 400, "agent"),
      placed("b", 3000, 0, "agent"),
      placed("b1", 3000, 400, "agent"),
    ];
    const links = [supervises("a", "a1"), supervises("b", "b1")];
    const at = tidy(boxes, links, { aspect: 100 });
    // 同一行从左到右：a 树整个在 b 树左边。
    expect(at.a!.y).toBe(at.b!.y);
    expect(Math.max(at.a!.x, at.a1!.x) + 200).toBeLessThan(at.b!.x);
    expect(at.a1!.y).toBe(at.a!.y);
    expect(at.b1!.y).toBe(at.b!.y);
  });

  it("(c) 附件（浏览器）落在所连 Agent 同列正下方", () => {
    const boxes = [
      placed("main", 0, 0, "agent"),
      placed("sub", 500, 0, "agent"),
      placed("web", 2000, 2000, "node", 300, 200),
      placed("other", 600, 900, "agent"),
    ];
    const links = [
      supervises("main", "sub"),
      supervises("main", "other"),
      { source: "sub", target: "web" },
    ];
    const at = tidy(boxes, links, { aspect: 100 });
    expect(at.web!.x).toBe(at.sub!.x);
    expect(at.web!.y).toBeGreaterThan(at.sub!.y + 100);
    // 附件挤在 sub 与下一个兄弟之间，兄弟往下让。
    expect(at.other!.x).toBe(at.sub!.x);
    expect(at.other!.y).toBeGreaterThan(at.web!.y + 200);
  });

  it("(d) 白板孤岛整体平移，内部相对位置不变", () => {
    const boxes = [
      placed("n", 0, 0),
      // 三个相距 ≤ 24px 的白板对象 = 一个孤岛（导入的 Mermaid 散件）。
      placed("w1", 1000, 1000, "wb", 100, 40),
      placed("w2", 1110, 1000, "wb", 100, 40),
      placed("w3", 1000, 1060, "wb", 210, 2),
      // 远处一个独立的白板对象自成一岛。
      placed("far", 5000, 5000, "wb", 50, 50),
    ];
    const at = tidy(boxes, [], { aspect: 1 });
    expect(at.w2!.x - at.w1!.x).toBe(110);
    expect(at.w2!.y - at.w1!.y).toBe(0);
    expect(at.w3!.y - at.w1!.y).toBe(60);
    expect(at.w3!.x - at.w1!.x).toBe(0);
    // 孤岛整体当一个盒子，和 far 不重叠。
    expect(overlaps(boxes, at)).toEqual([]);
  });

  it("(e) 幂等：整理两次，第二次位移为 0", () => {
    const boxes = [
      placed("main", 900, 600, "agent", 300, 200),
      placed("s1", 0, 0, "agent"),
      placed("s2", 2000, 50, "agent"),
      placed("web", 1300, 1700, "node", 320, 240),
      placed("note", 4000, 300),
      placed("ed", 4200, 900),
      placed("w1", 70, 2000, "wb", 120, 60),
      placed("w2", 200, 2010, "wb", 120, 60),
      placed("lone", 3333, 3333, "node", 150, 90),
    ];
    const links = [
      supervises("main", "s1"),
      supervises("main", "s2"),
      { source: "s2", target: "web" },
      { source: "note", target: "ed" },
    ];
    const options = { aspect: 16 / 9 };
    const first = tidy(boxes, links, options);
    const second = again(boxes, links, first, options);
    expect(second).toEqual(first);
  });

  it("(f) 阅读顺序：原来在上面的仍在上面", () => {
    // 三个孤立节点竖着排；宽高比 1 → 裹成一列，顺序不能被输入顺序打乱。
    const boxes = [
      placed("bottom", 0, 2000),
      placed("top", 0, 0),
      placed("middle", 0, 1000),
    ];
    const at = tidy(boxes, [], { aspect: 0.1 });
    expect(at.top!.y).toBeLessThan(at.middle!.y);
    expect(at.middle!.y).toBeLessThan(at.bottom!.y);
  });

  it("(g) 网格：单元左上角都是 8 的倍数", () => {
    const boxes = [
      placed("a", 13, 7, "node", 203, 97),
      placed("b", 500, 3, "node", 177, 131),
      placed("c", 999, 1001, "agent", 211, 149),
      placed("d", 1500, 20, "agent", 199, 99),
    ];
    const at = tidy(boxes, [supervises("c", "d")], { aspect: 1.6 });
    for (const point of Object.values(at)) {
      expect(point.x % 8).toBe(0);
      expect(point.y % 8).toBe(0);
    }
  });

  it("(h) 无主从边的分量沿用拓扑分列", () => {
    const boxes = [placed("a", 0, 0), placed("b", 0, 300), placed("c", 0, 600)];
    const at = tidy(
      boxes,
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
      { aspect: 100, grid: 0 },
    );
    expect(at.a).toEqual({ x: 0, y: 0 });
    expect(at.b).toEqual({ x: 200 + COLUMN_GAP, y: 0 });
    expect(at.c).toEqual({ x: (200 + COLUMN_GAP) * 2, y: 0 });
  });

  it("主从成环也不死循环，从阅读顺序最靠前的那个剪断", () => {
    const boxes = [placed("x", 0, 0, "agent"), placed("y", 0, 500, "agent")];
    const at = tidy(boxes, [supervises("x", "y"), supervises("y", "x")], {
      aspect: 100,
      grid: 0,
    });
    expect(at.x).toEqual({ x: 0, y: 0 });
    expect(at.y).toEqual({ x: 200 + COLUMN_GAP, y: 0 });
  });

  it("重心法：第二列按上一列邻居的位置排，减少交叉", () => {
    // a、b 在第 0 列（a 在上）；a→d、b→c，c 原本在 d 上面。
    const boxes = [
      placed("a", 0, 0),
      placed("b", 0, 400),
      placed("c", 500, 0),
      placed("d", 500, 400),
    ];
    const at = tidy(
      boxes,
      [
        { source: "a", target: "d" },
        { source: "b", target: "c" },
        { source: "a", target: "b" },
      ],
      { aspect: 100, grid: 0 },
    );
    // a→b 让 b 进了第 1 列，d 也在第 1 列；c 在第 2 列。
    expect(at.b!.x).toBe(at.d!.x);
    expect(overlaps(boxes, at)).toEqual([]);
  });
});
