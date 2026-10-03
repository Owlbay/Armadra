import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { loadBoard, saveBoard } from "../canvas/documents";
import { stickyNode } from "../canvas/nodes.fixture";
import { nodesOf, projectDoc } from "./doc";
import { readUpdatesAfter, realtimeRow } from "./store";
import {
  CLOSE_BAD_FRAME,
  CLOSE_FORBIDDEN,
  CLOSE_GOING_AWAY,
  CLOSE_TOO_LARGE,
  MAX_FRAME_BYTES,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
} from "./sync";
import { REALTIME_CAPABILITY } from "./index";
import {
  type BoardFixture,
  MemoryClient,
  boardFixture,
  pumpAll,
} from "./realtime.fixture";

/**
 * core 不依赖 `@armadra/shared`，常量各写一份；这里按源码逐条对，改一边忘了
 * 另一边会在这里红。
 */
describe("与共享层的契约常量一致（契约 §16.1）", () => {
  it("消息类型、关闭码、帧上限、能力名", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const shared = readFileSync(
      resolve(here, "../../../../../packages/shared/src/api/realtime.ts"),
      "utf8",
    );
    const expected = [
      `REALTIME_CAPABILITY = "${REALTIME_CAPABILITY}"`,
      `sync: ${MESSAGE_SYNC},`,
      `awareness: ${MESSAGE_AWARENESS},`,
      `queryAwareness: ${MESSAGE_QUERY_AWARENESS},`,
      `goingAway: ${CLOSE_GOING_AWAY},`,
      `tooLarge: ${CLOSE_TOO_LARGE},`,
      `badFrame: ${CLOSE_BAD_FRAME},`,
      `forbidden: ${CLOSE_FORBIDDEN},`,
      `REALTIME_MAX_FRAME_BYTES = ${MAX_FRAME_BYTES / (1024 * 1024)} * 1024 * 1024`,
      'active: "realtime_active"',
      'disabled: "realtime_disabled"',
    ];
    for (const line of expected) expect(shared).toContain(line);
  });
});

