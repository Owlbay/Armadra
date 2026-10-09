import type { CanvasNode, Position } from "@armadra/shared";
import { absolutePosition } from "../store/canvas-store";
import { defaultNodeSize } from "../store/defaults";

/**
 * 画布几何 —— 连线贴边、组框命中、方向选择三件事。
 *
 * 全是纯函数：React Flow 的内部节点也好、文档里的节点也好，先化成
 * `Box` 再进来，这样这套算法能被单测直接覆盖。
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Side = "left" | "right" | "top" | "bottom";

export function centerOf(box: Box): Position {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** 节点在画布上的绝对矩形（组员的 position 是相对组框的）。 */
export function nodeBox(nodes: readonly CanvasNode[], node: CanvasNode): Box {
  const position = absolutePosition(nodes, node);
  const size = node.size ?? defaultNodeSize(node.type);
  return {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  };
}

/** 某条边的中点。 */
export function anchorPoint(box: Box, side: Side): Position {
  switch (side) {
    case "left":
      return { x: box.x, y: box.y + box.height / 2 };
    case "right":
      return { x: box.x + box.width, y: box.y + box.height / 2 };
    case "top":
      return { x: box.x + box.width / 2, y: box.y };
    case "bottom":
      return { x: box.x + box.width / 2, y: box.y + box.height };
  }
}

/**
 * 连线锚点的取边规则。
 *
 * - `horizontal`：只走左右（横向布局的派发线：主右 → 子左）；
 * - `vertical`：只走上下（纵向布局的派发线：主底 → 子顶）；
 * - `free`：按两端的相对位置选最近的边（对等的上下文线、引用线）。
 */
export type LinkAnchor = "horizontal" | "vertical" | "free";

/**
 * 两个矩形之间沿 x / y 轴的空隙（负数表示在这条轴上有重叠）。
 *
 * `free` 选边看空隙而不只看中心：一个 600 宽的终端斜下方挂一个小便签，
 * 中心横向差更大，但两者在 x 上其实是重叠的——那时走左右会让线先往回折。
 */
function gaps(source: Box, target: Box): { x: number; y: number } {
  return {
    x: Math.max(
      target.x - (source.x + source.width),
      source.x - (target.x + target.width),
    ),
    y: Math.max(
      target.y - (source.y + source.height),
      source.y - (target.y + target.height),
    ),
  };
}

/** `free` 锚这一次该走左右还是上下。 */
function freeAxis(source: Box, target: Box): "horizontal" | "vertical" {
  const gap = gaps(source, target);
  const apartX = gap.x >= 0;
  const apartY = gap.y >= 0;
  // 只在一条轴上分开：就走那条轴上相对的两条边。
  if (apartX && !apartY) return "horizontal";
  if (apartY && !apartX) return "vertical";
  // 两条轴上都分开（斜着摆）：空隙大的那条轴。
  if (apartX && apartY) return gap.x >= gap.y ? "horizontal" : "vertical";
  // 叠在一起：退回比较中心。
  const from = centerOf(source);
  const to = centerOf(target);
  return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
    ? "horizontal"
    : "vertical";
}

/** 两个矩形互相「面对」的边。 */
export function facingSides(
  source: Box,
  target: Box,
  anchor: LinkAnchor = "horizontal",
): { source: Side; target: Side } {
  const from = centerOf(source);
  const to = centerOf(target);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const axis = anchor === "free" ? freeAxis(source, target) : anchor;

  if (axis === "horizontal") {
    return dx >= 0
      ? { source: "right", target: "left" }
      : { source: "left", target: "right" };
  }
  return dy >= 0
    ? { source: "bottom", target: "top" }
    : { source: "top", target: "bottom" };
}

/**
 * 派发线这一刻该用的锚（#211）。
 *
 * 子节点还在布局方向的「下游」（纵向：整个落在主的下方；横向：整个落在主的
 * 右侧）时按布局方向走主底 → 子顶 / 主右 → 子左，同侧几条线共用一个出点；
 * 被拖到主的上方、左侧或与主叠在一起时，布局方向已经说不通，改走就近边。
 */
export function dispatchAnchor(
  source: Box,
  target: Box,
  direction: "vertical" | "horizontal",
): LinkAnchor {
  const downstream =
    direction === "vertical"
      ? target.y >= source.y + source.height
      : target.x >= source.x + source.width;
  return downstream ? direction : "free";
}

export interface EdgeGeometry {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourceSide: Side;
  targetSide: Side;
}

/** 连线两端的贴边坐标 + 各自的朝向，交给 `getBezierPath` 用。 */
export function edgeGeometry(
  source: Box,
  target: Box,
  anchor: LinkAnchor = "horizontal",
): EdgeGeometry {
  const sides = facingSides(source, target, anchor);
  const from = anchorPoint(source, sides.source);
  const to = anchorPoint(target, sides.target);
  return {
    sourceX: from.x,
    sourceY: from.y,
    targetX: to.x,
    targetY: to.y,
    sourceSide: sides.source,
    targetSide: sides.target,
  };
}

