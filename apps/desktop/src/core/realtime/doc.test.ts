import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { canonicalJson, loadBoard, saveBoard } from "../canvas/documents";
import type { CanvasNode } from "../canvas/document-types";
import { linkEdge, stickyNode } from "../canvas/nodes.fixture";
import { uuidV7 } from "../workspaces/support";
import {
  type BoardProjection,
  applyDelta,
  applyDocument,
  composeWhiteboard,
  createBoardDoc,
  nodesOf,
  normalizeWhiteboard,
  projectDoc,
  replaceText,
  splitWhiteboard,
} from "./doc";
import { materialize } from "./materialize";
import { type BoardFixture, boardFixture } from "./realtime.fixture";

/** 一块有各种字段的板：便签、组与子节点、终端、主从边、白板。 */
function richDocument(boardId: string): BoardProjection {
  const group: CanvasNode = {
    ...stickyNode(boardId),
    type: "group",
    title: "Group",
    data: { kind: "group" },
    collapsed: true,
    expandedHeight: 300,
  };
  const child: CanvasNode = {
    ...stickyNode(boardId),
    parentId: group.id,
    labels: ["todo", "ui"],
    note: "注释",
    data: { kind: "sticky", content: "多行\n便签", extra: { b: 1, a: [2, 3] } },
  };
  const terminal: CanvasNode = {
    ...stickyNode(boardId),
    type: "terminal",
    title: "Shell",
    data: { kind: "terminal", cwd: "/tmp", shell: "zsh", handle: "worker" },
  };
  const { size: _size, ...bare } = stickyNode(boardId);
  const edges = [
    linkEdge(boardId, child.id, terminal.id),
    { ...linkEdge(boardId, terminal.id, group.id), role: "supervises" },
  ];
  const whiteboard = JSON.stringify({
    engine: "react-flow",
    version: 2,
    items: [
      { id: "wb:b", kind: "rect", x: 1, y: 2, w: 3, h: 4, z: 2, style: {} },
      {
        id: "wb:a",
        kind: "text",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        z: 1,
        style: {},
        text: "hi",
      },
    ],
    references: [{ id: "r1", itemId: "wb:a", nodeId: child.id }],
    legacy: { engine: "old", sha256: "x", bytes: 1 },
  });
  return {
    nodes: [group, child, terminal, bare as CanvasNode],
    edges,
    whiteboard,
  };
}

function byId<T extends { id: string }>(
  entries: readonly T[],
): Map<string, string> {
  return new Map(entries.map((entry) => [entry.id, canonicalJson(entry)]));
}

describe("文档结构", () => {
  let fx: BoardFixture;
  beforeEach(() => {
    fx = boardFixture();
  });
  afterEach(() => fx.close());

  it("表 → 文档 → 投影逐字段等价，物化回表也等价", () => {
    const rich = richDocument(fx.board.id);
    const saved = saveBoard(fx.core.database, fx.workspaceId, fx.board.id, {
      expectedUpdatedAt: fx.board.updatedAt,
      nodes: rich.nodes,
      edges: rich.edges,
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: rich.whiteboard,
    });
    const doc = createBoardDoc();
    applyDocument(
      doc,
      fx.board.id,
      {
        nodes: saved.nodes,
        edges: saved.edges,
        whiteboard: saved.board.whiteboard,
      },
      "seed",
    );
    const projected = projectDoc(doc, fx.board.id);
    expect(byId(projected.nodes)).toEqual(byId(saved.nodes));
    expect(byId(projected.edges)).toEqual(byId(saved.edges));
    expect(JSON.parse(projected.whiteboard)).toEqual(
      JSON.parse(normalizeWhiteboard(saved.board.whiteboard)),
    );
    // 便签正文在 Y.Text 里，`data` 里不重复。
    const child = nodesOf(doc).get(rich.nodes[1]?.id ?? "");
    expect(child?.get("content")).toBeInstanceOf(Y.Text);
    expect(child?.get("data")).not.toHaveProperty("content");

    // 投影没变：物化不写表、不动修订号。
    const same = materialize(
      fx.core.database,
      fx.workspaceId,
      fx.board.id,
      doc,
    );
    expect(same.changed).toBe(false);
    expect(same.document.board.updatedAt).toBe(saved.board.updatedAt);

    // 文档里改一个字段，物化出来的表与投影逐字段相等。
    nodesOf(doc)
      .get(rich.nodes[2]?.id ?? "")
      ?.set("title", "Renamed");
    const written = materialize(
      fx.core.database,
      fx.workspaceId,
      fx.board.id,
      doc,
    );
    expect(written.changed).toBe(true);
    const reloaded = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
    expect(byId(reloaded.nodes)).toEqual(
      byId(projectDoc(doc, fx.board.id).nodes),
    );
  });

  it("三方 diff 只写改了的字段，别人并发改的保留", () => {
    const note = stickyNode(fx.board.id);
    const base: BoardProjection = { nodes: [note], edges: [], whiteboard: "" };
    const doc = createBoardDoc();
    applyDocument(doc, fx.board.id, base, "seed");
    // 客户端并发改了标题与正文……
    const map = nodesOf(doc).get(note.id);
    map?.set("title", "client title");
    const text = map?.get("content") as Y.Text;
    text.insert(text.length, " world");
    // ……core 写者只挪了位置。
    applyDelta(
      doc,
      base,
      { ...base, nodes: [{ ...note, position: { x: 50, y: 60 } }] },
      "core",
    );
    const [node] = projectDoc(doc, fx.board.id).nodes;
    expect(node?.title).toBe("client title");
    expect(node?.position).toEqual({ x: 50, y: 60 });
    expect((node?.data as { content: string }).content).toBe("hello world");
  });

  it("别人刚删掉的节点，core 写者改它不会复活", () => {
    const note = stickyNode(fx.board.id);
    const base: BoardProjection = { nodes: [note], edges: [], whiteboard: "" };
    const doc = createBoardDoc();
    applyDocument(doc, fx.board.id, base, "seed");
    nodesOf(doc).delete(note.id);
    applyDelta(
      doc,
      base,
      { ...base, nodes: [{ ...note, title: "x" }] },
      "core",
    );
    expect(projectDoc(doc, fx.board.id).nodes).toHaveLength(0);
  });
});

