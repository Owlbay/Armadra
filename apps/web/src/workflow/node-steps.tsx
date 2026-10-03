import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";

import { useT } from "@/app/preferences-store";
import { useAccess } from "@/app/use-access";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { type WorkflowRunJson, workflowsApi } from "./api";
import { workflowKeys } from "./store";

/**
 * 画布上「第 n 步」（设计系统 §4「工作流运行」）：运行中的工作流里，正在跑
 * 的那一步对应的节点头部、状态胶囊前多一枚 `Badge secondary`。
 *
 * 运行列表每块画板只取一次（与工作流页同一个查询键，`workflow.run` 帧到了
 * 由 `useWorkflowEvents` 失效重取），算成「节点 → 第几步」放进这张小表；节点
 * 只读表，不各自发请求。
 */
export const useWorkflowNodeSteps = create<{
  steps: Readonly<Record<string, number>>;
}>(() => ({ steps: {} }));

/** 运行中的运行里，正在跑的步骤 → 节点 → 从 1 起的步号。 */
export function nodeSteps(
  runs: readonly WorkflowRunJson[],
): Record<string, number> {
  const steps: Record<string, number> = {};
  for (const run of runs) {
    if (run.status !== "running" && run.status !== "waiting") continue;
    run.steps.forEach((step, index) => {
      if (step.status === "running" && step.nodeId)
        steps[step.nodeId] = index + 1;
    });
  }
  return steps;
}

/**
 * 取当前画板的运行列表并写表。由常驻的草案层（`DraftLayer`）调用：它与草案卡
 * 一样要在页面开不开都在。
 */
export function useWorkflowStepSync(): void {
  const boardId = useCanvasStore((state) => state.boardId);
  // 工作流路由对成员一律 403（契约 §15）：成员不取。
  const member = useAccess().member;
  const runs = useQuery({
    queryKey: workflowKeys.runs(boardId ?? ""),
    queryFn: () => workflowsApi.runs({ boardId: boardId!, limit: 50 }),
    enabled: Boolean(boardId) && !member,
    retry: false,
  });
  const data = runs.data;
  React.useEffect(() => {
    useWorkflowNodeSteps.setState({ steps: data ? nodeSteps(data) : {} });
  }, [data]);
}

/** 节点头部的「第 n 步」；不在运行中的步骤里就不画。 */
export function WorkflowStepBadge({ nodeId }: { nodeId: string }) {
  const t = useT();
  const step = useWorkflowNodeSteps((state) => state.steps[nodeId]);
  if (!step) return null;
  return (
    <Badge
      variant="secondary"
      data-slot="workflow-step-badge"
      className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
    >
      {t("workflow.node.step", { n: String(step) })}
    </Badge>
  );
}
