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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import {
  availableExports,
  exportToBoard,
  type ExportKind,
} from "./export-to-board";

const ITEMS: readonly { kind: ExportKind; icon: LucideIcon }[] = [
  { kind: "sticky", icon: StickyNote },
  { kind: "text", icon: Type },
  { kind: "editor", icon: Code2 },
  { kind: "mermaid", icon: Workflow },
];

/** 选区落在这条消息里时用选中的那段，否则整条。 */
function selectedTextWithin(root: HTMLElement | null): string {
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
 * 助手消息的「输出到画板」（设计系统 §5.2）：悬停出一个 `⋯`，菜单四项；
 * 右键同样四项，有选区时只输出选中的那段。不可用的项灰掉，不解释原因。
 */
export function ExportMenu({
  text,
  source,
  children,
  defaultOpen,
}: {
  text: string;
  source: ContentSource;
  children: React.ReactNode;
  /** 只给展示页：让菜单展开着截图。 */
  defaultOpen?: boolean;
}) {
  const t = useT();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [picked, setPicked] = React.useState(text);
  const available = React.useMemo(() => availableExports(picked), [picked]);
  const whole = React.useMemo(() => availableExports(text), [text]);

  const items = (Item: typeof DropdownMenuItem | typeof ContextMenuItem) =>
    ITEMS.map(({ kind, icon: Icon }) => (
      <Item
        key={kind}
        className="text-[13px]"
        disabled={!(Item === DropdownMenuItem ? whole : available).has(kind)}
        onSelect={() =>
          void exportToBoard(
            kind,
            Item === DropdownMenuItem ? text : picked,
            source,
          )
        }
      >
        <Icon />
        {t(`acp.export.${kind}`)}
      </Item>
    ));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rootRef}
          data-slot="acp-export"
          className="group/export relative"
          onContextMenu={(event) => {
            // 节点自己的右键菜单不再弹：这里是消息的菜单。
            event.stopPropagation();
            setPicked(selectedTextWithin(rootRef.current) || text);
          }}
        >
          {children}
          <div className="absolute -top-1 right-0 opacity-0 transition-opacity group-hover/export:opacity-100 focus-within:opacity-100 has-data-[state=open]:opacity-100">
            <DropdownMenu
              {...(defaultOpen ? { defaultOpen: true, modal: false } : {})}
            >
              <DropdownMenuTrigger asChild>
                <IconButton
                  label={t("acp.export.menu")}
                  className="bg-[var(--card)]"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <Ellipsis />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {items(DropdownMenuItem)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        {items(ContextMenuItem)}
      </ContextMenuContent>
    </ContextMenu>
  );
}
