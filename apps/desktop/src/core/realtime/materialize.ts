/**
 * 文档 → 表（补全架构 §6.3「物化」）。
 *
 * 表是缓存：`nodes` / `edges` / `whiteboard_json` 由文档的投影整份对出来，
 * 经 `canvas/documents.materializeBoard`——与 `saveBoard` 同一套校验、差异写
 * 入与名字对账，不另写一条写表的路。
 *
 * 文档里可能有表放不下的东西：一个页面送来的节点缺字段、两个人同时给两个节点
 * 起了同一个名字、一个 id 已经被别的板占了。CRDT 没有「拒绝这次更新」这一步，
 * 所以物化前先**清理文档**（{@link sanitizeDoc}）：以 `origin: "core"` 的事务
 * 删掉放不下的节点与边、清掉越界的 `parentId` 与撞名的 `data.handle`。清理本身
 * 也是一条更新，会同步给每个客户端，于是文档与表始终一致。
 */

import type { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";

import {
  canonicalJson,
  materializeBoard,
  readBoard,
} from "../canvas/documents";
import type {
  BoardDocument,
  CanvasEdge,
  CanvasNode,
} from "../canvas/document-types";
import { handleOfNode, syncHandles } from "../canvas/handles";
import { validateDocument, validateWhiteboard } from "../canvas/validation";
import { badRequest } from "../workspaces/support";
import {
  type BoardProjection,
  edgesOf,
  normalizeWhiteboard,
  nodesOf,
  projectDoc,
} from "./doc";

/** core 自己的事务用的 origin（拦截、清理、种子）。 */
export const CORE_ORIGIN = "core";

/**
 * 把文档里表放不下的东西清掉，返回清了几处。没有要清的就不开事务、不产生
 * 更新。
 */
export function sanitizeDoc(
  doc: Y.Doc,
  boardId: string,
  database: DatabaseSync,
): number {
  const projection = projectDoc(doc, boardId);
  const foreignNodes = foreignIds(database, "nodes", boardId, projection.nodes);
  const foreignEdges = foreignIds(database, "edges", boardId, projection.edges);
  const dropNodes = new Set<string>();
  for (const node of projection.nodes) {
    if (foreignNodes.has(node.id) || !nodeValid(boardId, node)) {
      dropNodes.add(node.id);
    }
  }
  const kept = projection.nodes.filter((node) => !dropNodes.has(node.id));
  const keptIds = new Set(kept.map((node) => node.id));
  const groups = new Set(
    kept.filter((node) => node.type === "group").map((node) => node.id),
  );
  const clearParent = kept
    .filter(
      (node) =>
        node.parentId !== undefined &&
        (node.parentId === node.id || !groups.has(node.parentId)),
    )
    .map((node) => node.id);
  const taken = new Set<string>();
  const clearHandle: string[] = [];
  for (const node of kept) {
    const handle = handleOfNode(node);
    if (handle === undefined) continue;
    if (taken.has(handle)) clearHandle.push(node.id);
    else taken.add(handle);
  }
  const dropEdges = projection.edges
    .filter(
      (edge) =>
        foreignEdges.has(edge.id) ||
        !keptIds.has(edge.source) ||
        !keptIds.has(edge.target) ||
        !edgeValid(boardId, edge, keptIds),
    )
    .map((edge) => edge.id);
  const fixes =
    dropNodes.size + clearParent.length + clearHandle.length + dropEdges.length;
  if (fixes === 0) return 0;
  doc.transact(() => {
    const nodes = nodesOf(doc);
    for (const id of dropNodes) nodes.delete(id);
    for (const id of clearParent) nodes.get(id)?.delete("parentId");
    for (const id of clearHandle) {
      const map = nodes.get(id);
      const data = map?.get("data");
      if (map === undefined || data === null || typeof data !== "object") {
        continue;
      }
      const { handle: _handle, ...rest } = data as Record<string, unknown>;
      map.set("data", rest);
    }
    const edges = edgesOf(doc);
    for (const id of dropEdges) edges.delete(id);
  }, CORE_ORIGIN);
  return fixes;
}

function nodeValid(boardId: string, node: CanvasNode): boolean {
  // 父子关系另判（清掉 `parentId` 而不是删节点），这里只看节点自己。
  const { parentId: _parentId, ...alone } = node;
  try {
    validateDocument(boardId, [alone as CanvasNode], []);
    return true;
  } catch {
    return false;
  }
}

function edgeValid(
  boardId: string,
  edge: CanvasEdge,
  nodeIds: ReadonlySet<string>,
): boolean {
  return (
    nodeIds.has(edge.source) &&
    nodeIds.has(edge.target) &&
    edgeShapeValid(boardId, edge)
  );
}

/** 悬挂之外的边校验：形状、种类、角色。 */
function edgeShapeValid(boardId: string, edge: CanvasEdge): boolean {
  const stub = (id: string): CanvasNode =>
    ({
      id,
      boardId,
      type: "group",
      title: "x",
      color: "#000000",
      position: { x: 0, y: 0 },
      labels: [],
      note: "",
      data: { kind: "group" },
      createdAt: edge.createdAt,
      updatedAt: edge.updatedAt,
    }) as CanvasNode;
  try {
    validateDocument(boardId, [stub(edge.source), stub(edge.target)], [edge]);
    return true;
  } catch {
    return false;
  }
}

function foreignIds(
  database: DatabaseSync,
  table: "nodes" | "edges",
  boardId: string,
  entries: readonly { readonly id: string }[],
): Set<string> {
  const out = new Set<string>();
  if (entries.length === 0) return out;
  const query = database.prepare(`SELECT board_id FROM ${table} WHERE id = ?`);
  for (const entry of entries) {
    const row = query.get(entry.id) as { board_id: string } | undefined;
    if (row !== undefined && row.board_id !== boardId) out.add(entry.id);
  }
  return out;
}

/**
 * 一份投影能不能原样落表：与 `saveBoard` 同样的拒绝（校验、跨板 id、撞名）。
 * 拦截在写进文档之前用它，core 写者因此拿到与非实时板一样的错误。撞名用真的
 * `syncHandles` 在一个保存点里试跑再回滚，错误文案与非实时板逐字相同。
 */
export function checkProjection(
  database: DatabaseSync,
  boardId: string,
  projection: BoardProjection,
): void {
  validateDocument(boardId, projection.nodes, projection.edges);
  validateWhiteboard(projection.whiteboard);
  if (foreignIds(database, "nodes", boardId, projection.nodes).size > 0) {
    throw badRequest("Board contains a node that belongs to another board");
  }
  if (foreignIds(database, "edges", boardId, projection.edges).size > 0) {
    throw badRequest("Board contains an edge that belongs to another board");
  }
  database.exec("SAVEPOINT realtime_check");
  try {
    syncHandles(database, boardId, projection.nodes);
  } finally {
    database.exec("ROLLBACK TO realtime_check");
    database.exec("RELEASE realtime_check");
  }
}

/** 表里那一份与投影是不是同一份（逐字段，白板按物化后的形状比）。 */
export function sameAsTables(
  stored: BoardDocument,
  projection: BoardProjection,
): boolean {
  if (
    normalizeWhiteboard(stored.board.whiteboard) !==
    normalizeWhiteboard(projection.whiteboard)
  ) {
    return false;
  }
  if (stored.nodes.length !== projection.nodes.length) return false;
  if (stored.edges.length !== projection.edges.length) return false;
  const nodes = new Map(stored.nodes.map((node) => [node.id, node] as const));
  for (const node of projection.nodes) {
    const other = nodes.get(node.id);
    if (other === undefined) return false;
    if (
      canonicalJson(comparableNode(other)) !==
      canonicalJson(comparableNode(node))
    ) {
      return false;
    }
  }
  const edges = new Map(stored.edges.map((edge) => [edge.id, edge] as const));
  for (const edge of projection.edges) {
    const other = edges.get(edge.id);
    if (other === undefined) return false;
    // 省略 `role` = 保留表里的那一个（`saveBoard` 的规矩）。
    const role = edge.role ?? other.role;
    if (
      canonicalJson({ ...edge, role }) !==
      canonicalJson({ ...other, role: other.role })
    ) {
      return false;
    }
  }
  return true;
}

/** 表读回的节点没有 `collapsed: false`，投影里可能有：比之前抹平。 */
function comparableNode(node: CanvasNode): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node };
  if (out.collapsed !== true) delete out.collapsed;
  return out;
}

export interface MaterializeResult {
  readonly document: BoardDocument;
  /** 表真的变了（`updated_at` 前进了）。 */
  readonly changed: boolean;
}

/**
 * 物化一次：投影与表不同才写；写不写都返回表里的当前一份。调用方负责先
 * {@link sanitizeDoc}、事后记 `materialized_seq`。
 */
export function materialize(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
  doc: Y.Doc,
): MaterializeResult {
  const projection = projectDoc(doc, boardId);
  const stored = readBoard(database, workspaceId, boardId);
  if (sameAsTables(stored, projection)) {
    return { document: stored, changed: false };
  }
  return {
    document: materializeBoard(database, workspaceId, boardId, projection),
    changed: true,
  };
}
