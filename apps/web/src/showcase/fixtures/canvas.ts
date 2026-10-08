import type { CanvasNode } from "@armadra/shared";

/**
 * `canvas` 分区的假画布（设计展示页 §2.1）：600×400 里三个节点、一个分组、
 * 三种边、两个他人光标与选区、两枚评论钉、一条投递流光。纯对象，无副作用；
 * 标题与正文是用户内容，允许中文。
 */

const BOARD = "00000000-0000-4000-8000-000000000000";
const AT = "2026-10-03T09:00:00.000Z";

export const CANVAS_IDS = {
  group: "00000000-0000-4000-8000-000000000001",
  terminal: "00000000-0000-4000-8000-000000000002",
  sticky: "00000000-0000-4000-8000-000000000003",
  editor: "00000000-0000-4000-8000-000000000004",
} as const;

function node(
  partial: Pick<CanvasNode, "id" | "type" | "title" | "position" | "data"> & {
    size: { width: number; height: number };
    color?: string;
  },
): CanvasNode {
  return {
    boardId: BOARD,
    color: "#0a84ff",
    labels: [],
    note: "",
    createdAt: AT,
    updatedAt: AT,
    ...partial,
  };
}

export const CANVAS_NODES: CanvasNode[] = [
  node({
    id: CANVAS_IDS.group,
    type: "group",
    title: "画布同步",
    color: "#bf5af2",
    position: { x: 16, y: 20 },
    size: { width: 336, height: 228 },
    data: { kind: "group" },
  }),
  node({
    id: CANVAS_IDS.terminal,
    type: "terminal",
    title: "planner",
    position: { x: 32, y: 56 },
    size: { width: 304, height: 176 },
    data: { kind: "terminal", agent: { id: "claude" } },
  }),
  node({
    id: CANVAS_IDS.sticky,
    type: "sticky",
    title: "约定",
    position: { x: 392, y: 28 },
    size: { width: 192, height: 132 },
    data: {
      kind: "sticky",
      content: "保存走 canvas-store；\n远端改动按 seq 合并。",
    },
  }),
  node({
    id: CANVAS_IDS.editor,
    type: "editor",
    title: "project.ts",
    position: { x: 392, y: 212 },
    size: { width: 192, height: 168 },
    data: { kind: "editor", path: "src/canvas/sync/project.ts" },
  }),
];

/** 三种边：便签 → 终端（对等）、终端 → 编辑器（主从）、分组 → 编辑器（引用）。 */
export const CANVAS_EDGES = [
  {
    id: "edge-peer",
    type: "link",
    source: CANVAS_IDS.sticky,
    target: CANVAS_IDS.terminal,
    data: {},
  },
  {
    id: "edge-supervises",
    type: "link",
    source: CANVAS_IDS.terminal,
    target: CANVAS_IDS.editor,
    data: { role: "supervises" },
  },
  {
    id: "edge-reference",
    type: "reference",
    source: CANVAS_IDS.group,
    target: CANVAS_IDS.editor,
    data: {},
  },
] as const;

/** 投递流光落在哪条边上（`source → target`）。 */
export const DELIVERY = {
  source: CANVAS_IDS.terminal,
  target: CANVAS_IDS.editor,
} as const;

export const TERMINAL_LINES = [
  "$ claude",
  "> 读取 src/canvas/sync/project.ts",
  "  projectNodes · projectEdges",
  "> 修改 3 处，等待测试",
  "  ✓ 41 passed",
] as const;

export const EDITOR_LINES = [
  "export function projectEdges(",
  "  document: CanvasTables | null,",
  "  whiteboard: WhiteboardDoc,",
  "): CanvasFlowEdge[] {",
  "  const nodes = new Set();",
] as const;

/** 他人：光标位置、选中的节点（虚线成员色）。自己是 1，其他人从 2 起。 */
export const PEERS = [
  {
    member: 2,
    name: "林夏",
    cursor: { x: 300, y: 250 },
    selects: CANVAS_IDS.terminal,
  },
  {
    member: 5,
    name: "Noah",
    cursor: { x: 500, y: 178 },
    selects: CANVAS_IDS.sticky,
  },
] as const;

/** 评论钉：一枚未解决（带品牌小点）、一枚已解决（整体淡出）。 */
export const PINS = [
  { member: 2, x: 330, y: 44, count: 2, resolved: false },
  { member: 5, x: 578, y: 206, count: 1, resolved: true },
] as const;

/**
 * 簇色固定状态（ui-wave2 §5.4）：两棵派发树 + 一个独立 Agent + 一张便签。
 * id 按创建顺序排（第一棵树取第一个簇色）。纵向布局：主在上、从在下。
 */
export const CLUSTER_IDS = {
  leadA: "00000000-0000-4000-8000-000000000101",
  subA1: "00000000-0000-4000-8000-000000000102",
  subA2: "00000000-0000-4000-8000-000000000103",
  lone: "00000000-0000-4000-8000-000000000104",
  leadB: "00000000-0000-4000-8000-000000000105",
  subB1: "00000000-0000-4000-8000-000000000106",
  note: "00000000-0000-4000-8000-000000000107",
} as const;

const CLUSTER_SIZE = { width: 130, height: 72 };

function agentNode(
  id: string,
  title: string,
  agent: string,
  x: number,
  y: number,
): CanvasNode {
  return node({
    id,
    type: "terminal",
    title,
    position: { x, y },
    size: CLUSTER_SIZE,
    data: { kind: "terminal", agent: { id: agent } },
  });
}

export const CLUSTER_NODES: CanvasNode[] = [
  agentNode(CLUSTER_IDS.leadA, "planner", "claude", 90, 16),
  agentNode(CLUSTER_IDS.subA1, "codex-1", "codex", 16, 150),
  agentNode(CLUSTER_IDS.subA2, "codex-2", "codex", 164, 150),
  agentNode(CLUSTER_IDS.lone, "reviewer", "codex", 250, 16),
  agentNode(CLUSTER_IDS.leadB, "lead", "opencode", 440, 16),
  agentNode(CLUSTER_IDS.subB1, "worker", "claude", 456, 150),
  node({
    id: CLUSTER_IDS.note,
    type: "sticky",
    title: "约定",
    position: { x: 308, y: 150 },
    size: CLUSTER_SIZE,
    data: { kind: "sticky", content: "" },
  }),
];

export const CLUSTER_EDGES = [
  [CLUSTER_IDS.leadA, CLUSTER_IDS.subA1, "supervises"],
  [CLUSTER_IDS.leadA, CLUSTER_IDS.subA2, "supervises"],
  [CLUSTER_IDS.leadB, CLUSTER_IDS.subB1, "supervises"],
  [CLUSTER_IDS.note, CLUSTER_IDS.lone, "peer"],
  // 跨簇的上下文线：专用色 `--link-context`，与两簇的派发线一眼分开。
  [CLUSTER_IDS.subB1, CLUSTER_IDS.note, "peer"],
].map(([source, target, role]) => ({
  id: `cluster-${source}-${target}`,
  boardId: BOARD,
  kind: "link" as const,
  source: source!,
  target: target!,
  role: role as "peer" | "supervises",
  createdAt: AT,
  updatedAt: AT,
}));
