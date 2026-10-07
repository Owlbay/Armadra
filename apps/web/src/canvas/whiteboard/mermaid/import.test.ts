import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardDocument } from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { canUndo, resetHistory, undo } from "@/store/canvas/history";
import { emptyWhiteboard } from "../model";
import { FLOWCHART_LR } from "./fixtures";
import { importMermaidText } from "./import";

/** 导入 Mermaid → 一个组（UI 设计 §6.3）：整理时整张图是一个刚体。 */

const STAMP = "2026-10-07T00:00:00.000Z";

beforeEach(() => {
  resetHistory();
  useCanvasStore.setState({
    workspace: { id: "w1", rootPath: "/w" } as never,
    document: {
      board: {
        id: "019ff7d1-0d12-7421-833d-2c5e8d64ed00",
        workspaceId: "w1",
        name: "board",
        sortOrder: 0,
        viewport: { x: 0, y: 0, zoom: 1 },
        whiteboard: "",
        createdAt: STAMP,
        updatedAt: STAMP,
      },
      nodes: [],
      edges: [],
    } as unknown as BoardDocument,
    whiteboard: emptyWhiteboard(),
  });
});

afterEach(() => {
  resetHistory();
  useCanvasStore.setState({ document: null, whiteboard: emptyWhiteboard() });
});

describe("importMermaidText", () => {
  it("整张图进一个 origin: import 的组，对象 parentId 指向它", async () => {
    const outcome = await importMermaidText(FLOWCHART_LR, { x: 500, y: 500 });
    expect(outcome.kind).toBe("graph");
    const state = useCanvasStore.getState();
    const groups = state.document!.nodes.filter(
      (node) => node.type === "group",
    );
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.title).toBe("Mermaid");
    expect(group.data).toMatchObject({ kind: "group", origin: "import" });
    expect(state.whiteboard.items.length).toBeGreaterThan(1);
    expect(
      state.whiteboard.items.every((item) => item.parentId === group.id),
    ).toBe(true);
    if (outcome.kind === "graph") {
      expect(outcome.ids).toHaveLength(state.whiteboard.items.length);
    }
    expect(state.selectedNodeIds).toEqual([group.id]);
  });

  it("撤销一次，整张图连同组一起消失", async () => {
    await importMermaidText(FLOWCHART_LR, { x: 0, y: 0 });
    undo();
    expect(canUndo()).toBe(false);
    const state = useCanvasStore.getState();
    expect(state.document!.nodes).toHaveLength(0);
    expect(state.whiteboard.items).toHaveLength(0);
  });
});
