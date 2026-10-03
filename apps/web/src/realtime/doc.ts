import * as Y from "yjs";
import {
  canvasEdgeSchema,
  canvasNodeSchema,
  type CanvasEdge,
  type CanvasNode,
} from "@armadra/shared";

import { adoptList } from "../canvas/sync/merge";
import {
  emptyWhiteboard,
  itemSchema,
  referenceSchema,
  whiteboardLegacySchema,
  type Item,
  type Reference,
  type WhiteboardDoc,
} from "../canvas/whiteboard/model";

/**
 * 一块板的 `Y.Doc` 在页面这一侧的读写（契约 §16.1 的文档结构，补全架构
 * §6.2）。core 的 `core/realtime/doc.ts` 是同一份结构的另一半——core 不依赖
 * 共享包、页面也不能 import core，所以两边各写一份，键名与取值规则以契约
 * 为准：
 *
 *   * `nodes: Y.Map<nodeId, Y.Map>`：字段与 `CanvasNode` 同名、按字段 LWW；
 *     `data.content` 是字符串时放在键 `content` 的 `Y.Text` 里。
 *   * `edges: Y.Map<edgeId, JSON>`：整条 LWW，不带 `id` / `boardId`。
 *   * `whiteboard` / `whiteboardRefs: Y.Map<id, string>`：每项一条 JSON 串。
 *   * `meta.whiteboardEnvelope`：白板去掉两个数组之后的外壳（JSON 串）。
 *
 * 写入按**实体身份**比：store 的每个动作都造新对象，没动过的仍是同一个引用，
 * 所以一次编辑只写它碰过的那几条，成本与改动条数成正比。
 */

export const NODE_FIELDS = [
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
] as const;

type NodeField = (typeof NODE_FIELDS)[number];

const CONTENT = "content";
const ENVELOPE = "whiteboardEnvelope";

export function nodesOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap("nodes");
}
export function edgesOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("edges");
}
export function itemsOf(doc: Y.Doc): Y.Map<string> {
  return doc.getMap("whiteboard");
}
export function referencesOf(doc: Y.Doc): Y.Map<string> {
  return doc.getMap("whiteboardRefs");
}
export function metaOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("meta");
}

/** 撤销管理器要盯的全部根类型（节点、连线、白板同一个栈，§6.4）。 */
export function rootsOf(doc: Y.Doc): Y.AbstractType<unknown>[] {
  return [
    nodesOf(doc),
    edgesOf(doc),
    itemsOf(doc),
    referencesOf(doc),
    metaOf(doc),
  ] as Y.AbstractType<unknown>[];
}

/* -------------------------------- 规范化 --------------------------------- */

/** 键序无关的 JSON，比较「是不是同一个值」用。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "undefined";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) out[key] = sortKeys(source[key]);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------ 本地 → 文档 ------------------------------ */

/** 参与同步的那几张表，取自 store。 */
export interface LocalSnapshot {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  readonly whiteboard: WhiteboardDoc;
}

/**
 * 把 `before → after` 的改动以一次事务写进文档。只看对象身份变了的实体；
 * 文档里已经没有的节点 / 边不复活（别人刚删了：删除优先）。
 */
export function writeLocal(
  doc: Y.Doc,
  before: LocalSnapshot,
  after: LocalSnapshot,
  origin: unknown,
): boolean {
  let wrote = false;
  doc.transact(() => {
    if (before.nodes !== after.nodes) {
      wrote = writeNodes(doc, before.nodes, after.nodes) || wrote;
    }
    if (before.edges !== after.edges) {
      wrote = writeEdges(doc, before.edges, after.edges) || wrote;
    }
    if (before.whiteboard !== after.whiteboard) {
      wrote =
        writeWhiteboard(doc, before.whiteboard, after.whiteboard) || wrote;
    }
  }, origin);
  return wrote;
}

function indexById<T extends { id: string }>(
  list: readonly T[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const entity of list) map.set(entity.id, entity);
  return map;
}

function fieldOf(node: CanvasNode, field: NodeField): unknown {
  const value = (node as unknown as Record<string, unknown>)[field];
  if (
    field === "data" &&
    isRecord(value) &&
    typeof value.content === "string"
  ) {
    const { content: _content, ...rest } = value;
    return rest;
  }
  return value;
}

