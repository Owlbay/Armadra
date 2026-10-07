import type { CanvasEdge, CanvasNode, Position } from "@armadra/shared";
import { COLLAPSED_HEIGHT, defaultNodeSize } from "../store/defaults";

/**
 * 整理布局（UI 设计 2026-10-07 §6.4；前身是 v3 计划 §23）。
 *
 * 全是纯函数，七步：
 *   1. **刚体化**：每个盒子先成一个「单元」；白板对象（`kind: "wb"`）之间
 *      包围盒相交或间距 ≤ 24px 的并成一个孤岛（并查集）。单元内部的相对
 *      位置永远不变——导入的一张图、手画的一组框线整体平移，不会被拆开。
 *   2. **阅读顺序**：单元按原位置排序，先按 `y` 以 `ROW_GAP` 量化成行，行内
 *      按 `x`。后面所有「谁先谁后」都用它，所以整理两次结果不变（幂等）。
 *   3. **主从树**：只取 `role: "supervises"` 的边建森林（一个单元最多一个主，
 *      先到的赢）。根在第 0 列，子在第 1 列顶对齐根、纵向等距，孙在第 2 列按
 *      父的顺序分段。对等边连着的非 Agent 单元作为「附件」挂在它连的那个树
 *      成员同列正下方。每棵树（连同附件）是一个簇：多主各成簇。
 *   4. **其余分量**：剩下的单元按无向连通分量成簇，簇内拓扑分列；列内顺序
 *      第 0 列按阅读顺序，之后每列按上一列邻居的平均 y（重心法）排。
 *   5. **裹行**：簇按阅读顺序塞进当前行，行宽超过
 *      `sqrt(总面积 × 视口宽高比) × 1.15` 就换行。
 *   6. **网格**：每个单元左上角吸到 8px。
 *   7. 原点 (0,0)：调用方负责平移回原来那块内容的左上角。
 *
 * 复杂度 O(n log n + e)（孤岛按 x 排序后扫描，最坏退化成 O(n²) 只在全部
 * 白板对象叠在一列上时出现）。
 */

export type TidyKind = "agent" | "node" | "wb";

export interface TidyBox {
  id: string;
  width: number;
  height: number;
  /** 原位置；缺省 (0,0)，于是阅读顺序退回输入顺序。 */
  x?: number;
  y?: number;
  /** 缺省 `node`。只有 `wb` 参与孤岛，只有非 `agent` 能做附件。 */
  kind?: TidyKind;
}

export interface TidyLink {
  source: string;
  target: string;
  /** `supervises`：`source` 是主。缺省是对等。 */
  role?: "supervises";
}

export interface TidyOptions {
  /** 目标区域宽高比，默认按视口给；拿不到视口时退回 16:9。 */
  aspect?: number;
  /** 网格边长，默认 8。 */
  grid?: number;
}

/** 版式常量（§6.4）。 */
export const ROW_GAP = 48;
export const COLUMN_GAP = 60;
export const MAX_DEPTH = 50;
export const DEFAULT_ASPECT = 16 / 9;
export const GRID = 8;
/** 白板对象之间相距这么近就算同一个孤岛。 */
export const ISLAND_GAP = 24;
/** 行宽上限的宽容系数：宁可略宽，也不要为了 1px 把一整列挤到下一行。 */
export const ROW_WIDTH_SLACK = 1.15;

/* --------------------------------- 单元 ----------------------------------- */

interface Unit {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: TidyKind;
  /** 成员相对单元左上角的偏移。 */
  members: { id: string; dx: number; dy: number }[];
  /** 阅读顺序的名次。 */
  rank: number;
}

/** 前进一步：把坐标向上取整到网格（网格为 0 时原样）。 */
type Step = (value: number) => number;

/** 一个簇排完之后的相对布局：单元 id → 相对簇左上角的位置。 */
interface Cluster {
  width: number;
  height: number;
  offsets: Map<string, Position>;
  /** 簇里最靠前的阅读名次，决定簇的先后。 */
  rank: number;
}

