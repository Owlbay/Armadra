/**
 * 属性测试（补全架构 §6.4 末条、§12）：两个内存客户端与 core 写者随机并发
 * 操作、随机交错投递、随机断线重连之后，三份文档收敛；物化进表的结果与文档
 * 投影逐字段相等。种子固定，失败可复现。
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { canonicalJson, loadBoard, saveBoard } from "../canvas/documents";
import type { CanvasNode } from "../canvas/document-types";
import { linkEdge, stickyNode } from "../canvas/nodes.fixture";
import {
  type BoardProjection,
  edgesOf,
  metaOf,
  nodesOf,
  normalizeWhiteboard,
  projectDoc,
  replaceText,
  whiteboardOf,
} from "./doc";
import {
  type BoardFixture,
  MemoryClient,
  boardFixture,
  prng,
  pumpAll,
} from "./realtime.fixture";

const SEEDS = 24;
const STEPS = 80;

function pick<T>(random: () => number, entries: readonly T[]): T | undefined {
  if (entries.length === 0) return undefined;
  return entries[Math.floor(random() * entries.length)];
}

/** 页面会做的那些编辑，直接对客户端文档。 */
function clientEdit(
  random: () => number,
  client: MemoryClient,
  boardId: string,
): void {
  const doc = client.doc;
  const nodes = nodesOf(doc);
  const ids = [...nodes.keys()];
  const roll = random();
  if (roll < 0.2 || ids.length === 0) {
    const node = stickyNode(boardId);
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(node)) {
      if (key === "id" || key === "boardId") continue;
      if (key === "data") {
        map.set("data", { kind: "sticky" });
        const text = new Y.Text();
        text.insert(0, "note");
        map.set("content", text);
        continue;
      }
      map.set(key, value);
    }
    nodes.set(node.id, map);
    return;
  }
  const id = pick(random, ids) as string;
  const map = nodes.get(id);
  if (map === undefined) return;
  if (roll < 0.3) {
    nodes.delete(id);
  } else if (roll < 0.45) {
    map.set("title", `t${Math.floor(random() * 1000)}`);
  } else if (roll < 0.6) {
    map.set("position", {
      x: Math.round(random() * 500),
      y: Math.round(random() * 500),
    });
  } else if (roll < 0.75) {
    const text = map.get("content");
    if (text instanceof Y.Text) {
      const at = Math.floor(random() * (text.length + 1));
      if (random() < 0.7 || text.length === 0) {
        text.insert(at, String.fromCharCode(97 + Math.floor(random() * 26)));
      } else {
        text.delete(Math.min(at, text.length - 1), 1);
      }
    }
  } else if (roll < 0.85) {
    const target = pick(random, ids) as string;
    if (target !== id) {
      const edge = linkEdge(boardId, id, target);
      edgesOf(doc).set(edge.id, {
        source: edge.source,
        target: edge.target,
        kind: "link",
        createdAt: edge.createdAt,
        updatedAt: edge.updatedAt,
      });
    }
  } else if (roll < 0.9) {
    const edge = pick(random, [...edgesOf(doc).keys()]);
    if (edge !== undefined) edgesOf(doc).delete(edge);
  } else {
    doc.transact(() => {
      metaOf(doc).set(
        "whiteboardEnvelope",
        JSON.stringify({ engine: "react-flow", version: 2 }),
      );
      const item = `wb:${Math.floor(random() * 4)}`;
      if (random() < 0.8) {
        whiteboardOf(doc).set(
          item,
          JSON.stringify({
            id: item,
            kind: "rect",
            z: Math.floor(random() * 3),
            x: random(),
          }),
        );
      } else {
        whiteboardOf(doc).delete(item);
      }
    });
  }
}

/** core 写者：读表、改一个节点的标题或便签正文、按读到的修订号存回去。 */
function coreEdit(random: () => number, fx: BoardFixture): void {
  const document = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
  const target = pick(random, document.nodes);
  const nodes: CanvasNode[] = document.nodes.map((node) => {
    if (node !== target) return node;
    if (random() < 0.5)
      return { ...node, title: `core${Math.floor(random() * 100)}` };
    const content = (node.data as { content?: string }).content ?? "";
    return {
      ...node,
      data: { ...(node.data as object), content: `${content}!` },
    };
  });
  if (target === undefined)
    nodes.push({ ...stickyNode(fx.board.id), title: "core new" });
  saveBoard(fx.core.database, fx.workspaceId, fx.board.id, {
    expectedUpdatedAt: document.board.updatedAt,
    nodes,
    edges: document.edges,
    viewport: document.board.viewport,
  });
}

function comparable(projection: BoardProjection) {
  return {
    nodes: new Map(
      projection.nodes.map((node) => [node.id, canonicalJson(node)]),
    ),
    edges: new Map(
      projection.edges.map((edge) => [
        edge.id,
        canonicalJson({ ...edge, role: edge.role ?? "peer" }),
      ]),
    ),
    whiteboard: normalizeWhiteboard(projection.whiteboard),
  };
}

describe("随机并发收敛与物化等价", () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    it(`种子 ${seed}`, () => {
      const random = prng(seed);
      const fx = boardFixture({ debounceMs: 60_000 });
      try {
        const live = fx.hub.open(fx.workspaceId, fx.board.id, true);
        if (live === undefined) throw new Error("not opened");
        const a = new MemoryClient("a");
        const b = new MemoryClient("b");
        a.connect(fx.hub, live);
        b.connect(fx.hub, live);
        pumpAll([a, b]);
        let bOnline = true;

        for (let step = 0; step < STEPS; step += 1) {
          const roll = random();
          if (roll < 0.3) clientEdit(random, a, fx.board.id);
          else if (roll < 0.55) clientEdit(random, b, fx.board.id);
          else if (roll < 0.62) coreEdit(random, fx);
          else if (roll < 0.66) fx.hub.flush(live, true);
          else if (roll < 0.69) {
            if (bOnline) b.disconnect(fx.hub);
            else b.connect(fx.hub, live);
            bOnline = !bOnline;
          } else {
            // 随机交错：投递一帧或处理一帧。
            const client = random() < 0.5 ? a : b;
            if (random() < 0.5) client.flushOne();
            else client.readOne();
          }
        }

        if (!bOnline) b.connect(fx.hub, live);
        pumpAll([a, b]);
        fx.hub.flush(live, true);
        pumpAll([a, b]);

        const server = projectDoc(live.doc, fx.board.id);
        expect(comparable(projectDoc(a.doc, fx.board.id))).toEqual(
          comparable(server),
        );
        expect(comparable(projectDoc(b.doc, fx.board.id))).toEqual(
          comparable(server),
        );
        const stored = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
        expect(
          comparable({
            nodes: stored.nodes,
            edges: stored.edges,
            whiteboard: stored.board.whiteboard,
          }),
        ).toEqual(comparable(server));
      } finally {
        fx.close();
      }
    });
  }
});
