import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, X } from "lucide-react";
import {
  AGENT_IDS,
  type WorkflowDraft,
  type WorkflowFrozenSchedule,
  type WorkflowStep,
  type WorkflowTemplateJson,
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
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/ui/field";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Item } from "@/ui/item";
import { ScrollArea } from "@/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Textarea } from "@/ui/textarea";
import { useCanvasStore } from "@/store/canvas-store";
import { workflowErrorKey, workflowsApi } from "./api";
import {
  addRole,
  addStep,
  canSaveDraft,
  dependsOn,
  moveStep,
  removeRole,
  removeStep,
  roleInUse,
  updateRole,
} from "./model";
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

/** 本工作空间里能直接升级的冻结计划（参数相容的）。 */
export function upgradableSchedules(
  frozen: readonly WorkflowFrozenSchedule[],
  workspaceId: string | null | undefined,
): string[] {
  return frozen
    .filter(
      (item) =>
        item.workspaceId === workspaceId && item.reason === "compatible",
    )
    .map((item) => item.scheduleId);
}

/** 左列的一步：拖柄、序号与名字（点了选中）、种类、删除。 */
function StepItem({
  step,
  index,
  selected,
  removable,
  onSelect,
  onRemove,
}: {
  step: WorkflowStep;
  index: number;
  selected: boolean;
  removable: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const sortable = useSortable({ id: step.id });
  return (
    <Item
      ref={sortable.setNodeRef}
      role="listitem"
      size="xs"
      variant={selected ? "muted" : "default"}
      data-slot="workflow-editor-step"
      data-step-id={step.id}
      data-selected={selected}
      className="flex-nowrap gap-1 px-1 py-0.5"
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        zIndex: sortable.isDragging ? 1 : undefined,
      }}
    >
      <IconButton
        label={t("workflow.editor.reorder", { id: step.id })}
        data-slot="workflow-editor-step-handle"
        className="cursor-grab touch-none"
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical />
      </IconButton>
      <Button
        variant="ghost"
        size="sm"
        aria-current={selected || undefined}
        className="h-7 min-w-0 flex-1 justify-start gap-2 px-1 font-normal hover:bg-transparent"
        onClick={onSelect}
      >
        <span className="tabular-nums text-muted-foreground">{index + 1}</span>
        <span className="min-w-0 truncate">{step.id}</span>
        <span className="flex-1" />
        <Badge variant="outline" className="h-[18px] px-1 text-[11px]">
          {t(`workflow.kind.${step.kind}`)}
        </Badge>
      </Button>
      <IconButton
        label={t("workflow.editor.removeStep", { id: step.id })}
        data-slot="workflow-editor-step-remove"
        disabled={!removable}
        onClick={onRemove}
      >
        <X />
      </IconButton>
    </Item>
  );
}

