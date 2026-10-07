import type { Board, BoardDocument, CanvasNode } from "@armadra/shared";

/** 实时层单测共用的板与节点（只在测试里用）。 */

export const STAMP = "2026-10-03T00:00:00.000Z";

export const BOARD: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: STAMP,
  updatedAt: STAMP,
};

export const ONE = "019ff7d1-1111-7000-8000-000000000001";
export const TWO = "019ff7d1-1111-7000-8000-000000000002";
export const NOTE = "019ff7d1-1111-7000-8000-000000000003";

export function terminal(id: string, x: number): CanvasNode {
  return {
    id,
    boardId: BOARD.id,
    type: "terminal",
    title: id.slice(-4),
    color: "#0a84ff",
    position: { x, y: 0 },
    size: { width: 200, height: 100 },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: STAMP,
    updatedAt: STAMP,
  } as CanvasNode;
}

export function sticky(id: string, content: string): CanvasNode {
  return {
    id,
    boardId: BOARD.id,
    type: "sticky",
    title: "Sticky",
    color: "#ffd60a",
    position: { x: 0, y: 300 },
    size: { width: 200, height: 160 },
    labels: [],
    note: "",
    data: { kind: "sticky", content },
    createdAt: STAMP,
    updatedAt: STAMP,
  } as CanvasNode;
}

export function boardDocument(nodes: CanvasNode[]): BoardDocument {
  return { board: { ...BOARD }, nodes, edges: [] };
}
