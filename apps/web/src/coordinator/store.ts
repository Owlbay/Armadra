import { create } from "zustand";

import { useCanvasStore } from "@/store/canvas-store";

/**
 * 分派抽屉看的是哪一个协调者（设计系统 §5.4）。抽屉的开合是画布的工作面板
 * （`panels.dispatch`，一次只开一个由 `setPanel` 保证）；这里只记节点。
 */
export const useDispatchTarget = create<{ nodeId: string | null }>(() => ({
  nodeId: null,
}));

export function openDispatchDrawer(nodeId: string): void {
  useDispatchTarget.setState({ nodeId });
  useCanvasStore.getState().setPanel("dispatch", "drawer");
}

export function closeDispatchDrawer(): void {
  useCanvasStore.getState().setPanel("dispatch", "closed");
}
