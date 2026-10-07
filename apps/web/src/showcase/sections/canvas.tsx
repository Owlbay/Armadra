import * as React from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { MousePointer2 } from "lucide-react";
import type { CanvasNode } from "@armadra/shared";

import "@xyflow/react/dist/style.css";
import "../../styles/canvas.css";
import { useT } from "@/app/preferences-store";
import { agentColorVar } from "@/agent/launch";
import { edgeKey, useDeliveryStore } from "@/agent/delivery-store";
import { edgeTypes } from "@/canvas/flow/edges/edge-types";
import GroupNode from "@/canvas/flow/nodes/GroupNode";
import { NodeShell } from "@/nodes/NodeShell";
import { ColorDot } from "@/ui/color-dot";
import { memberColorVar } from "@/ui/member-dot";
import {
  CANVAS_EDGES,
  CANVAS_IDS,
  CANVAS_NODES,
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

export default function CanvasSection() {
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
    <div ref={frame} style={{ height: (HEIGHT + 2) * scale }}>
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
  );
}
