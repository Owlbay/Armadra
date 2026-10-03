import * as React from "react";
import {
  ArrowLeftRight,
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  MoveRight,
  Pencil,
  Search,
  SquareTerminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { AcpToolCallStatus, AcpToolKind } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import { DiffBlock } from "./DiffBlock";
import type { AcpToolCallView } from "./store";

const KIND_ICONS: Record<AcpToolKind, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  delete: Trash2,
  move: MoveRight,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
  switch_mode: ArrowLeftRight,
  other: Wrench,
};

const STATUS_TONES: Record<AcpToolCallStatus, StatusTone> = {
  pending: "queued",
  in_progress: "working",
  completed: "idle",
  failed: "failed",
};

/** 入参与输出最多先显示这么多行，其余「展开全部」。 */
export const TOOL_PREVIEW_LINES = 20;

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function outputText(call: AcpToolCallView): string {
  const blocks = call.content
    .map((item) =>
      item.type === "content" && item.content.type === "text"
        ? (item.content.text ?? "")
        : "",
    )
    .filter(Boolean);
  if (blocks.length > 0) return blocks.join("\n");
  return stringify(call.rawOutput);
}

function Preformatted({ label, text }: { label: string; text: string }) {
  const t = useT();
  const [all, setAll] = React.useState(false);
  const lines = text.split("\n");
  const clipped = !all && lines.length > TOOL_PREVIEW_LINES;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[length:var(--text-caption)] text-muted-foreground">
        {label}
      </span>
      <pre className="overflow-x-auto rounded-[var(--r-control)] bg-[var(--surface-raised)] px-2 py-1 font-mono text-xs whitespace-pre">
        {clipped ? lines.slice(0, TOOL_PREVIEW_LINES).join("\n") : text}
      </pre>
      {clipped && (
        <Button
          variant="ghost"
          size="xs"
          className="self-start"
          onClick={() => setAll(true)}
        >
          {t("acp.tool.showAll")}
        </Button>
      )}
    </div>
  );
}

/** 一次工具调用：kind 图标 + 标题 + 状态胶囊；展开看入参与输出。 */
export function ToolCallRow({ call }: { call: AcpToolCallView }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const Icon = KIND_ICONS[call.kind ?? "other"];
  const input = stringify(call.rawInput);
  const output = outputText(call);
  const diffs = call.content.filter((item) => item.type === "diff");
  const expandable = Boolean(input || output);

  return (
    <div className="flex flex-col gap-1" data-tool-call={call.toolCallId}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex min-h-7 items-center gap-1.5 rounded-[var(--r-control)] border border-[var(--border)] px-2 py-1">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {call.title}
          </span>
          {call.status && (
            <StatusPill
              tone={STATUS_TONES[call.status]}
              label={t(`acp.tool.status.${call.status}`)}
            />
          )}
          {expandable && (
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("acp.tool.details")}
              >
                {open ? <ChevronDown /> : <ChevronRight />}
              </Button>
            </CollapsibleTrigger>
          )}
        </div>
        <CollapsibleContent className="flex flex-col gap-1.5 px-1 pt-1.5">
          {input && <Preformatted label={t("acp.tool.input")} text={input} />}
          {output && (
            <Preformatted label={t("acp.tool.output")} text={output} />
          )}
        </CollapsibleContent>
      </Collapsible>
      {diffs.map((diff, index) =>
        diff.type === "diff" ? (
          <DiffBlock
            key={`${diff.path}-${index}`}
            path={diff.path}
            oldText={diff.oldText ?? ""}
            newText={diff.newText}
          />
        ) : null,
      )}
    </div>
  );
}
