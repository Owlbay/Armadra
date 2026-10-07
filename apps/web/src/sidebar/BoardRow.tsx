/**
 * 侧栏里的一行画布（§26 →§27 →§28）。
 *
 * 行本身 = 图标 + 名称 + 行尾信号点 + `⋯`；右键与 `⋯` 给同一组动作
 * （重命名 / 置顶 / 删除）。双击名称原位编辑，行下面不挂 Agent 列表——「我的 Agent
 * 现在怎么样了」只在铃铛展开的状态面板里看。
 */
import { useState } from "react";
import { LayoutGrid, MoreHorizontal, Pin } from "lucide-react";

import { useT } from "../app/preferences-store";
import { cn } from "@/lib/cn";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { InlineName } from "./InlineName";
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
import { DANGER_ACTION_CLASS } from "@/lib/danger-action";
import { IconButton } from "@/ui/icon-button";
import type { BoardEntry, BoardSignal } from "./board-tree";
import { SignalDot } from "./SignalDot";
import { displayName } from "./display-name";

export interface BoardRowProps {
  board: BoardEntry;
  active: boolean;
  pinned: boolean;
  signal?: BoardSignal;
  /** 工作空间只剩一块板时不让删。 */
  canDelete: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onRename: (name: string) => Promise<unknown>;
  /** 置顶组里的行会带上工作空间名，作为第二行的说明。 */
  caption?: string;
  /**
   * 项目行下面的画布：内容往右缩，但**底色仍然铺满**——高亮块因此与上面的
   * 项目行严丝合缝，不会因为左边空一截、四角又是圆的而看着断开（§27）。
   */
  indent?: boolean;
}

export function BoardRow({
  board,
  active,
  pinned,
  signal,
  canDelete,
  onSelect,
  onDelete,
  onTogglePin,
  onRename,
  caption,
  indent,
}: BoardRowProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /* 右键与 `⋯` 是同一组动作，所以只描述一次，两种菜单各渲染一遍。 */
  const actions = [
    {
      key: "rename",
      label: t("sidebar.rename"),
      disabled: false,
      run: () => setEditing(true),
    },
    {
      key: "pin",
      label: pinned ? t("sidebar.boardUnpin") : t("sidebar.boardPin"),
      disabled: false,
      run: onTogglePin,
    },
    {
      key: "delete",
      label: t("sidebar.boardDelete"),
      disabled: !canDelete,
      run: () => setConfirming(true),
    },
  ];

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-active={active ? "true" : undefined}
            className={cn(
              "group/board motion-hover flex h-7 items-center gap-1 rounded-[var(--r-control)] pr-1 hover:bg-[var(--hover)] data-[active=true]:bg-[color-mix(in_srgb,var(--brand)_15%,transparent)] data-[active=true]:text-[var(--brand-text)]",
              indent ? "pl-4" : "pl-1.5",
            )}
          >
            {pinned ? (
              <Pin className="size-3.5 shrink-0 opacity-60" />
            ) : (
              <LayoutGrid className="size-3.5 shrink-0 opacity-60" />
            )}
            <InlineName
              name={displayName(board.name, t)}
              label={t("sidebar.boardName")}
              caption={caption}
              editing={editing}
              onEditingChange={setEditing}
              onSelect={onSelect}
              onSave={onRename}
            />
            {signal?.attention ? (
              <SignalDot tone="attention" label={t("sidebar.needsYou")} />
            ) : signal?.unread ? (
              <SignalDot tone="unread" label={t("sidebar.unread")} />
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  label={t("sidebar.boardMenu")}
                  className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover/board:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="z-[var(--z-menu)]"
                onCloseAutoFocus={(event) => {
                  if (editing) event.preventDefault();
                }}
              >
                {actions.map((action) => (
                  <DropdownMenuItem
                    key={action.key}
                    disabled={action.disabled}
                    onSelect={action.run}
                  >
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          className="z-[var(--z-menu)]"
          onCloseAutoFocus={(event) => {
            if (editing) event.preventDefault();
          }}
        >
          {actions.map((action) => (
            <ContextMenuItem
              key={action.key}
              disabled={action.disabled}
              onSelect={action.run}
            >
              {action.label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>

      <ResponsiveAlertDialog open={confirming} onOpenChange={setConfirming}>
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("sidebar.boardDeleteTitle", {
                name: displayName(board.name, t),
              })}
            </ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {t("sidebar.boardDeleteDescription")}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("sidebar.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              className={DANGER_ACTION_CLASS}
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              {t("sidebar.boardDeleteConfirm")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </li>
  );
}