/** 控制点离锚点的距离；两端相距越远弯得越缓，但不无限放大。 */
const CURVATURE = 0.25;
const MIN_CONTROL = 20;
const MAX_CONTROL = 160;

function controlOffset(side: Side, dx: number, dy: number): Position {
  const span = Math.max(Math.abs(dx), Math.abs(dy)) * CURVATURE;
  const k = Math.min(MAX_CONTROL, Math.max(MIN_CONTROL, span));
  switch (side) {
    case "left":
      return { x: -k, y: 0 };
    case "right":
      return { x: k, y: 0 };
    case "top":
      return { x: 0, y: -k };
    case "bottom":
      return { x: 0, y: k };
  }
}

export interface BezierPath {
  d: string;
  /** 三次贝塞尔在 t=0.5 处的点，标签挂在这里。 */
  labelX: number;
  labelY: number;
}

export interface BezierControls {
  c1: Position;
  c2: Position;
}

/**
 * 两个控制点。`bezierPath` 与 link shape 的命中几何 / 指示器共用同一条曲线，
 * 所以控制点必须只有这一处定义（`shapes/link-path.ts` 要按同样的曲线采样）。
 */
export function bezierControls(geometry: EdgeGeometry): BezierControls {
  const dx = geometry.targetX - geometry.sourceX;
  const dy = geometry.targetY - geometry.sourceY;
  const from = controlOffset(geometry.sourceSide, dx, dy);
  const to = controlOffset(geometry.targetSide, dx, dy);
  return {
    c1: { x: geometry.sourceX + from.x, y: geometry.sourceY + from.y },
    c2: { x: geometry.targetX + to.x, y: geometry.targetY + to.y },
  };
}

/**
 * 贝塞尔连线（替代 React Flow 的 `getBezierPath`）。
 *
 * 覆盖层的派生边自己画，所以这段几何必须留在纯函数里能被单测覆盖，
 * 不能藏在某个渲染组件的 JSX 中间。
 */
export function bezierPath(geometry: EdgeGeometry): BezierPath {
  const { c1, c2 } = bezierControls(geometry);
  return {
    d: `M ${geometry.sourceX},${geometry.sourceY} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${geometry.targetX},${geometry.targetY}`,
    labelX: (geometry.sourceX + 3 * c1.x + 3 * c2.x + geometry.targetX) / 8,
    labelY: (geometry.sourceY + 3 * c1.y + 3 * c2.y + geometry.targetY) / 8,
  };
}

/* --------------------------------- 组框命中 -------------------------------- */

export function containsPoint(box: Box, point: Position): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

export interface GroupCandidate {
  id: string;
  box: Box;
}

/**
 * 拖拽结束时判断节点落进了哪个组：取包含节点中心、且面积最小的组
 * （小组套在大组里时以更具体的那个为准）。
 */
export function hitTestGroup(
  groups: readonly GroupCandidate[],
  point: Position,
  exclude: readonly string[] = [],
): string | null {
  const skip = new Set(exclude);
  let best: GroupCandidate | null = null;
  for (const group of groups) {
    if (skip.has(group.id)) continue;
    if (!containsPoint(group.box, point)) continue;
    const area = group.box.width * group.box.height;
    if (!best || area < best.box.width * best.box.height) best = group;
  }
  return best?.id ?? null;
}

/* -------------------------------- 方向导航 --------------------------------- */

export type Direction = "left" | "right" | "up" | "down";

interface DirectedBox {
  id: string;
  box: Box;
}

/**
 * `⌘方向键`：从当前节点朝某个方向找最近的节点（§8）。
 *
 * 只接受主轴上确实在那个方向、且落在 ±45° 锥形里的候选；
 * 距离按「主轴距离 + 0.5×偏移」加权，所以正对面的节点永远赢过斜上方的。
 */
export function nearestInDirection(
  boxes: readonly DirectedBox[],
  fromId: string,
  direction: Direction,
): string | null {
  const origin = boxes.find((item) => item.id === fromId);
  if (!origin) return null;
  const from = centerOf(origin.box);

  let best: { id: string; score: number } | null = null;
  for (const candidate of boxes) {
    if (candidate.id === fromId) continue;
    const to = centerOf(candidate.box);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const along =
      direction === "left"
        ? -dx
        : direction === "right"
          ? dx
          : direction === "up"
            ? -dy
            : dy;
    if (along <= 0) continue;
    const across =
      direction === "left" || direction === "right"
        ? Math.abs(dy)
        : Math.abs(dx);
    // ±45° 锥形之外的不算「在这个方向上」
    if (across > along) continue;
    const score = along + across * 0.5;
    if (!best || score < best.score) best = { id: candidate.id, score };
  }
  return best?.id ?? null;
}

/** 一组盒子的外包围矩形，`fitView` / 焦点居中要用。 */
export function boundingBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
