import type { Position } from "@armadra/shared";
import { create } from "zustand";

/**
 * 新建 Agent 向导的开关（ACP 设计 §8 第 1 条）。
 *
 * 新建菜单的规格（`canvas/menus/add-menu.ts`）不是组件文件，不该 import 向导
 * 那一整棵组件树；开关单独放在这里，向导只订阅它——与 Mermaid 导入对话框
 * （`whiteboard/mermaid/open.ts`）同一个做法。
 */
interface WizardOpenState {
  open: boolean;
  /** 新节点的中心锚点；null = 视口中心。 */
  at: Position | null;
  /**
   * 「派生 Agent…」（设计 ui-acp-refresh §2.3）：新节点是这个节点的从，建好后
   * 连一条 `role: "supervises"` 的边，并放在它右侧。null = 普通新建。
   */
  supervisorNodeId: string | null;
}

export const useWizardOpen = create<WizardOpenState>(() => ({
  open: false,
  at: null,
  supervisorNodeId: null,
}));

export function openNewAgentWizard(at: Position | null = null): void {
  useWizardOpen.setState({ open: true, at, supervisorNodeId: null });
}

/** 从一个 Agent 节点派生一个从：同一个向导，创建后连主从边。 */
export function openSpawnAgentWizard(supervisorNodeId: string): void {
  useWizardOpen.setState({ open: true, at: null, supervisorNodeId });
}

export function closeNewAgentWizard(): void {
  useWizardOpen.setState({ open: false, at: null, supervisorNodeId: null });
}
