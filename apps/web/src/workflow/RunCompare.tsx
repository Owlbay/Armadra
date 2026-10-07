import type { WorkflowRunJson, WorkflowRunStepJson } from "@armadra/shared";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Badge } from "@/ui/badge";
import { ScrollArea } from "@/ui/scroll-area";
import { StatusPill } from "@/ui/status-pill";
import { compareRuns, paramSummary, runTone, stepTone } from "./model";

/**
 * 两次运行并排（补全架构 §5.4「记录与对比」）：每一步一行，左右各是那次的
 * 状态与产出正文；两边逐字相同的步骤标「相同」，否则标「不同」。
 */
export function RunCompare({
  left,
  right,
  open,
  onClose,
}: {
  left: WorkflowRunJson | null;
  right: WorkflowRunJson | null;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const rows = left && right ? compareRuns(left, right) : [];
  return (
    <ResponsiveDialog
      open={open && left !== null && right !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent
        className="sm:max-w-[860px]"
        data-slot="workflow-compare-dialog"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("workflow.compare.title")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {left && right ? (
          <ScrollArea className="max-h-[60vh] min-w-0">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2 pr-2">
              <RunHead run={left} />
              <RunHead run={right} />
              {rows.map((row) => (
                <div
                  key={row.stepId}
                  data-slot="workflow-compare-row"
                  data-same={row.same}
                  className="col-span-2 grid min-w-0 grid-cols-subgrid gap-y-1 border-t border-border pt-2"
                >
                  <div className="col-span-2 flex min-w-0 items-center gap-1.5 text-[12px]">
                    <Badge
                      variant="outline"
                      className="h-[18px] px-1 text-[11px]"
                    >
                      {t(`workflow.kind.${row.kind}`)}
                    </Badge>
                    <span className="font-medium">{row.stepId}</span>
                    <span className="flex-1" />
                    <Badge
                      variant={row.same ? "secondary" : "outline"}
                      className={
                        row.same
                          ? "text-[11px]"
                          : "text-[11px] text-[var(--warn-text)]"
                      }
                    >
                      {t(
                        row.same
                          ? "workflow.compare.same"
                          : "workflow.compare.different",
                      )}
                    </Badge>
                  </div>
                  <StepCell step={row.left} />
                  <StepCell step={row.right} />
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function RunHead({ run }: { run: WorkflowRunJson }) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <span className="tabular-nums text-muted-foreground">
          {new Intl.DateTimeFormat(locale, {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(run.startedAt))}
        </span>
        <StatusPill
          tone={runTone(run.status)}
          label={t(`workflow.status.${run.status}`)}
        />
      </div>
      <p className="truncate text-[11px] text-muted-foreground">
        {paramSummary(run.params) || run.title}
      </p>
    </div>
  );
}

function StepCell({ step }: { step: WorkflowRunStepJson | null }) {
  const t = useT();
  if (step === null) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {t("workflow.compare.missing")}
      </p>
    );
  }
  return (
    <div className="min-w-0 space-y-1">
      <StatusPill
        tone={stepTone(step.status)}
        label={t(`workflow.step.${step.status}`)}
      />
      {step.decision ? (
        <p className="text-[11px] text-muted-foreground">
          {t(`workflow.decision.${step.decision}`)}
          {step.note ? ` · ${step.note}` : ""}
        </p>
      ) : null}
      {step.outputs.length === 0 && step.kind !== "gate" ? (
        <p className="text-[11px] text-muted-foreground">
          {t("workflow.compare.none")}
        </p>
      ) : null}
      {step.outputs.map((output) => (
        <pre
          key={`${output.key}-${output.at}`}
          className="max-h-40 min-w-0 overflow-auto rounded-[var(--r-control)] bg-muted px-2 py-1 font-sans text-[11px] whitespace-pre-wrap select-text"
        >
          {output.body}
        </pre>
      ))}
    </div>
  );
}
