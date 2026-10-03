import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Workflow } from "lucide-react";
import type { WorkflowDraftRow } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { useAccess } from "@/app/use-access";
import { Button } from "@/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/ui/card";
import { Input } from "@/ui/input";
import { useCanvasStore } from "@/store/canvas-store";
import { workflowErrorKey, workflowsApi } from "./api";
import { useWorkflowStepSync } from "./node-steps";
import { openWorkflowPanel, useWorkflowEvents, workflowKeys } from "./store";

/**
 * 草案卡（设计系统 §5.5）：协调者 `workflow_propose` 落库的草案在当前画布上
 * 浮出来，名称可改，「保存为工作流」入模板库，「丢弃」收掉。卡浮在画布上而
 * 不进画布文档：草案是 core 的一行，不是用户画的东西。
 *
 * 这一层常驻（`Overlays` 的事件订阅组）：`workflow.draft` 到达之前就要订阅好。
 */
export function DraftLayer() {
  useWorkflowEvents();
  // 画布节点头部的「第 n 步」读这张表（设计系统 §4）。
  useWorkflowStepSync();
  const boardId = useCanvasStore((state) => state.boardId);
  // 工作流路由对成员一律 403（契约 §15）：成员不取、不显示草案卡。
  const member = useAccess().member;
  const drafts = useQuery({
    queryKey: workflowKeys.drafts(boardId ?? ""),
    queryFn: () =>
      workflowsApi.drafts({ boardId: boardId!, status: "pending" }),
    enabled: Boolean(boardId) && !member,
    retry: false,
  });
  const pending = drafts.data ?? [];
  if (pending.length === 0) return null;
  return (
    <div
      data-slot="workflow-drafts"
      className="pointer-events-none fixed top-14 left-1/2 z-[var(--z-banners)] flex w-[min(360px,calc(100vw-24px))] -translate-x-1/2 flex-col gap-2"
    >
      {pending.slice(0, 3).map((row) => (
        <DraftCard key={row.id} row={row} />
      ))}
    </div>
  );
}

export function DraftCard({ row }: { row: WorkflowDraftRow }) {
  const t = useT();
  const client = useQueryClient();
  const [name, setName] = React.useState(row.draft.title);
  const refresh = () =>
    client.invalidateQueries({ queryKey: workflowKeys.all });
  const save = useMutation({
    mutationFn: () =>
      workflowsApi.confirmDraft(row.id, {
        ...(name.trim() && name.trim() !== row.draft.title
          ? { name: name.trim() }
          : {}),
      }),
    onSuccess: () => {
      void refresh();
      toast.success(t("workflow.toast.saved"));
      openWorkflowPanel("templates");
    },
    onError: (error) => toast.error(t(workflowErrorKey(error))),
  });
  const discard = useMutation({
    mutationFn: () => workflowsApi.discardDraft(row.id),
    onSuccess: () => void refresh(),
    onError: (error) => toast.error(t(workflowErrorKey(error))),
  });
  const busy = save.isPending || discard.isPending;
  return (
    <Card
      size="sm"
      data-slot="workflow-draft"
      data-draft-id={row.id}
      className="pointer-events-auto min-w-0 gap-2 shadow-[var(--shadow-node)]"
    >
      <CardHeader className="gap-0.5">
        <CardDescription className="flex items-center gap-1 text-[11px]">
          <Workflow className="size-3.5" />
          {t("workflow.draft.label")}
        </CardDescription>
        <CardTitle className="truncate text-[13px]">
          {row.draft.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 space-y-2">
        <p className="truncate text-[12px] text-muted-foreground">
          {t("workflow.library.stats", {
            roles: row.draft.roles.length,
            steps: row.draft.steps.length,
          })}
          {" · "}
          {row.draft.roles.map((role) => role.agentId).join(" / ")}
        </p>
        <Input
          aria-label={t("workflow.draft.name")}
          value={name}
          maxLength={160}
          onChange={(event) => setName(event.target.value)}
        />
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          data-slot="workflow-draft-discard"
          onClick={() => discard.mutate()}
        >
          {t("workflow.draft.discard")}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          data-slot="workflow-draft-save"
          onClick={() => save.mutate()}
        >
          {t("workflow.draft.save")}
        </Button>
      </CardFooter>
    </Card>
  );
}
