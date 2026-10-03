/**
 * 一块板的 `Y.Doc`：结构、投影（文档 → 表的形状）与按差异写入（补全架构
 * §6.2，契约 §16.1）。
 *
 * 结构：
 *
 *   * `nodes: Y.Map<nodeId, Y.Map>`——每个节点一张 `Y.Map`，字段与
 *     `CanvasNode` 同名（`type / title / color / position / size / collapsed /
 *     expandedHeight / parentId / labels / note / data / createdAt /
 *     updatedAt`），值是 JSON，按字段 LWW。`data.content` 是字符串时（便签
 *     正文）单独放在 `content: Y.Text` 里，`data` 里不再带它，所以两个人可以
 *     同时往同一张便签里打字。
 *   * `edges: Y.Map<edgeId, JSON>`——整条边一个值（不带 `boardId`）。
 *   * `whiteboard: Y.Map<itemId, string>`、`whiteboardRefs: Y.Map<refId,
 *     string>`——每个白板 item / 引用一条不透明 JSON 串，按 item 粒度 LWW。
 *     core 只认外壳（`items` / `references` 两个数组、每项有字符串 `id`），
 *     不解析 item 内容。
 *   * `meta: Y.Map`——`whiteboardEnvelope`：白板 JSON 去掉两个数组之后的外壳
 *     （`engine`、`version`……）；`whiteboardRaw`：认不出外壳的白板原文，原样
 *     保留。视口不进文档。
 *
 * 这里全是纯函数（只碰 `Y.Doc`，不碰库），物化与拦截都建在它上面。
 */

import * as Y from "yjs";

import type { CanvasEdge, CanvasNode } from "../canvas/document-types";

/** 文档投影：物化进表的就是它。 */
export interface BoardProjection {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  /** `boards.whiteboard_json` 的值；`""` = 没有白板。 */
  readonly whiteboard: string;
}

export const EMPTY_PROJECTION: BoardProjection = {
  nodes: [],
  edges: [],
  whiteboard: "",
};

/** 节点上按字段 LWW 的那些键，也是投影里节点字段的顺序。 */
const NODE_FIELDS = [
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
const RAW = "whiteboardRaw";

export function nodesOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap("nodes");
}

export function edgesOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("edges");
}

export function whiteboardOf(doc: Y.Doc): Y.Map<string> {
  return doc.getMap("whiteboard");
}

export function whiteboardRefsOf(doc: Y.Doc): Y.Map<string> {
  return doc.getMap("whiteboardRefs");
}

export function metaOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("meta");
}

/* ------------------------------- 规范化 ---------------------------------- */

/** 键排序后的 JSON：比较两个值是否相同用它，与 `canonicalJson` 同一规则。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "undefined";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort())
    out[key] = sortKeys(source[key]);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/* ------------------------------- 白板外壳 -------------------------------- */

export interface WhiteboardParts {
  /** 去掉 `items` / `references` 之后的外壳；`undefined` = 没有可认的外壳。 */
  readonly envelope?: Record<string, unknown>;
  /** 认不出外壳时的原文（非空串）。 */
  readonly raw?: string;
  readonly items: ReadonlyMap<string, string>;
  readonly references: ReadonlyMap<string, string>;
}

const NO_PARTS: WhiteboardParts = { items: new Map(), references: new Map() };

/**
 * 白板 JSON 拆成外壳与逐项。认不出（不是对象、缺数组、某项没有字符串
 * `id`、id 重复）就整份当原文——core 不替页面判格式。
 */
export function splitWhiteboard(text: string): WhiteboardParts {
  if (text === "") return NO_PARTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...NO_PARTS, raw: text };
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.items) ||
    !Array.isArray(parsed.references)
  ) {
    return { ...NO_PARTS, raw: text };
  }
  const items = byId(parsed.items);
  const references = byId(parsed.references);
  if (items === undefined || references === undefined) {
    return { ...NO_PARTS, raw: text };
  }
  const envelope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "items" && key !== "references") envelope[key] = value;
  }
  return { envelope, items, references };
}

function byId(entries: unknown[]): Map<string, string> | undefined {
  const out = new Map<string, string>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") {
      return undefined;
    }
    if (out.has(entry.id)) return undefined;
    out.set(entry.id, JSON.stringify(entry));
  }
  return out;
}

/**
 * 外壳与逐项拼回白板 JSON。item 按 `z` 再按 id 排、引用按 id 排：`Y.Map` 没有
 * 顺序，排序是物化结果确定的唯一办法（页面按 `z` 画，数组顺序不承载语义）。
 */
export function composeWhiteboard(parts: WhiteboardParts): string {
  if (parts.envelope === undefined) {
    if (parts.raw !== undefined) return parts.raw;
    if (parts.items.size === 0 && parts.references.size === 0) return "";
  }
  const items = [...parts.items.entries()]
    .map(([id, json]) => ({ id, value: parseOr(json), z: zOf(json) }))
    .sort((a, b) => a.z - b.z || compare(a.id, b.id))
    .map((entry) => entry.value);
  const references = [...parts.references.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([, json]) => parseOr(json));
  return JSON.stringify({ ...(parts.envelope ?? {}), items, references });
}

