import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  WorkflowDraft,
  WorkflowStep,
  WorkflowTemplateJson,
} from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/ui/field";
import { Input } from "@/ui/input";
import { ScrollArea } from "@/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Textarea } from "@/ui/textarea";
import { workflowErrorKey, workflowsApi } from "./api";
import { workflowKeys } from "./store";

/** 改一步：只动这一步，其余原样。 */
export function updateStep(
  draft: WorkflowDraft,
  stepId: string,
  patch: Partial<WorkflowStep>,
): WorkflowDraft {
  return {
    ...draft,
    steps: draft.steps.map((step) =>
      step.id === stepId ? ({ ...step, ...patch } as WorkflowStep) : step,
    ),
  };
}

/** 保存时的模板：`version` 只增（契约 §15.2）。 */
export function nextVersion(
  template: WorkflowTemplateJson,
  draft: WorkflowDraft,
): WorkflowDraft {
  return { ...draft, version: Math.max(template.version, draft.version) + 1 };
}

/**
 * 模板编辑器（设计系统 §5.5）：整页对话框，左边步骤列表、右边当前步骤的表单
 * （角色、提示词、依赖；关卡是说明与依赖）。参数的缺省值与名称在顶上。
 * 保存走 `PUT /api/workflows/templates/{id}`，版本号加一；别人先改过时
 * core 回 `template_version_stale`，这里如实说。
 */