function unionFind(ids: readonly string[]) {
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (start: string): string => {
    let root = start;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cursor = start;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  return { find, union };
}

/** 第 1 步：盒子 → 单元。白板对象按距离并成孤岛，其余一盒一单元。 */
function unitsOf(boxes: readonly TidyBox[]): {
  units: Unit[];
  unitOf: Map<string, string>;
} {
  const geometry = boxes.map((box) => ({
    box,
    x: box.x ?? 0,
    y: box.y ?? 0,
    kind: box.kind ?? "node",
  }));
  const wb = geometry
    .filter((entry) => entry.kind === "wb")
    .sort((a, b) => a.x - b.x);
  const { find, union } = unionFind(wb.map((entry) => entry.box.id));
  for (let i = 0; i < wb.length; i += 1) {
    const a = wb[i]!;
    const reach = a.x + a.box.width + ISLAND_GAP;
    for (let j = i + 1; j < wb.length && wb[j]!.x <= reach; j += 1) {
      const b = wb[j]!;
      if (
        b.y <= a.y + a.box.height + ISLAND_GAP &&
        a.y <= b.y + b.box.height + ISLAND_GAP
      ) {
        union(a.box.id, b.box.id);
      }
    }
  }

  // 单元按输入顺序出现：孤岛的位置取它第一个成员在输入里的位置。
  const unitOf = new Map<string, string>();
  const grouped = new Map<string, typeof geometry>();
  for (const entry of geometry) {
    const key =
      entry.kind === "wb" ? `island:${find(entry.box.id)}` : entry.box.id;
    unitOf.set(entry.box.id, key);
    const list = grouped.get(key);
    if (list) list.push(entry);
    else grouped.set(key, [entry]);
  }

  const units: Unit[] = [];
  for (const [id, entries] of grouped) {
    const left = Math.min(...entries.map((entry) => entry.x));
    const top = Math.min(...entries.map((entry) => entry.y));
    const right = Math.max(
      ...entries.map((entry) => entry.x + entry.box.width),
    );
    const bottom = Math.max(
      ...entries.map((entry) => entry.y + entry.box.height),
    );
    units.push({
      id,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      kind: entries[0]!.kind,
      members: entries.map((entry) => ({
        id: entry.box.id,
        dx: entry.x - left,
        dy: entry.y - top,
      })),
      rank: 0,
    });
  }

  // 第 2 步：阅读顺序。`sort` 是稳定的，坐标全缺省时就是输入顺序。
  const ordered = [...units].sort(
    (a, b) =>
      Math.floor(a.y / ROW_GAP) - Math.floor(b.y / ROW_GAP) || a.x - b.x,
  );
  ordered.forEach((unit, index) => {
    unit.rank = index;
  });
  return { units: ordered, unitOf };
}

/* ------------------------------- 主从树簇 --------------------------------- */

interface UnitLink {
  source: string;
  target: string;
  supervises: boolean;
}

function byRank(units: ReadonlyMap<string, Unit>) {
  return (a: string, b: string) => units.get(a)!.rank - units.get(b)!.rank;
}

/**
 * 第 3 步：主从森林 + 附件。返回每棵树的成员（含附件）与布局。
 * 用掉的单元记进 `used`，剩下的交给拓扑分列。
 */
function treeClusters(
  units: ReadonlyMap<string, Unit>,
  links: readonly UnitLink[],
  used: Set<string>,
  up: Step,
): Cluster[] {
  const order = byRank(units);
  const parent = new Map<string, string>();
  for (const link of [...links]
    .filter((entry) => entry.supervises)
    .sort((a, b) => order(a.target, b.target) || order(a.source, b.source))) {
    // 一个从只认一个主：先到的赢（`canvas/supervision.ts` 同一条规矩）。
    if (!parent.has(link.target)) parent.set(link.target, link.source);
  }
  if (parent.size === 0) return [];

  const children = new Map<string, string[]>();
  for (const [child, boss] of parent) {
    const list = children.get(boss);
    if (list) list.push(child);
    else children.set(boss, [child]);
  }
  for (const list of children.values()) list.sort(order);

  // 根：在树里、没有主的单元；环里谁都有主，就从阅读顺序最靠前的那个剪断。
  const inTree = [...new Set([...parent.keys(), ...parent.values()])].sort(
    order,
  );
  const roots: string[] = [];
  const reached = new Set<string>();
  const reach = (root: string) => {
    const stack = [root];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const child of children.get(id) ?? []) stack.push(child);
    }
  };
  for (const id of inTree) {
    if (!parent.has(id)) {
      roots.push(id);
      reach(id);
    }
  }
  for (const id of inTree) {
    if (reached.has(id)) continue;
    // 上溯到环上，从那里剪断。
    const seen = new Set<string>();
    let cursor = id;
    while (parent.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parent.get(cursor)!;
    }
    const boss = parent.get(cursor);
    if (boss !== undefined) {
      children.set(
        boss,
        (children.get(boss) ?? []).filter((child) => child !== cursor),
      );
      parent.delete(cursor);
    }
    roots.push(cursor);
    reach(cursor);
  }
  for (const id of reached) used.add(id);

  // 结构顺序：树按成员里最靠前的阅读名次排，树内按先序。只看结构不看坐标，
  // 整理之后再整理一次，附件仍然挂在同一个成员下面。
  const preorder = new Map<string, number>();
  const trees = roots.map((root) => {
    const members: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const id = stack.pop()!;
      members.push(id);
      stack.push(...[...(children.get(id) ?? [])].reverse());
    }
    return {
      members,
      rank: Math.min(...members.map((id) => units.get(id)!.rank)),
    };
  });
  trees.sort((a, b) => a.rank - b.rank);
  for (const tree of trees) {
    for (const id of tree.members) preorder.set(id, preorder.size);
  }

  // 附件：对等边连着树成员的非 Agent 单元，挂在结构顺序最靠前的那个成员下。
  const host = new Map<string, string>();
  for (const link of links) {
    if (link.supervises) continue;
    for (const [mine, other] of [
      [link.source, link.target],
      [link.target, link.source],
    ] as const) {
      if (!reached.has(other) || used.has(mine)) continue;
      if (units.get(mine)!.kind === "agent") continue;
      const current = host.get(mine);
      if (
        current === undefined ||
        preorder.get(other)! < preorder.get(current)!
      ) {
        host.set(mine, other);
      }
    }
  }
  const attachments = new Map<string, string[]>();
  for (const [attachment, owner] of host) {
    used.add(attachment);
    const list = attachments.get(owner);
    if (list) list.push(attachment);
    else attachments.set(owner, [attachment]);
  }
  for (const list of attachments.values()) list.sort(order);

  return roots.map((root) =>
    layoutTree(root, units, children, parent, attachments, up),
  );
}

