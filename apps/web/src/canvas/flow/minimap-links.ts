import type { LayoutDirection } from "@armadra/shared";

import {
  bezierControls,
  dispatchAnchor,
  edgeGeometry,
  type Box,
  type LinkAnchor,
} from "../geometry";
import type { CanvasFlowEdge } from "../sync/project";
import { linkColor, STROKE_WIDTH } from "./edges/link-visual";

/**
 * 小地图里的连线（#216，纯函数，`Minimap.tsx` 与单测共用）。
 *
 * 和画布上同一条曲线：两端矩形相对的边的中点之间的三次贝塞尔，取边规则也
 * 一样——上下文线 `free`（就近边），派发线 `dispatchAnchor`（子在下游时按
 * 布局方向，否则就近边）。简化掉的是只在画布上有意义的部分：箭头、标签、
 * 命中区、选中与投递闪动。
 *
 * 为了省内存与 CPU，所有连线**按颜色合并**成几条 `<path>`（上下文一色、
 * 每个派发簇一色，通常不超过六条），不为每条边建元素；坐标取整，`d` 短一半。
 */

/** 节点在画布坐标里的矩形；不在小地图里（隐藏、没量到尺寸）时是 `undefined`。 */
export type BoxLookup = (id: string) => Box | undefined;

export interface MinimapLinkPath {
  /** 这一组的颜色，同时是 React key。 */
  color: string;
  role: "context" | "dispatch";
  d: string;
}

export interface MinimapLinkLayer {
  paths: MinimapLinkPath[];
  /** 线宽（屏幕像素，配 `vector-effect: non-scaling-stroke`）。 */
  width: number;
}

/** 小地图 SVG 的尺寸（`<MiniMap>` 的缺省 200×150，我们没改）。 */
export const MINIMAP_SVG_WIDTH = 200;
export const MINIMAP_SVG_HEIGHT = 150;

/** 线宽的上下限（屏幕像素）：再细就看不见，再粗就比节点描边还抢眼。 */
export const MINIMAP_LINK_MIN_WIDTH = 1;
export const MINIMAP_LINK_MAX_WIDTH = 1.5;

/** 拖动节点时最多每这么多毫秒重算一次连线。 */
export const MINIMAP_LINK_THROTTLE_MS = 60;

const round = (value: number) => Math.round(value);

/** 一条边的子路径：`M x,y C c1 c2 end`，坐标取整。 */
export function minimapLinkSegment(
  source: Box,
  target: Box,
  anchor: LinkAnchor,
): string {
  const geometry = edgeGeometry(source, target, anchor);
  const { c1, c2 } = bezierControls(geometry);
  return (
    `M${round(geometry.sourceX)},${round(geometry.sourceY)}` +
    `C${round(c1.x)},${round(c1.y)} ${round(c2.x)},${round(c2.y)} ` +
    `${round(geometry.targetX)},${round(geometry.targetY)}`
  );
}

/**
 * 画布的线宽按小地图的缩放比例换成屏幕像素，夹在上下限之间。
 *
 * `viewScale` 是一个屏幕像素对应多少画布单位（`<MiniMap>` 的同名量）；这里
 * 只按节点的外接矩形估它——视口框也会撑大小地图，但为它在平移时逐帧重算
 * 不划算。
 */
export function minimapLinkWidth(extent: {
  width: number;
  height: number;
}): number {
  const viewScale = Math.max(
    extent.width / MINIMAP_SVG_WIDTH,
    extent.height / MINIMAP_SVG_HEIGHT,
  );
  if (!(viewScale > 0)) return MINIMAP_LINK_MAX_WIDTH;
  const width = STROKE_WIDTH / viewScale;
  return Math.min(
    MINIMAP_LINK_MAX_WIDTH,
    Math.max(MINIMAP_LINK_MIN_WIDTH, Math.round(width * 100) / 100),
  );
}

/** 一组矩形的外接尺寸；空表是 0×0。 */
export function boxesExtent(boxes: Iterable<Box>): {
  width: number;
  height: number;
} {
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
  if (minX > maxX) return { width: 0, height: 0 };
  return { width: maxX - minX, height: maxY - minY };
}

/**
 * 整张画布的连线 → 按颜色合并好的几条 path 与线宽。
 *
 * 只画 `link` 边（上下文与派发）；内容引用（`reference`）不是 Agent 之间的
 * 关系，不画。任一端不在小地图里的边跳过。上下文线排在前面，派发线压在上面。
 * `extent` 是小地图里全部节点的外接尺寸，定线宽用；不给就按连线两端估。
 */
export function minimapLinkLayer(
  edges: readonly CanvasFlowEdge[],
  boxOf: BoxLookup,
  familyColorOf: (id: string) => string | undefined,
  direction: LayoutDirection,
  extent?: { width: number; height: number },
): MinimapLinkLayer {
  const groups = new Map<
    string,
    { role: MinimapLinkPath["role"]; d: string[] }
  >();
  const ends: Box[] = [];

  for (const edge of edges) {
    if (edge.type !== "link" || edge.hidden) continue;
    const source = boxOf(edge.source);
    const target = boxOf(edge.target);
    if (!source || !target) continue;
    const supervises = edge.data?.role === "supervises";
    const anchor: LinkAnchor = supervises
      ? dispatchAnchor(source, target, direction)
      : "free";
    const color = linkColor({
      supervises,
      familyColor: familyColorOf(edge.source),
    });
    let group = groups.get(color);
    if (!group) {
      group = { role: supervises ? "dispatch" : "context", d: [] };
      groups.set(color, group);
    }
    group.d.push(minimapLinkSegment(source, target, anchor));
    if (!extent) ends.push(source, target);
  }

  const paths = [...groups].map(([color, group]) => ({
    color,
    role: group.role,
    d: group.d.join(""),
  }));
  paths.sort((a, b) => (a.role === b.role ? 0 : a.role === "context" ? -1 : 1));
  return {
    paths,
    width:
      paths.length === 0
        ? MINIMAP_LINK_MAX_WIDTH
        : minimapLinkWidth(extent ?? boxesExtent(ends)),
  };
}