describe("便签正文", () => {
  it("只替换公共前后缀之外的一段", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "hello brave world");
    const deltas: unknown[] = [];
    text.observe((event) => deltas.push(event.delta));
    replaceText(text, "hello new world");
    expect(text.toString()).toBe("hello new world");
    expect(deltas).toEqual([[{ retain: 6 }, { delete: 5 }, { insert: "new" }]]);
  });

  it("两个副本并发输入同一张便签都保留", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("t").insert(0, "abc");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    replaceText(a.getText("t"), "abcX");
    replaceText(b.getText("t"), "Yabc");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(a.getText("t").toString()).toBe("YabcX");
    expect(b.getText("t").toString()).toBe("YabcX");
  });
});

describe("白板外壳", () => {
  it("拆开再拼回，item 按 z、引用按 id 排", () => {
    const text = JSON.stringify({
      engine: "react-flow",
      version: 2,
      items: [
        { id: "b", z: 5 },
        { id: "a", z: 1 },
      ],
      references: [{ id: "r2" }, { id: "r1" }],
    });
    const parts = splitWhiteboard(text);
    expect(parts.envelope).toEqual({ engine: "react-flow", version: 2 });
    expect([...parts.items.keys()]).toEqual(["b", "a"]);
    expect(JSON.parse(composeWhiteboard(parts))).toEqual({
      engine: "react-flow",
      version: 2,
      items: [
        { id: "a", z: 1 },
        { id: "b", z: 5 },
      ],
      references: [{ id: "r1" }, { id: "r2" }],
    });
  });

  it("认不出的白板原样保留，空串还是空串", () => {
    for (const raw of [
      "not json",
      '{"items":[{"x":1}],"references":[]}',
      "[1]",
    ]) {
      const doc = createBoardDoc();
      applyDocument(
        doc,
        uuidV7(),
        { nodes: [], edges: [], whiteboard: raw },
        "seed",
      );
      expect(projectDoc(doc, uuidV7()).whiteboard).toBe(raw);
    }
    expect(normalizeWhiteboard("")).toBe("");
  });

  it("并发改不同的 item 互不覆盖", () => {
    const start = JSON.stringify({
      engine: "react-flow",
      version: 2,
      items: [
        { id: "a", z: 1, x: 0 },
        { id: "b", z: 2, x: 0 },
      ],
      references: [],
    });
    const boardId = uuidV7();
    const a = createBoardDoc();
    applyDocument(
      a,
      boardId,
      { nodes: [], edges: [], whiteboard: start },
      "seed",
    );
    const b = createBoardDoc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const move = (which: string) =>
      start.replace(
        `{"id":"${which}","z":${which === "a" ? 1 : 2},"x":0}`,
        `{"id":"${which}","z":${which === "a" ? 1 : 2},"x":9}`,
      );
    applyDelta(
      a,
      { nodes: [], edges: [], whiteboard: start },
      { nodes: [], edges: [], whiteboard: move("a") },
      "x",
    );
    applyDelta(
      b,
      { nodes: [], edges: [], whiteboard: start },
      { nodes: [], edges: [], whiteboard: move("b") },
      "y",
    );
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const items = (
      JSON.parse(projectDoc(a, boardId).whiteboard) as {
        items: { x: number }[];
      }
    ).items;
    expect(items.map((item) => item.x)).toEqual([9, 9]);
  });
});