export function TemplateEditor({
  template,
  onClose,
  initialStep,
  inline = false,
}: {
  template: WorkflowTemplateJson | null;
  onClose: () => void;
  /** 打开时选中的步骤；缺省第一步。 */
  initialStep?: string;
  /** 不套对话框，平铺渲染（展示页）。 */
  inline?: boolean;
}) {
  const t = useT();
  const client = useQueryClient();
  const [draft, setDraft] = React.useState<WorkflowDraft | null>(null);
  const [name, setName] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  React.useEffect(() => {
    setDraft(template ? template.template : null);
    setName(template?.name ?? "");
    setSelected(initialStep ?? template?.template.steps[0]?.id ?? null);
  }, [template, initialStep]);

  const save = useMutation({
    mutationFn: () =>
      workflowsApi.updateTemplate(template!.id, {
        name: name.trim() || template!.name,
        template: nextVersion(template!, draft!),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: workflowKeys.all });
      toast.success(t("workflow.toast.saved"));
      onClose();
    },
    onError: (error) => toast.error(t(workflowErrorKey(error))),
  });

  const step = draft?.steps.find((item) => item.id === selected) ?? null;
  const patch = (value: Partial<WorkflowStep>) =>
    setDraft((current) =>
      current && selected ? updateStep(current, selected, value) : current,
    );

  const title = t("workflow.editor.title", { name: template?.name ?? "" });
  const content = (
    <>
      {draft ? (
        <div className="grid min-h-0 flex-1 gap-4 max-sm:overflow-y-auto sm:grid-cols-[240px_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col gap-2">
            <Field>
              <FieldLabel htmlFor="workflow-editor-name">
                {t("workflow.editor.name")}
              </FieldLabel>
              <Input
                id="workflow-editor-name"
                value={name}
                maxLength={160}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <p className="text-[12px] font-medium">
              {t("workflow.editor.steps")}
            </p>
            <ScrollArea className="min-h-0 flex-1 max-sm:max-h-44 max-sm:flex-none">
              <div className="flex flex-col gap-1" role="list">
                {draft.steps.map((item, index) => (
                  <Button
                    key={item.id}
                    role="listitem"
                    variant={item.id === selected ? "secondary" : "ghost"}
                    size="sm"
                    data-slot="workflow-editor-step"
                    data-selected={item.id === selected}
                    aria-current={item.id === selected || undefined}
                    className="h-8 w-full justify-start gap-2 font-normal"
                    onClick={() => setSelected(item.id)}
                  >
                    <span className="tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <span className="min-w-0 truncate">{item.id}</span>
                    <span className="flex-1" />
                    <Badge
                      variant="outline"
                      className="h-[18px] px-1 text-[11px]"
                    >
                      {t(`workflow.kind.${item.kind}`)}
                    </Badge>
                  </Button>
                ))}
              </div>
            </ScrollArea>
          </div>
          <ScrollArea className="min-h-0">
            <div className="min-w-0 space-y-4 pr-2">
              {step ? (
                <FieldGroup className="gap-3" data-slot="workflow-editor-form">
                  {step.kind === "gate" ? (
                    <Field>
                      <FieldLabel htmlFor="workflow-editor-label">
                        {t("workflow.editor.label")}
                      </FieldLabel>
                      <Input
                        id="workflow-editor-label"
                        value={step.label}
                        maxLength={160}
                        onChange={(event) =>
                          patch({ label: event.target.value })
                        }
                      />
                    </Field>
                  ) : (
                    <>
                      <Field>
                        <FieldLabel>{t("workflow.editor.role")}</FieldLabel>
                        <Select
                          value={step.role}
                          onValueChange={(role) => patch({ role })}
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-full"
                            aria-label={t("workflow.editor.role")}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="z-[var(--z-dialog)]">
                            {draft.roles.map((role) => (
                              <SelectItem key={role.id} value={role.id}>
                                {role.title ?? role.id} · {role.agentId}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="workflow-editor-prompt">
                          {t("workflow.editor.prompt")}
                        </FieldLabel>
                        <Textarea
                          id="workflow-editor-prompt"
                          rows={6}
                          maxLength={2000}
                          value={step.prompt}
                          onChange={(event) =>
                            patch({ prompt: event.target.value })
                          }
                        />
                      </Field>
                    </>
                  )}
                  {draft.steps.length > 1 ? (
                    <FieldSet>
                      <FieldLegend variant="label">
                        {t("workflow.editor.after")}
                      </FieldLegend>
                      <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {draft.steps
                          .filter((other) => other.id !== step.id)
                          .map((other) => {
                            const checked = step.after.includes(other.id);
                            // collect 的来源必须在依赖里：不许取消。
                            const locked =
                              step.kind === "collect" &&
                              step.from.includes(other.id);
                            return (
                              <label
                                key={other.id}
                                className="flex items-center gap-1.5 text-[12px]"
                              >
                                <Checkbox
                                  checked={checked}
                                  disabled={locked}
                                  onCheckedChange={(value) =>
                                    patch({
                                      after: value
                                        ? [...step.after, other.id]
                                        : step.after.filter(
                                            (id) => id !== other.id,
                                          ),
                                    })
                                  }
                                />
                                {other.id}
                              </label>
                            );
                          })}
                      </div>
                    </FieldSet>
                  ) : null}
                </FieldGroup>
              ) : null}
              {draft.params.length > 0 ? (
                <FieldSet>
                  <FieldLegend variant="label">
                    {t("workflow.editor.params")}
                  </FieldLegend>
                  <FieldGroup className="gap-2">
                    {draft.params.map((param, index) => (
                      <Field key={param.name} orientation="horizontal">
                        <FieldLabel
                          htmlFor={`workflow-editor-param-${param.name}`}
                          className="w-32 shrink-0 font-mono text-[12px]"
                        >
                          {param.name}
                        </FieldLabel>
                        <Input
                          id={`workflow-editor-param-${param.name}`}
                          placeholder={t("workflow.editor.default")}
                          value={param.default ?? ""}
                          onChange={(event) =>
                            setDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    params: current.params.map((item, at) =>
                                      at === index
                                        ? {
                                            ...item,
                                            default:
                                              event.target.value === ""
                                                ? null
                                                : event.target.value,
                                          }
                                        : item,
                                    ),
                                  }
                                : current,
                            )
                          }
                        />
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>
              ) : null}
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </>
  );
  const actions = (
    <>
      <Button variant="outline" onClick={onClose}>
        {t("workflow.cancel")}
      </Button>
      <Button
        data-slot="workflow-editor-save"
        disabled={save.isPending || draft === null}
        onClick={() => save.mutate()}
      >
        {t("workflow.editor.save")}
      </Button>
    </>
  );

  if (inline) {
    // 展示页与无对话框的宿主：同一份表单，平铺在一块卡片里。
    return (
      <section
        data-slot="workflow-editor"
        aria-label={title}
        className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:h-[560px]"
      >
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {content}
        <div className="flex justify-end gap-2">{actions}</div>
      </section>
    );
  }

  return (
    <ResponsiveDialog
      open={template !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent
        data-slot="workflow-editor"
        className="flex h-[min(680px,calc(100dvh-48px))] flex-col gap-3 sm:max-w-[920px]"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {content}
        <ResponsiveDialogFooter>{actions}</ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
