import { srcPrefix } from "../sources/scope";
import { useEffect } from "react";
import { create } from "zustand";
import { useQueryClient } from "@tanstack/react-query";

import { onWorkspaceEvent } from "@/api/events";
import { useCanvasStore } from "@/store/canvas-store";

/**
 * 工作流页面的视图状态（设计系统 §5.5）：开着哪个页签、展开了哪次运行、挑了
 * 哪两次对比、哪个关卡在答、哪个模板在改或在起跑。真相在 core（契约 §15），
 * 列表走 react-query；收到 `workflow.*` 事件整组重读——帧里不带正文。
 */

export type WorkflowTab = "templates" | "runs";

export interface GateTarget {
  readonly runId: string;
  readonly stepId: string;
  readonly label: string;
}

export interface WorkflowView {
  tab: WorkflowTab;
  /** 展开看步骤的那次运行。 */
  expanded: string | null;
  /** 勾了对比的运行，最多两次，先勾的在左。 */
  compare: string[];
  comparing: boolean;
  gate: GateTarget | null;
  /** 正在编辑的模板。 */
  editing: string | null;
  /** 正在填参数起跑的模板。 */
  starting: string | null;
  setTab: (tab: WorkflowTab) => void;
  expand: (runId: string | null) => void;
  toggleCompare: (runId: string) => void;
  setComparing: (open: boolean) => void;
  openGate: (gate: GateTarget | null) => void;
  edit: (templateId: string | null) => void;
  start: (templateId: string | null) => void;
}

export const useWorkflowView = create<WorkflowView>((set) => ({
  tab: "templates",
  expanded: null,
  compare: [],
  comparing: false,
  gate: null,
  editing: null,
  starting: null,
  setTab: (tab) => set({ tab }),
  expand: (expanded) => set({ expanded }),
  toggleCompare: (runId) =>
    set((state) => {
      if (state.compare.includes(runId)) {
        return { compare: state.compare.filter((id) => id !== runId) };
      }
      // 第三次勾选挤掉最早的那次：对比永远是两次。
      return { compare: [...state.compare, runId].slice(-2) };
    }),
  setComparing: (comparing) => set({ comparing }),
  openGate: (gate) => set({ gate }),
  edit: (editing) => set({ editing }),
  start: (starting) => set({ starting }),
}));

export const workflowKeys = {
  get all() {
    return [...srcPrefix(), "workflow"] as const;
  },
  drafts: (boardId: string) =>
    [...srcPrefix(), "workflow", "drafts", boardId] as const,
  templates: () => [...srcPrefix(), "workflow", "templates"] as const,
  runs: (boardId: string) =>
    [...srcPrefix(), "workflow", "runs", boardId] as const,
};

/** 开工作流页，落在给定的页签上。 */
export function openWorkflowPanel(tab: WorkflowTab = "templates"): void {
  useWorkflowView.getState().setTab(tab);
  useCanvasStore.getState().setPanel("workflow", "drawer");
}

/**
 * 订阅三种 `workflow.*` 帧，重读列表。挂在常驻的草案层上：草案卡要在事件到达
 * 之前就订阅好，页面开不开都一样。
 */
export function useWorkflowEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () =>
      void client.invalidateQueries({ queryKey: workflowKeys.all });
    const offs = [
      onWorkspaceEvent("workflow.draft", refresh),
      onWorkspaceEvent("workflow.run", refresh),
      onWorkspaceEvent("workflow.gate", refresh),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);
}
