import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadBoard, saveBoard, setRealtimeHooks } from "../canvas/documents";
import type { BoardDocument, CanvasNode } from "../canvas/document-types";
import { stickyNode } from "../canvas/nodes.fixture";
import { DomainError } from "../workspaces/support";
import { nodesOf, projectDoc } from "./doc";
import { realtimeRow } from "./store";
import {
  type BoardFixture,
  MemoryClient,
  boardFixture,
  pumpAll,
} from "./realtime.fixture";

function refusal(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** core 写者的样子：读一份、改一下、按读到的修订号存回去（不带 clientId）。 */
function coreWrite(
  fx: BoardFixture,
  edit: (document: BoardDocument) => readonly CanvasNode[],
): BoardDocument {
  const document = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
  return saveBoard(fx.core.database, fx.workspaceId, fx.board.id, {
    expectedUpdatedAt: document.board.updatedAt,
    nodes: edit(document),
    edges: document.edges,
    viewport: document.board.viewport,
  });
}

describe("实时板上的写入拦截", () => {
  let fx: BoardFixture;
  let note: CanvasNode;

  beforeEach(() => {
    fx = boardFixture({ idleMs: 30 });
    note = stickyNode(fx.board.id);
    saveBoard(fx.core.database, fx.workspaceId, fx.board.id, {
      expectedUpdatedAt: fx.board.updatedAt,
      nodes: [note],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  });
  afterEach(() => fx.close());

  function goLive() {
    const live = fx.hub.open(fx.workspaceId, fx.board.id, true);
    if (live === undefined) throw new Error("not opened");
    return live;
  }

  it("控制动词经文档写入：客户端收到更新，更新流里记的是 core", () => {
    const live = goLive();
    const client = new MemoryClient();
    client.connect(fx.hub, live);
    pumpAll([client]);

    const saved = coreWrite(fx, (document) => [
      ...document.nodes,
      { ...stickyNode(fx.board.id), title: "from verb" },
    ]);
    expect(saved.nodes.map((node) => node.title)).toContain("from verb");
    pumpAll([client]);
    expect(
      projectDoc(client.doc, fx.board.id).nodes.map((node) => node.title),
    ).toContain("from verb");
    const authors = fx.core.database
      .prepare("SELECT principal_id FROM board_updates WHERE board_id = ?")
      .all(fx.board.id) as { principal_id: string | null }[];
    expect(authors.some((row) => row.principal_id === null)).toBe(true);
  });

  it("带 clientId 的直写答 409 realtime_active；没有拦截也拒", () => {
    goLive();
    const document = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
    const request = {
      expectedUpdatedAt: document.board.updatedAt,
      nodes: document.nodes,
      edges: document.edges,
      viewport: document.board.viewport,
    };
    const http = refusal(() =>
      saveBoard(fx.core.database, fx.workspaceId, fx.board.id, {
        ...request,
        clientId: "client-aaaaaaaa",
      }),
    );
    expect([http.status, http.code]).toEqual([409, "realtime_active"]);

    const undo = setRealtimeHooks(fx.core.database, undefined);
    const bare = refusal(() =>
      saveBoard(fx.core.database, fx.workspaceId, fx.board.id, request),
    );
    expect(bare.code).toBe("realtime_active");
    undo();
  });

  it("客户端并发改的字段保留，core 只写自己改的", () => {
    const live = goLive();
    const client = new MemoryClient();
    client.connect(fx.hub, live);
    pumpAll([client]);
    nodesOf(client.doc).get(note.id)?.set("title", "typed by a person");
    pumpAll([client]);

    // 写者读的时候文档已经物化进表（读前补物化），所以它看到的是新标题。
    coreWrite(fx, (document) =>
      document.nodes.map((node) => ({ ...node, position: { x: 7, y: 8 } })),
    );
    pumpAll([client]);
    const [node] = projectDoc(client.doc, fx.board.id).nodes;
    expect(node?.title).toBe("typed by a person");
    expect(node?.position).toEqual({ x: 7, y: 8 });
  });

  it("读到的那份旧了照旧 409", () => {
    goLive();
    const stale = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
    coreWrite(fx, (document) =>
      document.nodes.map((node) => ({ ...node, title: "first" })),
    );
    const error = refusal(() =>
      saveBoard(fx.core.database, fx.workspaceId, fx.board.id, {
        expectedUpdatedAt: stale.board.updatedAt,
        nodes: stale.nodes,
        edges: [],
        viewport: stale.board.viewport,
      }),
    );
    expect(error.status).toBe(409);
  });

  it("撞名与坏节点照旧拒绝，文档一字不动", () => {
    const live = goLive();
    const named = (handle: string): CanvasNode => ({
      ...stickyNode(fx.board.id),
      type: "terminal",
      data: { kind: "terminal", handle },
    });
    coreWrite(fx, (document) => [...document.nodes, named("worker")]);
    const seq = live.seq;
    const collision = refusal(() =>
      coreWrite(fx, (document) => [...document.nodes, named("Worker")]),
    );
    expect(collision.status).toBe(400);
    const invalid = refusal(() =>
      coreWrite(fx, (document) => [...document.nodes, { ...note, id: "nope" }]),
    );
    expect(invalid.status).toBe(400);
    expect(live.seq).toBe(seq);
    expect(projectDoc(live.doc, fx.board.id).nodes).toHaveLength(2);
  });

  it("没有客户端也加载文档，空闲后卸载", async () => {
    goLive();
    fx.hub.unload(fx.hub.live(fx.board.id) ?? goLive());
    expect(fx.hub.live(fx.board.id)).toBeUndefined();
    coreWrite(fx, (document) =>
      document.nodes.map((node) => ({ ...node, title: "offline verb" })),
    );
    expect(fx.hub.live(fx.board.id)).toBeDefined();
    expect(
      loadBoard(fx.core.database, fx.workspaceId, fx.board.id).nodes[0]?.title,
    ).toBe("offline verb");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fx.hub.live(fx.board.id)).toBeUndefined();
    expect(realtimeRow(fx.core.database, fx.board.id)?.realtime).toBe(true);
  });

  it("设置关掉后，没人连着的实时板在下一次写入时退回租约模式", () => {
    const live = goLive();
    const client = new MemoryClient();
    client.connect(fx.hub, live);
    pumpAll([client]);
    nodesOf(client.doc).get(note.id)?.set("title", "kept");
    pumpAll([client]);
    fx.enabled = false;
    // 有人连着：不退，写入仍经文档。
    coreWrite(fx, (document) => document.nodes);
    expect(realtimeRow(fx.core.database, fx.board.id)?.realtime).toBe(true);

    client.disconnect(fx.hub);
    const saved = coreWrite(fx, (document) =>
      document.nodes.map((node) => ({ ...node, color: "#00ff00" })),
    );
    expect(realtimeRow(fx.core.database, fx.board.id)).toEqual({
      realtime: false,
      materializedSeq: 0,
    });
    expect(saved.nodes[0]?.title).toBe("kept");
    expect(saved.nodes[0]?.color).toBe("#00ff00");
    const leftovers = fx.core.database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM board_updates WHERE board_id = ?) + (SELECT COUNT(*) FROM board_snapshots WHERE board_id = ?) AS n",
      )
      .get(fx.board.id, fx.board.id) as { n: number };
    expect(Number(leftovers.n)).toBe(0);
  });
});
