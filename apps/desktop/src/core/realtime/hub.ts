/**
 * 活动文档的生命周期（补全架构 §6.3）：加载（快照 + 更新重放）、切到实时、
 * 更新落库与转发、去抖物化、快照截断、空闲卸载，以及设置关掉之后退回租约
 * 模式。
 *
 * 一块板同时最多一个活动 `Y.Doc`，由这里持有；同步连接与 core 写者的拦截都
 * 经它拿文档。所有库写都是同步的，单线程里「应用更新 → 追加一行 → 转发」
 * 之间插不进别的代码。
 */

import type { DatabaseSync } from "node:sqlite";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import { readBoard } from "../canvas/documents";
import { DomainError } from "../workspaces/support";
import { type BoardProjection, applyDocument, createBoardDoc } from "./doc";
import { CORE_ORIGIN, materialize, sanitizeDoc } from "./materialize";
import {
  appendUpdate,
  latestSeq,
  markLeaseMode,
  markRealtime,
  readSnapshot,
  readUpdatesAfter,
  realtimeRow,
  setMaterializedSeq,
  writeSnapshot,
} from "./store";
import {
  CLOSE_GOING_AWAY,
  type SyncConnection,
  type SyncRoom,
  awarenessFrame,
} from "./sync";

/** 去抖：最后一次更新之后多久物化一次。 */
export const MATERIALIZE_DEBOUNCE_MS = 1_000;
/** 没有客户端之后多久卸载文档。 */
export const IDLE_UNLOAD_MS = 60_000;
/** 每多少条更新写一次快照并截断更新流。 */
export const SNAPSHOT_EVERY = 500;

export interface HubOptions {
  readonly database: DatabaseSync;
  /** 设置 `collab.realtime`：能不能把一块板切到实时。 */
  readonly enabled: () => boolean;
  /** 表追上文档之后广播 `board.changed`。 */
  readonly publishChanged: (
    workspaceId: string,
    boardId: string,
    updatedAt: string,
  ) => void;
  readonly log?: {
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
  readonly now?: () => number;
  readonly debounceMs?: number;
  readonly idleMs?: number;
  readonly snapshotEvery?: number;
}

export class LiveBoard implements SyncRoom {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly connections = new Set<SyncConnection>();
  /** 更新流里最后一条的 `seq`。 */
  seq: number;
  /** 最近一份快照覆盖到的 `seq`。 */
  snapshotSeq: number;
  /** 表追到的 `seq`。 */
  materializedSeq: number;
  /** 文档有表里还没有的改动。 */
  dirty = false;
  materializeTimer: ReturnType<typeof setTimeout> | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  disposed = false;

  constructor(
    readonly workspaceId: string,
    readonly boardId: string,
    doc: Y.Doc,
    seq: number,
    snapshotSeq: number,
    materializedSeq: number,
  ) {
    this.doc = doc;
    this.seq = seq;
    this.snapshotSeq = snapshotSeq;
    this.materializedSeq = materializedSeq;
    this.awareness = new Awareness(doc);
    // core 自己不是 awareness 成员：在线表只列人。
    this.awareness.setLocalState(null);
  }
}

export class RealtimeHub {
  private readonly boards = new Map<string, LiveBoard>();
  private readonly database: DatabaseSync;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly idleMs: number;
  private readonly snapshotEvery: number;
  private stopped = false;

  constructor(private readonly options: HubOptions) {
    this.database = options.database;
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? MATERIALIZE_DEBOUNCE_MS;
    this.idleMs = options.idleMs ?? IDLE_UNLOAD_MS;
    this.snapshotEvery = options.snapshotEvery ?? SNAPSHOT_EVERY;
  }

  get enabled(): boolean {
    try {
      return this.options.enabled();
    } catch {
      return false;
    }
  }

  /** 这块板此刻是否有活动文档。 */
  live(boardId: string): LiveBoard | undefined {
    return this.boards.get(boardId);
  }

  liveBoards(): LiveBoard[] {
    return [...this.boards.values()];
  }

  /**
   * 拿到一块板的活动文档，没有就加载。`allowSwitch` 时非实时板会被切到实时
   * （第一个能说实时协议的客户端打开它）；否则非实时板答 `undefined`。
   */
  open(
    workspaceId: string,
    boardId: string,
    allowSwitch: boolean,
  ): LiveBoard | undefined {
    if (this.stopped) return undefined;
    const existing = this.boards.get(boardId);
    if (existing !== undefined) return existing;
    const row = realtimeRow(this.database, boardId);
    if (row === undefined) return undefined;
    if (!row.realtime && !allowSwitch) return undefined;
    // 404 由它答：板在别的工作空间时与非实时板的读同一个错误。
    const stored = readBoard(this.database, workspaceId, boardId);
    const live = row.realtime
      ? this.load(workspaceId, boardId, row.materializedSeq)
      : this.switchOn(workspaceId, boardId, {
          nodes: stored.nodes,
          edges: stored.edges,
          whiteboard: stored.board.whiteboard,
        });
    this.boards.set(boardId, live);
    this.wire(live);
    // 重启重放：表落后于更新流，加载完马上补一次物化。
    if (live.materializedSeq < live.seq) {
      live.dirty = true;
      this.flush(live, true);
    }
    this.armIdle(live);
    return live;
  }