/** 一棵树排成列：父 j 的子块起点 = max(父 j 顶边, 上一段底边 + 行距)。 */
function layoutTree(
  root: string,
  units: ReadonlyMap<string, Unit>,
  children: ReadonlyMap<string, readonly string[]>,
  parent: ReadonlyMap<string, string>,
  attachments: ReadonlyMap<string, readonly string[]>,
  up: Step,
): Cluster {
  const columns: string[][] = [[root]];
  for (let depth = 1; depth <= MAX_DEPTH; depth += 1) {
    const next = columns[depth - 1]!.flatMap((id) => children.get(id) ?? []);
    if (next.length === 0) break;
    columns.push(next);
  }

  const top = new Map<string, number>();
  const offsets = new Map<string, Position>();
  let x = 0;
  let right = 0;
  let height = 0;
  let rank = units.get(root)!.rank;
  for (const [depth, column] of columns.entries()) {
    let bottom = 0;
    let free = 0;
    let width = 0;
    let lastParent: string | undefined;
    for (const id of column) {
      const boss = depth === 0 ? undefined : parent.get(id);
      let y = free;
      if (boss !== undefined && boss !== lastParent) {
        y = Math.max(top.get(boss) ?? 0, y);
      }
      lastParent = boss;
      // 节点本身，然后是它的附件，同列正下方。
      for (const member of [id, ...(attachments.get(id) ?? [])]) {
        const unit = units.get(member)!;
        offsets.set(member, { x, y });
        if (member === id) top.set(id, y);
        rank = Math.min(rank, unit.rank);
        width = Math.max(width, unit.width);
        bottom = y + unit.height;
        free = up(bottom + ROW_GAP);
        y = free;
      }
    }
    height = Math.max(height, bottom);
    right = x + width;
    x = up(right + COLUMN_GAP);
  }
  return { width: right, height, offsets, rank };
}

