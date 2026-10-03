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
import type { CanvasNode } from "@armadra/shared";

import "@xyflow/react/dist/style.css";
import "../../styles/canvas.css";
import { useT } from "@/app/preferences-store";
import { agentColorVar } from "@/agent/launch";
import { edgeTypes } from "@/canvas/flow/edges/edge-types";
import { NodeShell } from "@/nodes/NodeShell";
import { Badge } from "@/ui/badge";
import { ColorDot } from "@/ui/color-dot";
import type { StatusTone } from "@/ui/status-pill";
import { DraftCard } from "@/workflow/DraftCard";
import { WorkflowStepBadge, useWorkflowNodeSteps } from "@/workflow/node-steps";
import {
  BODY_LINES,
  COORDINATOR_EDGES,
  COORDINATOR_IDS,
  COORDINATOR_NODES,
  DRAFT,
  WORKING_STEP,
} from "../fixtures/coordinator";

/**
 * `coordinator` 分区（设计展示页 §2.1，设计系统 §5.4）：ama 分派三个成员。
 *
 * 画布上的真组件：节点外壳、状态胶囊、主从边（「驱动」）、运行中成员头部的
 * 「第 n 步」（`WorkflowStepBadge`）；ama 头部多一枚「3 成员」。右边是
 * `workflow_propose` 落下的真草案卡。节点体是静态的一行字——真终端要连 core。
 */

type CoordinatorFlowNode = Node<CanvasNode, "member">;

const WIDTH = 600;
const HEIGHT = 296;

const TONES: Record<string, { tone: StatusTone; label: string }> = {
  [COORDINATOR_IDS.lead]: { tone: "working", label: "showcase.tone.working" },
  [COORDINATOR_IDS.done]: { tone: "done", label: "showcase.tone.done" },
  [COORDINATOR_IDS.working]: {
    tone: "working",
    label: "showcase.tone.working",
  },
  [COORDINATOR_IDS.failed]: { tone: "failed", label: "showcase.tone.failed" },
};

function MemberNode({ data: node }: NodeProps<CoordinatorFlowNode>) {
  const t = useT();
  const agentId =
    node.data.kind === "terminal" ? (node.data.agent?.id ?? "") : "";
  const tone = TONES[node.id];
  const lead = node.id === COORDINATOR_IDS.lead;
  return (
    <NodeShell
      node={node}
      selected={false}
      headerMark={<ColorDot color={agentColorVar(agentId)} size={8} />}
      headerChips={
        lead ? (
          <Badge
            variant="secondary"
            className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
          >
            {t("showcase.coordinator.members", { count: 3 })}
          </Badge>
        ) : (
          <WorkflowStepBadge nodeId={node.id} />
        )
      }
      {...(tone ? { status: { tone: tone.tone, label: t(tone.label) } } : {})}
      {...(tone?.tone === "working" ? { glow: "working" as const } : {})}
    >
      <div className="h-full truncate bg-[var(--term-bg)] px-3 py-2 font-mono text-[length:var(--text-code)] text-[var(--term-fg)]">
        {BODY_LINES[node.id]}
      </div>
    </NodeShell>
  );
}

const nodeTypes: NodeTypes = { member: MemberNode };

const flowNodes: CoordinatorFlowNode[] = COORDINATOR_NODES.map((node) => ({
  id: node.id,
  type: "member",
  position: node.position,
  data: node,
  width: node.size?.width,
  height: node.size?.height,
  draggable: false,
  selectable: false,
}));

const flowEdges: Edge[] = COORDINATOR_EDGES.map((edge) => ({
  ...edge,
  data: { ...edge.data },
  selectable: false,
}));

export default function CoordinatorSection() {
  // 运行中的那个成员是工作流的第二步（设计系统 §4「工作流运行」）。
  React.useEffect(() => {
    useWorkflowNodeSteps.setState({
      steps: { [COORDINATOR_IDS.working]: WORKING_STEP },
    });
    return () => useWorkflowNodeSteps.setState({ steps: {} });
  }, []);

  // 手机宽度下整块等比缩小，不出横向滚动（同 canvas 分区）。
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
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div
        ref={frame}
        className="min-w-0"
        style={{ height: (HEIGHT + 2) * scale }}
      >
        <div
          data-showcase-coordinator
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
        </div>
      </div>
      <div className="min-w-0 max-w-[360px]">
        <DraftCard row={DRAFT} />
      </div>
    </div>
  );
}
