import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarClock,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
  Workflow,
} from "lucide-react";
import type { WorkflowRunJson, WorkflowTemplateJson } from "@armadra/shared";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { scheduleWorkflow } from "@/panels/automation/open";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/ui/field";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { workflowErrorKey, workflowsApi } from "./api";
import {
  defaultParams,
  filledParams,
  missingParams,
  templateStats,
} from "./model";
import { useWorkflowView, workflowKeys } from "./store";

/** 「2 天前」——按当前语言。 */
export function relativeTime(
  iso: string,
  locale: string,
  now = Date.now(),
): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size)
      return format.format(Math.round(seconds / size), unit);
  }
  return format.format(seconds, "second");
}

export interface TemplateLibraryProps {
  templates: readonly WorkflowTemplateJson[];
  runs: readonly WorkflowRunJson[];
  /** 读的人没有起跑的权限时只看。 */
  canRun?: boolean;
  /** 「上次 n 天前」的参照时刻；缺省现在（展示页钉住它）。 */
  now?: number;
}

/**
 * 模板库（设计系统 §5.5）：Card 网格，每张卡三个数与「运行」「编辑」，其余动作
 * （定时运行、删除）在「更多」里。空态只有一句话。
 */
export function TemplateLibrary({
  templates,
  runs,
  canRun = true,
  now,
}: TemplateLibraryProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const start = useWorkflowView((state) => state.start);
  const edit = useWorkflowView((state) => state.edit);
  const [deleting, setDeleting] = React.useState<WorkflowTemplateJson | null>(
    null,
  );
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => workflowsApi.deleteTemplate(id),
    onSuccess: () => client.invalidateQueries({ queryKey: workflowKeys.all }),
    onError: (error) => toast.error(t(workflowErrorKey(error))),
  });

  if (templates.length === 0) {
    return (
      <Empty data-slot="workflow-library-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Workflow />
          </EmptyMedia>
          <EmptyTitle className="text-[13px] font-normal text-muted-foreground">
            {t("workflow.library.empty")}
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <div
        data-slot="workflow-library"
        className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3"
      >
        {templates.map((template) => {
          const stats = templateStats(template, runs);
          return (
            <Card
              key={template.id}
              size="sm"
              data-slot="workflow-template"
              data-template-id={template.id}
              className="h-full min-w-0"
            >
              <CardHeader>
                <CardTitle className="truncate text-[13px]">
                  {template.name}
                </CardTitle>
                <CardDescription className="truncate text-[12px]">
                  {t("workflow.library.stats", {
                    roles: stats.roles,
                    steps: stats.steps,
                  })}{" "}
                  ·{" "}
                  {stats.lastRunAt
                    ? t("workflow.library.lastRun", {
                        when: relativeTime(stats.lastRunAt, locale, now),
                      })
                    : t("workflow.library.never")}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex min-w-0 flex-1 flex-wrap content-start gap-1">
                {template.template.roles.map((role) => (
                  <span
                    key={role.id}
                    className="truncate rounded-[var(--r-control)] bg-muted px-1.5 text-[11px] leading-[18px] text-muted-foreground"
                  >
                    {role.title ?? role.id} · {role.agentId}
                  </span>
                ))}
              </CardContent>
              <CardFooter className="gap-1 border-t border-border py-2">
                <Button
                  size="sm"
                  disabled={!canRun}
                  data-slot="workflow-run"
                  onClick={() => start(template.id)}
                >
                  <Play />
                  {t("workflow.run")}
                </Button>
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canRun}
                  onClick={() => edit(template.id)}
                >
                  <Pencil />
                  {t("workflow.edit")}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton label={t("workflow.more")} disabled={!canRun}>
                      <MoreHorizontal />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() =>
                        scheduleWorkflow({
                          templateId: template.id,
                          name: template.name,
                          params: {},
                        })
                      }
                    >
                      <CalendarClock />
                      {t("workflow.schedule")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setDeleting(template)}
                    >
                      <Trash2 />
                      {t("workflow.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardFooter>
            </Card>
          );
        })}
      </div>
      <ResponsiveAlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("workflow.delete.title", { name: deleting?.name ?? "" })}
            </ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {t("workflow.delete.body")}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("workflow.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) remove.mutate(deleting.id);
                setDeleting(null);
              }}
            >
              {t("workflow.delete")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}

/**
 * 起跑：模板有参数时先填参数，没有就一步到位。画布是当前这块。
 */
export function StartRunDialog({
  template,
  onClose,
}: {
  template: WorkflowTemplateJson | null;
  onClose: () => void;
}) {
  const t = useT();
  const boardId = useCanvasStore((state) => state.boardId);
  const setTab = useWorkflowView((state) => state.setTab);
  const expand = useWorkflowView((state) => state.expand);
  const client = useQueryClient();
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [missing, setMissing] = React.useState<string[]>([]);
  React.useEffect(() => {
    setValues({});
    setMissing([]);
  }, [template?.id]);

  const run = useMutation({
    mutationFn: () =>
      workflowsApi.startRun({
        templateId: template!.id,
        params: filledParams(values),
        boardId: boardId!,
      }),
    onSuccess: (started) => {
      void client.invalidateQueries({ queryKey: workflowKeys.all });
      toast.success(t("workflow.toast.started"));
      setTab("runs");
      expand(started.id);
      onClose();
    },
    onError: (error) => toast.error(t(workflowErrorKey(error))),
  });

  /** 改一个参数：它的「没填」提示跟着消失。 */
  function edit(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    setMissing((current) => current.filter((item) => item !== name));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!template) return;
    const gaps = missingParams(template.template, {
      ...defaultParams(template.template),
      ...values,
    });
    setMissing(gaps);
    if (gaps.length > 0 || !boardId) return;
    run.mutate();
  }

  return (
    <ResponsiveDialog
      open={template !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent className="sm:max-w-[440px]">
        <form className="grid gap-4" onSubmit={submit}>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t("workflow.start.title", { name: template?.name ?? "" })}
            </ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          {template && template.template.params.length > 0 ? (
            <FieldGroup className="gap-3">
              {template.template.params.map((param) => {
                const long = param.type === "text";
                const id = `workflow-param-${param.name}`;
                return (
                  <Field
                    key={param.name}
                    data-invalid={missing.includes(param.name) || undefined}
                  >
                    <FieldLabel htmlFor={id}>
                      {param.label ?? param.name}
                    </FieldLabel>
                    {long ? (
                      <Textarea
                        id={id}
                        rows={3}
                        value={values[param.name] ?? ""}
                        placeholder={param.default ?? ""}
                        aria-invalid={missing.includes(param.name) || undefined}
                        onChange={(event) =>
                          edit(param.name, event.target.value)
                        }
                      />
                    ) : (
                      <Input
                        id={id}
                        value={values[param.name] ?? ""}
                        placeholder={param.default ?? ""}
                        aria-invalid={missing.includes(param.name) || undefined}
                        onChange={(event) =>
                          edit(param.name, event.target.value)
                        }
                      />
                    )}
                  </Field>
                );
              })}
              {missing.length > 0 ? (
                <FieldError>{t("workflow.error.missing_param")}</FieldError>
              ) : null}
            </FieldGroup>
          ) : null}
          {!boardId ? (
            <FieldError>{t("workflow.start.noBoard")}</FieldError>
          ) : null}
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("workflow.cancel")}
            </Button>
            <Button
              type="submit"
              data-slot="workflow-start-submit"
              disabled={run.isPending || !boardId}
            >
              <Play />
              {t("workflow.run")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
