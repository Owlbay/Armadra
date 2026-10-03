import type { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  badRequest,
  conflict,
  rfc3339,
} from "../workspaces/support";
import { type Board, getBoard } from "./boards";
import type {
  BoardDocument,
  CanvasEdge,
  CanvasNode,
  SaveBoardRequest,
} from "./document-types";
import { syncHandles } from "./handles";
import { forgetNodes } from "./orphans";
import {
  validateDocument,
  validateViewport,
  validateWhiteboard,
} from "./validation";

/**
 * Loading a board's nodes, edges and whiteboard snapshot, and saving them
 * under an optimistic revision check.
 *
 * A port of the pre-merge implementation. Two things in it are contract
 * rather than implementation, and neither may drift:
 *
 *   * **The CAS.** `UPDATE … WHERE id = ? AND updated_at = ?` is the whole of
 *     it. A row count other than 1 is a 409, and the front end answers a 409
 *     by rebasing its unsaved edits onto a fresh load and trying again. The
 *     board's `updated_at` *is* its revision number.
 *   * **A save is a diff, never a rewrite.** `agent_mailbox` is
 *     `ON DELETE CASCADE` on `nodes`, so deleting and re-inserting every row
 *     would drop every message on the board on every autosave — a drag, a
 *     rename or a colour change included.
 */

interface NodeRow {
  id: string;
  board_id: string;
  type: string;
  title: string;
  color: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  collapsed: number;
  expanded_height: number | null;
  parent_id: string | null;
  labels_json: string;
  note: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  board_id: string;
  source_node_id: string;
  target_node_id: string;
  kind: string;
  role: string;
  created_at: string;
  updated_at: string;
}

/* --------------------------- 实时板（契约 §16.2） -------------------------- */

/**
 * 实时板的两个挂点，由 `core/realtime` 装配时登记（按库登记：同一进程里的两个
 * core 各有各的）。
 *
 *   * `beforeLoad`：读一块实时板之前，把文档里还没物化的更新先落进表，读到的
 *     就是文档的当前投影。
 *   * `save`：core 自己的写者（控制动词、调度、依赖编排）对实时板的保存。
 *     拦截把请求与文档 diff 后以 `origin: "core"` 的事务写进文档，再物化。
 *
 * 没登记时实时板一律拒写：表不是这块板的真相，绕过文档写表等于丢掉别人的
 * 编辑。
 */
export interface RealtimeBoardHooks {
  beforeLoad(
    database: DatabaseSync,
    workspaceId: string,
    boardId: string,
  ): void;
  save(
    database: DatabaseSync,
    workspaceId: string,
    boardId: string,
    request: SaveBoardRequest,
  ): BoardDocument;
}

const realtimeHooks = new WeakMap<DatabaseSync, RealtimeBoardHooks>();

/** 登记（`undefined` 撤销）这个库的实时挂点。返回撤销函数。 */
export function setRealtimeHooks(
  database: DatabaseSync,
  hooks: RealtimeBoardHooks | undefined,
): () => void {
  if (hooks === undefined) realtimeHooks.delete(database);
  else realtimeHooks.set(database, hooks);
  return () => {
    if (realtimeHooks.get(database) === hooks) realtimeHooks.delete(database);
  };
}

/** 409 `realtime_active`：这块板已经切到实时，表不能直接写（契约 §16.2）。 */
export function realtimeActive(): DomainError {
  return new DomainError(
    409,
    "realtime_active",
    "Board is in realtime mode; edits go through the sync stream",
  );
}

/** `boards.realtime`：这块板的真相是不是 `Y.Doc`。 */
export function isRealtimeBoard(
  database: DatabaseSync,
  boardId: string,
): boolean {
  const row = database
    .prepare("SELECT realtime FROM boards WHERE id = ?")
    .get(boardId) as { realtime: number | bigint } | undefined;
  return row !== undefined && Number(row.realtime) === 1;
}

