import type { Position } from "@armadra/shared";

import type { CanvasState } from "@/store/canvas/types";
import { beginCoalesce, endCoalesce } from "@/store/canvas/history";
import { useCanvasStore } from "@/store/canvas-store";
import { isCanvasLocked } from "./canvas-lock";
import { nodeBox, type Box } from "./geometry";
import {
  GRID,
  tidy,
  tidyKindOf,
  type TidyKind,
  type TidyLink,
  type TidyOptions,
} from "./tidy";
import { toItemId, type Item } from "./whiteboard/model";
import { moveItems } from "./whiteboard/store";

/**
 * 整理排布的画布侧（React Flow 计划 §1.2 F09，替代 `tidy-editor.ts`）。
 *
 * 算法在 `tidy.ts`（刚体单元 + 阅读顺序 + 主从树 + 裹行，UI 设计 §6.4）。
 * 这里负责四件事——定范围、取矩形、取链接、一次提交。
 *
 * **范围**（§6.5）：选区里的顶层单元 ≥ 2 个时只整理选中的那些，原点取它们
 * 的包围盒左上角，其余一概不动；否则整理全画布。
 *
 * **参与排布的是「顶层对象」**：没有父级的节点与白板对象各算一个矩形。
 * 组员（`parentId` 指向某个 Frame 的节点与白板对象）不单独参与，Frame
 * 整体移动时它们靠相对坐标跟着走，内部布局一点不变。
 *
 * **链接**取两处：`document.edges`（上下文连线）与 `whiteboard.references`
 * （内容引用）。两端各自上溯到自己的顶层容器，连在一起的东西才不会被拆到
 * 画布两头。
 *
 * **一次手势一条历史**：节点走 `moveNodes`、白板对象走 `whiteboard.moveItems`
 * （§2.11 就是这么约定的：整理只挪位置，不该有权把整份白板文档换掉），
 * 两次 commit 由 `beginCoalesce` / `endCoalesce` 合并成一条，所以整理之后
 * 按一下 ⌘Z 就整块回到原位。
 *
 * 锁定视图（`canvas-lock.ts`）时什么都不动：锁的是相机，但「画布自己重排
 * 一遍」比平移更突兀，旧引擎在只读编辑器上也是直接返回空的。
 */

interface Movable {
  id: string;
  box: Box;
  kind: TidyKind;
}

/** 对象 id 上溯到它的顶层容器（节点只嵌套一层，组不能进组）。 */
function rootResolver(state: CanvasState): (id: string) => string {
  const parentOf = new Map<string, string>();
  for (const node of state.document?.nodes ?? []) {
    parentOf.set(node.id, node.parentId ?? node.id);
  }
  for (const item of state.whiteboard.items) {
    const id = toItemId(item.id);
    parentOf.set(id, item.parentId ?? id);
  }
  return (id) => parentOf.get(id) ?? id;
}

/**
 * 选区换算成顶层对象 id。不足两个就是「没有可整理的选区」，返回 null，
 * 调用方整理全画布。Dock 的提示与命令共用这一条判断。
 */
export function tidySelection(state: CanvasState): ReadonlySet<string> | null {
  const selected = state.selectedNodeIds.length + state.selectedItemIds.length;
  if (selected < 2) return null;
  const root = rootResolver(state);
  const tops = new Set<string>();
  for (const id of [...state.selectedNodeIds, ...state.selectedItemIds]) {
    tops.add(root(id));
  }
  return tops.size >= 2 ? tops : null;
}

/** 顶层节点的矩形；组员跟着自己的 Frame 一起动，不单独参与。 */
function movableNodes(): Movable[] {
  const document = useCanvasStore.getState().document;
  const nodes = document?.nodes ?? [];
  // 主从边两端都算 Agent：主从关系只在 Agent 之间建立。
  const supervised = new Set<string>();
  for (const edge of document?.edges ?? []) {
    if (edge.role !== "supervises") continue;
    supervised.add(edge.source);
    supervised.add(edge.target);
  }
  return nodes
    .filter((node) => !node.parentId)
    .map((node) => ({
      id: node.id,
      box: nodeBox(nodes, node),
      kind:
        node.type !== "group" && supervised.has(node.id)
          ? "agent"
          : tidyKindOf(node),
    }));
}