/**
 * 模板编辑器（设计系统 §5.5）：整页对话框，左边步骤列表（可增删、拖排）、右边
 * 当前步骤的表单（角色、提示词、依赖；汇总多一列来源；关卡是说明与依赖），
 * 下面是角色（可增删、换 CLI）与参数缺省值。保存走
 * `PUT /api/workflows/templates/{id}`，版本号加一；别人先改过时 core 回
 * `template_version_stale`，这里如实说。答复里有冻结在旧版本上的定时计划时，
 * 提示一次并可直接把本工作空间里参数相容的升到新版本（契约 §15.6）。
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
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const [draft, setDraft] = React.useState<WorkflowDraft | null>(null);
  const [name, setName] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  React.useEffect(() => {
    setDraft(template ? template.template : null);
    setName(template?.name ?? "");
    setSelected(initialStep ?? template?.template.steps[0]?.id ?? null);
  }, [template, initialStep]);

  // 不挂在组件上：保存成功后编辑器就关了，提示里的按钮在那之后才会被点。
  const upgrade = (templateId: string, scheduleIds: string[]) => {
    workflowsApi
      .upgradeSchedules(templateId, workspaceId ?? "", scheduleIds)
      .then((result) => {
        void client.invalidateQueries({ queryKey: ["automation"] });
        toast.success(
          t("workflow.toast.upgraded", { count: result.upgraded.length }),
        );
      })
      .catch((error: unknown) => toast.error(t(workflowErrorKey(error))));
  };

  const save = useMutation({
    mutationFn: () =>
      workflowsApi.updateTemplate(template!.id, {
        name: name.trim() || template!.name,
        template: nextVersion(template!, draft!),
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: workflowKeys.all });
      void client.invalidateQueries({ queryKey: ["automation"] });
      const frozen = result.frozenSchedules;
      const ready = upgradableSchedules(frozen, workspaceId);
      if (frozen.length > 0) {
        toast.message(t("workflow.toast.frozen", { count: frozen.length }), {
          action:
            ready.length > 0
              ? {
                  label: t("workflow.upgrade"),
                  onClick: () => upgrade(result.template.id, ready),
                }
              : undefined,
        });
      } else {
        toast.success(t("workflow.toast.saved"));
      }
      onClose();
    },
    onError: (error) => toast.error(t(workflowErrorKey(error))),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const step = draft?.steps.find((item) => item.id === selected) ?? null;
  const patch = (value: Partial<WorkflowStep>) =>
    setDraft((current) =>
      current && selected ? updateStep(current, selected, value) : current,
    );
  const onDragEnd = (event: DragEndEvent) => {
    const over = event.over;
    if (!draft || !over || event.active.id === over.id) return;
    const ids = draft.steps.map((item) => item.id);
    setDraft(
      moveStep(
        draft,
        ids.indexOf(String(event.active.id)),
        ids.indexOf(String(over.id)),
      ),
    );
  };
  const add = (kind: WorkflowStep["kind"]) => {
    if (!draft) return;
    const next = addStep(draft, kind);
    setDraft(next.draft);
    setSelected(next.id);
  };
  const remove = (stepId: string) => {
    if (!draft) return;
    const next = removeStep(draft, stepId);
    setDraft(next);
    if (selected === stepId) setSelected(next.steps[0]?.id ?? null);
  };
  const agentChoices = (current: string) =>
    (AGENT_IDS as readonly string[]).includes(current)
      ? AGENT_IDS
      : [current, ...AGENT_IDS];

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
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-medium">
                {t("workflow.editor.steps")}
              </p>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    label={t("workflow.editor.addStep")}
                    data-slot="workflow-editor-add-step"
                    disabled={draft.steps.length >= 32}
                  >
                    <Plus />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="z-[var(--z-dialog)]"
                >
                  {(["prompt", "collect", "gate"] as const).map((kind) => (
                    <DropdownMenuItem
                      key={kind}
                      data-slot="workflow-editor-add-kind"
                      data-kind={kind}
                      disabled={kind === "collect" && draft.steps.length === 0}
                      onSelect={() => add(kind)}
                    >
                      {t(`workflow.kind.${kind}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <ScrollArea className="min-h-0 flex-1 max-sm:max-h-44 max-sm:flex-none">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={draft.steps.map((item) => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col gap-1" role="list">
                    {draft.steps.map((item, index) => (
                      <StepItem
                        key={item.id}
                        step={item}
                        index={index}
                        selected={item.id === selected}
                        removable={draft.steps.length > 1}
                        onSelect={() => setSelected(item.id)}
                        onRemove={() => remove(item.id)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
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
                  {step.kind === "collect" && draft.steps.length > 1 ? (
                    <FieldSet data-slot="workflow-editor-from">
                      <FieldLegend variant="label">
                        {t("workflow.editor.from")}
                      </FieldLegend>
                      <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {draft.steps
                          .filter((other) => other.id !== step.id)
                          .map((other) => (
                            <label
                              key={other.id}
                              className="flex items-center gap-1.5 text-[12px]"
                            >
                              <Checkbox
                                checked={step.from.includes(other.id)}
                                disabled={dependsOn(draft, other.id, step.id)}
                                onCheckedChange={(value) =>
                                  patch(
                                    value
                                      ? {
                                          from: [...step.from, other.id],
                                          after: step.after.includes(other.id)
                                            ? step.after
                                            : [...step.after, other.id],
                                        }
                                      : {
                                          from: step.from.filter(
                                            (id) => id !== other.id,
                                          ),
                                        },
                                  )
                                }
                              />
                              {other.id}
                            </label>
                          ))}
                      </div>
                    </FieldSet>
                  ) : null}
                  {draft.steps.length > 1 ? (
                    <FieldSet data-slot="workflow-editor-after">
                      <FieldLegend variant="label">
                        {t("workflow.editor.after")}
                      </FieldLegend>
                      <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {draft.steps
                          .filter((other) => other.id !== step.id)
                          .map((other) => {
                            const checked = step.after.includes(other.id);
                            // collect 的来源必须在依赖里：不许取消；
                            // 等着这一步的步骤不能再被它依赖（会成环）。
                            const locked =
                              (step.kind === "collect" &&
                                step.from.includes(other.id)) ||
                              (!checked && dependsOn(draft, other.id, step.id));
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
              <FieldSet data-slot="workflow-editor-roles">
                <div className="flex items-center justify-between">
                  <FieldLegend variant="label" className="mb-0">
                    {t("workflow.editor.roles")}
                  </FieldLegend>
                  <IconButton
                    label={t("workflow.editor.addRole")}
                    data-slot="workflow-editor-add-role"
                    disabled={draft.roles.length >= 8}
                    onClick={() => setDraft(addRole(draft).draft)}
                  >
                    <Plus />
                  </IconButton>
                </div>
                <FieldGroup className="gap-2">
                  {draft.roles.map((role) => (
                    <div
                      key={role.id}
                      data-slot="workflow-editor-role"
                      data-role-id={role.id}
                      className="flex min-w-0 items-center gap-2"
                    >
                      <span className="w-16 shrink-0 truncate font-mono text-[12px]">
                        {role.id}
                      </span>
                      <Input
                        aria-label={t("workflow.editor.roleTitle", {
                          id: role.id,
                        })}
                        placeholder={role.id}
                        className="h-8 min-w-0 flex-1"
                        maxLength={160}
                        value={role.title ?? ""}
                        onChange={(event) =>
                          setDraft(
                            updateRole(draft, role.id, {
                              title:
                                event.target.value === ""
                                  ? null
                                  : event.target.value,
                            }),
                          )
                        }
                      />
                      <Select
                        value={role.agentId}
                        onValueChange={(agentId) =>
                          setDraft(updateRole(draft, role.id, { agentId }))
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-32 shrink-0"
                          aria-label={t("workflow.editor.roleAgent", {
                            id: role.id,
                          })}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="z-[var(--z-dialog)]">
                          {agentChoices(role.agentId).map((agentId) => (
                            <SelectItem key={agentId} value={agentId}>
                              {agentId}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <IconButton
                        label={t("workflow.editor.removeRole", { id: role.id })}
                        data-slot="workflow-editor-role-remove"
                        disabled={
                          draft.roles.length <= 1 || roleInUse(draft, role.id)
                        }
                        onClick={() => setDraft(removeRole(draft, role.id))}
                      >
                        <X />
                      </IconButton>
                    </div>
                  ))}
                </FieldGroup>
              </FieldSet>
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
        disabled={save.isPending || draft === null || !canSaveDraft(draft)}
        onClick={() => save.mutate()}
      >
        {t("workflow.editor.save")}
      </Button>
    </>
  );

  if (inline) {
    // 展示页与无对话框的宿主：同一份表单，平铺在一块卡片里。
    return (
      <Card
        data-slot="workflow-editor"
        role="region"
        aria-label={title}
        className="min-w-0 gap-3 overflow-visible rounded-xl border border-border p-4 py-4 text-[length:inherit] ring-0 sm:h-[560px]"
      >
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {content}
        <div className="flex justify-end gap-2">{actions}</div>
      </Card>
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
