import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ChevronRight,
  GitCompareArrows,
  ListChecks,
  Square,
} from "lucide-react";
import type {
  WorkflowRunJson,
  WorkflowRunStepJson,
  WorkflowTemplateJson,
} from "@armadra/shared";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/ui/item";
import { StatusPill } from "@/ui/status-pill";
import { workflowErrorKey, workflowsApi } from "./api";
import {
  finished,
  outputCount,
  paramSummary,
  runTone,
  stepTone,
  waitingGates,
} from "./model";
import { useWorkflowView, workflowKeys } from "./store";

function clock(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * 运行记录（设计系统 §5.5）：时间 · 模板 · 参数摘要 · 状态 · 产出 · 对比。
 * 工作面板只有一栏宽，所以按手机的形态用 Item 列表；点一行展开看每一步的
 * 节点、产出（`post` 正文）与关卡答复。
 */
export function RunPanel({
  runs,
  templates = [],
  canAct = true,
}: {
  runs: readonly WorkflowRunJson[];
  /** 关卡的说明从模板里取（运行行上只有步骤 id）。 */
  templates?: readonly WorkflowTemplateJson[];
  canAct?: boolean;
}) {
  const t = useT();
  const compare = useWorkflowView((state) => state.compare);
  const toggleCompare = useWorkflowView((state) => state.toggleCompare);
  const setComparing = useWorkflowView((state) => state.setComparing);

  if (runs.length === 0) {
    return (
      <Empty data-slot="workflow-runs-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListChecks />
          </EmptyMedia>
          <EmptyTitle className="text-[13px] font-normal text-muted-foreground">
            {t("workflow.runs.empty")}
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 items-center justify-end">
        <Button
          size="sm"
          variant="outline"
          data-slot="workflow-compare"
          disabled={compare.length !== 2}
          onClick={() => setComparing(true)}
        >
          <GitCompareArrows />
          {t("workflow.runs.compareSelected")}
        </Button>
      </div>
      <ItemGroup className="gap-1.5" data-slot="workflow-runs">
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            selected={compare.includes(run.id)}
            onToggleCompare={() => toggleCompare(run.id)}
            canAct={canAct}
            templates={templates}
          />
        ))}
      </ItemGroup>
    </div>
  );
}

function RunRow({
  run,
  selected,
  onToggleCompare,
  canAct,
  templates,
}: {
  run: WorkflowRunJson;
  selected: boolean;
  onToggleCompare: () => void;
  canAct: boolean;
  templates: readonly WorkflowTemplateJson[];
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const expanded = useWorkflowView((state) => state.expanded === run.id);
  const expand = useWorkflowView((state) => state.expand);
  const openGate = useWorkflowView((state) => state.openGate);
  const client = useQueryClient();
  const stop = useMutation({
    mutationFn: () => workflowsApi.cancelRun(run.id),
    onSuccess: () => client.invalidateQueries({ queryKey: workflowKeys.all }),
    onError: (error) => toast.error(t(workflowErrorKey(error))),
  });
  const gate = waitingGates(run)[0];
  const params = paramSummary(run.params);
  const outputs = outputCount(run);

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(open) => expand(open ? run.id : null)}
    >
      <Item
        variant="outline"
        size="xs"
        data-slot="workflow-run-row"
        data-run-id={run.id}
        data-status={run.status}
        className="min-w-0 flex-nowrap"
      >
        <Checkbox
          checked={selected}
          aria-label={t("workflow.runs.compare")}
          onCheckedChange={onToggleCompare}
        />
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("workflow.runs.details")}
            className="shrink-0"
          >
            <ChevronRight
              className={cn("transition-transform", expanded && "rotate-90")}
            />
          </Button>
        </CollapsibleTrigger>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="w-full min-w-0 text-[12px]">
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {clock(run.startedAt, locale)}
            </span>
            <span className="min-w-0 truncate">{run.title}</span>
          </ItemTitle>
          {params || outputs > 0 ? (
            <ItemDescription className="truncate text-[11px]">
              {[
                params,
                outputs > 0
                  ? t("workflow.runs.outputs", { count: outputs })
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions className="shrink-0 gap-1">
          {gate && canAct ? (
            <Button
              size="xs"
              data-slot="workflow-gate-open"
              onClick={() =>
                openGate({
                  runId: run.id,
                  stepId: gate.stepId,
                  label: gateLabel(run, gate.stepId, templates),
                })
              }
            >
              {t("workflow.runs.answer")}
            </Button>
          ) : null}
          <StatusPill
            tone={runTone(run.status)}
            label={t(`workflow.status.${run.status}`)}
          />
        </ItemActions>
      </Item>
      <CollapsibleContent>
        <div className="ml-6 min-w-0 space-y-1.5 border-l border-border py-2 pl-3">
          {run.reason ? (
            <p className="text-[11px] text-muted-foreground">
              {t("workflow.runs.reason", { reason: run.reason })}
            </p>
          ) : null}
          {run.steps.map((step) => (
            <StepLine key={step.stepId} step={step} />
          ))}
          {!finished(run) && canAct ? (
            <Button
              size="xs"
              variant="outline"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              <Square />
              {t("workflow.runs.stop")}
            </Button>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * 关卡的说明：模板还是起跑时那一版就从模板里取，改过了退回步骤 id（运行
 * 行不带模板快照）。
 */
export function gateLabel(
  run: WorkflowRunJson,
  stepId: string,
  templates: readonly WorkflowTemplateJson[],
): string {
  const template = templates.find(
    (item) =>
      item.id === run.templateId && item.version === run.templateVersion,
  );
  const step = template?.template.steps.find((item) => item.id === stepId);
  return step?.kind === "gate" ? step.label : stepId;
}

function StepLine({ step }: { step: WorkflowRunStepJson }) {
  const t = useT();
  return (
    <div
      data-slot="workflow-step"
      data-step-id={step.stepId}
      className="min-w-0 space-y-1"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <Badge variant="outline" className="h-[18px] px-1 text-[11px]">
          {t(`workflow.kind.${step.kind}`)}
        </Badge>
        <span className="min-w-0 truncate font-medium">{step.stepId}</span>
        {step.role ? (
          <span className="min-w-0 truncate text-muted-foreground">
            {step.role}
          </span>
        ) : null}
        <span className="flex-1" />
        <StatusPill
          tone={stepTone(step.status)}
          label={t(`workflow.step.${step.status}`)}
        />
      </div>
      {step.decision ? (
        <p className="text-[11px] text-muted-foreground">
          {t(`workflow.decision.${step.decision}`)}
          {step.note ? ` · ${step.note}` : ""}
        </p>
      ) : null}
      {step.reason && step.status !== "done" ? (
        <p className="text-[11px] text-muted-foreground">{step.reason}</p>
      ) : null}
      {step.outputs.map((output) => (
        <pre
          key={`${output.key}-${output.at}`}
          className="max-h-32 min-w-0 overflow-auto rounded-[var(--r-control)] bg-muted px-2 py-1 font-sans text-[11px] whitespace-pre-wrap select-text"
        >
          {output.body}
        </pre>
      ))}
    </div>
  );
}
