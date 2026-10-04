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
  /** 运行中的运行里已完成、且眼下没有别的步骤在跑的角色节点。 */
  done?: Readonly<Record<string, true>>;
}>(() => ({ steps: {}, done: {} }));

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
 * 运行中的运行里，已经做完自己那一步的角色节点（设计系统 §4「完成的节点边框
 * 1px `--success`」）。同一个节点还有一步在跑就不算——那时它画的是「第 n 步」。
 */
export function doneNodes(
  runs: readonly WorkflowRunJson[],
): Record<string, true> {
  const running = nodeSteps(runs);
  const done: Record<string, true> = {};
  for (const run of runs) {
    if (run.status !== "running" && run.status !== "waiting") continue;
    for (const step of run.steps) {
      if (step.status === "done" && step.nodeId && !running[step.nodeId])
        done[step.nodeId] = true;
    }
  }
  return done;
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
    useWorkflowNodeSteps.setState({
      steps: data ? nodeSteps(data) : {},
      done: data ? doneNodes(data) : {},
    });
  }, [data]);
}

/**
 * 节点头部的「第 n 步」；不在运行中的步骤里就不画。已完成的角色节点画一个不
 * 占位的标记，节点外框据此换成 1px `--success`（`styles/nodes.css`）。
 */
export function WorkflowStepBadge({ nodeId }: { nodeId: string }) {
  const t = useT();
  const step = useWorkflowNodeSteps((state) => state.steps[nodeId]);
  const done = useWorkflowNodeSteps((state) => state.done?.[nodeId] === true);
  if (!step) {
    return done ? (
      <span data-workflow-done="true" hidden aria-hidden="true" />
    ) : null;
  }
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
