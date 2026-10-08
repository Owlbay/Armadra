import * as React from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { MousePointer2 } from "lucide-react";
import type { BoardDocument, CanvasNode } from "@armadra/shared";

import "@xyflow/react/dist/style.css";
import "../../styles/canvas.css";
import { useT } from "@/app/preferences-store";
import { agentColorVar } from "@/agent/launch";
import { edgeKey, useDeliveryStore } from "@/agent/delivery-store";
import { edgeTypes } from "@/canvas/flow/edges/edge-types";
import { useFamilies } from "@/canvas/family";
import {
  MinimapNode,
  minimapFill,
  minimapItemOf,
  minimapStroke,
} from "@/canvas/flow/Minimap";
import type { CanvasFlowNode } from "@/canvas/sync/project";
import { useCanvasStore } from "@/store/canvas-store";
import GroupNode from "@/canvas/flow/nodes/GroupNode";
import { NodeShell } from "@/nodes/NodeShell";
import { HEADER_CHIP_CLASS } from "@/nodes/header-chip";
import { Badge } from "@/ui/badge";
import { ColorDot } from "@/ui/color-dot";
import { memberColorVar } from "@/ui/member-dot";
import {
  CANVAS_EDGES,
  CANVAS_IDS,
  CANVAS_NODES,
  CLUSTER_EDGES,
  CLUSTER_NODES,
  DELIVERY,
  EDITOR_LINES,
  PEERS,
  PINS,
  TERMINAL_LINES,
} from "../fixtures/canvas";

/**
 * `canvas` 分区（设计展示页 §2.1，设计系统 §4）：600×400 的假画布。
 *
 * 节点外壳、状态胶囊、光晕、分组、两种边都是画布上的真组件；节点体换成
 * 静态内容——真终端要连 core，真编辑器要读文件，展示页两样都不碰。
 * 他人光标、选区与评论钉是多人协同（设计系统 §5.6–§5.7）的视觉，按 §4 的
 * 表画在节点之上的一层（`--z-canvas-overlay`）。
 */

type ShowcaseFlowNode = Node<CanvasNode, "showcase" | "group">;

const WIDTH = 600;
const HEIGHT = 400;

function TerminalBody() {
  return (
    <div className="h-full bg-[var(--term-bg)] px-3 py-2 font-mono text-[length:var(--text-code)] leading-[1.5] text-[var(--term-fg)]">
      {TERMINAL_LINES.map((line) => (
        <div key={line} className="truncate whitespace-pre">
          {line}
        </div>
      ))}
    </div>
  );
}

function EditorBody() {
  return (
    <div className="h-full px-3 py-2 font-mono text-[length:var(--text-code)] leading-[1.5]">
      {EDITOR_LINES.map((line) => (
        <div key={line} className="truncate whitespace-pre">
          {line}
        </div>
      ))}
    </div>
  );
}

function StickyBody({ content }: { content: string }) {
  return (
    <div className="h-full px-3 py-2 text-[length:var(--text-body)] whitespace-pre-line">
      {content}
    </div>
  );
}

/** 其他人选中这个节点：1.5px 虚线成员色，外扩 2px（设计系统 §4）。 */
function peerSelection(id: string): string | undefined {
  const peer = PEERS.find((candidate) => candidate.selects === id);
  return peer ? memberColorVar(peer.member) : undefined;
}

