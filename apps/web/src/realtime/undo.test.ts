import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { useCanvasStore } from "../store/canvas-store";
import { canRedo, canUndo, record } from "../store/canvas/history";
import { bindStore, type Binding } from "./binding";
import { nodesOf, writeLocal } from "./doc";
import { BOARD, ONE, TWO, boardDocument, terminal } from "./realtime.fixture";
import { installUndo, type RealtimeUndo } from "./undo";

/**
 * 实时板的撤销（补全架构 §6.4）：`Y.UndoManager` 只追踪本地来源，远端改动
 * 不进栈；撤销一个已被远端删掉的节点上的改动是 no-op。
 */

const REMOTE = "remote-peer";

const store = () => useCanvasStore.getState();
const positionOf = (id: string) =>
  store().document!.nodes.find((node) => node.id === id)?.position;
const ids = () => store().document!.nodes.map((node) => node.id);

describe("实时板的撤销", () => {
  let doc: Y.Doc;
  let binding: Binding;
  let undo: RealtimeUndo;

  beforeEach(() => {
    store().selectBoard(BOARD.id);
    store().setDocument(boardDocument([terminal(ONE, 0), terminal(TWO, 400)]));
    store().setRealtime({ boardId: BOARD.id, writable: true });
    doc = new Y.Doc();
    const state = store();
    writeLocal(
      doc,
      { nodes: [], edges: [], whiteboard: state.whiteboard },
      {
        nodes: state.document!.nodes,
        edges: [],
        whiteboard: state.whiteboard,
      },
      REMOTE,
    );
    binding = bindStore({ doc, boardId: BOARD.id });
    undo = installUndo(doc, binding.origin);
  });

  afterEach(() => {
    undo.destroy();
    binding.destroy();
    store().setRealtime(null);
    store().selectBoard(null);
  });

  it("⌘Z 撤回本地那一步，⇧⌘Z 重做", () => {
    expect(canUndo()).toBe(false);
    store().moveNodes([{ id: ONE, position: { x: 50, y: 50 } }]);
    expect(canUndo()).toBe(true);

    store().undo();
    expect(positionOf(ONE)).toEqual({ x: 0, y: 0 });
    expect(canRedo()).toBe(true);

    store().redo();
    expect(positionOf(ONE)).toEqual({ x: 50, y: 50 });
  });

  it("每个动作一条历史：连续两次移动撤两次", () => {
    store().moveNodes([{ id: ONE, position: { x: 1, y: 0 } }]);
    store().moveNodes([{ id: ONE, position: { x: 2, y: 0 } }]);
    store().undo();
    expect(positionOf(ONE)).toEqual({ x: 1, y: 0 });
    store().undo();
    expect(positionOf(ONE)).toEqual({ x: 0, y: 0 });
  });

  it("远端改动不进撤销栈，⌘Z 也撤不掉它", () => {
    store().moveNodes([{ id: TWO, position: { x: 400, y: 90 } }]);
    doc.transact(() => {
      nodesOf(doc).get(ONE)!.set("position", { x: 700, y: 0 });
    }, REMOTE);
    expect(positionOf(ONE)).toEqual({ x: 700, y: 0 });

    store().undo();
    expect(positionOf(TWO)).toEqual({ x: 400, y: 0 });
    expect(positionOf(ONE)).toEqual({ x: 700, y: 0 });
    expect(canUndo()).toBe(false);
  });

  it("撤销一个被远端删掉的节点上的改动是 no-op", () => {
    store().moveNodes([{ id: ONE, position: { x: 33, y: 33 } }]);
    doc.transact(() => nodesOf(doc).delete(ONE), REMOTE);
    expect(ids()).not.toContain(ONE);

    store().undo();
    expect(ids()).not.toContain(ONE);
    expect(nodesOf(doc).has(ONE)).toBe(false);
  });

  it("撤销本地新建、但远端已经删了的节点：什么都不发生", () => {
    const created = terminal("019ff7d1-1111-7000-8000-0000000000aa", 900);
    useCanvasStore.setState({
      document: {
        ...store().document!,
        nodes: [...store().document!.nodes, created],
      },
    });
    expect(nodesOf(doc).has(created.id)).toBe(true);
    doc.transact(() => nodesOf(doc).delete(created.id), REMOTE);

    const before = store().document;
    store().undo();
    expect(ids()).not.toContain(created.id);
    expect(store().document).toBe(before);
  });

  it("store 自己的历史栈停用；卸下之后恢复", () => {
    record({
      label: "edit",
      before: {
        nodes: new Map([[ONE, null]]),
        edges: new Map(),
        items: new Map(),
        references: new Map(),
      },
      after: {
        nodes: new Map(),
        edges: new Map(),
        items: new Map(),
        references: new Map(),
      },
    });
    expect(canUndo()).toBe(false);
    undo.destroy();
    expect(canUndo()).toBe(false);
    store().moveNodes([{ id: ONE, position: { x: 4, y: 4 } }]);
    expect(canUndo()).toBe(true);
    undo = installUndo(doc, binding.origin);
  });

  it("只读时 ⌘Z 不动", () => {
    store().moveNodes([{ id: ONE, position: { x: 5, y: 5 } }]);
    store().setRealtime({ boardId: BOARD.id, writable: false });
    store().undo();
    expect(positionOf(ONE)).toEqual({ x: 5, y: 5 });
  });
});