  /** 首次切到实时：从表种文档、写首个快照，同一个事务里标 `realtime = 1`。 */
  private switchOn(
    workspaceId: string,
    boardId: string,
    seed: BoardProjection,
  ): LiveBoard {
    const doc = createBoardDoc();
    applyDocument(doc, boardId, seed, CORE_ORIGIN);
    markRealtime(
      this.database,
      boardId,
      Y.encodeStateAsUpdate(doc),
      this.now(),
    );
    return new LiveBoard(workspaceId, boardId, doc, 0, 0, 0);
  }

  /** 快照 + 其后的更新，按 `seq` 重放。 */
  private load(
    workspaceId: string,
    boardId: string,
    materializedSeq: number,
  ): LiveBoard {
    const doc = createBoardDoc();
    const snapshot = readSnapshot(this.database, boardId);
    if (snapshot !== undefined) Y.applyUpdate(doc, snapshot.state);
    const snapshotSeq = snapshot?.seq ?? 0;
    let seq = snapshotSeq;
    for (const row of readUpdatesAfter(this.database, boardId, snapshotSeq)) {
      Y.applyUpdate(doc, row.update);
      seq = row.seq;
    }
    return new LiveBoard(
      workspaceId,
      boardId,
      doc,
      seq,
      snapshotSeq,
      materializedSeq,
    );
  }