export function loadBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
): BoardDocument {
  const hooks = realtimeHooks.get(database);
  if (hooks !== undefined && isRealtimeBoard(database, boardId)) {
    hooks.beforeLoad(database, workspaceId, boardId);
  }
  return readBoard(database, workspaceId, boardId);
}

/** 只读表、不经实时挂点。物化自己读回结果用它，免得再触发一次物化。 */
export function readBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
): BoardDocument {
  const board = getBoard(database, workspaceId, boardId);
  const nodeRows = database
    .prepare(
      "SELECT id, board_id, type, title, color, x, y, width, height, collapsed, expanded_height, " +
        "parent_id, labels_json, note, data_json, created_at, updated_at " +
        "FROM nodes WHERE board_id = ? ORDER BY created_at",
    )
    .all(board.id) as unknown as NodeRow[];
  const edgeRows = database
    .prepare(
      "SELECT id, board_id, source_node_id, target_node_id, kind, role, created_at, updated_at " +
        "FROM edges WHERE board_id = ? ORDER BY created_at",
    )
    .all(board.id) as unknown as EdgeRow[];
  return {
    board,
    nodes: nodeRows.map(nodeFromRow),
    edges: edgeRows.map((row) => ({
      id: row.id,
      boardId: row.board_id,
      source: row.source_node_id,
      target: row.target_node_id,
      kind: row.kind,
      // 对等还是主从（迁移 0024）。已有的边一条都没有变含义：列的缺省是
      // `peer`，而它们本来就是对等的。
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

function nodeFromRow(row: NodeRow): CanvasNode {
  // A label list we cannot decode is a missing chip, not a board that refuses
  // to open — the same reasoning the Rust reader applies.
  let labels: string[] = [];
  try {
    const parsed = JSON.parse(row.labels_json) as unknown;
    if (Array.isArray(parsed)) {
      labels = parsed.filter(
        (entry): entry is string => typeof entry === "string",
      );
    }
  } catch {
    labels = [];
  }
  const node: Record<string, unknown> = {
    id: row.id,
    boardId: row.board_id,
    type: row.type,
    title: row.title,
    color: row.color,
    position: { x: row.x, y: row.y },
    labels,
    note: row.note,
    data: JSON.parse(row.data_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.width !== null && row.height !== null) {
    node.size = { width: row.width, height: row.height };
  }
  // `skip_serializing_if = "Option::is_none"` plus `(collapsed != 0).then_some(true)`:
  // a collapsed node carries `true`, an expanded one carries no key at all.
  if (Number(row.collapsed) !== 0) node.collapsed = true;
  if (row.expanded_height !== null) node.expandedHeight = row.expanded_height;
  if (row.parent_id !== null) node.parentId = row.parent_id;
  return orderNode(node);
}

/**
 * `data_json`, spelled the way `serde_json` spells it.
 *
 * A node's `data` is an opaque payload, and the Rust Runtime stored it through
 * `serde_json::Value` — whose object is a `BTreeMap`, so every key came back
 * **sorted**. Nothing reads `data` positionally, but the two implementations
 * write into the same column of the same file, and a board saved by one and
 * read by the other should come back byte for byte. Sorting here is what makes
 * that true, and what makes a diff of the two answers empty rather than
 * "identical except for key order".
 *
 * Sorted by UTF-16 code unit, which is the same order as `BTreeMap<String>`'s
 * UTF-8 byte order for every key below U+10000 — and a node payload key
 * outside the BMP is not a thing that exists.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    ordered[key] = canonical(source[key]);
  }
  return ordered;
}

/** Serde emits the struct's field order; a byte diff against Rust wants it. */
function orderNode(node: Record<string, unknown>): CanvasNode {
  const ordered: Record<string, unknown> = {};
  for (const key of [
    "id",
    "boardId",
    "type",
    "title",
    "color",
    "position",
    "size",
    "collapsed",
    "expandedHeight",
    "parentId",
    "labels",
    "note",
    "data",
    "createdAt",
    "updatedAt",
  ]) {
    if (key in node) ordered[key] = node[key];
  }
  return ordered as unknown as CanvasNode;
}

/**
 * The whole document, written under the caller's revision.
 *
 * Everything happens in one `BEGIN IMMEDIATE`: the CAS, the deletes, the
 * orphan cleanup and the upserts. A save that fails part way takes the
 * cleanup back with it — a node that still exists must never be missing its
 * status.
 *
 * 实时板（契约 §16.2）：带 `clientId` 的写（HTTP 那条路，旧页面）一律 409
 * `realtime_active`；core 自己的写者交给实时挂点，经文档写入；没有挂点也拒。
 */
export function saveBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
  request: SaveBoardRequest,
): BoardDocument {
  const board = getBoard(database, workspaceId, boardId);
  if (isRealtimeBoard(database, board.id)) {
    const hooks = realtimeHooks.get(database);
    if (request.clientId !== undefined || hooks === undefined) {
      throw realtimeActive();
    }
    return hooks.save(database, workspaceId, boardId, request);
  }
  validateDocument(board.id, request.nodes, request.edges);
  validateViewport(request.viewport);
  let whiteboard = board.whiteboard;
  if (request.whiteboard !== undefined) {
    validateWhiteboard(request.whiteboard);
    whiteboard = request.whiteboard;
  }
  writeDocument(database, board, {
    expectedUpdatedAt: request.expectedUpdatedAt,
    nodes: request.nodes,
    edges: request.edges,
    viewportJson: JSON.stringify({
      x: request.viewport.x,
      y: request.viewport.y,
      zoom: request.viewport.zoom,
    }),
    whiteboard,
  });
  return readBoard(database, workspaceId, boardId);
}

/**
 * 物化入口：把实时板文档的投影写进表（补全架构 §6.3）。
 *
 * 只给 `core/realtime` 用。与 `saveBoard` 同一套校验与差异写入，区别只有两处：
 * 没有调用方的修订号可比（文档就是真相，CAS 比的是此刻表里的那一份），视口
 * 不进文档，所以原样保留。
 */
export function materializeBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
  projection: {
    readonly nodes: readonly CanvasNode[];
    readonly edges: readonly CanvasEdge[];
    readonly whiteboard: string;
  },
): BoardDocument {
  const board = getBoard(database, workspaceId, boardId);
  validateDocument(board.id, projection.nodes, projection.edges);
  validateWhiteboard(projection.whiteboard);
  writeDocument(database, board, {
    expectedUpdatedAt: board.updatedAt,
    nodes: projection.nodes,
    edges: projection.edges,
    viewportJson: JSON.stringify(board.viewport),
    whiteboard: projection.whiteboard,
  });
  return readBoard(database, workspaceId, boardId);
}

interface DocumentWrite {
  readonly expectedUpdatedAt: string;
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  readonly viewportJson: string;
  readonly whiteboard: string;
}

function writeDocument(
  database: DatabaseSync,
  board: Board,
  request: DocumentWrite,
): void {
  const viewportJson = request.viewportJson;
  const whiteboard = request.whiteboard;
  database.exec("BEGIN IMMEDIATE");
  try {
    const nextUpdatedAt = rfc3339();
    const updated = database
      .prepare(
        "UPDATE boards SET updated_at = ?, viewport_json = ?, whiteboard_json = ? " +
          "WHERE id = ? AND updated_at = ?",
      )
      .run(
        nextUpdatedAt,
        viewportJson,
        whiteboard,
        board.id,
        request.expectedUpdatedAt,
      );
    if (updated.changes !== 1) {
      throw conflict("Board changed since it was loaded; reload before saving");
    }

    const storedEdges = database
      .prepare("SELECT id, role FROM edges WHERE board_id = ?")
      .all(board.id) as unknown as { id: string; role: string }[];
    const storedEdgeIds = storedEdges.map((row) => row.id);
    // 一条边送上来时**没有** `role`，意思是「这一项我没有意见」，不是「把它
    // 设回对等」。每一个还不认识这个字段的写者——一张旧的画布文档、一个还没
    // 跟上的页面——否则都会在一次无关的保存里悄悄把主从关系抹平。同一条规矩
    // 白板快照已经在用（省略即保留）。
    const storedRoles = new Map(
      storedEdges.map((row) => [row.id, row.role] as const),
    );
    const storedNodeIds = (
      database
        .prepare("SELECT id FROM nodes WHERE board_id = ?")
        .all(board.id) as unknown as { id: string }[]
    ).map((row) => row.id);
    const keptEdgeIds = new Set(request.edges.map((edge) => edge.id));
    const keptNodeIds = new Set(request.nodes.map((node) => node.id));

    // Edges first: an edge the document dropped may point at a node it also
    // dropped, and `edges` is `ON DELETE CASCADE` on `nodes` too. Every edge
    // that stays has both endpoints in `request.nodes` (`validateDocument`),
    // so nothing surviving the node deletes is left dangling.
    const deleteEdge = database.prepare("DELETE FROM edges WHERE id = ?");
    for (const id of storedEdgeIds) {
      if (!keptEdgeIds.has(id)) deleteEdge.run(id);
    }
    const droppedNodeIds = storedNodeIds.filter((id) => !keptNodeIds.has(id));
    const deleteNode = database.prepare("DELETE FROM nodes WHERE id = ?");
    for (const id of droppedNodeIds) deleteNode.run(id);
    forgetNodes(database, droppedNodeIds);

    // The `WHERE` guard keeps an id owned by another board from being moved
    // onto this one: a plain INSERT would fail on the primary key, and
    // silently stealing the row would be worse than either.
    const upsertNode = database.prepare(
      "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, collapsed, " +
        "expanded_height, parent_id, labels_json, note, data_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET " +
        "type = excluded.type, title = excluded.title, color = excluded.color, " +
        "x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height, " +
        "collapsed = excluded.collapsed, expanded_height = excluded.expanded_height, " +
        "parent_id = excluded.parent_id, labels_json = excluded.labels_json, " +
        "note = excluded.note, data_json = excluded.data_json, " +
        "created_at = excluded.created_at, updated_at = excluded.updated_at " +
        "WHERE nodes.board_id = excluded.board_id",
    );
    for (const node of request.nodes) {
      const written = upsertNode.run(
        node.id,
        node.boardId,
        node.type,
        node.title,
        node.color,
        node.position.x,
        node.position.y,
        node.size?.width ?? null,
        node.size?.height ?? null,
        node.collapsed === true ? 1 : 0,
        node.expandedHeight ?? null,
        node.parentId ?? null,
        JSON.stringify(node.labels),
        node.note,
        canonicalJson(node.data),
        node.createdAt,
        node.updatedAt,
      );
      if (written.changes !== 1) {
        throw badRequest("Board contains a node that belongs to another board");
      }
    }
    const upsertEdge = database.prepare(
      "INSERT INTO edges (id, board_id, source_node_id, target_node_id, kind, role, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET " +
        "source_node_id = excluded.source_node_id, " +
        "target_node_id = excluded.target_node_id, kind = excluded.kind, " +
        "role = excluded.role, " +
        "created_at = excluded.created_at, updated_at = excluded.updated_at " +
        "WHERE edges.board_id = excluded.board_id",
    );
    for (const edge of request.edges) {
      const written = upsertEdge.run(
        edge.id,
        edge.boardId,
        edge.source,
        edge.target,
        edge.kind,
        edge.role ?? storedRoles.get(edge.id) ?? "peer",
        edge.createdAt,
        edge.updatedAt,
      );
      if (written.changes !== 1) {
        throw badRequest(
          "Board contains an edge that belongs to another board",
        );
      }
    }
    // Agent 的名字（`docs/design/agent-delivery.md` §2.5）：`node_handles` 是
    // 唯一来源，`data.handle` 是它的渲染副本，两者只有这一个写入点，所以不会
    // 各自漂移。撞名在这里被拒绝——事务回滚，整次保存不落库。
    syncHandles(database, board.id, request.nodes);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export type { BoardDocument, CanvasEdge, CanvasNode, SaveBoardRequest };