function contentOf(node: CanvasNode): string | undefined {
  const data = node.data as unknown;
  return isRecord(data) && typeof data.content === "string"
    ? data.content
    : undefined;
}

function nodeMap(node: CanvasNode): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const field of NODE_FIELDS) {
    const value = fieldOf(node, field);
    if (value !== undefined) map.set(field, clone(value));
  }
  const content = contentOf(node);
  if (content !== undefined) map.set(CONTENT, new Y.Text(content));
  return map;
}

function writeNodes(
  doc: Y.Doc,
  before: readonly CanvasNode[],
  after: readonly CanvasNode[],
): boolean {
  const nodes = nodesOf(doc);
  const from = indexById(before);
  const to = indexById(after);
  let wrote = false;
  for (const id of from.keys()) {
    if (!to.has(id) && nodes.has(id)) {
      nodes.delete(id);
      wrote = true;
    }
  }
  for (const [id, node] of to) {
    const previous = from.get(id);
    if (previous === node) continue;
    const existing = nodes.get(id);
    if (!(existing instanceof Y.Map)) {
      if (previous !== undefined) continue; // 别人删了：删除优先
      nodes.set(id, nodeMap(node));
      wrote = true;
      continue;
    }
    for (const field of NODE_FIELDS) {
      const want = fieldOf(node, field);
      const had =
        previous === undefined ? existing.get(field) : fieldOf(previous, field);
      if (stableJson(want) === stableJson(had)) continue;
      if (want === undefined) existing.delete(field);
      else existing.set(field, clone(want));
      wrote = true;
    }
    const wantText = contentOf(node);
    const hadText = previous === undefined ? undefined : contentOf(previous);
    if (previous === undefined || wantText !== hadText) {
      wrote = writeContent(existing, hadText, wantText) || wrote;
    }
  }
  return wrote;
}

/**
 * 便签正文：按「上一份 → 这一份」的公共前后缀算出这次改了哪一段，落到
 * `Y.Text` 的同一位置。文档里的文本与上一份不同（手势中攒着没灌的远端改动）
 * 时退回「当前文本 → 目标文本」的最小改动。
 */
function writeContent(
  map: Y.Map<unknown>,
  had: string | undefined,
  want: string | undefined,
): boolean {
  const current = map.get(CONTENT);
  if (want === undefined) {
    if (current === undefined) return false;
    map.delete(CONTENT);
    return true;
  }
  if (!(current instanceof Y.Text)) {
    map.set(CONTENT, new Y.Text(want));
    return true;
  }
  const base = had !== undefined && current.toString() === had ? had : null;
  return spliceText(current, base ?? current.toString(), want);
}

/** 公共前后缀之外的那一段换掉；返回是否真的写了。 */
export function spliceText(text: Y.Text, have: string, want: string): boolean {
  if (have === want) return false;
  let start = 0;
  const limit = Math.min(have.length, want.length);
  while (start < limit && have[start] === want[start]) start += 1;
  let end = 0;
  while (
    end < limit - start &&
    have[have.length - 1 - end] === want[want.length - 1 - end]
  ) {
    end += 1;
  }
  const removed = have.length - start - end;
  const inserted = want.slice(start, want.length - end);
  if (removed > 0) text.delete(start, removed);
  if (inserted !== "") text.insert(start, inserted);
  return true;
}

function edgeValue(edge: CanvasEdge): Record<string, unknown> {
  const value: Record<string, unknown> = {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
  };
  if (edge.role !== undefined) value.role = edge.role;
  value.createdAt = edge.createdAt;
  value.updatedAt = edge.updatedAt;
  return value;
}

function writeEdges(
  doc: Y.Doc,
  before: readonly CanvasEdge[],
  after: readonly CanvasEdge[],
): boolean {
  const edges = edgesOf(doc);
  const from = indexById(before);
  const to = indexById(after);
  let wrote = false;
  for (const id of from.keys()) {
    if (!to.has(id) && edges.has(id)) {
      edges.delete(id);
      wrote = true;
    }
  }
  for (const [id, edge] of to) {
    const previous = from.get(id);
    if (previous === edge) continue;
    if (previous !== undefined && !edges.has(id)) continue;
    const value = edgeValue(edge);
    if (stableJson(edges.get(id)) === stableJson(value)) continue;
    edges.set(id, value);
    wrote = true;
  }
  return wrote;
}

