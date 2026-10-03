/**
 * `board_comments` 的存取（补全架构 §6.3「评论」）。只有表与校验：路由、
 * 权限（作者或 owner 才能删）、`@` 解析与 `board.comment` 事件在 G2-6。
 *
 * 评论不进 `Y.Doc`：权限、审计与锚点都要 core 判。锚点三选一——节点、白板
 * item、画布坐标。回复只有一层：回复的 `parentId` 指向一条顶层评论，锚点随
 * 父评论。
 */

import type { DatabaseSync } from "node:sqlite";

import { badRequest, notFound, uuidV7 } from "../workspaces/support";

export const COMMENT_ANCHOR_KINDS = ["node", "item", "point"] as const;
export type CommentAnchorKind = (typeof COMMENT_ANCHOR_KINDS)[number];

/** 一条评论正文的上限（字符）。 */
export const MAX_COMMENT_CHARS = 10_000;
/** 锚点 id（节点 id 或白板 item id）的上限。 */
const MAX_ANCHOR_ID_CHARS = 200;

export type CommentAnchor =
  | { readonly kind: "node" | "item"; readonly id: string }
  | { readonly kind: "point"; readonly x: number; readonly y: number };

export interface BoardComment {
  readonly id: string;
  readonly boardId: string;
  readonly anchor: CommentAnchor;
  readonly body: string;
  readonly authorPrincipalId: string;
  readonly parentId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly resolvedAtMs: number | null;
}

interface CommentRow {
  id: string;
  board_id: string;
  anchor_kind: string;
  anchor_id: string | null;
  x: number | null;
  y: number | null;
  body: string;
  author_principal_id: string;
  parent_id: string | null;
  created_at_ms: number | bigint;
  updated_at_ms: number | bigint;
  resolved_at_ms: number | bigint | null;
}

const SELECT =
  "SELECT id, board_id, anchor_kind, anchor_id, x, y, body, author_principal_id, parent_id, " +
  "created_at_ms, updated_at_ms, resolved_at_ms FROM board_comments";

function fromRow(row: CommentRow): BoardComment {
  const anchor: CommentAnchor =
    row.anchor_kind === "point"
      ? { kind: "point", x: Number(row.x), y: Number(row.y) }
      : {
          kind: row.anchor_kind === "item" ? "item" : "node",
          id: row.anchor_id ?? "",
        };
  return {
    id: row.id,
    boardId: row.board_id,
    anchor,
    body: row.body,
    authorPrincipalId: row.author_principal_id,
    parentId: row.parent_id,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    resolvedAtMs:
      row.resolved_at_ms === null ? null : Number(row.resolved_at_ms),
  };
}

export function validateCommentBody(body: unknown): string {
  if (typeof body !== "string") throw badRequest("body must be a string");
  const trimmed = body.trim();
  if (trimmed === "" || [...trimmed].length > MAX_COMMENT_CHARS) {
    throw badRequest("Comment body is empty or too long");
  }
  return trimmed;
}

export function validateAnchor(anchor: unknown): CommentAnchor {
  if (anchor === null || typeof anchor !== "object") {
    throw badRequest("anchor must be an object");
  }
  const value = anchor as Record<string, unknown>;
  if (value.kind === "point") {
    if (
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y)
    ) {
      throw badRequest("A point anchor needs finite x and y");
    }
    return { kind: "point", x: value.x, y: value.y };
  }
  if (value.kind === "node" || value.kind === "item") {
    if (
      typeof value.id !== "string" ||
      value.id === "" ||
      value.id.length > MAX_ANCHOR_ID_CHARS
    ) {
      throw badRequest("A node or item anchor needs an id");
    }
    return { kind: value.kind, id: value.id };
  }
  throw badRequest("Unknown anchor kind");
}

export interface NewComment {
  readonly boardId: string;
  readonly anchor: CommentAnchor;
  readonly body: string;
  readonly authorPrincipalId: string;
  readonly parentId?: string | null;
}