describe("同步流", () => {
  let fx: BoardFixture;
  beforeEach(() => {
    fx = boardFixture();
  });
  afterEach(() => fx.close());

  function seedOneNote() {
    const note = stickyNode(fx.board.id);
    saveBoard(fx.core.database, fx.workspaceId, fx.board.id, {
      expectedUpdatedAt: fx.board.updatedAt,
      nodes: [note],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    return note;
  }

  it("第一个实时客户端打开时把板切到实时，表里的内容种进文档", () => {
    const note = seedOneNote();
    expect(realtimeRow(fx.core.database, fx.board.id)?.realtime).toBe(false);
    const live = fx.hub.open(fx.workspaceId, fx.board.id, true);
    if (live === undefined) throw new Error("not opened");
    expect(realtimeRow(fx.core.database, fx.board.id)?.realtime).toBe(true);
    const client = new MemoryClient();
    client.connect(fx.hub, live);
    pumpAll([client]);
    expect(projectDoc(client.doc, fx.board.id).nodes.map((n) => n.id)).toEqual([
      note.id,
    ]);
  });

  it("设置关着时不切", () => {
    fx.enabled = false;
    expect(
      fx.hub.open(fx.workspaceId, fx.board.id, fx.hub.enabled),
    ).toBeUndefined();
    expect(realtimeRow(fx.core.database, fx.board.id)?.realtime).toBe(false);
  });

  it("两个内存客户端互相看到对方的编辑，更新逐条落库", () => {
    const note = seedOneNote();
    const live = fx.hub.open(fx.workspaceId, fx.board.id, true);
    if (live === undefined) throw new Error("not opened");
    const a = new MemoryClient("a");
    const b = new MemoryClient("b");
    a.connect(fx.hub, live, { principalId: "alice" });
    b.connect(fx.hub, live, { principalId: "bob" });
    pumpAll([a, b]);

    nodesOf(a.doc).get(note.id)?.set("title", "from a");
    (nodesOf(b.doc).get(note.id)?.get("content") as Y.Text).insert(0, ">> ");
    pumpAll([a, b]);

    for (const client of [a, b]) {
      const [node] = projectDoc(client.doc, fx.board.id).nodes;
      expect(node?.title).toBe("from a");
      expect((node?.data as { content: string }).content).toBe(">> hello");
    }
    const authors = readUpdatesAfter(fx.core.database, fx.board.id, 0);
    expect(authors.length).toBeGreaterThanOrEqual(2);
    const principals = fx.core.database
      .prepare(
        "SELECT principal_id FROM board_updates WHERE board_id = ? ORDER BY seq",
      )
      .all(fx.board.id)
      .map((row) => (row as { principal_id: string }).principal_id);
    expect(principals).toEqual(expect.arrayContaining(["alice", "bob"]));
  });

  it("只读者的更新被丢弃并以 4403 关流；它的 step1 照常回答", () => {
    const note = seedOneNote();
    const live = fx.hub.open(fx.workspaceId, fx.board.id, true);
    if (live === undefined) throw new Error("not opened");
    const writer = new MemoryClient("writer");
    const reader = new MemoryClient("reader");
    writer.connect(fx.hub, live);
    reader.connect(fx.hub, live, { canWrite: () => false });
    pumpAll([writer, reader]);
    // 只读者拿到了完整文档（step1 → step2）。
    expect(projectDoc(reader.doc, fx.board.id).nodes).toHaveLength(1);
    expect(reader.closed).toBeUndefined();

    nodesOf(reader.doc).get(note.id)?.set("title", "sneaky");
    pumpAll([writer, reader]);
    expect(reader.closed?.code).toBe(CLOSE_FORBIDDEN);
    expect(projectDoc(live.doc, fx.board.id).nodes[0]?.title).toBe("Sticky");
    expect(projectDoc(writer.doc, fx.board.id).nodes[0]?.title).toBe("Sticky");
    expect(live.connections.size).toBe(1);
  });

  it("awareness 转给每个连接，断开时清掉", () => {
    const live = fx.hub.open(fx.workspaceId, fx.board.id, true);
    if (live === undefined) throw new Error("not opened");
    const a = new MemoryClient("a");
    const b = new MemoryClient("b");
    a.connect(fx.hub, live);
    b.connect(fx.hub, live, { canWrite: () => false });
    // 只读者也能发 awareness：让别人看见自己在看。
    b.awareness.setLocalState({
      principalId: "p",
      name: "Bob",
      cursor: { x: 1, y: 2 },
    });
    pumpAll([a, b]);
    expect(a.awareness.getStates().get(b.doc.clientID)).toMatchObject({
      name: "Bob",
    });
    expect(b.closed).toBeUndefined();

    b.disconnect(fx.hub);
    pumpAll([a]);
    expect(a.awareness.getStates().has(b.doc.clientID)).toBe(false);
  });

  it("断线期间的本地编辑在重连后经 step1 / step2 补齐", () => {
    const note = seedOneNote();
    const live = fx.hub.open(fx.workspaceId, fx.board.id, true);
    if (live === undefined) throw new Error("not opened");
    const a = new MemoryClient("a");
    const b = new MemoryClient("b");
    a.connect(fx.hub, live);
    b.connect(fx.hub, live);
    pumpAll([a, b]);
    b.disconnect(fx.hub);
    nodesOf(b.doc).get(note.id)?.set("color", "#ff0000");
    nodesOf(a.doc).get(note.id)?.set("title", "online");
    pumpAll([a]);
    b.connect(fx.hub, live);
    pumpAll([a, b]);
    for (const doc of [a.doc, b.doc, live.doc]) {
      const [node] = projectDoc(doc, fx.board.id).nodes;
      expect(node?.color).toBe("#ff0000");
      expect(node?.title).toBe("online");
    }
  });

  it("坏帧与超大帧关流", () => {
    const live = fx.hub.open(fx.workspaceId, fx.board.id, true);
    if (live === undefined) throw new Error("not opened");
    const a = new MemoryClient("a");
    a.connect(fx.hub, live);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarUint(encoder, syncProtocol.messageYjsUpdate);
    encoding.writeVarUint8Array(encoder, new Uint8Array([255, 255, 255, 1, 2]));
    a.conn?.receive(encoding.toUint8Array(encoder));
    expect(a.closed?.code).toBe(CLOSE_BAD_FRAME);

    const b = new MemoryClient("b");
    b.connect(fx.hub, live);
    b.conn?.receive(new Uint8Array(MAX_FRAME_BYTES + 1));
    expect(b.closed?.code).toBe(CLOSE_TOO_LARGE);
  });

  it("最后一个客户端离开时物化并广播 board.changed", () => {
    const note = seedOneNote();
    const live = fx.hub.open(fx.workspaceId, fx.board.id, true);
    if (live === undefined) throw new Error("not opened");
    const a = new MemoryClient("a");
    a.connect(fx.hub, live);
    pumpAll([a]);
    nodesOf(a.doc).get(note.id)?.set("title", "bye");
    pumpAll([a]);
    expect(fx.changed).toHaveLength(0);
    a.disconnect(fx.hub);
    expect(fx.changed).toHaveLength(1);
    const reloaded = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
    expect(reloaded.nodes[0]?.title).toBe("bye");
    expect(realtimeRow(fx.core.database, fx.board.id)?.materializedSeq).toBe(
      live.seq,
    );
  });
});