function writeStrings<T extends { id: string }>(
  map: Y.Map<string>,
  before: readonly T[],
  after: readonly T[],
): boolean {
  if (before === after) return false;
  const from = indexById(before);
  const to = indexById(after);
  let wrote = false;
  for (const id of from.keys()) {
    if (!to.has(id) && map.has(id)) {
      map.delete(id);
      wrote = true;
    }
  }
  for (const [id, entity] of to) {
    const previous = from.get(id);
    if (previous === entity) continue;
    if (previous !== undefined && !map.has(id)) continue;
    const json = JSON.stringify(entity);
    if (map.get(id) === json) continue;
    map.set(id, json);
    wrote = true;
  }
  return wrote;
}

function envelopeOf(whiteboard: WhiteboardDoc): Record<string, unknown> {
  const { items: _items, references: _references, ...rest } = whiteboard;
  return rest;
}

function writeWhiteboard(
  doc: Y.Doc,
  before: WhiteboardDoc,
  after: WhiteboardDoc,
): boolean {
  let wrote = writeStrings(itemsOf(doc), before.items, after.items);
  wrote =
    writeStrings(referencesOf(doc), before.references, after.references) ||
    wrote;
  const envelope = envelopeOf(after);
  const meta = metaOf(doc);
  const current = meta.get(ENVELOPE);
  const parsed = typeof current === "string" ? parseJson(current) : undefined;
  if (stableJson(parsed) !== stableJson(envelope)) {
    // 只在外壳真的变了（或文档还没有外壳而这边有白板内容）时写。
    if (
      stableJson(envelopeOf(before)) !== stableJson(envelope) ||
      (parsed === undefined &&
        (after.items.length > 0 || after.references.length > 0))
    ) {
      meta.set(ENVELOPE, JSON.stringify(envelope));
      wrote = true;
    }
  }
  return wrote;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/* ------------------------------ 文档 → 本地 ------------------------------ */

/** 文档投影成 store 的形状；与 `local` 内容相同的实体沿用 `local` 的对象。 */
export interface RemoteState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  whiteboard: WhiteboardDoc;
}

/**
 * 读出整份文档。逐条校验：校验不过的节点 / 边 / 白板项不进 store（core 物化
 * 前会把它们从文档里清掉，§16.2「清理」），一条坏数据不拖垮整块画布。
 */
export function readRemote(
  doc: Y.Doc,
  boardId: string,
  local: LocalSnapshot,
): RemoteState {
  return {
    nodes: readNodes(doc, boardId, local.nodes),
    edges: readEdges(doc, boardId, local.edges),
    whiteboard: readWhiteboard(doc, local.whiteboard),
  };
}

function byCreated(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  return compare(a.createdAt, b.createdAt) || compare(a.id, b.id);
}

/**
 * `Y.Map` 没有顺序：已经在本地的那些保持本地的顺序（React Flow 按数组画，
 * 换顺序就是一次白重渲），新来的按 `order` 排在后面。
 */
