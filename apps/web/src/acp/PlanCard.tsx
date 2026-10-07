import * as React from "react";
import { ChevronDown, ChevronRight, Circle, CircleCheck } from "lucide-react";
import type { AcpPlanEntry } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Spinner } from "@/ui/spinner";
import { ActionBar, CopyAction } from "./MessageActions";

/** 计划卡要的三样：条目、画在哪一回合、那一回合结束没有。 */
export interface PlanView {
  readonly entries: readonly AcpPlanEntry[];
  readonly turn: number;
  /** 回合结束了：默认折叠成一行。 */
  readonly settled: boolean;
}

type PlanStatus = "pending" | "in_progress" | "completed";

function statusOf(entry: AcpPlanEntry): PlanStatus {
  return entry.status === "completed" || entry.status === "in_progress"
    ? entry.status
    : "pending";
}

/** 计划 → Markdown 清单（「复制为清单」）。 */
export function planChecklist(entries: readonly AcpPlanEntry[]): string {
  return entries
    .map((entry) => {
      const status = statusOf(entry);
      const mark = status === "completed" ? "x" : " ";
      return `- [${mark}] ${entry.content}`;
    })
    .join("\n");
}

function StatusIcon({ status }: { status: PlanStatus }) {
  const t = useT();
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      {status === "completed" ? (
        <CircleCheck
          aria-hidden
          className="size-3.5 text-[var(--success-text)]"
        />
      ) : status === "in_progress" ? (
        <Spinner aria-hidden className="size-3 text-[var(--working-text)]" />
      ) : (
        <Circle aria-hidden className="size-3 text-muted-foreground" />
      )}
      <span className="sr-only">{t(`acp.plan.status.${status}`)}</span>
    </span>
  );
}

/**
 * `plan`（ACP 会话视图 §5.2）：回合顶部一张卡，回合进行中默认展开，回合结束
 * 后自动折叠成一行「3/5 已完成」。状态用图标 + 读屏文字，不只靠颜色。
 */
export function PlanCard({
  plan,
  live,
  defaultOpen,
}: {
  plan: PlanView;
  /** 这一回合还在跑。 */
  live?: boolean;
  /** 只给展示页：不看回合状态。 */
  defaultOpen?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(defaultOpen ?? !plan.settled);
  // 回合结束那一刻收起；之后人自己展开不再被收。
  React.useEffect(() => {
    if (plan.settled && defaultOpen === undefined) setOpen(false);
  }, [plan.settled, defaultOpen]);
  const done = plan.entries.filter(
    (entry) => statusOf(entry) === "completed",
  ).length;

  return (
    <Card
      data-slot="acp-plan"
      data-open={open}
      className="gap-0 rounded-[var(--r-card)] px-1 py-1"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="group/act flex items-center gap-1.5">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="min-w-0 justify-start gap-1.5 font-normal"
            >
              {open ? <ChevronDown /> : <ChevronRight />}
              <span className="font-medium">{t("acp.plan.title")}</span>
              <span className="text-muted-foreground tabular-nums">
                {t("acp.plan.progress", {
                  done,
                  total: plan.entries.length,
                })}
              </span>
              {live && (
                <Spinner aria-hidden className="size-3 text-muted-foreground" />
              )}
            </Button>
          </CollapsibleTrigger>
          <ActionBar className="ml-auto">
            <CopyAction
              text={() => planChecklist(plan.entries)}
              label={t("acp.plan.copy")}
            />
          </ActionBar>
        </div>
        <CollapsibleContent>
          <ol className="flex flex-col gap-1 px-2 pt-1 pb-1">
            {plan.entries.map((entry, index) => {
              const status = statusOf(entry);
              return (
                <li
                  key={index}
                  data-status={status}
                  className="flex items-start gap-2 text-[13px]"
                >
                  <span className="mt-[3px]">
                    <StatusIcon status={status} />
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 [overflow-wrap:anywhere]",
                      status === "completed" && "text-muted-foreground",
                    )}
                  >
                    {entry.content}
                  </span>
                  {entry.priority === "high" && (
                    <Badge variant="outline" className="shrink-0">
                      {t("acp.plan.high")}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
