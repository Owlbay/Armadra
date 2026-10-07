import * as React from "react";
import {
  Code2,
  Ellipsis,
  StickyNote,
  Type,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ContentSource } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  availableExports,
  exportToBoard,
  type ExportKind,
} from "./export-to-board";
import { Action } from "./MessageActions";

const ITEMS: readonly { kind: ExportKind; icon: LucideIcon }[] = [
  { kind: "sticky", icon: StickyNote },
  { kind: "text", icon: Type },
  { kind: "editor", icon: Code2 },
  { kind: "mermaid", icon: Workflow },
];

/** 选区落在这条消息里时用选中的那段，否则整条。 */
export function selectedTextWithin(root: HTMLElement | null): string {
  const selection =
    typeof window === "undefined" ? null : window.getSelection();
  if (!root || !selection || selection.isCollapsed) return "";
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if (!anchor || !focus) return "";
  if (!root.contains(anchor) || !root.contains(focus)) return "";
  return selection.toString();
}

/**
 * 助手消息的「输出到画板」（设计系统 §5.2）：消息工具条里的一个 `⋯`，菜单
 * 四项。只包工具条、不包正文（ACP 会话视图 §5.1）：正文照常选字、点链接。
 * 按下时选区落在这条消息里就只输出选中的那段。不可用的项灰掉，不解释原因。
 */
export function ExportMenu({
  text,
  source,
  selectionRoot,
  defaultOpen,
}: {
  text: string;
  source: ContentSource;
  /** 这条消息的正文：选区在它里面时输出选中的那段。 */
  selectionRoot?: React.RefObject<HTMLElement | null>;
  /** 只给展示页：让菜单展开着截图。 */
  defaultOpen?: boolean;
}) {
  const t = useT();
  const [picked, setPicked] = React.useState(text);
  React.useEffect(() => setPicked(text), [text]);
  const available = React.useMemo(() => availableExports(picked), [picked]);

  return (
    <DropdownMenu {...(defaultOpen ? { defaultOpen: true, modal: false } : {})}>
      <DropdownMenuTrigger asChild>
        <Action
          label={t("acp.export.menu")}
          onPointerDown={(event) => {
            event.stopPropagation();
            setPicked(
              selectedTextWithin(selectionRoot?.current ?? null) || text,
            );
          }}
        >
          <Ellipsis />
        </Action>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {ITEMS.map(({ kind, icon: Icon }) => (
          <DropdownMenuItem
            key={kind}
            className="text-[13px]"
            disabled={!available.has(kind)}
            onSelect={() => void exportToBoard(kind, picked, source)}
          >
            <Icon />
            {t(`acp.export.${kind}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