/* ------------------------------- 拓扑分列 --------------------------------- */

/**
 * 第 4 步：无主从边的分量。只有出边没有入边的单元在最左列，每层一列；
 * 纯环（谁都有入边）整列落在最后一列。
 */
function layoutComponent(
  members: readonly Unit[],
  links: readonly UnitLink[],
  up: Step,
): Cluster {
  const ids = new Set(members.map((unit) => unit.id));
  const edges = links.filter(
    (link) => ids.has(link.source) && ids.has(link.target),
  );
  const incoming = new Map<string, number>(members.map((unit) => [unit.id, 0]));
  const outgoing = new Map<string, string[]>();
  const neighbours = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const edge of edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    push(outgoing, edge.source, edge.target);
    push(neighbours, edge.source, edge.target);
    push(neighbours, edge.target, edge.source);
  }

  // 从「只有出边」的根开始 DFS。`>= level` 的守卫让环不会无限循环，
  // MAX_DEPTH 兜住病态长链。
  const depth = new Map<string, number>();
  const visit = (id: string, level: number) => {
    if (level > MAX_DEPTH) return;
    const seen = depth.get(id);
    if (seen !== undefined && seen >= level) return;
    depth.set(id, level);
    for (const next of outgoing.get(id) ?? []) visit(next, level + 1);
  };
  for (const unit of members) {
    if (incoming.get(unit.id) === 0 && outgoing.has(unit.id)) visit(unit.id, 0);
  }
  const rest = Math.max(-1, ...depth.values()) + 1;
  const columns = new Map<number, Unit[]>();
  for (const unit of members) {
    const level = depth.get(unit.id) ?? rest;
    const column = columns.get(level);
    if (column) column.push(unit);
    else columns.set(level, [unit]);
  }

  const offsets = new Map<string, Position>();
  const centre = new Map<string, number>();
  let x = 0;
  let right = 0;
  let height = 0;
  let first = true;
  for (const level of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(level)!;
    // members 已按阅读顺序；第 0 列保持它，之后按上一列邻居的平均中心 y 排
    // （重心法一遍），没有已排邻居的按阅读顺序排在后面。
    const keyed = column.map((unit) => {
      const ys = (neighbours.get(unit.id) ?? [])
        .map((other) => centre.get(other))
        .filter((value): value is number => value !== undefined);
      const key =
        first || ys.length === 0
          ? Number.POSITIVE_INFINITY
          : ys.reduce((sum, value) => sum + value, 0) / ys.length;
      return { unit, key };
    });
    keyed.sort((a, b) =>
      a.key === b.key ? a.unit.rank - b.unit.rank : a.key - b.key,
    );
    let y = 0;
    let width = 0;
    for (const { unit } of keyed) {
      offsets.set(unit.id, { x, y });
      centre.set(unit.id, y + unit.height / 2);
      height = Math.max(height, y + unit.height);
      y = up(y + unit.height + ROW_GAP);
      width = Math.max(width, unit.width);
    }
    right = x + width;
    x = up(right + COLUMN_GAP);
    first = false;
  }
  return {
    width: right,
    height,
    offsets,
    rank: Math.min(...members.map((unit) => unit.rank)),
  };
}

/* --------------------------------- 入口 ----------------------------------- */

function snap(value: number, grid: number): number {
  return grid > 0 ? Math.round(value / grid) * grid : value;
}

/**
 * 盒子 → 位置（原点 (0,0)）。每个输入盒子都有一个结果；孤岛成员保持彼此的
 * 相对偏移。
 */
