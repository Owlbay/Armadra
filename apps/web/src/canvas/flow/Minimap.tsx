import { scoped } from "../../sources/scope";
import * as React from "react";
import { MiniMap, Panel, useReactFlow, useStore } from "@xyflow/react";
import type { MiniMapNodeProps, ReactFlowState } from "@xyflow/react";
import { Map, Minus } from "lucide-react";

import { useAgentStatusStore, type AgentGlow } from "@/agent/status-store";
import {
  headerStateFor,
  useProgramStatusStore,
} from "@/agent/program-status-store";
import { useMinimapPreferences } from "@/app/minimap-preferences";
import { useT } from "@/app/preferences-store";
import { useLayoutDirection } from "@/canvas/layout-direction";
import { useThrottledValue } from "@/lib/use-throttled-value";
import { IconButton } from "@/ui/icon-button";
import type { Box } from "../geometry";
import { isItemId } from "../whiteboard/model";
import { useFamilies, type Family } from "../family";
import type { CanvasFlowEdge, CanvasFlowNode } from "../sync/project";
import {
  boxesExtent,
  minimapLinkLayer,
  MINIMAP_LINK_THROTTLE_MS,
  type BoxLookup,
} from "./minimap-links";

/**
 * 状态缩略图（React Flow 计划 F20 / §1.2，归属 B1）。
 *
 * 旧引擎的缩略图是自绘的一整块 canvas（`overlays/StatusMinimap.tsx`，约
 * 250 行）：它把整页对象合成两条 `Path2D` 再各刷一次颜色，没有「按对象
 * 上色」的入口，所以「按 Agent 状态描边」只能自己画。React Flow 的
 * `<MiniMap>` 反过来——`nodeColor` 与 `nodeStrokeColor` 都是**按节点求值的
 * 函数**，正好就是我们要的那个入口（粗细是个常数，所以另配一个 20 行的
 * `nodeComponent`）。于是整块自绘换成三个纯函数，几何、命中测试、指针换算、
 * DPR、主题重读全部由库负责。
 *
 * 配色（ui-wave2 §5.2）：填充按 `familyOf`——派发簇同色、独立 Agent 标识色、
 * 其他节点按类型；描边仍是三种状态，派发簇成员无状态时描边用簇色。连线也画
 * 进来（#216），和画布上同一套锚点、曲线与颜色：上下文线 `--link-context`、
 * 派发线取主的簇色；按颜色合并成几条 path，见 `minimap-links.ts`。
 *
 * 保留的行为：三种状态描边、点一下定位到那个节点、可收起（收起状态在
 * `app/minimap-preferences.ts`）、位置右下角、离右边与下边各 14px，
 * 画布再窄也不挪（是 Dock 向左让，`styles/canvas.css`）。
 *
 * 放弃的行为：视口框的自定义描边（`maskColor` 只有一个颜色）与「拖着走」时
 * 的 200ms 动画（`pannable` 是即时跟随，比动画跟手）。
 */

/* -------------------------------- 颜色 ------------------------------------ */

/** 状态 → 描边色用的 CSS 变量（`styles/tokens.css`）。 */
export const MINIMAP_COLORS = {
  /** working：陶土色。 */
  working: "var(--agent-working)",
  /** needs-you。 */
  attention: "var(--status-attention)",
  /** 未读。 */
  unread: "var(--brand)",
  /** 无状态的节点、白板对象与分组：一块低对比的底。 */
  plain: "var(--muted-foreground)",
} as const;

export interface MinimapItem {
  /** 白板对象（`wb:` 前缀）与分组一律低对比，不参与状态描边。 */
  plain?: boolean;
  glow?: AgentGlow;
  selected?: boolean;
  /** `familyOf` 给的颜色（簇色 / 标识色 / 类型色）；白板对象没有。 */
  color?: string;
  /** 派发簇成员：无状态时描边也用簇色。 */
  cluster?: boolean;
}

/**
 * 状态 → 描边色（旧画布契约 §3.2）。
 *
 * 三种状态的优先级由 `agentHeaderState()` 定好了（一个节点同一时刻只会有
 * 一种光晕），这里只做映射；没有状态的节点用中性描边。
 */
export function minimapStroke(item: MinimapItem): string {
  if (item.plain) return MINIMAP_COLORS.plain;
  switch (item.glow) {
    case "working":
      return MINIMAP_COLORS.working;
    case "attention":
      return MINIMAP_COLORS.attention;
    case "unread":
      return MINIMAP_COLORS.unread;
    default:
      // 派发簇的描边用簇色：同一个主派出来的一眼连成一片。对等线不改色。
      return item.cluster && item.color ? item.color : MINIMAP_COLORS.plain;
  }
}

/** 三种状态描边色的集合，`minimapStrokeWidth` 靠它认出「有状态」。 */
const STATUS_STROKES: ReadonlySet<string> = new Set([
  MINIMAP_COLORS.working,
  MINIMAP_COLORS.attention,
  MINIMAP_COLORS.unread,
]);

