import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardDocument, CanvasNode } from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { canUndo, resetHistory, undo } from "@/store/canvas/history";
import {
  commitBatch,
  emptyBatch,
  ungroup,
  GROUP_PADDING,
} from "./import-group";
import { makeItem } from "./test-support";
import { emptyWhiteboard } from "./whiteboard/model";

/** 导入批次 = 一个 `group` 节点（UI 设计 §6.2 / §6.3）。 */

const STAMP = "2026-10-07T00:00:00.000Z";

function load(nodes: CanvasNode[] = []): void {
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
      nodes,
      edges: [],
    } as unknown as BoardDocument,
    whiteboard: emptyWhiteboard(),
  });
}

const groups = () =>
  (useCanvasStore.getState().document?.nodes ?? []).filter(
    (node) => node.type === "group",
  );

beforeEach(() => {
  resetHistory();
  load();
});

afterEach(() => {
  resetHistory();
  useCanvasStore.setState({ document: null, whiteboard: emptyWhiteboard() });
});

describe("commitBatch", () => {
  it("≥ 2 个对象套一个 origin: import 的组，坐标换成相对组框", () => {
    const a = makeItem("shape", { x: 100, y: 200, w: 50, h: 50 });
    const b = makeItem("text", { x: 300, y: 260, w: 40, h: 20 });
    const batch = emptyBatch();
    batch.items.push(a, b);
    batch.nodes.push({
      type: "sticky",
      options: {
        position: { x: 400, y: 100 },
        size: { width: 100, height: 80 },
      },
    });

    const result = commitBatch(batch, "Import");
    expect(result.groupId).not.toBeNull();
    const [group] = groups();
    expect(group?.id).toBe(result.groupId);
    expect(group?.title).toBe("Import");
    expect(group?.data).toMatchObject({ kind: "group", origin: "import" });
    expect(group?.position.x).toBe(100 - GROUP_PADDING);

    const state = useCanvasStore.getState();
    const items = state.whiteboard.items;
    expect(items.every((item) => item.parentId === group!.id)).toBe(true);
    // 相对坐标 + 组框原点 = 原来的绝对坐标。
    const placedA = items.find((item) => item.id === a.id)!;
    expect(placedA.x + group!.position.x).toBe(100);
    expect(placedA.y + group!.position.y).toBe(200);
    const sticky = state.document!.nodes.find(
      (node) => node.type === "sticky",
    )!;
    expect(sticky.parentId).toBe(group!.id);
    expect(sticky.position.x + group!.position.x).toBe(400);
    // 选中的是组。
    expect(state.selectedNodeIds).toEqual([group!.id]);
  });

  it("一条历史：撤销一次整批消失", () => {
    const batch = emptyBatch();
    batch.items.push(makeItem("shape"), makeItem("shape", { x: 300 }));
    commitBatch(batch, "Import");
    expect(groups()).toHaveLength(1);
    undo();
    expect(canUndo()).toBe(false);
    expect(groups()).toHaveLength(0);
    expect(useCanvasStore.getState().whiteboard.items).toHaveLength(0);
  });

  it("单个对象不套组", () => {
    const batch = emptyBatch();
    batch.items.push(makeItem("shape"));
    const result = commitBatch(batch, "Import");
    expect(result.groupId).toBeNull();
    expect(groups()).toHaveLength(0);
    expect(
      useCanvasStore.getState().whiteboard.items[0]?.parentId ?? null,
    ).toBe(null);
  });
});

describe("ungroup", () => {
  it("组员回到页面级、绝对坐标不变，组框删掉；一次撤销复原", () => {
    const batch = emptyBatch();
    batch.items.push(
      makeItem("shape", { x: 100, y: 200 }),
      makeItem("shape", { x: 400, y: 200 }),
    );
    batch.nodes.push({
      type: "sticky",
      options: { position: { x: 700, y: 50 } },
    });
    const { groupId } = commitBatch(batch, "Import");
    resetHistory();

    ungroup(groupId!);
    expect(groups()).toHaveLength(0);
    const state = useCanvasStore.getState();
    const xs = state.whiteboard.items.map((item) => [
      item.parentId ?? null,
      item.x,
    ]);
    expect(xs).toEqual([
      [null, 100],
      [null, 400],
    ]);
    const sticky = state.document!.nodes.find(
      (node) => node.type === "sticky",
    )!;
    expect(sticky.parentId).toBeUndefined();
    expect(sticky.position).toEqual({ x: 700, y: 50 });

    undo();
    expect(canUndo()).toBe(false);
    expect(groups()).toHaveLength(1);
  });
});