/** 顶层白板对象的矩形。id 用 `wb:` 前缀，和节点共用一张排布表。 */
function movableItems(items: readonly Item[]): Movable[] {
  return items
    .filter((item) => !item.parentId)
    .map((item) => ({
      id: toItemId(item.id),
      box: { x: item.x, y: item.y, width: item.w, height: item.h },
      kind: "wb" as const,
    }));
}

/**
 * 连线与引用当链接：两端各自上溯到顶层容器，同一个容器内部的连线忽略。
 * 主从边带上 `role`，其余都是对等。
 */
function links(ids: ReadonlySet<string>): TidyLink[] {
  const state = useCanvasStore.getState();
  const root = rootResolver(state);
  const result: TidyLink[] = [];
  const add = (from: string, to: string, supervises = false) => {
    const source = root(from);
    const target = root(to);
    if (source === target) return;
    if (!ids.has(source) || !ids.has(target)) return;
    result.push(
      supervises ? { source, target, role: "supervises" } : { source, target },
    );
  };
  for (const edge of state.document?.edges ?? []) {
    add(edge.source, edge.target, edge.role === "supervises");
  }
  for (const reference of state.whiteboard.references) {
    add(toItemId(reference.itemId), reference.nodeId);
  }
  return result;
}

export interface ArrangeOptions extends TidyOptions {
  /**
   * 只整理这些顶层对象（`tidySelection` 的结果）。缺省整理全画布。
   */
  only?: ReadonlySet<string> | null;
}

const snap = (value: number) => Math.round(value / GRID) * GRID;

/**
 * 把整块画布（或选区）重排一次，保持内容包围盒的左上角不动（吸到网格）。
 *
 * 返回值只给测试用：真正的效果是一次 `moveNodes` + 一次 `moveItems`，
 * 合并成一条历史。
 */
export function arrangeCanvas(
  options: ArrangeOptions = {},
): Record<string, Position> {
  if (isCanvasLocked()) return {};
  const state = useCanvasStore.getState();
  const items = state.whiteboard.items;
  const only = options.only ?? null;
  const movable = [...movableNodes(), ...movableItems(items)].filter(
    (entry) => only === null || only.has(entry.id),
  );
  if (movable.length === 0) return {};

  const ids = new Set(movable.map((entry) => entry.id));
  const positions = tidy(
    movable.map((entry) => ({
      id: entry.id,
      x: entry.box.x,
      y: entry.box.y,
      width: Math.max(1, entry.box.width),
      height: Math.max(1, entry.box.height),
      kind: entry.kind,
    })),
    links(ids),
    { aspect: options.aspect, grid: options.grid },
  );

  // 排布结果的原点是 (0,0)；平移回原来那块内容的左上角，画布不会突然跳走。
  const originX = snap(Math.min(...movable.map((entry) => entry.box.x)));
  const originY = snap(Math.min(...movable.map((entry) => entry.box.y)));
  const nodeMoves: { id: string; position: Position }[] = [];
  const itemMoves = new Map<string, Position>();
  const applied: Record<string, Position> = {};

  for (const entry of movable) {
    const packed = positions[entry.id];
    if (!packed) continue;
    const position = { x: originX + packed.x, y: originY + packed.y };
    applied[entry.id] = position;
    if (position.x === entry.box.x && position.y === entry.box.y) continue;
    if (entry.kind === "wb") {
      itemMoves.set(entry.id, position);
    } else {
      nodeMoves.push({ id: entry.id, position });
    }
  }
  if (nodeMoves.length === 0 && itemMoves.size === 0) return applied;

  // 一条历史：两次 commit 并成一次（§2.7 的合并会话）。
  beginCoalesce("canvas.tidy");
  try {
    if (nodeMoves.length > 0) useCanvasStore.getState().moveNodes(nodeMoves);
    if (itemMoves.size > 0) {
      moveItems([...itemMoves].map(([id, position]) => ({ id, position })));
    }
  } finally {
    endCoalesce();
  }
  return applied;
}