export function createComment(
  database: DatabaseSync,
  input: NewComment,
  now: number = Date.now(),
): BoardComment {
  const body = validateCommentBody(input.body);
  let anchor = validateAnchor(input.anchor);
  const parentId = input.parentId ?? null;
  if (parentId !== null) {
    const parent = getComment(database, input.boardId, parentId);
    if (parent.parentId !== null) {
      throw badRequest("Replies are one level deep");
    }
    anchor = parent.anchor;
  }
  const id = uuidV7(now);
  database
    .prepare(
      "INSERT INTO board_comments (id, board_id, anchor_kind, anchor_id, x, y, body, " +
        "author_principal_id, parent_id, created_at_ms, updated_at_ms, resolved_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .run(
      id,
      input.boardId,
      anchor.kind,
      anchor.kind === "point" ? null : anchor.id,
      anchor.kind === "point" ? anchor.x : null,
      anchor.kind === "point" ? anchor.y : null,
      body,
      input.authorPrincipalId,
      parentId,
      now,
      now,
    );
  return getComment(database, input.boardId, id);
}

export function getComment(
  database: DatabaseSync,
  boardId: string,
  id: string,
): BoardComment {
  const row = database
    .prepare(`${SELECT} WHERE id = ? AND board_id = ?`)
    .get(id, boardId) as CommentRow | undefined;
  if (row === undefined) throw notFound("Comment was not found");
  return fromRow(row);
}

export interface CommentQuery {
  /** 只要锚在这个节点或白板 item 上的（含它们的回复）。 */
  readonly anchor?: { readonly kind: "node" | "item"; readonly id: string };
  /** 缺省包括已解决的。 */
  readonly includeResolved?: boolean;
}

/** 一块板的评论，按创建时间。 */
export function listComments(
  database: DatabaseSync,
  boardId: string,
  query: CommentQuery = {},
): BoardComment[] {
  const clauses = ["board_id = ?"];
  const params: (string | number)[] = [boardId];
  if (query.anchor !== undefined) {
    clauses.push("anchor_kind = ?", "anchor_id = ?");
    params.push(query.anchor.kind, query.anchor.id);
  }
  if (query.includeResolved === false) clauses.push("resolved_at_ms IS NULL");
  const rows = database
    .prepare(
      `${SELECT} WHERE ${clauses.join(" AND ")} ORDER BY created_at_ms, id`,
    )
    .all(...params) as unknown as CommentRow[];
  return rows.map(fromRow);
}

export function updateCommentBody(
  database: DatabaseSync,
  boardId: string,
  id: string,
  body: string,
  now: number = Date.now(),
): BoardComment {
  const text = validateCommentBody(body);
  getComment(database, boardId, id);
  database
    .prepare(
      "UPDATE board_comments SET body = ?, updated_at_ms = ? WHERE id = ? AND board_id = ?",
    )
    .run(text, now, id, boardId);
  return getComment(database, boardId, id);
}

/** 解决 / 重新打开。只对顶层评论有意义；回复随父评论。 */
export function setCommentResolved(
  database: DatabaseSync,
  boardId: string,
  id: string,
  resolved: boolean,
  now: number = Date.now(),
): BoardComment {
  const comment = getComment(database, boardId, id);
  if (comment.parentId !== null) {
    throw badRequest("Only a top-level comment can be resolved");
  }
  database
    .prepare(
      "UPDATE board_comments SET resolved_at_ms = ?, updated_at_ms = ? WHERE id = ? AND board_id = ?",
    )
    .run(resolved ? now : null, now, id, boardId);
  return getComment(database, boardId, id);
}

/** 删一条评论；顶层评论的回复随它一起删（外键级联）。 */
export function deleteComment(
  database: DatabaseSync,
  boardId: string,
  id: string,
): void {
  getComment(database, boardId, id);
  database
    .prepare("DELETE FROM board_comments WHERE id = ? AND board_id = ?")
    .run(id, boardId);
}

/** 锚在这些节点上的评论（`readableAs` 的附加资料用，G2-6）。 */
export function commentsOnNodes(
  database: DatabaseSync,
  boardId: string,
  nodeIds: readonly string[],
): BoardComment[] {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = database
    .prepare(
      `${SELECT} WHERE board_id = ? AND anchor_kind = 'node' AND anchor_id IN (${placeholders}) ORDER BY created_at_ms, id`,
    )
    .all(boardId, ...nodeIds) as unknown as CommentRow[];
  return rows.map(fromRow);
}