  private wire(live: LiveBoard): void {
    live.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.persist(live, update, origin);
    });
    live.awareness.on(
      "update",
      (
        change: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const ids = [...change.added, ...change.updated, ...change.removed];
        const from = [...live.connections].find((conn) => conn === origin);
        if (from !== undefined) {
          for (const id of change.added) from.awarenessIds.add(id);
          for (const id of change.removed) from.awarenessIds.delete(id);
        }
        if (ids.length === 0) return;
        const frame = awarenessFrame(live.awareness, ids);
        for (const conn of live.connections) conn.send(frame);
      },
    );
  }

  /** 一条更新：追加落库、转发给其余连接、武装物化与快照。 */
  private persist(live: LiveBoard, update: Uint8Array, origin: unknown): void {
    const author = [...live.connections].find((conn) => conn === origin);
    live.seq += 1;
    try {
      appendUpdate(
        this.database,
        live.boardId,
        live.seq,
        update,
        author === undefined ? null : author.principalId,
        this.now(),
      );
    } catch (error) {
      // 落不了库的更新不能当作已经写下：关掉全部连接，客户端重连后按库里
      // 的状态重新同步，没落库的那一条在它们本地，会随 step2 再送一次。
      live.seq -= 1;
      this.options.log?.error("实时更新落库失败", {
        boardId: live.boardId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.evict(live);
      return;
    }
    for (const conn of live.connections) {
      if (conn !== author) conn.sendUpdate(update);
    }
    live.dirty = true;
    this.scheduleMaterialize(live);
    if (live.seq - live.snapshotSeq >= this.snapshotEvery) {
      this.snapshot(live);
    }
  }

  private scheduleMaterialize(live: LiveBoard): void {
    if (live.materializeTimer !== undefined)
      clearTimeout(live.materializeTimer);
    live.materializeTimer = setTimeout(() => {
      live.materializeTimer = undefined;
      this.flush(live, true);
    }, this.debounceMs);
    live.materializeTimer.unref?.();
  }

  /**
   * 物化：先清理文档里表放不下的东西，再对表。`publish` 时表真的变了就广播
   * `board.changed`；拦截那条路由调用方自己广播，传 `false`。
   */
  flush(live: LiveBoard, publish: boolean): void {
    if (live.disposed) return;
    if (live.materializeTimer !== undefined) {
      clearTimeout(live.materializeTimer);
      live.materializeTimer = undefined;
    }
    if (!live.dirty && live.materializedSeq >= live.seq) return;
    try {
      sanitizeDoc(live.doc, live.boardId, this.database);
      if (live.materializeTimer !== undefined) {
        clearTimeout(live.materializeTimer);
        live.materializeTimer = undefined;
      }
      const result = materialize(
        this.database,
        live.workspaceId,
        live.boardId,
        live.doc,
      );
      setMaterializedSeq(this.database, live.boardId, live.seq);
      live.materializedSeq = live.seq;
      live.dirty = false;
      if (publish && result.changed) {
        this.options.publishChanged(
          live.workspaceId,
          live.boardId,
          result.document.board.updatedAt,
        );
      }
    } catch (error) {
      // 表落后不丢数据：真相在更新流里，下一次物化或重启重放会补上。
      this.options.log?.warn("实时板物化失败", {
        boardId: live.boardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 写快照并截断更新流。 */
  snapshot(live: LiveBoard): void {
    if (live.disposed || live.seq <= live.snapshotSeq) return;
    try {
      writeSnapshot(
        this.database,
        live.boardId,
        live.seq,
        Y.encodeStateAsUpdate(live.doc),
        this.now(),
      );
      live.snapshotSeq = live.seq;
    } catch (error) {
      this.options.log?.warn("实时板快照失败", {
        boardId: live.boardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  attach(live: LiveBoard, conn: SyncConnection): void {
    live.connections.add(conn);
    if (live.idleTimer !== undefined) {
      clearTimeout(live.idleTimer);
      live.idleTimer = undefined;
    }
  }

  /** 一条连接断开：清它的 awareness；最后一个走了就物化、写快照、武装卸载。 */
  detach(live: LiveBoard, conn: SyncConnection): void {
    if (!live.connections.delete(conn)) return;
    if (conn.awarenessIds.size > 0) {
      removeAwarenessStates(live.awareness, [...conn.awarenessIds], null);
    }
    if (live.connections.size === 0) {
      this.flush(live, true);
      this.snapshot(live);
      this.armIdle(live);
    }
  }

  /** core 写者碰过一块没人连着的板：空闲计时从现在重新算。 */
  touch(live: LiveBoard): void {
    if (live.connections.size === 0) this.armIdle(live);
  }

  private armIdle(live: LiveBoard): void {
    if (live.connections.size > 0) return;
    if (live.idleTimer !== undefined) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => {
      live.idleTimer = undefined;
      if (live.connections.size === 0) this.unload(live);
    }, this.idleMs);
    live.idleTimer.unref?.();
  }

  /**
   * 卸载：物化、写快照、释放文档。设置已关回租约模式时，表成为真相，这块板
   * 退回 `realtime = 0`（契约 §16.2）。
   */
  unload(live: LiveBoard): void {
    if (live.disposed) return;
    this.flush(live, true);
    this.snapshot(live);
    if (!this.enabled && live.connections.size === 0 && !live.dirty) {
      try {
        markLeaseMode(this.database, live.boardId);
      } catch (error) {
        this.options.log?.warn("实时板退回租约模式失败", {
          boardId: live.boardId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.dispose(live);
  }

  /**
   * 设置关掉之后，一块没有活动文档的实时板退回租约模式：先加载并物化（表可能
   * 落后于更新流），再标 `realtime = 0`。有连接时不退——那些客户端还在写。
   */
  revertToLease(workspaceId: string, boardId: string): boolean {
    const row = realtimeRow(this.database, boardId);
    if (row === undefined || !row.realtime) return true;
    const live = this.open(workspaceId, boardId, false);
    if (live === undefined) return false;
    if (live.connections.size > 0) return false;
    this.unload(live);
    return !(realtimeRow(this.database, boardId)?.realtime ?? false);
  }

  /** 落库失败后的止损：关掉全部连接、丢掉内存文档，下一次按库重载。 */
  private evict(live: LiveBoard): void {
    for (const conn of [...live.connections]) {
      conn.close(CLOSE_GOING_AWAY, "storage failure");
    }
    live.connections.clear();
    this.dispose(live);
  }

  private dispose(live: LiveBoard): void {
    if (live.disposed) return;
    live.disposed = true;
    if (live.materializeTimer !== undefined)
      clearTimeout(live.materializeTimer);
    if (live.idleTimer !== undefined) clearTimeout(live.idleTimer);
    live.awareness.destroy();
    live.doc.destroy();
    if (this.boards.get(live.boardId) === live)
      this.boards.delete(live.boardId);
  }

  /** core 退出：每块活动板物化、写快照，关掉连接。 */
  stop(): void {
    if (this.stopped) return;
    for (const live of [...this.boards.values()]) {
      for (const conn of [...live.connections]) {
        conn.close(CLOSE_GOING_AWAY, "core stopping");
      }
      live.connections.clear();
      this.flush(live, false);
      this.snapshot(live);
      this.dispose(live);
    }
    this.stopped = true;
  }

  /** 板上最新的 `seq`（没有活动文档时读库）。 */
  latestSeq(boardId: string): number {
    return this.boards.get(boardId)?.seq ?? latestSeq(this.database, boardId);
  }
}

/** 409 `realtime_disabled`：设置关了实时协同，这块板不能切过去。 */
export function realtimeDisabled(): DomainError {
  return new DomainError(
    409,
    "realtime_disabled",
    "Realtime collaboration is turned off",
  );
}
