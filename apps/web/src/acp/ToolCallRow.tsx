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
  RotateCcw,
  Search,
  SquareTerminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type {
  AcpToolCallStatus,
  AcpToolKind,
  ContentSource,
} from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { basename } from "@/files/file-operations";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import { DiffBlock, workspaceRelative } from "./DiffBlock";
import { Action, ActionBar, CopyAction } from "./MessageActions";
import { openLink } from "./open-link";
import type { AcpToolCallView, AcpToolLocation } from "./store";

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

/** `completed` 用 `done`（设计系统 §2.3），与「等待」的灰一眼分得开。 */
export const STATUS_TONES: Record<AcpToolCallStatus, StatusTone> = {
  pending: "queued",
  in_progress: "working",
  completed: "done",
  failed: "failed",
};

/** 入参与输出最多先显示这么多行，其余「展开全部」。 */
export const TOOL_PREVIEW_LINES = 20;

/** 工具行上最多画几枚文件胶囊，其余折成 `+N`。 */
export const MAX_LOCATIONS = 2;

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function outputText(call: AcpToolCallView): string {
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

/** `execute` 的命令：`rawInput.command`（字符串或数组），或者整个字符串入参。 */
export function commandOf(call: AcpToolCallView): string | null {
  if (call.kind !== "execute") return null;
  const input = call.rawInput;
  if (typeof input === "string") return input || null;
  if (input && typeof input === "object") {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") return command || null;
    if (Array.isArray(command) && command.every((p) => typeof p === "string"))
      return command.join(" ") || null;
  }
  return null;
}

function Preformatted({
  label,
  text,
  copyLabel,
}: {
  label: string;
  text: string;
  copyLabel: string;
}) {
  const t = useT();
  const [all, setAll] = React.useState(false);
  const lines = text.split("\n");
  const clipped = !all && lines.length > TOOL_PREVIEW_LINES;
  return (
    <div className="group/act flex flex-col gap-0.5">
      <div className="flex h-6 items-center gap-1">
        <span className="text-[length:var(--text-caption)] text-muted-foreground">
          {label}
        </span>
        <ActionBar className="ml-auto">
          <CopyAction text={text} label={copyLabel} />
        </ActionBar>
      </div>
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

/** 文件胶囊：工作区内的能点（打开编辑器并跳到行），外面的只显示。 */
function Locations({ locations }: { locations: readonly AcpToolLocation[] }) {
  const t = useT();
  const root = useCanvasStore((state) => state.workspace?.rootPath);
  if (locations.length === 0) return null;
  const shown = locations.slice(0, MAX_LOCATIONS);
  const rest = locations.length - shown.length;
  return (
    <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
      {shown.map((location, index) => {
        const relative = workspaceRelative(location.path, root);
        const name = basename(location.path) || location.path;
        const label = location.line ? `${name}:${location.line}` : name;
        if (!relative) {
          return (
            <Badge
              key={index}
              variant="outline"
              title={location.path}
              className="max-w-28 min-w-0 font-mono"
            >
              <span className="truncate">{label}</span>
            </Badge>
          );
        }
        return (
          <Button
            key={index}
            variant="outline"
            size="xs"
            title={location.path}
            aria-label={t("acp.tool.location.open", { path: relative })}
            className="h-5 max-w-28 min-w-0 rounded-4xl px-2 font-mono text-xs font-medium"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() =>
              openLink(
                { kind: "file", path: relative },
                location.line ?? undefined,
              )
            }
          >
            <span className="truncate">{label}</span>
          </Button>
        );
      })}
      {rest > 0 && (
        <Badge
          variant="outline"
          title={locations
            .slice(MAX_LOCATIONS)
            .map((location) => location.path)
            .join("\n")}
          className="shrink-0 tabular-nums"
        >
          {t("acp.tool.locations.more", { count: rest })}
        </Badge>
      )}
    </span>
  );
}

/**
 * 一次工具调用（ACP 会话视图 §5.2）：kind 图标 + 标题 + 文件胶囊 + 状态胶囊；
 * 展开看入参与输出，`diff` 各一张 `DiffBlock`。悬停 / 聚焦时行尾出复制入参、
 * 复制输出、（`execute`）复制命令、（失败）让它重试。
 */
export function ToolCallRow({
  call,
  onRetry,
  source,
}: {
  call: AcpToolCallView;
  /** 给了才有「落为变更节点」。 */
  source?: ContentSource | undefined;
  /** 「让它重试」：把「请重试：标题」回填进输入框（编辑后重发同一条路）。 */
  onRetry?: (text: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const Icon = KIND_ICONS[call.kind ?? "other"];
  const input = stringify(call.rawInput);
  const output = outputText(call);
  const command = commandOf(call);
  const diffs = call.content.filter((item) => item.type === "diff");
  const terminal = call.content.some((item) => item.type === "terminal");
  const expandable = Boolean(input || output || terminal);

  return (
    <div className="flex flex-col gap-1" data-tool-call={call.toolCallId}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="group/act flex min-h-7 items-center gap-1.5 rounded-[var(--r-control)] border border-[var(--border)] px-2 py-0.5">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-20 flex-1 truncate text-[13px]">
            {call.title}
          </span>
          <Locations locations={call.locations ?? []} />
          <ActionBar className="shrink-0">
            {command && (
              <CopyAction text={command} label={t("acp.tool.copyCommand")} />
            )}
            {call.status === "failed" && onRetry && (
              <Action
                label={t("acp.tool.retry")}
                onClick={() =>
                  onRetry(t("acp.tool.retryPrompt", { title: call.title }))
                }
              >
                <RotateCcw />
              </Action>
            )}
          </ActionBar>
          {call.status && (
            <StatusPill
              tone={STATUS_TONES[call.status]}
              label={t(`acp.tool.status.${call.status}`)}
              className="shrink-0"
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
          {input && (
            <Preformatted
              label={t("acp.tool.input")}
              text={input}
              copyLabel={t("acp.tool.copyInput")}
            />
          )}
          {output && (
            <Preformatted
              label={t("acp.tool.output")}
              text={output}
              copyLabel={t("acp.tool.copyOutput")}
            />
          )}
          {terminal && (
            <span className="px-1 text-[11px] text-muted-foreground">
              {t("acp.tool.terminalUnavailable")}
            </span>
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
            source={source}
          />
        ) : null,
      )}
    </div>
  );
}
