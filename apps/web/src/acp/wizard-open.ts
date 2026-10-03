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
}

export const useWizardOpen = create<WizardOpenState>(() => ({
  open: false,
  at: null,
}));

export function openNewAgentWizard(at: Position | null = null): void {
  useWizardOpen.setState({ open: true, at });
}

export function closeNewAgentWizard(): void {
  useWizardOpen.setState({ open: false, at: null });
}
