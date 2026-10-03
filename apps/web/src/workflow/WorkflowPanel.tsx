import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, X } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { useAccess } from "@/app/use-access";
import { WorkPanelSheet } from "@/panels/WorkPanelSheet";
import { TABS_CONTENT_FOCUS } from "@/panels/tabs-focus";
import { useCanvasStore } from "@/store/canvas-store";
import { Alert, AlertTitle } from "@/ui/alert";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { SheetTitle } from "@/ui/sheet";
import { Skeleton } from "@/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { workflowErrorKey, workflowsApi } from "./api";
import { GateDialog } from "./GateDialog";
import { RunCompare } from "./RunCompare";
import { RunPanel } from "./RunPanel";
import { StartRunDialog, TemplateLibrary } from "./TemplateLibrary";
import { TemplateEditor } from "./TemplateEditor";
import { type WorkflowTab, useWorkflowView, workflowKeys } from "./store";

/**
 * 工作面板的「工作流」页（设计系统 §5.5）：模板库与当前画布的运行记录两个
 * 页签；起跑、编辑、关卡答复与对比是从这里开的对话框。
 */
export function WorkflowPanel() {
  const t = useT();
  const mode = useCanvasStore((state) => state.panels.workflow);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const boardId = useCanvasStore((state) => state.boardId);
  const view = useWorkflowView();
  const client = useQueryClient();
  // 成员访问工作流路由一律 403（契约 §15）：不发请求，只说没有权限。
  const member = useAccess().member;
  const open = mode === "drawer" && !member;

  const templates = useQuery({
    queryKey: workflowKeys.templates(),
    queryFn: () => workflowsApi.templates(),
    enabled: open,
    retry: false,
  });
  const runs = useQuery({
    queryKey: workflowKeys.runs(boardId ?? ""),
    queryFn: () => workflowsApi.runs({ boardId: boardId!, limit: 50 }),
    enabled: open && Boolean(boardId),
    retry: false,
  });
  const close = () => setPanel("workflow", "closed");
  const templateOf = (id: string | null) =>
    templates.data?.find((item) => item.id === id) ?? null;
  const runOf = (id: string | undefined) =>
    runs.data?.find((item) => item.id === id) ?? null;
  const failure = templates.error ?? runs.error;

  return (
    <>
      <WorkPanelSheet panel="workflow" open={mode === "drawer"} onClose={close}>
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
          <SheetTitle className="shrink-0 truncate text-[13px] font-semibold">
            {t("workflow.title")}
          </SheetTitle>
          <div className="flex-1" />
          <IconButton
            label={t("workflow.reload")}
            onClick={() =>
              void client.invalidateQueries({ queryKey: workflowKeys.all })
            }
          >
            <RotateCw />
          </IconButton>
          <IconButton label={t("workflow.close")} onClick={close}>
            <X />
          </IconButton>
        </div>
        <Tabs
          value={view.tab}
          onValueChange={(value) => view.setTab(value as WorkflowTab)}
          className="min-h-0 min-w-0 flex-1 gap-0"
        >
          <TabsList
            variant="line"
            className="h-10 w-full shrink-0 rounded-none border-b border-border"
          >
            {(["templates", "runs"] as const).map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className="min-w-0 text-xs"
              >
                {t(`workflow.tab.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {(["templates", "runs"] as const).map((value) => (
            <TabsContent
              key={value}
              value={value}
              className={`mt-0 flex min-h-0 flex-col data-[state=inactive]:hidden ${TABS_CONTENT_FOCUS}`}
            >
              <ScrollArea className="min-h-0 flex-1">
                <div className="min-w-0 p-3">
                  {member ? (
                    <Alert>
                      <AlertTitle className="font-normal">
                        {t("workflow.error.forbidden")}
                      </AlertTitle>
                    </Alert>
                  ) : failure ? (
                    <Alert variant="destructive">
                      <AlertTitle className="font-normal break-words">
                        {t(workflowErrorKey(failure))}
                      </AlertTitle>
                    </Alert>
                  ) : templates.isPending ? (
                    <div
                      className="space-y-2"
                      aria-label={t("workflow.loading")}
                    >
                      <Skeleton className="h-24 w-full" />
                      <Skeleton className="h-24 w-full" />
                    </div>
                  ) : value === "templates" ? (
                    <TemplateLibrary
                      templates={templates.data ?? []}
                      runs={runs.data ?? []}
                    />
                  ) : (
                    <RunPanel
                      runs={runs.data ?? []}
                      templates={templates.data ?? []}
                    />
                  )}
                </div>
              </ScrollArea>
            </TabsContent>
          ))}
        </Tabs>
      </WorkPanelSheet>
      <StartRunDialog
        template={templateOf(view.starting)}
        onClose={() => view.start(null)}
      />
      <TemplateEditor
        template={templateOf(view.editing)}
        onClose={() => view.edit(null)}
      />
      <GateDialog />
      <RunCompare
        open={view.comparing}
        left={runOf(view.compare[0])}
        right={runOf(view.compare[1])}
        onClose={() => view.setComparing(false)}
      />
    </>
  );
}