function orderLike<T extends { id: string }>(
  local: readonly T[],
  next: T[],
  order: (a: T, b: T) => number,
): T[] {
  const byId = indexById(next);
  const out: T[] = [];
  for (const entity of local) {
    const found = byId.get(entity.id);
    if (found === undefined) continue;
    out.push(found);
    byId.delete(entity.id);
  }
  return [...out, ...[...byId.values()].sort(order)];
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function readNodes(
  doc: Y.Doc,
  boardId: string,
  local: readonly CanvasNode[],
): CanvasNode[] {
  const known = indexById(local);
  const out: CanvasNode[] = [];
  nodesOf(doc).forEach((map, id) => {
    if (!(map instanceof Y.Map)) return;
    const raw: Record<string, unknown> = { id, boardId };
    for (const field of NODE_FIELDS) {
      if (!map.has(field)) continue;
      const value = map.get(field);
      if (value !== undefined) raw[field] = clone(value);
    }
    const content = map.get(CONTENT);
    if (content instanceof Y.Text) {
      raw.data = {
        ...(isRecord(raw.data) ? raw.data : {}),
        content: content.toString(),
      };
    }
    const existing = known.get(id);
    if (existing && sameJson(existing, raw)) {
      out.push(existing);
      return;
    }
    const parsed = canvasNodeSchema.safeParse(raw);
    if (!parsed.success) return;
    out.push(
      existing && sameJson(existing, parsed.data) ? existing : parsed.data,
    );
  });
  return adoptList(local as CanvasNode[], orderLike(local, out, byCreated));
}

function readEdges(
  doc: Y.Doc,
  boardId: string,
  local: readonly CanvasEdge[],
): CanvasEdge[] {
  const known = indexById(local);
  const out: CanvasEdge[] = [];
  edgesOf(doc).forEach((value, id) => {
    if (!isRecord(value)) return;
    const raw = { ...clone(value), id, boardId };
    const existing = known.get(id);
    if (existing && sameJson(existing, raw)) {
      out.push(existing);
      return;
    }
    const parsed = canvasEdgeSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  });
  return adoptList(local as CanvasEdge[], orderLike(local, out, byCreated));
}

function readEntries<T extends { id: string }>(
  map: Y.Map<string>,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  local: readonly T[],
): T[] {
  const known = indexById(local);
  const out: T[] = [];
  map.forEach((json, id) => {
    const value = parseJson(json);
    const existing = known.get(id);
    if (existing && sameJson(existing, value)) {
      out.push(existing);
      return;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success && parsed.data && parsed.data.id === id) {
      out.push(parsed.data);
    }
  });
  return out;
}

function readWhiteboard(doc: Y.Doc, local: WhiteboardDoc): WhiteboardDoc {
  const items = orderLike(
    local.items,
    readEntries<Item>(itemsOf(doc), itemSchema, local.items),
    (a, b) => a.z - b.z || compare(a.id, b.id),
  );
  const references = orderLike(
    local.references,
    readEntries<Reference>(
      referencesOf(doc),
      referenceSchema,
      local.references,
    ),
    (a, b) => compare(a.id, b.id),
  );
  const envelope = metaOf(doc).get(ENVELOPE);
  const parsed = typeof envelope === "string" ? parseJson(envelope) : undefined;
  const legacy = isRecord(parsed)
    ? whiteboardLegacySchema.safeParse(parsed.legacy)
    : undefined;
  const nextItems = adoptList(local.items, items);
  const nextReferences = adoptList(local.references, references);
  const nextLegacy =
    legacy?.success && legacy.data !== undefined ? legacy.data : undefined;
  if (
    nextItems === local.items &&
    nextReferences === local.references &&
    sameJson(nextLegacy ?? null, local.legacy ?? null)
  ) {
    return local;
  }
  const base = emptyWhiteboard();
  return {
    ...base,
    items: nextItems,
    references: nextReferences,
    ...(nextLegacy === undefined ? {} : { legacy: nextLegacy }),
  };
}

/* ------------------------------- 正文变基 -------------------------------- */

interface TextEdit {
  start: number;
  removed: number;
  inserted: string;
}

function textEdit(have: string, want: string): TextEdit {
  let start = 0;
  const limit = Math.min(have.length, want.length);
  while (start < limit && have[start] === want[start]) start += 1;
  let end = 0;
  while (
    end < limit - start &&
    have[have.length - 1 - end] === want[want.length - 1 - end]
  ) {
    end += 1;
  }
  return {
    start,
    removed: have.length - start - end,
    inserted: want.slice(start, want.length - end),
  };
}

/**
 * 编辑框里的草稿是相对 `base`（开始编辑那一刻的正文）写的；这期间别人把正文
 * 改成了 `theirs`。把「我这次改的那一段」落到 `theirs` 上：两段不重叠时两边
 * 的字都留下（两个人同时往同一张便签里打字），重叠时以我的为准。
 */
export function rebaseText(base: string, mine: string, theirs: string): string {
  if (theirs === base || mine === theirs) return mine;
  if (mine === base) return theirs;
  const my = textEdit(base, mine);
  const their = textEdit(base, theirs);
  const myEnd = my.start + my.removed;
  const theirEnd = their.start + their.removed;
  let start: number;
  if (myEnd <= their.start) {
    start = my.start;
  } else if (my.start >= theirEnd) {
    start = my.start + their.inserted.length - their.removed;
  } else {
    return mine;
  }
  return (
    theirs.slice(0, start) + my.inserted + theirs.slice(start + my.removed)
  );
}
