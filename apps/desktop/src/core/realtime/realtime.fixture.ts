/**
 * 实时域测试的夹具：一块真库里的板、一个中枢，以及说 `y-protocols` 的内存
 * 客户端（与页面将用的 provider 同一套帧）。帧进队列、显式 `pump`，测试可以
 * 控制两个客户端之间的交错。
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { type Board, listBoards } from "../canvas/boards";
import { setRealtimeHooks } from "../canvas/documents";
import { type Fixture, fixture } from "../workspaces/fixture";
import { createWorkspace } from "../workspaces/table";
import { type HubOptions, type LiveBoard, RealtimeHub } from "./hub";
import { realtimeHooks } from "./intercept";
import { MESSAGE_AWARENESS, MESSAGE_SYNC, SyncConnection } from "./sync";

export interface BoardFixture {
  readonly core: Fixture;
  readonly workspaceId: string;
  readonly board: Board;
  readonly hub: RealtimeHub;
  readonly changed: { boardId: string; updatedAt: string }[];
  enabled: boolean;
  close(): void;
}

export function boardFixture(
  options: Partial<
    Omit<HubOptions, "database" | "enabled" | "publishChanged">
  > = {},
): BoardFixture {
  const core = fixture([]);
  const workspaceId = createWorkspace(core.database, {
    name: "fixture",
    rootPath: core.directory,
  }).id;
  const board = listBoards(core.database, workspaceId)[0];
  if (board === undefined) throw new Error("the default board is missing");
  const changed: { boardId: string; updatedAt: string }[] = [];
  const state: BoardFixture = {
    core,
    workspaceId,
    board,
    changed,
    enabled: true,
    hub: undefined as unknown as RealtimeHub,
    close() {
      undo();
      hub.stop();
      core.close();
    },
  };
  const hub = new RealtimeHub({
    database: core.database,
    enabled: () => state.enabled,
    publishChanged: (_workspace, boardId, updatedAt) => {
      changed.push({ boardId, updatedAt });
    },
    ...options,
  });
  (state as { hub: RealtimeHub }).hub = hub;
  const undo = setRealtimeHooks(core.database, realtimeHooks(hub));
  return state;
}

/** 说同步协议的内存客户端。 */
export class MemoryClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** 发往服务端、还没投递的帧。 */
  readonly outbox: Uint8Array[] = [];
  /** 服务端发来、还没处理的帧。 */
  readonly inbox: Uint8Array[] = [];
  closed: { code: number; reason: string } | undefined;
  conn: SyncConnection | undefined;
  private live: LiveBoard | undefined;
  private connected = false;

  constructor(readonly name = "client") {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this || !this.connected) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.outbox.push(encoding.toUint8Array(encoder));
    });
    this.awareness.on(
      "update",
      (
        change: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin === this || !this.connected) return;
        const ids = [...change.added, ...change.updated, ...change.removed];
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids),
        );
        this.outbox.push(encoding.toUint8Array(encoder));
      },
    );
  }

  connect(
    hub: RealtimeHub,
    live: LiveBoard,
    options: { principalId?: string; canWrite?: () => boolean } = {},
  ): void {
    this.closed = undefined;
    this.live = live;
    this.connected = true;
    const conn = new SyncConnection(
      live,
      {
        send: (frame) => this.inbox.push(frame),
        close: (code, reason) => {
          this.closed = { code, reason };
          this.connected = false;
          hub.detach(live, conn);
        },
      },
      {
        principalId: options.principalId ?? "",
        canWrite: options.canWrite ?? (() => true),
      },
    );
    this.conn = conn;
    hub.attach(live, conn);
    conn.greet();
    // 客户端这一侧的 step1：问服务端「我缺什么」，离线期间的本地改动随服务端
    // 的 step1 回一份 step2 补上。
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.outbox.push(encoding.toUint8Array(encoder));
    const local = this.awareness.getLocalState();
    if (local !== null) this.awareness.setLocalState(local);
  }

  disconnect(hub: RealtimeHub): void {
    if (this.conn === undefined || this.live === undefined) return;
    this.connected = false;
    this.outbox.length = 0;
    this.inbox.length = 0;
    hub.detach(this.live, this.conn);
    this.conn = undefined;
  }

  /** 投递一帧到服务端。返回是否还有。 */
  flushOne(): boolean {
    const frame = this.outbox.shift();
    if (frame === undefined || this.conn === undefined) return false;
    this.conn.receive(frame);
    return true;
  }

  /** 处理一帧服务端来的。 */
  readOne(): boolean {
    const frame = this.inbox.shift();
    if (frame === undefined) return false;
    const decoder = decoding.createDecoder(frame);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1 && this.connected) {
        this.outbox.push(encoding.toUint8Array(encoder));
      }
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      );
    }
    return true;
  }

  get idle(): boolean {
    return this.outbox.length === 0 && this.inbox.length === 0;
  }
}

/** 把所有客户端的帧来回投递到静止。 */
export function pumpAll(clients: readonly MemoryClient[]): void {
  for (let round = 0; round < 10_000; round += 1) {
    let moved = false;
    for (const client of clients) {
      while (client.flushOne()) moved = true;
      while (client.readOne()) moved = true;
    }
    if (!moved) return;
  }
  throw new Error("pump did not settle");
}

/** 可复现的伪随机（mulberry32）。 */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