export function tidy(
  boxes: TidyBox[],
  links: TidyLink[],
  options: TidyOptions = {},
): Record<string, Position> {
  if (boxes.length === 0) return {};
  const grid = options.grid ?? GRID;
  const { units, unitOf } = unitsOf(boxes);
  const byId = new Map(units.map((unit) => [unit.id, unit]));

  // 链接换算到单元；同一单元内部的、自环与指向未知盒子的忽略，重复的合并。
  const seen = new Set<string>();
  const unitLinks: UnitLink[] = [];
  for (const link of links) {
    const source = unitOf.get(link.source);
    const target = unitOf.get(link.target);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    const supervises = link.role === "supervises";
    const key = `${source}\u0000${target}\u0000${supervises}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unitLinks.push({ source, target, supervises });
  }

  const used = new Set<string>();
  // 每一步前进量都向上取整到网格：等高的兄弟仍然等距，吸网格不会把间距
  // 吃掉一格。
  const up: Step = (value) =>
    grid > 0 ? Math.ceil(value / grid - 1e-9) * grid : value;
  const clusters = treeClusters(byId, unitLinks, used, up);

  const restUnits = units.filter((unit) => !used.has(unit.id));
  const restLinks = unitLinks.filter(
    (link) => !used.has(link.source) && !used.has(link.target),
  );
  const { find, union } = unionFind(restUnits.map((unit) => unit.id));
  for (const link of restLinks) union(link.source, link.target);
  const components = new Map<string, Unit[]>();
  for (const unit of restUnits) {
    const root = find(unit.id);
    const list = components.get(root);
    if (list) list.push(unit);
    else components.set(root, [unit]);
  }
  for (const members of components.values()) {
    clusters.push(layoutComponent(members, restLinks, up));
  }
  clusters.sort((a, b) => a.rank - b.rank);

  // 第 5 步：裹行。
  const totalArea = clusters.reduce(
    (sum, cluster) => sum + cluster.width * cluster.height,
    0,
  );
  const aspect =
    options.aspect && Number.isFinite(options.aspect) && options.aspect > 0
      ? options.aspect
      : DEFAULT_ASPECT;
  const rowLimit = Math.sqrt(totalArea * aspect) * ROW_WIDTH_SLACK;

  const positions: Record<string, Position> = {};
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const cluster of clusters) {
    // `x > 0` 的守卫：比一整行还宽的簇自己独占一行，不会死循环换行。
    if (x > 0 && x + cluster.width > rowLimit) {
      x = 0;
      y = up(y + rowHeight + ROW_GAP);
      rowHeight = 0;
    }
    for (const [id, offset] of cluster.offsets) {
      const unit = byId.get(id)!;
      // 第 6 步：单元左上角吸网格（前进量已经取整，这里只兜底）；成员随
      // 单元平移。
      const left = snap(x + offset.x, grid);
      const top = snap(y + offset.y, grid);
      for (const member of unit.members) {
        positions[member.id] = { x: left + member.dx, y: top + member.dy };
      }
    }
    x = up(x + cluster.width + COLUMN_GAP);
    rowHeight = Math.max(rowHeight, cluster.height);
  }
  return positions;
}

/** 文档层的入口：过滤掉组员，按真实尺寸与原位置排布顶层节点。 */
export function tidyPositions(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  options: TidyOptions = {},
): Record<string, Position> {
  const top = nodes.filter((node) => !node.parentId);
  const boxes = top.map((node): TidyBox => {
    const size = node.size ?? defaultNodeSize(node.type);
    return {
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: size.width,
      // 折叠之后只剩头部，按 40px 参与排布，否则行里全是空气。
      height: node.collapsed ? COLLAPSED_HEIGHT : size.height,
      kind: tidyKindOf(node),
    };
  });
  return tidy(
    boxes,
    edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      ...(edge.role === "supervises" ? { role: "supervises" as const } : {}),
    })),
    options,
  );
}

/** 节点在整理里算不算 Agent：带 `agent` 的终端。 */
export function tidyKindOf(node: Pick<CanvasNode, "type" | "data">): TidyKind {
  const data = node.data as { agent?: unknown } | undefined;
  return node.type === "terminal" && data?.agent != null ? "agent" : "node";
}