function ShowcaseNode({ data: node }: NodeProps<ShowcaseFlowNode>) {
  const t = useT();
  const peer = peerSelection(node.id);
  const body =
    node.data.kind === "terminal" ? (
      <TerminalBody />
    ) : node.data.kind === "editor" ? (
      <EditorBody />
    ) : node.data.kind === "sticky" ? (
      <StickyBody content={node.data.content} />
    ) : null;
  const working = node.id === CANVAS_IDS.terminal;
  const unread = node.id === CANVAS_IDS.editor;
  return (
    <div
      className="h-full w-full rounded-[var(--r-card)]"
      style={
        peer ? { outline: `1.5px dashed ${peer}`, outlineOffset: 2 } : undefined
      }
    >
      <NodeShell
        node={node}
        selected={false}
        {...(working
          ? {
              glow: "working" as const,
              status: {
                tone: "working" as const,
                label: t("showcase.tone.working"),
              },
              headerMark: <ColorDot color={agentColorVar("claude")} size={8} />,
            }
          : {})}
        {...(unread
          ? {
              glow: "unread" as const,
              status: {
                tone: "unread" as const,
                label: t("showcase.tone.unread"),
              },
            }
          : {})}
      >
        {body}
      </NodeShell>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  showcase: ShowcaseNode,
  group: GroupNode,
};

const flowNodes: ShowcaseFlowNode[] = CANVAS_NODES.map((node) => ({
  id: node.id,
  type: node.type === "group" ? "group" : "showcase",
  position: node.position,
  data: node,
  width: node.size?.width,
  height: node.size?.height,
  zIndex: node.type === "group" ? 0 : 1,
  draggable: false,
  selectable: false,
  dragHandle: ".drag-handle",
}));

const flowEdges: Edge[] = CANVAS_EDGES.map((edge) => ({
  ...edge,
  data: { ...edge.data },
  selectable: false,
}));

/** 他人光标：16px 箭头成员色 + 右下名字标签（设计系统 §4）。 */
function PeerCursor({
  member,
  name,
  x,
  y,
}: {
  member: number;
  name: string;
  x: number;
  y: number;
}) {
  const color = memberColorVar(member);
  return (
    <div
      data-peer-cursor
      className="pointer-events-none absolute flex items-start"
      style={{ transform: `translate(${x}px, ${y}px)`, left: 0, top: 0 }}
    >
      <MousePointer2
        className="size-4"
        style={{ color, fill: color }}
        strokeWidth={1.5}
      />
      <span
        className="mt-3 rounded-[var(--r-pill)] border bg-card px-1.5 text-[length:var(--text-caption)] leading-4"
        style={{ borderColor: color }}
      >
        {name}
      </span>
    </div>
  );
}

/** 评论钉：24px 圆、`--card` 底、2px 成员色边、里面是计数（设计系统 §4）。 */
function CommentPin({
  member,
  x,
  y,
  count,
  resolved,
}: {
  member: number;
  x: number;
  y: number;
  count: number;
  resolved: boolean;
}) {
  return (
    <div
      data-comment-pin={resolved ? "resolved" : "open"}
      className="pointer-events-none absolute flex size-6 items-center justify-center rounded-[var(--r-pill)] border-2 bg-card text-[length:var(--text-caption)] font-medium tabular-nums"
      style={{
        left: x - 12,
        top: y - 12,
        borderColor: resolved ? "var(--faint)" : memberColorVar(member),
        color: resolved ? "var(--faint)" : undefined,
      }}
    >
      {count}
      {resolved ? null : (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-[var(--r-pill)] bg-[var(--brand)]" />
      )}
    </div>
  );
}

/* ------------------------- 节点头：全部常显（§4） ------------------------- */

const HEADER_WIDTH = 600;
const HEADER_HEIGHT_PX = 72;

/** 一个头部塞满的终端：名字、三枚胶囊加一枚折叠计数、状态、审批、动作。 */
const HEADER_NODE: CanvasNode = {
  ...(CANVAS_NODES.find((node) => node.id === CANVAS_IDS.terminal) ??
    CANVAS_NODES[0]!),
  id: "00000000-0000-4000-8000-0000000000f1",
  position: { x: 0, y: 0 },
  size: { width: HEADER_WIDTH, height: HEADER_HEIGHT_PX },
  data: {
    kind: "terminal",
    agent: { id: "claude" },
    handle: "reviewer",
  } as CanvasNode["data"],
};

function HeaderSpecimenNode({ data: node }: NodeProps<ShowcaseFlowNode>) {
  const t = useT();
  return (
    <NodeShell
      node={node}
      selected={false}
      headerMark={<ColorDot color={agentColorVar("claude")} size={8} />}
      headerChips={
        <>
          <Badge variant="outline" className={HEADER_CHIP_CLASS}>
            6.6 MB
          </Badge>
          <Badge variant="outline" className={HEADER_CHIP_CLASS}>
            {t("delivery.queued", { count: 2 })}
          </Badge>
          <Badge variant="outline" className={HEADER_CHIP_CLASS}>
            {t("contextReads.count", { count: 3 })}
          </Badge>
          <Badge variant="destructive" className={HEADER_CHIP_CLASS}>
            exit 1
          </Badge>
        </>
      }
      status={{ tone: "attention", label: t("showcase.tone.attention") }}
      approval={{ pendingId: "showcase", onAnswer: () => undefined }}
    >
      <TerminalBody />
    </NodeShell>
  );
}

const headerNodeTypes: NodeTypes = { showcase: HeaderSpecimenNode };

const headerFlowNodes: ShowcaseFlowNode[] = [
  {
    id: HEADER_NODE.id,
    type: "showcase",
    position: { x: 0, y: 0 },
    data: HEADER_NODE,
    width: HEADER_WIDTH,
    height: HEADER_HEIGHT_PX,
    draggable: false,
    selectable: false,
    dragHandle: ".drag-handle",
  },
];

/** 节点头四段的固定状态：不悬停、不选中，所有控件也都在（设计系统 §4）。 */
function HeaderSpecimen({ scale }: { scale: number }) {
  return (
    <div style={{ height: (HEADER_HEIGHT_PX + 2) * scale }}>
      <div
        data-showcase-node-header
        className="canvas-stage relative origin-top-left overflow-hidden rounded-[var(--r-panel)] border border-border"
        style={{
          width: HEADER_WIDTH + 2,
          height: HEADER_HEIGHT_PX + 2,
          transform: scale < 1 ? `scale(${scale})` : undefined,
        }}
      >
        {/* 自己的 provider：展示页外层那一个归上面的假画布，共用会互相覆盖节点。 */}
        <ReactFlowProvider>
          <ReactFlow
            nodes={headerFlowNodes}
            edges={[]}
            nodeTypes={headerNodeTypes}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

/* ------------------------------ 簇色固定状态 ------------------------------ */

const CLUSTER_WIDTH = 600;
const CLUSTER_HEIGHT = 330;

/**
 * 簇色读的是 canvas-store 里的文档（`family.ts`）。展示页没有真画布，挂载时把
 * 两块假画布的节点与边写进去，卸载时还原。
 */
const SHOWCASE_DOCUMENT: BoardDocument = {
  board: {} as BoardDocument["board"],
  nodes: [...CANVAS_NODES, ...CLUSTER_NODES],
  edges: [
    ...CANVAS_EDGES.filter((edge) => edge.type === "link").map((edge) => ({
      id: edge.id,
      boardId: CLUSTER_EDGES[0]!.boardId,
      kind: "link" as const,
      source: edge.source,
      target: edge.target,
      ...("role" in edge.data ? { role: edge.data.role } : {}),
      createdAt: CLUSTER_EDGES[0]!.createdAt,
      updatedAt: CLUSTER_EDGES[0]!.updatedAt,
    })),
    ...CLUSTER_EDGES,
  ],
};

function ClusterNode({ data: node }: NodeProps<ShowcaseFlowNode>) {
  return (
    <NodeShell
      node={node}
      selected={false}
      {...(node.data.kind === "terminal"
        ? {
            headerMark: (
              <ColorDot color={agentColorVar(node.data.agent?.id)} size={8} />
            ),
          }
        : {})}
    >
      {null}
    </NodeShell>
  );
}

const clusterNodeTypes: NodeTypes = { armadra: ClusterNode };

const clusterFlowNodes = CLUSTER_NODES.map((node) => ({
  id: node.id,
  type: "armadra" as const,
  position: node.position,
  data: node,
  width: node.size?.width,
  height: node.size?.height,
  draggable: false,
  selectable: false,
  dragHandle: ".drag-handle",
}));

const clusterFlowEdges: Edge[] = CLUSTER_EDGES.map((edge) => ({
  id: edge.id,
  type: "link",
  source: edge.source,
  target: edge.target,
  data: { role: edge.role },
  selectable: false,
}));

const noGlow = () => undefined;

/**
 * 两簇 + 独立 Agent + 便签，配一张同色的小地图（设计 ui-wave2 §5.4）。上下文线
 * （便签 ↔ reviewer、reviewer ↔ worker）是专用的品红，派发线是各自的簇色，小地图里
 * 两类线同样分色。
 */
function ClusterSpecimen({ scale }: { scale: number }) {
  const families = useFamilies();
  return (
    <div style={{ height: (CLUSTER_HEIGHT + 2) * scale }}>
      <div
        data-showcase-clusters
        className="canvas-stage relative origin-top-left overflow-hidden rounded-[var(--r-panel)] border border-border"
        style={{
          width: CLUSTER_WIDTH + 2,
          height: CLUSTER_HEIGHT + 2,
          transform: scale < 1 ? `scale(${scale})` : undefined,
        }}
      >
        <ReactFlowProvider>
          <ReactFlow
            nodes={clusterFlowNodes}
            edges={clusterFlowEdges}
            nodeTypes={clusterNodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              color="var(--canvas-dot)"
              gap={20}
            />
            <MiniMap<CanvasFlowNode>
              // 真画布的位置规则（`styles/canvas.css`）读这三个变量，SVG 的
              // 尺寸读 width / height；展示页没有 Dock，贴着右下角放一张小的。
              style={
                {
                  width: 150,
                  height: 90,
                  "--minimap-w": "150px",
                  "--minimap-h": "90px",
                  "--navigation-bottom": "10px",
                } as React.CSSProperties
              }
              nodeColor={(node) =>
                minimapFill(minimapItemOf(node, noGlow, families))
              }
              nodeStrokeColor={(node) =>
                minimapStroke(minimapItemOf(node, noGlow, families))
              }
              nodeComponent={MinimapNode}
              nodeBorderRadius={3}
            />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}

export default function CanvasSection() {
  // 簇色从 canvas-store 读：挂载期间换成展示用的文档，卸载时还原。
  React.useEffect(() => {
    const previous = useCanvasStore.getState().document;
    useCanvasStore.setState({ document: SHOWCASE_DOCUMENT });
    return () => useCanvasStore.setState({ document: previous });
  }, []);

  // 投递流光只在「刚投递」的两秒内画；展示页把时刻放到未来，让它一直亮着。
  React.useEffect(() => {
    const key = edgeKey(DELIVERY.source, DELIVERY.target);
    useDeliveryStore.setState({
      marks: {
        [key]: {
          sourceNodeId: DELIVERY.source,
          targetNodeId: DELIVERY.target,
          outcome: "delivered",
          at: Date.now() + 10 * 60_000,
        },
      },
    });
    return () => useDeliveryStore.getState().reset();
  }, []);

  // 手机宽度下整块等比缩小（只缩显示，画布坐标不变），不出横向滚动。
  const frame = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(1);
  React.useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () =>
      setScale(Math.min(1, element.clientWidth / (WIDTH + 2)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={frame} className="flex flex-col gap-4">
      <div style={{ height: (HEIGHT + 2) * scale }}>
        <div
          data-showcase-canvas
          className="canvas-stage relative origin-top-left overflow-hidden rounded-[var(--r-panel)] border border-border"
          style={{
            width: WIDTH + 2,
            height: HEIGHT + 2,
            transform: scale < 1 ? `scale(${scale})` : undefined,
          }}
        >
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              color="var(--canvas-dot)"
              gap={20}
            />
          </ReactFlow>
          <div
            className="pointer-events-none absolute inset-0"
            style={{ zIndex: "var(--z-canvas-overlay)" }}
          >
            {PINS.map((pin) => (
              <CommentPin key={`${pin.x}-${pin.y}`} {...pin} />
            ))}
            {PEERS.map((peer) => (
              <PeerCursor
                key={peer.member}
                member={peer.member}
                name={peer.name}
                x={peer.cursor.x}
                y={peer.cursor.y}
              />
            ))}
          </div>
        </div>
      </div>
      <HeaderSpecimen scale={scale} />
      <ClusterSpecimen scale={scale} />
    </div>
  );
}