function parseOr(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function zOf(json: string): number {
  const value = parseOr(json);
  return isRecord(value) &&
    typeof value.z === "number" &&
    Number.isFinite(value.z)
    ? value.z
    : 0;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 物化后会长成什么样：比较两份白板是否「同一份」用它。 */
export function normalizeWhiteboard(text: string): string {
  return composeWhiteboard(splitWhiteboard(text));
}

/* --------------------------------- 投影 ---------------------------------- */

/** 文档 → 表的形状。节点按 `createdAt`、id 排，边同理。 */
export function projectDoc(doc: Y.Doc, boardId: string): BoardProjection {
  const nodes: CanvasNode[] = [];
  nodesOf(doc).forEach((map, id) => {
    if (map instanceof Y.Map) nodes.push(readNode(map, id, boardId));
  });
  nodes.sort(byCreated);
  const edges: CanvasEdge[] = [];
  edgesOf(doc).forEach((value, id) => {
    if (isRecord(value)) edges.push(readEdge(value, id, boardId));
  });
  edges.sort(byCreated);
  return { nodes, edges, whiteboard: readWhiteboard(doc) };
}

function byCreated(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  return compare(a.createdAt, b.createdAt) || compare(a.id, b.id);
}

function readNode(
  map: Y.Map<unknown>,
  id: string,
  boardId: string,
): CanvasNode {
  const node: Record<string, unknown> = { id, boardId };
  for (const field of NODE_FIELDS) {
    if (!map.has(field)) continue;
    const value = map.get(field);
    if (value === undefined) continue;
    node[field] = clone(value);
  }
  const content = map.get(CONTENT);
  if (content instanceof Y.Text) {
    const data = isRecord(node.data) ? node.data : {};
    node.data = { ...data, content: content.toString() };
  }
  // 读回的形状要能直接进 `saveBoard` 的校验：缺省的数组与字符串补上。
  if (!Array.isArray(node.labels)) node.labels = [];
  if (typeof node.note !== "string") node.note = "";
  return node as unknown as CanvasNode;
}

function readEdge(
  value: Record<string, unknown>,
  id: string,
  boardId: string,
): CanvasEdge {
  const edge: Record<string, unknown> = {
    id,
    boardId,
    source: value.source,
    target: value.target,
    kind: value.kind,
  };
  if (value.role !== undefined) edge.role = value.role;
  edge.createdAt = value.createdAt;
  edge.updatedAt = value.updatedAt;
  return edge as unknown as CanvasEdge;
}

function readWhiteboard(doc: Y.Doc): string {
  const meta = metaOf(doc);
  const envelopeJson = meta.get(ENVELOPE);
  const raw = meta.get(RAW);
  let envelope: Record<string, unknown> | undefined;
  if (typeof envelopeJson === "string") {
    const parsed = parseOr(envelopeJson);
    if (isRecord(parsed)) envelope = parsed;
  }
  return composeWhiteboard({
    ...(envelope === undefined ? {} : { envelope }),
    ...(typeof raw === "string" && raw !== "" ? { raw } : {}),
    items: new Map(whiteboardOf(doc).entries()),
    references: new Map(whiteboardRefsOf(doc).entries()),
  });
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/* ------------------------------- 按差异写入 ------------------------------ */

/**
 * 把 `base → target` 的改动以一次事务写进文档。
 *
 * 三方合并：只写调用方真的改了的字段，文档里别人并发改的、调用方没碰的东西
 * 原样保留。`base` 是调用方读到的那一份（core 写者读的是物化表）；种子写入
 * 时 `base` 是空投影，等于整份写入。
 *
 *   * 节点：`base` 有、`target` 没有 → 删；`target` 有、文档没有而 `base` 也
 *     没有 → 整个新建；两边都有 → 逐字段比，变了的才写。`base` 有而文档里已经
 *     没有（别人刚删了）→ 删除优先，不复活。
 *   * 便签正文：变了就按「文档当前文本 → 目标文本」的公共前后缀写最小改动。
 *   * 边与白板 item：整值 LWW，同样只写变了的。
 */
export function applyDelta(
  doc: Y.Doc,
  base: BoardProjection,
  target: BoardProjection,
  origin: unknown,
): void {
  doc.transact(() => {
    applyNodes(doc, base.nodes, target.nodes);
    applyEdges(doc, base.edges, target.edges);
    applyWhiteboard(doc, base.whiteboard, target.whiteboard);
  }, origin);
}

/** 整份写入：文档变成 `target`（种子与测试用）。 */
export function applyDocument(
  doc: Y.Doc,
  boardId: string,
  target: BoardProjection,
  origin: unknown,
): void {
  applyDelta(doc, projectDoc(doc, boardId), target, origin);
}

function applyNodes(
  doc: Y.Doc,
  base: readonly CanvasNode[],
  target: readonly CanvasNode[],
): void {
  const nodes = nodesOf(doc);
  const before = new Map(base.map((node) => [node.id, node] as const));
  const after = new Map(target.map((node) => [node.id, node] as const));
  for (const id of before.keys()) {
    if (!after.has(id) && nodes.has(id)) nodes.delete(id);
  }
  for (const [id, node] of after) {
    const existing = nodes.get(id);
    const previous = before.get(id);
    if (!(existing instanceof Y.Map)) {
      if (previous !== undefined) continue; // 别人删了：删除优先
      nodes.set(id, nodeMap(node));
      continue;
    }
    for (const field of NODE_FIELDS) {
      const want = fieldOf(node, field);
      const had = previous === undefined ? undefined : fieldOf(previous, field);
      if (previous !== undefined && stableJson(want) === stableJson(had)) {
        continue;
      }
      if (
        previous === undefined &&
        stableJson(want) === stableJson(existing.get(field))
      ) {
        continue;
      }
      if (want === undefined) existing.delete(field);
      else existing.set(field, clone(want));
    }
    const wantText = contentOf(node);
    const hadText = previous === undefined ? undefined : contentOf(previous);
    if (previous === undefined || wantText !== hadText) {
      writeContent(existing, wantText);
    }
  }
}

/** 节点字段的文档值：`data` 去掉进了 `Y.Text` 的正文。 */
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
  const data = node.data;
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
  if (content !== undefined) {
    const text = new Y.Text();
    text.insert(0, content);
    map.set(CONTENT, text);
  }
  return map;
}

function writeContent(map: Y.Map<unknown>, want: string | undefined): void {
  const current = map.get(CONTENT);
  if (want === undefined) {
    if (current !== undefined) map.delete(CONTENT);
    return;
  }
  if (!(current instanceof Y.Text)) {
    const text = new Y.Text();
    text.insert(0, want);
    map.set(CONTENT, text);
    return;
  }
  replaceText(current, want);
}

/** 公共前后缀之外的那一段换掉：并发输入的其余部分不受影响。 */
export function replaceText(text: Y.Text, want: string): void {
  const have = text.toString();
  if (have === want) return;
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
  const edit = () => {
    if (removed > 0) text.delete(start, removed);
    if (inserted !== "") text.insert(start, inserted);
  };
  // 一次事务：删与插是同一次编辑，客户端收到的是一条更新。
  if (text.doc === null) edit();
  else text.doc.transact(edit);
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

function applyEdges(
  doc: Y.Doc,
  base: readonly CanvasEdge[],
  target: readonly CanvasEdge[],
): void {
  const edges = edgesOf(doc);
  const before = new Map(
    base.map((edge) => [edge.id, edgeValue(edge)] as const),
  );
  const after = new Map(
    target.map((edge) => [edge.id, edgeValue(edge)] as const),
  );
  for (const id of before.keys()) {
    if (!after.has(id) && edges.has(id)) edges.delete(id);
  }
  for (const [id, value] of after) {
    const previous = before.get(id);
    if (previous !== undefined) {
      if (stableJson(previous) === stableJson(value)) continue;
      if (!edges.has(id)) continue; // 别人删了：删除优先
    } else if (stableJson(edges.get(id)) === stableJson(value)) {
      continue;
    }
    edges.set(id, value);
  }
}

function applyWhiteboard(doc: Y.Doc, base: string, target: string): void {
  if (base === target) return;
  const before = splitWhiteboard(base);
  const after = splitWhiteboard(target);
  const meta = metaOf(doc);
  const beforeEnvelope =
    before.envelope === undefined ? undefined : stableJson(before.envelope);
  const afterEnvelope =
    after.envelope === undefined ? undefined : stableJson(after.envelope);
  if (beforeEnvelope !== afterEnvelope) {
    if (after.envelope === undefined) meta.delete(ENVELOPE);
    else meta.set(ENVELOPE, JSON.stringify(after.envelope));
  }
  if (before.raw !== after.raw) {
    if (after.raw === undefined) meta.delete(RAW);
    else meta.set(RAW, after.raw);
  }
  applyStrings(whiteboardOf(doc), before.items, after.items);
  applyStrings(whiteboardRefsOf(doc), before.references, after.references);
}

function applyStrings(
  map: Y.Map<string>,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): void {
  for (const id of before.keys()) {
    if (!after.has(id) && map.has(id)) map.delete(id);
  }
  for (const [id, json] of after) {
    const previous = before.get(id);
    if (previous !== undefined) {
      if (stableJson(parseOr(previous)) === stableJson(parseOr(json))) continue;
      if (!map.has(id)) continue; // 别人删了：删除优先
    } else if (map.get(id) === json) {
      continue;
    }
    map.set(id, json);
  }
}

/** 一块空板的文档。 */
export function createBoardDoc(): Y.Doc {
  // `gc: true`（缺省）：删除的内容只留墓碑，快照不随历史无限变大。
  return new Y.Doc();
}
