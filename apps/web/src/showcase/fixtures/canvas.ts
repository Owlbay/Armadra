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
