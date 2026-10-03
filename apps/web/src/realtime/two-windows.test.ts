import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { emptyWhiteboard } from "../canvas/whiteboard/model";
import { writeLocal } from "./doc";
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
 * 两个窗口同开一块**实时**板（`canvas/sync/two-windows.test.ts` 的实时版本，
 * 补全架构 §6.4）。
 *
 * 两份真的 store（`vi.resetModules()` 之后各自 import），各自一份 `Y.Doc`、
 * 绑定与撤销管理器；中间的「core」是一份文档加一个手动投递的队列，所以能
 * 模拟「两边同时改、之后才互相看到」。
 */

vi.setConfig({ testTimeout: 60_000 });

vi.mock("../nodes/registry", () => {
  const meta = {
    labelKey: "node.terminal",
    icon: null,
    defaultSize: { width: 200, height: 100 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#0a84ff",
    hasBridgeHandles: false,
  };
  const table = new Proxy({} as Record<string, typeof meta>, {
    get: () => meta,
    has: () => true,
  });
  return { NODE_META: table, nodeMeta: () => meta };
});

const INITIAL = () =>
  boardDocument([terminal(ONE, 0), terminal(TWO, 400), sticky(NOTE, "hello")]);

/** core：一份文档；窗口的更新先进队列，`pump()` 才真正互相送达。 */
function makeCore() {
  const doc = new Y.Doc();
  const seed = INITIAL();
  writeLocal(
    doc,
    { nodes: [], edges: [], whiteboard: emptyWhiteboard() },
    { nodes: seed.nodes, edges: [], whiteboard: emptyWhiteboard() },
    "core",
  );
  const windows: { doc: Y.Doc; inbox: Uint8Array[] }[] = [];
  const outbox: { from: Y.Doc; update: Uint8Array }[] = [];
  return {
    doc,
    attach(client: Y.Doc) {
      Y.applyUpdate(client, Y.encodeStateAsUpdate(doc), "core");
      client.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === "core") return;
        outbox.push({ from: client, update });
      });
      windows.push({ doc: client, inbox: [] });
    },
    /** 把攒着的更新送到 core，再转给其余窗口。 */
    pump() {
      while (outbox.length > 0) {
        const { from, update } = outbox.shift()!;
        Y.applyUpdate(doc, update, "window");
        for (const window of windows) {
          if (window.doc !== from) Y.applyUpdate(window.doc, update, "core");
        }
      }
    },
  };
}

type Core = ReturnType<typeof makeCore>;

async function openWindow(core: Core) {
  vi.resetModules();
  const { useCanvasStore } = await import("../store/canvas-store");
  const { bindStore } = await import("./binding");
  const { installUndo } = await import("./undo");
  const store = useCanvasStore;
  store.getState().selectBoard(BOARD.id);
  store.getState().setDocument(INITIAL());
  store.getState().setRealtime({ boardId: BOARD.id, writable: true });
  const doc = new Y.Doc();
  core.attach(doc);
  const binding = bindStore({ doc, boardId: BOARD.id });
  binding.flush();
  installUndo(doc, binding.origin);
  const node = (id: string) =>
    store.getState().document!.nodes.find((row) => row.id === id);
  return {
    store,
    doc,
    node,
    positionOf: (id: string) => node(id)?.position,
    contentOf: (id: string) => {
      const data = node(id)?.data as { content?: string } | undefined;
      return data?.content;
    },
  };
}

describe("两个窗口同开一块实时板", () => {
  let core: Core;
  beforeEach(() => {
    core = makeCore();
  });

  it("A 拖一个节点，B 收到同步就看到新位置；视口各是各的", async () => {
    const a = await openWindow(core);
    const b = await openWindow(core);
    b.store.getState().setViewport({ x: -120, y: 30, zoom: 0.5 });
    a.store.getState().setViewport({ x: 900, y: 900, zoom: 2 });

    a.store.getState().moveNodes([{ id: ONE, position: { x: 515, y: 565 } }]);
    core.pump();

    expect(b.positionOf(ONE)).toEqual({ x: 515, y: 565 });
    expect(b.store.getState().document!.board.viewport).toEqual({
      x: -120,
      y: 30,
      zoom: 0.5,
    });
  });

  it("两边同时拖不同的节点，谁的都不丢", async () => {
    const a = await openWindow(core);
    const b = await openWindow(core);
    a.store.getState().moveNodes([{ id: ONE, position: { x: 11, y: 11 } }]);
    b.store.getState().moveNodes([{ id: TWO, position: { x: 22, y: 22 } }]);
    core.pump();
    for (const window of [a, b]) {
      expect(window.positionOf(ONE)).toEqual({ x: 11, y: 11 });
      expect(window.positionOf(TWO)).toEqual({ x: 22, y: 22 });
    }
  });

  it("同一张便签同时输入，两边的字都留下并收敛", async () => {
    const a = await openWindow(core);
    const b = await openWindow(core);
    a.store.getState().updateNodeData(NOTE, { content: "hello world" });
    b.store.getState().updateNodeData(NOTE, { content: "say hello" });
    core.pump();
    expect(a.contentOf(NOTE)).toBe("say hello world");
    expect(b.contentOf(NOTE)).toBe("say hello world");
  });

  it("新建、删除都跟得上；B 的 ⌘Z 撤不掉 A 建的节点", async () => {
    const a = await openWindow(core);
    const b = await openWindow(core);
    b.store.getState().moveNodes([{ id: ONE, position: { x: 5, y: 5 } }]);
    core.pump();

    const fresh = a.store.getState().addNode("sticky");
    core.pump();
    expect(b.node(fresh!)).toBeDefined();

    b.store.getState().undo();
    core.pump();
    expect(b.node(fresh!)).toBeDefined();
    expect(b.positionOf(ONE)).toEqual({ x: 0, y: 0 });
    expect(a.positionOf(ONE)).toEqual({ x: 0, y: 0 });

    a.store.getState().removeNodes([fresh!]);
    core.pump();
    expect(b.node(fresh!)).toBeUndefined();
  });

  it("断线期间的本地编辑在重连后补齐", async () => {
    const a = await openWindow(core);
    const b = await openWindow(core);
    // B「离线」：它的更新攒在队列里，直到 pump。
    b.store.getState().moveNodes([{ id: TWO, position: { x: 99, y: 99 } }]);
    a.store.getState().moveNodes([{ id: ONE, position: { x: 1, y: 2 } }]);
    expect(a.positionOf(TWO)).toEqual({ x: 400, y: 0 });
    core.pump();
    expect(a.positionOf(TWO)).toEqual({ x: 99, y: 99 });
    expect(b.positionOf(ONE)).toEqual({ x: 1, y: 2 });
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
  });
});
