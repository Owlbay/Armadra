import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { loadBoard, saveBoard, setRealtimeHooks } from "../canvas/documents";
import { linkEdge, stickyNode } from "../canvas/nodes.fixture";
import { uuidV7 } from "../workspaces/support";
import { edgesOf, nodesOf, projectDoc } from "./doc";
import { RealtimeHub } from "./hub";
import { realtimeHooks } from "./intercept";
import {
  latestSeq,
  readSnapshot,
  readUpdatesAfter,
  realtimeRow,
} from "./store";
import {
  type BoardFixture,
  MemoryClient,
  boardFixture,
  pumpAll,
} from "./realtime.fixture";

describe("物化、快照与重放", () => {
  let fx: BoardFixture;
  beforeEach(() => {
    fx = boardFixture({ snapshotEvery: 5, debounceMs: 60_000 });
  });
  afterEach(() => fx.close());

  function seed() {
    const note = stickyNode(fx.board.id);
    saveBoard(fx.core.database, fx.workspaceId, fx.board.id, {
      expectedUpdatedAt: fx.board.updatedAt,
      nodes: [note],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    const live = fx.hub.open(fx.workspaceId, fx.board.id, true);
    if (live === undefined) throw new Error("not opened");
    const client = new MemoryClient();
    client.connect(fx.hub, live);
    pumpAll([client]);
    return { note, live, client };
  }

  it("每 N 条更新写快照并截断更新流", () => {
    const { note, live, client } = seed();
    for (let index = 0; index < 12; index += 1) {
      nodesOf(client.doc).get(note.id)?.set("title", `t${index}`);
      pumpAll([client]);
    }
    expect(live.seq).toBe(12);
    const snapshot = readSnapshot(fx.core.database, fx.board.id);
    expect(snapshot?.seq).toBe(10);
    expect(
      readUpdatesAfter(fx.core.database, fx.board.id, 0).map((row) => row.seq),
    ).toEqual([11, 12]);
    // 快照 + 剩下的两条重放出来就是当前文档。
    const replay = new Y.Doc();
    if (snapshot !== undefined) Y.applyUpdate(replay, snapshot.state);
    for (const row of readUpdatesAfter(fx.core.database, fx.board.id, 10)) {
      Y.applyUpdate(replay, row.update);
    }
    expect(projectDoc(replay, fx.board.id).nodes[0]?.title).toBe("t11");
  });

  it("没物化就退出：下次读这块板时按快照 + 更新重放并补物化", () => {
    const { note, client } = seed();
    nodesOf(client.doc).get(note.id)?.set("title", "unsaved");
    pumpAll([client]);
    expect(realtimeRow(fx.core.database, fx.board.id)?.materializedSeq).toBe(0);
    // 「崩溃」：旧中枢不物化、不写快照，换一个新中枢接上同一个库。
    const restarted = new RealtimeHub({
      database: fx.core.database,
      enabled: () => true,
      publishChanged: () => {},
    });
    setRealtimeHooks(fx.core.database, realtimeHooks(restarted));
    try {
      const document = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
      expect(document.nodes[0]?.title).toBe("unsaved");
      expect(realtimeRow(fx.core.database, fx.board.id)?.materializedSeq).toBe(
        latestSeq(fx.core.database, fx.board.id),
      );
    } finally {
      restarted.stop();
      setRealtimeHooks(fx.core.database, realtimeHooks(fx.hub));
    }
  });

  it("文档里表放不下的东西在物化前被清掉，清理同步给客户端", () => {
    const { note, live, client } = seed();
    const other = {
      ...stickyNode(fx.board.id),
      data: { kind: "sticky", content: "x", handle: "dup" },
    };
    const named = {
      ...stickyNode(fx.board.id),
      data: { kind: "sticky", content: "y", handle: "dup" },
    };
    client.doc.transact(() => {
      const nodes = nodesOf(client.doc);
      // 标题为空的坏节点。
      const bad = new Y.Map<unknown>();
      bad.set("type", "sticky");
      bad.set("title", "");
      nodes.set(uuidV7(), bad);
      // 指向不存在的组。
      nodes.get(note.id)?.set("parentId", uuidV7());
      // 两个节点同名。
      for (const node of [other, named]) {
        const map = new Y.Map<unknown>();
        for (const [key, value] of Object.entries(node)) {
          if (key !== "id" && key !== "boardId") map.set(key, value);
        }
        nodes.set(node.id, map);
      }
      // 悬挂的边。
      const dangling = linkEdge(fx.board.id, note.id, uuidV7());
      edgesOf(client.doc).set(dangling.id, {
        source: dangling.source,
        target: dangling.target,
        kind: "link",
        createdAt: dangling.createdAt,
        updatedAt: dangling.updatedAt,
      });
    });
    pumpAll([client]);
    fx.hub.flush(live, true);
    pumpAll([client]);

    const stored = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
    expect(stored.nodes.map((node) => node.id).sort()).toEqual(
      [note.id, other.id, named.id].sort(),
    );
    expect(
      stored.nodes.find((node) => node.id === note.id)?.parentId,
    ).toBeUndefined();
    const handles = stored.nodes
      .map((node) => (node.data as { handle?: string }).handle)
      .filter((handle) => handle !== undefined);
    expect(handles).toEqual(["dup"]);
    expect(stored.edges).toHaveLength(0);
    // 客户端收到了清理：它的投影与表一致。
    const projected = projectDoc(client.doc, fx.board.id);
    expect(projected.nodes).toHaveLength(3);
    expect(projected.edges).toHaveLength(0);
    expect(fx.changed.length).toBeGreaterThan(0);
  });
});