/**
 * 有状态的节点画粗一点：缩略图上 1px 的色差不够，粗细才看得见。
 *
 * 入参是**描边色**而不是节点：`<MiniMap nodeStrokeWidth>` 只收一个常数
 * （不像 `nodeColor` / `nodeStrokeColor` 可以是函数），所以逐节点的粗细要靠
 * 自定义的 `nodeComponent`，而它拿到的只有算好的颜色。
 */
export function minimapStrokeWidth(stroke: string): number {
  return STATUS_STROKES.has(stroke) ? 4 : 2;
}

/**
 * 矩形填充：节点按 `familyOf` 的颜色取 55%（选中 80%），分组 35%；
 * 白板对象没有家族色，退回中性色 35%。
 */
export function minimapFill(item: MinimapItem): string {
  const color = item.color ?? "var(--muted-foreground)";
  const alpha = item.plain ? 0.35 : item.selected ? 0.8 : 0.55;
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

/** RF 的节点 → 上色要看的那几个位（分组和白板对象都算 `plain`）。 */
export function minimapItemOf(
  node: Pick<CanvasFlowNode, "id" | "type" | "selected">,
  glowOf: (nodeId: string) => AgentGlow | undefined,
  families?: ReadonlyMap<string, Family>,
): MinimapItem {
  const item = isItemId(node.id);
  const plain = node.type !== "armadra" || item;
  const glow = plain ? undefined : glowOf(node.id);
  const family = item ? undefined : families?.get(node.id);
  return {
    plain,
    selected: node.selected === true,
    ...(glow ? { glow } : {}),
    ...(family ? { color: family.color } : {}),
    ...(family?.kind === "cluster" && !plain ? { cluster: true } : {}),
  };
}

/* -------------------------------- 组件 ------------------------------------ */

/**
 * 缩略图里的一个矩形。
 *
 * 用自定义的 `nodeComponent` 而不是 RF 自带的那个，只为了一件事：逐节点的
 * 描边粗细。其余（圆角、命中、`shapeRendering`）与自带的一模一样。
 */
export function MinimapNode({
  id,
  x,
  y,
  width,
  height,
  borderRadius,
  className,
  color,
  strokeColor,
  shapeRendering,
  selected,
  onClick,
}: MiniMapNodeProps) {
  const first = useIsFirstMinimapNode(id);
  return (
    <>
      {first ? <MinimapLinkLayer /> : null}
      <rect
        className={`react-flow__minimap-node${selected ? " selected" : ""} ${className}`}
        x={x}
        y={y}
        rx={borderRadius}
        ry={borderRadius}
        width={width}
        height={height}
        style={{
          fill: color,
          stroke: strokeColor,
          strokeWidth: minimapStrokeWidth(strokeColor ?? MINIMAP_COLORS.plain),
        }}
        shapeRendering={shapeRendering}
        onClick={onClick ? (event) => onClick(event, id) : undefined}
      />
    </>
  );
}

/**
 * 第一个会被画进小地图的节点（不隐藏、量到了尺寸）。连线层挂在它前面，
 * 于是整层连线只渲染一次，而且压在所有节点矩形下面。
 */
export function firstMinimapNodeId(
  nodes: readonly { id: string; hidden?: boolean }[],
  boxOf: BoxLookup,
): string | undefined {
  for (const node of nodes) {
    if (!node.hidden && boxOf(node.id)) return node.id;
  }
  return undefined;
}

type NodeLookup = ReactFlowState["nodeLookup"];

/** RF 的绝对矩形；隐藏或没量到尺寸时 `undefined`（与 `<MiniMap>` 的过滤一致）。 */
function lookupBoxes(lookup: NodeLookup): BoxLookup {
  return (id) => {
    const node = lookup.get(id);
    if (!node || node.hidden) return undefined;
    const width = node.measured.width ?? node.width ?? node.initialWidth ?? 0;
    const height =
      node.measured.height ?? node.height ?? node.initialHeight ?? 0;
    if (width <= 0 || height <= 0) return undefined;
    const at = node.internals.positionAbsolute;
    return { x: at.x, y: at.y, width, height };
  };
}

function useIsFirstMinimapNode(id: string): boolean {
  return useStore(
    (state: ReactFlowState) =>
      firstMinimapNodeId(state.nodes, lookupBoxes(state.nodeLookup)) === id,
  );
}

/**
 * 整张画布的连线，按颜色合并成几条 `<path>`（`minimap-links.ts`）。
 *
 * 只在节点、边、簇色或布局方向变化时重算；拖动节点时 `nodes` 每帧都变，按
 * {@link MINIMAP_LINK_THROTTLE_MS} 节流。平移、缩放视口不重算。
 */
export function MinimapLinkLayer() {
  const nodes = useStore((state: ReactFlowState) => state.nodes);
  const edges = useStore(
    (state: ReactFlowState) => state.edges,
  ) as CanvasFlowEdge[];
  const lookup = useStore((state: ReactFlowState) => state.nodeLookup);
  const families = useFamilies();
  const direction = useLayoutDirection();
  const settled = useThrottledValue(nodes, MINIMAP_LINK_THROTTLE_MS);

  const layer = React.useMemo(() => {
    const boxOf = lookupBoxes(lookup);
    const boxes: Box[] = [];
    for (const node of settled) {
      const box = boxOf(node.id);
      if (box) boxes.push(box);
    }
    return minimapLinkLayer(
      edges,
      boxOf,
      (id) => families.get(id)?.color,
      direction,
      boxesExtent(boxes),
    );
  }, [settled, edges, lookup, families, direction]);

  if (layer.paths.length === 0) return null;
  return (
    <g data-slot="minimap-links" pointerEvents="none">
      {layer.paths.map((path) => (
        <path
          key={path.color}
          data-role={path.role}
          d={path.d}
          fill="none"
          stroke={path.color}
          strokeWidth={layer.width}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}

/**
 * 缩略图的收起 / 展开钮（#216）。
 *
 * 不进 `<MiniMap>`（它只渲染一张 SVG，没有插槽），所以贴着缩略图右上角单独
 * 摆一个 Panel（两边的 Panel margin 都归零，数值才是真实边距）。
 *
 * 展开时是缩略图右上角里的一个「−」，平时不显示，悬停缩略图或键盘聚焦时才
 * 出现（`styles/canvas.css`；触屏没有悬停，常显）。收起后 `--minimap-w/h`
 * 变成 36px（`App` 在 `.workspace-surface` 上写 `data-minimap-collapsed`），
 * 原地留一个常显的缩略图图标当展开入口。
 *
 * `reveal` 只给展示页：把「悬停时」那一刻定格下来。
 */
export function MinimapToggle({
  collapsed,
  onToggle,
  reveal = false,
}: {
  collapsed: boolean;
  onToggle: () => void;
  reveal?: boolean;
}) {
  const t = useT();
  const label = t(
    collapsed ? "canvas.expandMinimap" : "canvas.collapseMinimap",
  );
  return (
    <Panel
      position="bottom-right"
      className="minimap-toggle-panel"
      style={
        collapsed
          ? { margin: 0, right: 14, bottom: "var(--navigation-bottom)" }
          : {
              margin: 0,
              right: 18,
              bottom:
                "calc(var(--navigation-bottom) + var(--minimap-h) - 28px)",
            }
      }
    >
      <IconButton
        size={collapsed ? "cluster" : "inline"}
        data-slot="minimap-toggle"
        data-reveal={reveal ? "true" : undefined}
        className={
          collapsed
            ? "minimap-toggle border border-border bg-[var(--panel)]/90 backdrop-blur-[12px]"
            : "minimap-toggle bg-[var(--panel)]/90 hover:bg-[var(--hover)] hover:text-foreground"
        }
        label={label}
        title={label}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        {collapsed ? <Map /> : <Minus />}
      </IconButton>
    </Panel>
  );
}

/** 点一下缩略图里的节点：把它居中，缩放不变（旧引擎同款）。 */
const CENTER_DURATION = 200;

export function Minimap() {
  const t = useT();
  const flow = useReactFlow();
  const { collapsed, setCollapsed } = useMinimapPreferences();
  // 状态每变一次都要重刷描边色，所以订阅整张表而不是某一个节点。
  const statuses = useAgentStatusStore((state) => state.statuses);
  // 程序自报（契约 §53）与上报按节点头同一条规则合并，描边色才和节点头一致。
  const programs = useProgramStatusStore((state) => state.programs);
  const seen = useProgramStatusStore((state) => state.seen);

  const glowOf = React.useCallback(
    (nodeId: string) => {
      const key = scoped(nodeId);
      const status = statuses[key];
      return headerStateFor(
        Boolean(status?.agentId),
        status,
        programs[key],
        Boolean(seen[key]),
      ).glow;
    },
    [statuses, programs, seen],
  );

  const families = useFamilies();

  const nodeStrokeColor = React.useCallback(
    (node: CanvasFlowNode) =>
      minimapStroke(minimapItemOf(node, glowOf, families)),
    [glowOf, families],
  );
  const nodeColor = React.useCallback(
    (node: CanvasFlowNode) =>
      minimapFill(minimapItemOf(node, glowOf, families)),
    [glowOf, families],
  );
  const onNodeClick = React.useCallback(
    (_event: React.MouseEvent, node: CanvasFlowNode) => {
      const width = node.measured?.width ?? node.width ?? 0;
      const height = node.measured?.height ?? node.height ?? 0;
      void flow.setCenter(
        node.position.x + width / 2,
        node.position.y + height / 2,
        { zoom: flow.getZoom(), duration: CENTER_DURATION },
      );
    },
    [flow],
  );

  return (
    <>
      {collapsed ? null : (
        <MiniMap<CanvasFlowNode>
          pannable
          zoomable
          ariaLabel={t("canvas.minimap")}
          data-testid="minimap.canvas"
          nodeColor={nodeColor}
          nodeStrokeColor={nodeStrokeColor}
          nodeComponent={MinimapNode}
          nodeBorderRadius={3}
          onNodeClick={onNodeClick}
        />
      )}
      <MinimapToggle
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
    </>
  );
}

export default Minimap;
