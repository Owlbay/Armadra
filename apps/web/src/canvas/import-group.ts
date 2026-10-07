import type { CanvasNodeType } from "@armadra/shared";

import { NODE_META } from "@/nodes/registry";
import { beginCoalesce, endCoalesce } from "@/store/canvas/history";
import type { AddNodeOptions } from "@/store/canvas/types";
import { absolutePosition, useCanvasStore } from "@/store/canvas-store";
import { boundingBox, nodeBox, type Box } from "./geometry";
import { toItemId, type Item } from "./whiteboard/model";
import { addItems, itemsByIds, updateItems } from "./whiteboard/store";

/**
 * 导入批次 = 一个 `group` 节点（UI 设计 2026-10-07 §6.2 / §6.3）。
 *
 * 一次落下 ≥ 2 个对象（Mermaid 图、多张图片、多个文件）时先套一个组，对象的
 * `parentId` 指向它、坐标换成相对组框。整理把组当一个刚体，所以导入的东西
 * 再怎么整理也不会被拆成一长排。单个对象不套组。
 *
 * 不加字段、不改 `whiteboard_json v2`、无迁移：组节点与 `parentId` 本来就有，
 * 只多了组 data 上可选的 `origin: "import"`。
 *
 * 新建、套组、选中在一个合并会话里完成：撤销一次整批消失。
 */

/** 组框相对内容包围盒的内边距；顶边多留一条给标题。 */
export const GROUP_PADDING = 24;
export const GROUP_LABEL_SPACE = 12;

export interface BatchNode {
  type: CanvasNodeType;
  options: AddNodeOptions;
}

export interface ImportBatch {
  nodes: BatchNode[];
  items: Item[];
}

export function emptyBatch(): ImportBatch {
  return { nodes: [], items: [] };
}

export interface CommittedBatch {
  nodeIds: string[];
  /** 白板对象的原始 id（不带 `wb:`），与 `addItems` 的返回值一致。 */
  itemIds: string[];
  groupId: string | null;
}

/**
 * 把已经在画布上的一批顶层对象套进一个新组。不足两个时什么都不做。
 * 调用方负责合并会话；返回组 id。
 */
export function wrapInGroup(
  nodeIds: readonly string[],
  itemIds: readonly string[],
  title: string,
): string | null {
  if (nodeIds.length + itemIds.length < 2) return null;
  const state = useCanvasStore.getState();
  const nodes = state.document?.nodes ?? [];
  const members = nodeIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node) => node !== undefined && node.type !== "group");
  const items = itemsByIds(itemIds.map(toItemId));
  const boxes: Box[] = [
    ...members.map((node) => nodeBox(nodes, node!)),
    ...items.map((item) => ({
      x: item.x,
      y: item.y,
      width: item.w,
      height: item.h,
    })),
  ];
  if (members.length + items.length < 2) return null;
  const rect = boundingBox(boxes);
  if (!rect) return null;

  const min = NODE_META.group.minSize;
  const groupId = state.addNode("group", {
    position: {
      x: rect.x - GROUP_PADDING,
      y: rect.y - GROUP_PADDING - GROUP_LABEL_SPACE,
    },
    size: {
      width: Math.max(min.width, rect.width + GROUP_PADDING * 2),
      height: Math.max(
        min.height,
        rect.height + GROUP_PADDING * 2 + GROUP_LABEL_SPACE,
      ),
    },
    title,
    data: { kind: "group", origin: "import" },
    select: false,
  });
  if (!groupId) return null;

  if (members.length > 0) {
    useCanvasStore.getState().setParent(
      members.map((node) => node!.id),
      groupId,
    );
  }
  if (items.length > 0) {
    const group = useCanvasStore
      .getState()
      .document?.nodes.find((node) => node.id === groupId);
    const origin = group
      ? absolutePosition(useCanvasStore.getState().document?.nodes ?? [], group)
      : { x: 0, y: 0 };
    updateItems(
      items.map((item) => ({
        id: toItemId(item.id),
        patch: {
          parentId: groupId,
          x: item.x - origin.x,
          y: item.y - origin.y,
        },
      })),
    );
  }
  return groupId;
}

/**
 * 一批导入对象一次落地：新建节点与白板对象，≥ 2 个时套组，选中结果。
 * 一条历史。
 */
export function commitBatch(
  batch: ImportBatch,
  title: string,
  label = "canvas.import",
): CommittedBatch {
  const empty: CommittedBatch = { nodeIds: [], itemIds: [], groupId: null };
  if (batch.nodes.length === 0 && batch.items.length === 0) return empty;
  let result = empty;
  beginCoalesce(label);
  try {
    const nodeIds = batch.nodes
      .map(({ type, options }) =>
        useCanvasStore.getState().addNode(type, { ...options, select: false }),
      )
      .filter((id) => id !== "");
    const itemIds = addItems(batch.items);
    const groupId = wrapInGroup(nodeIds, itemIds, title);
    result = { nodeIds, itemIds, groupId };
  } finally {
    endCoalesce();
  }
  // 选中不进历史：成组了选组，否则选那一个对象。
  const store = useCanvasStore.getState();
  if (result.groupId) {
    store.setSelection({ nodes: [result.groupId], edges: [], items: [] });
  } else if (result.nodeIds.length > 0) {
    store.setSelection({ nodes: result.nodeIds, edges: [], items: [] });
  } else if (result.itemIds.length > 0) {
    store.setSelection({
      nodes: [],
      edges: [],
      items: result.itemIds.map(toItemId),
    });
  }
  return result;
}

/**
 * 解组：组员回到页面级（坐标换回绝对），组框删掉。一条历史。节点组员由
 * `removeNodes` 自己换回绝对坐标，白板组员在这里换。
 */
export function ungroup(groupId: string): void {
  const state = useCanvasStore.getState();
  const nodes = state.document?.nodes ?? [];
  const group = nodes.find((node) => node.id === groupId);
  if (!group || group.type !== "group") return;
  const origin = absolutePosition(nodes, group);
  const items = state.whiteboard.items.filter(
    (item) => item.parentId === groupId,
  );
  beginCoalesce("canvas.ungroup");
  try {
    if (items.length > 0) {
      updateItems(
        items.map((item) => ({
          id: toItemId(item.id),
          patch: { parentId: null, x: item.x + origin.x, y: item.y + origin.y },
        })),
      );
    }
    useCanvasStore.getState().removeNodes([groupId]);
  } finally {
    endCoalesce();
  }
}
