import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AcpPermissionOption } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { useAgentStatusStore } from "@/agent/status-store";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import { Card } from "@/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { acpApi } from "./api";
import { DiffBlock } from "./DiffBlock";
import { useAcpStore, type AcpPermissionView } from "./store";

/** 详情里的入参最多先显示这么多行。 */
export const PERMISSION_INPUT_LINES = 20;

function inputPreview(value: unknown): string {
  if (value === undefined || value === null) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  const lines = text.split("\n");
  return lines.length > PERMISSION_INPUT_LINES
    ? `${lines.slice(0, PERMISSION_INPUT_LINES).join("\n")}\n…`
    : text;
}

/**
 * 「详情」：这次要改什么——`toolCall.content` 的差异预览、入参（前 20 行）、
 * 涉及的文件。什么都没有时不出这一行。
 */
function Details({ permission }: { permission: AcpPermissionView }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const call = permission.toolCall;
  const diffs = (call.content ?? []).filter((item) => item.type === "diff");
  const input = inputPreview(call.rawInput);
  const locations = call.locations ?? [];
  if (diffs.length === 0 && !input && locations.length === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="-ml-1.5 font-normal text-muted-foreground"
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          {t("acp.permission.details")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1.5 pt-1">
        {locations.length > 0 && (
          <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground">
            {locations.map((location, index) => (
              <li key={index} className="truncate" title={location.path}>
                {location.line
                  ? `${location.path}:${location.line}`
                  : location.path}
              </li>
            ))}
          </ul>
        )}
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
        {input && (
          <pre className="max-h-60 overflow-auto rounded-[var(--r-control)] bg-[var(--surface-raised)] px-2 py-1 font-mono text-xs whitespace-pre">
            {input}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

const OPTION_LABELS: Record<AcpPermissionOption["kind"], string> = {
  allow_once: "acp.permission.allowOnce",
  allow_always: "acp.permission.allowAlways",
  reject_once: "acp.permission.reject",
  reject_always: "acp.permission.rejectAlways",
};

export function isAllowOption(option: AcpPermissionOption): boolean {
  return option.kind.startsWith("allow");
}

/**
 * 答一次：先收起（会话视图的卡片与头部的允许 / 拒绝一起），再发请求——与
 * 头部直答同一个做法，下一条事件未必立刻到，不能让人对着答过的请求再点。
 */
export function answerPermission(
  permission: AcpPermissionView,
  option: AcpPermissionOption,
): Promise<unknown> {
  useAcpStore.getState().resolvePermission(permission.pendingId);
  useAgentStatusStore.getState().resolveApproval(permission.pendingId);
  return acpApi
    .answer(
      permission.pendingId,
      isAllowOption(option) ? "allow" : "deny",
      option.optionId,
    )
    .catch(() => undefined);
}

/**
 * `session/request_permission` 的卡片（设计系统 §5.1）：标题是工具调用，
 * 选项按 ACP 的 kind 分允许 / 拒绝两组，允许用 default、拒绝用 outline。
 * 没有答复权限的人（不是 driver、终端也不是自己起的，契约 §23）看到同一张卡，
 * 按钮换成「等待接管」（设计系统 §5.8）。
 */
export function PermissionCard({
  permission,
  canAnswer,
  className,
  pinned = false,
}: {
  permission: AcpPermissionView;
  canAnswer: boolean;
  className?: string;
  /**
   * 钉在输入框上方的那一张：出现时焦点落到第一枚允许钮（ACP 会话视图
   * §5.7）。Esc 不答、不关。
   */
  pinned?: boolean;
}) {
  const t = useT();
  const allow = permission.options.filter(isAllowOption);
  const reject = permission.options.filter((option) => !isAllowOption(option));
  const first = allow[0]?.optionId;
  const firstRef = React.useRef<HTMLButtonElement>(null);
  // 钉住时焦点落到第一枚允许钮——但人正在输入框里打字时不抢：那一下 Enter
  // 会变成「允许」。
  React.useEffect(() => {
    if (!pinned || !canAnswer) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active.closest("input, textarea, select, [contenteditable='true']")
    ) {
      return;
    }
    firstRef.current?.focus({ preventScroll: true });
  }, [pinned, canAnswer, permission.pendingId]);
  const group = (options: AcpPermissionOption[], allowGroup: boolean) =>
    options.length > 0 && (
      <ButtonGroup>
        {options.map((option) => (
          <Button
            key={option.optionId}
            size="sm"
            variant={allowGroup ? "default" : "outline"}
            ref={option.optionId === first ? firstRef : undefined}
            onKeyDown={(event) => {
              if (event.key === "Escape") event.stopPropagation();
            }}
            onClick={() => void answerPermission(permission, option)}
          >
            {t(OPTION_LABELS[option.kind])}
          </Button>
        ))}
      </ButtonGroup>
    );

  return (
    <Card
      data-slot="acp-permission"
      data-pending-id={permission.pendingId}
      className={cn(
        "gap-2 border-l-2 border-l-[var(--warn)] px-3 py-2",
        className,
      )}
    >
      <span className="text-[13px] [overflow-wrap:anywhere]">
        {permission.toolCall.title}
      </span>
      <Details permission={permission} />
      {canAnswer ? (
        <div className="flex flex-wrap gap-2">
          {group(allow, true)}
          {group(reject, false)}
        </div>
      ) : (
        <Badge variant="outline" className="self-start">
          {t("acp.permission.awaitingDriver")}
        </Badge>
      )}
    </Card>
  );
}
