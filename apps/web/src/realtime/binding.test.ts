import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { useCanvasStore } from "../store/canvas-store";
import { canUndo } from "../store/canvas/history";
import { bindStore, type Binding } from "./binding";
import { nodesOf, writeLocal } from "./doc";
import {
  BOARD,
  NOTE,
  ONE,
  TWO,
  boardDocument,
  sticky,
  terminal,
} from "./realtime.fixture";

/**
 * 绑定层（补全架构 §6.4）：本地事务不回灌、远端更新经灌入路径、手势中延后。
 */

const REMOTE = "remote-peer";

function open(): void {
  const store = useCanvasStore.getState();
  store.selectBoard(BOARD.id);
  store.setDocument(
    boardDocument([terminal(ONE, 0), terminal(TWO, 400), sticky(NOTE, "hi")]),
  );
  store.setRealtime({ boardId: BOARD.id, writable: true });
}

function seed(doc: Y.Doc): void {
  const state = useCanvasStore.getState();
  writeLocal(
    doc,
    { nodes: [], edges: [], whiteboard: state.whiteboard },
    {
      nodes: state.document!.nodes,
      edges: state.document!.edges,
      whiteboard: state.whiteboard,
    },
    REMOTE,
  );
}

const positionOf = (id: string) =>
  useCanvasStore.getState().document!.nodes.find((node) => node.id === id)!
    .position;

describe("实时绑定", () => {
  let doc: Y.Doc;
  let binding: Binding;
  let gesture = false;
  let gestureListeners: (() => void)[] = [];

  beforeEach(() => {
    open();
    doc = new Y.Doc();
    seed(doc);
    gesture = false;
    gestureListeners = [];
    binding = bindStore({
      doc,
      boardId: BOARD.id,
      gestureActive: () => gesture,
      onGestureChange: (listener) => {
        gestureListeners.push(listener);
        return () => undefined;
      },
    });
  });

  afterEach(() => {
    binding.destroy();
    useCanvasStore.getState().setRealtime(null);
    useCanvasStore.getState().selectBoard(null);
  });

  it("本地动作镜像成一次本地 origin 的事务，且不回灌 store", () => {
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
    const apply = vi.spyOn(useCanvasStore.getState(), "applyRealtimeState");
    const before = useCanvasStore.getState().document;

    useCanvasStore
      .getState()
      .moveNodes([{ id: ONE, position: { x: 77, y: 8 } }]);

    expect(origins).toEqual([binding.origin]);
    expect(nodesOf(doc).get(ONE)!.get("position")).toEqual({ x: 77, y: 8 });
    expect(apply).not.toHaveBeenCalled();
    // 只是那一次本地改动，没有第二次 set。
    expect(useCanvasStore.getState().document).not.toBe(before);
    expect(positionOf(ONE)).toEqual({ x: 77, y: 8 });
    apply.mockRestore();
  });

  it("文档就是保存：本地编辑之后保存态仍是已保存", () => {
    useCanvasStore
      .getState()
      .moveNodes([{ id: ONE, position: { x: 1, y: 1 } }]);
    expect(useCanvasStore.getState().saveState).toBe("saved");
  });

  it("远端更新经灌入路径进 store：不进撤销、视口留本地、没动的对象原样", () => {
    useCanvasStore.getState().setViewport({ x: -40, y: 12, zoom: 0.5 });
    const untouched = useCanvasStore
      .getState()
      .document!.nodes.find((node) => node.id === TWO);

    doc.transact(() => {
      nodesOf(doc).get(ONE)!.set("position", { x: 300, y: 300 });
    }, REMOTE);

    expect(positionOf(ONE)).toEqual({ x: 300, y: 300 });
    expect(useCanvasStore.getState().document!.board.viewport).toEqual({
      x: -40,
      y: 12,
      zoom: 0.5,
    });
    expect(
      useCanvasStore.getState().document!.nodes.find((node) => node.id === TWO),
    ).toBe(untouched);
    expect(canUndo()).toBe(false);
    expect(useCanvasStore.getState().saveState).toBe("saved");
  });

  it("远端删掉的节点从选区里去掉", () => {
    useCanvasStore.getState().selectNodes([ONE, TWO]);
    doc.transact(() => nodesOf(doc).delete(ONE), REMOTE);
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([TWO]);
    expect(
      useCanvasStore.getState().document!.nodes.map((node) => node.id),
    ).not.toContain(ONE);
  });

  it("手势进行中先攒着，手势结束一次灌进来", () => {
    gesture = true;
    doc.transact(() => {
      nodesOf(doc).get(TWO)!.set("title", "remote");
    }, REMOTE);
    expect(
      useCanvasStore.getState().document!.nodes.find((node) => node.id === TWO)!
        .title,
    ).not.toBe("remote");

    gesture = false;
    for (const listener of gestureListeners) listener();
    expect(
      useCanvasStore.getState().document!.nodes.find((node) => node.id === TWO)!
        .title,
    ).toBe("remote");
  });

  it("手势中本地改动照常写进文档，攒着的远端改动不被它冲掉", () => {
    gesture = true;
    doc.transact(() => {
      nodesOf(doc).get(TWO)!.set("title", "remote");
    }, REMOTE);
    useCanvasStore
      .getState()
      .moveNodes([{ id: ONE, position: { x: 9, y: 9 } }]);
    expect(nodesOf(doc).get(TWO)!.get("title")).toBe("remote");
    gesture = false;
    for (const listener of gestureListeners) listener();
    expect(positionOf(ONE)).toEqual({ x: 9, y: 9 });
  });

  it("还没同步完时既不写文档也不灌 store", () => {
    binding.destroy();
    let ready = false;
    binding = bindStore({ doc, boardId: BOARD.id, ready: () => ready });
    doc.transact(() => nodesOf(doc).delete(ONE), REMOTE);
    expect(positionOf(ONE)).toEqual({ x: 0, y: 0 });

    ready = true;
    binding.flush();
    expect(
      useCanvasStore.getState().document!.nodes.map((node) => node.id),
    ).not.toContain(ONE);
  });

  it("换了板之后不再写", () => {
    useCanvasStore.getState().selectBoard(null);
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));
    useCanvasStore.setState({ saveState: "dirty" });
    expect(updates).toEqual([]);
  });
});
