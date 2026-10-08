import type { BoardDocument, CanvasNode } from "@armadra/shared";

import { agentColorVar } from "@/agent/launch";
import { useCanvasStore } from "@/store/canvas-store";

/**
 * 每个节点在小地图与派发线上用什么颜色（纯函数 + 一个 store 选择器）。
 *
 * 三种来源，优先级从上到下：
 *
 *  1. **派发簇**：`role: "supervises"` 的边连成的树。树按根的 id 排序（uuidv7
 *     单调，即创建顺序），第 i 棵取 `--node-color-${i % 7 + 1}`，根与子孙同色。
 *     簇色回答「谁派的」。
 *  2. **独立 Agent**：不在任何树上的 Agent 终端，用它的标识色（`--agent-<id>`），
 *     回答「是谁」。
 *  3. **其他节点**：按类型取 `--mm-*`（`styles/tokens.css`）。
 *
 * 节点头的色点仍然是标识色：标识色与簇色说的是两件事，互不借用。
 */

export type FamilyKind = "cluster" | "agent" | "type";

export interface Family {
  readonly kind: FamilyKind;
  /** 簇的根节点 id；只有 `cluster` 有。 */
  readonly rootId?: string;
  readonly color: string;
}

/** 七色循环（`NODE_COLORS` 的变量形式）。 */
export const CLUSTER_COLOR_COUNT = 7;

export function clusterColor(index: number): string {
  return `var(--node-color-${(index % CLUSTER_COLOR_COUNT) + 1})`;
}

/** 非 Agent 节点的类型色；没有登记的类型（纯 shell、活动卡片）用中性色。 */
const TYPE_COLORS: Readonly<Record<string, string>> = {
  sticky: "var(--mm-sticky)",
  editor: "var(--mm-editor)",
  files: "var(--mm-files)",
  browser: "var(--mm-browser)",
  diff: "var(--mm-diff)",
  automation: "var(--mm-automation)",
  group: "var(--mm-group)",
};

const NEUTRAL = "var(--muted-foreground)";

function agentIdOf(node: CanvasNode): string | undefined {
  return node.data.kind === "terminal" ? node.data.agent?.id : undefined;
}

export function familyOf(
  document: Pick<BoardDocument, "nodes" | "edges">,
): Map<string, Family> {
  const present = new Set(document.nodes.map((node) => node.id));
  // 先到的赢（与 `supervision.ts` 同一条规矩）：一个节点只认第一条上级边。
  const parent = new Map<string, string>();
  for (const edge of document.edges) {
    if (edge.role !== "supervises") continue;
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    if (edge.source === edge.target || parent.has(edge.target)) continue;
    parent.set(edge.target, edge.source);
  }
  const rootOf = (nodeId: string): string => {
    const seen = new Set<string>([nodeId]);
    let current = nodeId;
    for (;;) {
      const up = parent.get(current);
      // 环（core 不该写出来）：以环上 id 最小的那个当根，结果仍然稳定。
      if (up === undefined) return current;
      if (seen.has(up)) {
        const cycle = [up];
        for (let at = parent.get(up)!; at !== up; at = parent.get(at)!) {
          cycle.push(at);
        }
        return cycle.sort()[0]!;
      }
      seen.add(up);
      current = up;
    }
  };
  const members = new Map<string, string>();
  for (const child of parent.keys()) {
    members.set(child, rootOf(child));
  }
  const roots = [...new Set(members.values())].sort();
  for (const root of roots) members.set(root, root);
  const rank = new Map(roots.map((root, index) => [root, index] as const));

  const families = new Map<string, Family>();
  for (const node of document.nodes) {
    const root = members.get(node.id);
    if (root !== undefined) {
      families.set(node.id, {
        kind: "cluster",
        rootId: root,
        color: clusterColor(rank.get(root)!),
      });
      continue;
    }
    const agentId = agentIdOf(node);
    if (agentId) {
      families.set(node.id, { kind: "agent", color: agentColorVar(agentId) });
      continue;
    }
    families.set(node.id, {
      kind: "type",
      color: TYPE_COLORS[node.type] ?? NEUTRAL,
    });
  }
  return families;
}

/* ------------------------------ store 选择器 ------------------------------ */

let lastNodes: readonly CanvasNode[] | undefined;
let lastEdges: BoardDocument["edges"] | undefined;
let lastFamilies = new Map<string, Family>();

/**
 * 当前画布的 `familyOf`，按 `nodes` / `edges` 引用缓存：小地图与每一条派发线
 * 共用一次计算，拖动视口不重算。
 */
export function currentFamilies(
  document: Pick<BoardDocument, "nodes" | "edges"> | null | undefined,
): Map<string, Family> {
  if (!document) return new Map();
  if (document.nodes !== lastNodes || document.edges !== lastEdges) {
    lastNodes = document.nodes;
    lastEdges = document.edges;
    lastFamilies = familyOf(document);
  }
  return lastFamilies;
}

/** 某个节点的簇色 / 标识色 / 类型色；节点不在画布上时是 `undefined`。 */
export function useFamilyColor(nodeId: string): string | undefined {
  return useCanvasStore(
    (state) => currentFamilies(state.document).get(nodeId)?.color,
  );
}

/** 整张表（小地图要逐节点取色）。 */
export function useFamilies(): Map<string, Family> {
  return useCanvasStore((state) => currentFamilies(state.document));
}
