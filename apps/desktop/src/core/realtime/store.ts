/**
 * 实时板的持久层：`board_updates`、`board_snapshots` 与 `boards` 上的
 * `realtime` / `materialized_seq` 两列（补全架构 §3、§6.3）。
 *
 * 只有 SQL，没有 Yjs：文档怎么从这些字节里长出来是 `hub.ts` 的事。
 */

import type { DatabaseSync } from "node:sqlite";

export interface StoredSnapshot {
  readonly seq: number;
  readonly state: Uint8Array;
}

export interface StoredUpdate {
  readonly seq: number;
  readonly update: Uint8Array;
}

export interface RealtimeRow {
  readonly realtime: boolean;
  readonly materializedSeq: number;
}

export function realtimeRow(
  database: DatabaseSync,
  boardId: string,
): RealtimeRow | undefined {
  const row = database
    .prepare("SELECT realtime, materialized_seq FROM boards WHERE id = ?")
    .get(boardId) as
    | { realtime: number | bigint; materialized_seq: number | bigint }
    | undefined;
  if (row === undefined) return undefined;
  return {
    realtime: Number(row.realtime) === 1,
    materializedSeq: Number(row.materialized_seq),
  };
}

export function isRealtime(database: DatabaseSync, boardId: string): boolean {
  return realtimeRow(database, boardId)?.realtime === true;
}

/** 当前最大的 `seq`：更新流的最后一条，没有更新时是快照的那一条。 */
export function latestSeq(database: DatabaseSync, boardId: string): number {
  const update = database
    .prepare("SELECT MAX(seq) AS seq FROM board_updates WHERE board_id = ?")
    .get(boardId) as { seq: number | bigint | null };
  const snapshot = readSnapshot(database, boardId);
  return Math.max(
    update.seq === null ? 0 : Number(update.seq),
    snapshot?.seq ?? 0,
  );
}

export function readSnapshot(
  database: DatabaseSync,
  boardId: string,
): StoredSnapshot | undefined {
  const row = database
    .prepare("SELECT seq, state FROM board_snapshots WHERE board_id = ?")
    .get(boardId) as { seq: number | bigint; state: Uint8Array } | undefined;
  if (row === undefined) return undefined;
  return { seq: Number(row.seq), state: new Uint8Array(row.state) };
}

export function readUpdatesAfter(
  database: DatabaseSync,
  boardId: string,
  seq: number,
): StoredUpdate[] {
  const rows = database
    .prepare(
      'SELECT seq, "update" AS body FROM board_updates WHERE board_id = ? AND seq > ? ORDER BY seq',
    )
    .all(boardId, seq) as unknown as {
    seq: number | bigint;
    body: Uint8Array;
  }[];
  return rows.map((row) => ({
    seq: Number(row.seq),
    update: new Uint8Array(row.body),
  }));
}

export function appendUpdate(
  database: DatabaseSync,
  boardId: string,
  seq: number,
  update: Uint8Array,
  principalId: string | null,
  atMs: number,
): void {
  database
    .prepare(
      'INSERT INTO board_updates (board_id, seq, "update", principal_id, at_ms) VALUES (?, ?, ?, ?, ?)',
    )
    .run(boardId, seq, update, principalId, atMs);
}

/**
 * 写快照并截断更新流：快照覆盖到 `seq`，`seq` 及之前的更新行不再需要。
 * 一个事务——快照落下而更新没删，或者反过来，重放都会出错。
 */
export function writeSnapshot(
  database: DatabaseSync,
  boardId: string,
  seq: number,
  state: Uint8Array,
  atMs: number,
): void {
  inTransaction(database, () => {
    database
      .prepare(
        "INSERT INTO board_snapshots (board_id, seq, state, at_ms) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(board_id) DO UPDATE SET seq = excluded.seq, state = excluded.state, at_ms = excluded.at_ms",
      )
      .run(boardId, seq, state, atMs);
    database
      .prepare("DELETE FROM board_updates WHERE board_id = ? AND seq <= ?")
      .run(boardId, seq);
  });
}

/** 切到实时：首个快照与 `realtime = 1` 同一个事务。 */
export function markRealtime(
  database: DatabaseSync,
  boardId: string,
  state: Uint8Array,
  atMs: number,
): void {
  inTransaction(database, () => {
    database
      .prepare("DELETE FROM board_updates WHERE board_id = ?")
      .run(boardId);
    database
      .prepare(
        "INSERT INTO board_snapshots (board_id, seq, state, at_ms) VALUES (?, 0, ?, ?) " +
          "ON CONFLICT(board_id) DO UPDATE SET seq = 0, state = excluded.state, at_ms = excluded.at_ms",
      )
      .run(boardId, state, atMs);
    database
      .prepare(
        "UPDATE boards SET realtime = 1, materialized_seq = 0 WHERE id = ?",
      )
      .run(boardId);
  });
}

/**
 * 关回租约模式（设置 `collab.realtime = false` 之后、板上没有活动文档时）：
 * 调用方已经把文档物化进表，表重新成为真相，更新流与快照删掉。
 */
export function markLeaseMode(database: DatabaseSync, boardId: string): void {
  inTransaction(database, () => {
    database
      .prepare("DELETE FROM board_updates WHERE board_id = ?")
      .run(boardId);
    database
      .prepare("DELETE FROM board_snapshots WHERE board_id = ?")
      .run(boardId);
    database
      .prepare(
        "UPDATE boards SET realtime = 0, materialized_seq = 0 WHERE id = ?",
      )
      .run(boardId);
  });
}

export function setMaterializedSeq(
  database: DatabaseSync,
  boardId: string,
  seq: number,
): void {
  database
    .prepare("UPDATE boards SET materialized_seq = ? WHERE id = ?")
    .run(seq, boardId);
}

/** 嵌套安全：已经在事务里就直接跑（`saveBoard` 的物化入口自己开事务）。 */
export function inTransaction(database: DatabaseSync, run: () => void): void {
  if (database.isTransaction) {
    run();
    return;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
