import { useViewport } from "@xyflow/react";
import {
  LayoutGrid,
  Lock,
  LockOpen,
  Minus,
  Plus,
  Redo2,
  Undo2,
} from "lucide-react";
import {
  ADD_MENU_CONTENT_CLASS,
  AddMenuContent,
} from "../canvas/menus/AddMenuContent";
import { DockTools } from "./DockTools";
import { useCanCreateBrowser } from "@/nodes/browser/availability";
import { CommentModeButton } from "@/realtime/comments/CommentLayer";
import { setCanvasLocked, useCanvasLocked } from "../canvas/canvas-lock";
import { useMenuTooltip } from "./menu-tooltip";
import { currentViewportCenter } from "../canvas/placement";
import {
  fitView,
  MAX_ZOOM,
  MIN_ZOOM,
  zoomByStep,
  zoomToLevel,
} from "../canvas/flow/use-flow-viewport";
import { commandKeysLabel } from "../keybindings/active";
import { useCanUndo, useCanRedo, useCanvasStore } from "../store/canvas-store";
import { useEnabledAgents } from "../app/use-agents";
import { useT } from "../app/preferences-store";
import { rightPanelInset } from "../panels/WorkPanelSheet";
import { useCompactLayout } from "../platform/layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { IconButton } from "@/ui/icon-button";
import { runCanvasCommand } from "@/canvas/commands";
import { tidySelection } from "@/canvas/tidy-flow";
import { Separator } from "@/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/cn";

/** 缩放档位（右键菜单）+ 适应。以视口中心为锚点。 */
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const;

/** 视口缩放是浮点，夹到边界时差一点点也算到了。 */
const ZOOM_EPSILON = 0.001;

/**
 * 底部 Dock（§3.1）：`+` / 撤销 / 重做 / 整理 / 工具 / 保存点 / 缩放 / 用量。
 * 保存状态只用一个点表示，不写文字（§14 第 4 条）。
 *
 * 用量在最右端（F9）：它以前是右下角一个独立浮层，用户要求并进 Dock。
 * 锁定视图在最左端（2026-09-14 反馈）：它以前是左下角一个独立的浮钮，
 * 用户要求并进 Dock，Dock 本身居中。
 */
export function Dock() {
  const t = useT();
  const locked = useCanvasLocked();
  // `useViewport` 要在 `<ReactFlowProvider>` 之下：Dock 挂在 `App` 里，
  // provider 包着整棵树（§2.9），所以这里读得到。
  const { zoom } = useViewport();
  const workspace = useCanvasStore((state) => state.workspace);
  // 右侧抽屉是窗口级的固定层，盖在这一行的右端上（§58）。这一行让开它，Dock
  // 就在剩下那块看得见的画布里居中；手机上抽屉铺满整屏，没有可让的。
  const compact = useCompactLayout();
  const inset = useCanvasStore((state) =>
    compact ? null : rightPanelInset(state.panels),
  );
  const addNode = useCanvasStore((state) => state.addNode);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  // 选区里有 ≥ 2 个顶层单元时「整理」只整理选中的（UI 设计 §6.5）。
  const tidyScoped = useCanvasStore((state) => tidySelection(state) !== null);
  const tidyLabel = tidyScoped ? t("canvas.tidySelection") : t("dock.tidy");
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const agents = useEnabledAgents();
  const addMenu = useMenuTooltip();
  // 「新建浏览器」要看 core 带不带浏览器，答案是一次网络往返。在 Dock 挂上时就
  // 问，菜单第一次展开时项已经齐了。等到展开才问的话，答案回来时菜单长高一行：
  // 它向上展开、按展开那一刻的高度定位，要等下一次重新定位才挪开（后台标签页里
  // 不会挪），这期间底边盖住 `+`，按住再松开就落在底部那一项上——Radix 的菜单
  // 在松开处选中。
  useCanCreateBrowser();

  if (!workspace) return null;

  return (
    // 外层是一条贯穿画布底部的网格行（`styles/canvas.css`）：中间那格装
    // Dock，两侧留白相等时 Dock 就在画布正中；右侧留白有下限（缩略图的
    // 宽度加边距），画布不够宽时 Dock 向左让，缩略图永远留在右下角。
    <div
      className="canvas-dock-row"
      data-panel-inset={inset ? "true" : undefined}
      style={inset ? { right: `calc(14px + ${inset})` } : undefined}
    >
      <div
        data-slot="dock"
        className="canvas-dock z-[var(--z-dock)] flex h-[var(--dock-h)] items-center gap-1 rounded-[var(--r-panel)] border border-border bg-[var(--panel)]/90 px-1.5 shadow-[var(--shadow-pill)] backdrop-blur-[12px]"
      >
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <IconButton
              size="dock"
              data-slot="canvas-lock"
              label={locked ? t("canvas.unlock") : t("canvas.lock")}
              aria-pressed={locked}
              active={locked}
              onClick={() => setCanvasLocked(!locked)}
            >
              {locked ? <Lock /> : <LockOpen />}
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>
            {locked ? t("canvas.unlock") : t("canvas.lock")}
          </TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <DropdownMenu {...addMenu.menuProps}>
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild {...addMenu.tooltipTriggerProps}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  size="dock"
                  label={t("dock.add")}
                  active={addMenu.menuOpen}
                >
                  <Plus />
                </IconButton>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            {/* 菜单展开时不再挂提示：它会压在第一条菜单项上。 */}
            {addMenu.menuOpen ? null : (
              <TooltipContent>{t("dock.add")}</TooltipContent>
            )}
          </Tooltip>
          <DropdownMenuContent
            align="center"
            side="top"
            className={cn("z-[var(--z-menu)]", ADD_MENU_CONTENT_CLASS)}
          >
            {/* 落点在**展开这一刻**算：菜单开着时相机还能动。 */}
            {addMenu.menuOpen && (
              <AddMenuContent
                kind="dropdown"
                ctx={{
                  addNode,
                  position: currentViewportCenter(),
                  workspace,
                  agents,
                }}
              />
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <IconButton
              size="dock"
              label={t("dock.undo")}
              disabled={!canUndo}
              onClick={() => undo()}
            >
              <Undo2 />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>{t("dock.undo")}</TooltipContent>
        </Tooltip>

        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <IconButton
              size="dock"
              label={t("dock.redo")}
              disabled={!canRedo}
              onClick={() => redo()}
            >
              <Redo2 />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>{t("dock.redo")}</TooltipContent>
        </Tooltip>

        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <IconButton
              size="dock"
              label={tidyLabel}
              onClick={() => runCanvasCommand("canvas.tidy")}
            >
              <LayoutGrid />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>{tidyLabel}</TooltipContent>
        </Tooltip>

        {/* 白板工具组（§5）；画布没挂载时整组连同分隔线一起不渲染。 */}
        <DockTools />
        <CommentModeButton />

        <Separator orientation="vertical" className="mx-1 h-5" />

        <SaveDot />

        <ZoomControls zoom={zoom} />
      </div>
    </div>
  );
}

/** 缩放 −/+ 的提示：名字 + 当前键位（键位从命令表读，不写死）。 */
function zoomTooltip(
  command: "canvas.zoomIn" | "canvas.zoomOut",
  t: ReturnType<typeof useT>,
): string {
  const label = t(`cmd.${command}`);
  const keys = commandKeysLabel(command);
  return keys ? `${label} · ${keys}` : label;
}

/**
 * 缩放段 `[−] [NN%] [+]`（ui-wave2 §5.3）。到 `MIN_ZOOM` / `MAX_ZOOM` 时对应
 * 一侧禁用。百分比钮：单击 = 适应视图（用户反馈 2026-09-22：这一格该像
 * 「适应全屏」那样一下到位），右键才是缩放档位。⌘ / Ctrl + 滚轮的缩放走画布
 * 自己那条。
 */
export function ZoomControls({ zoom }: { zoom: number }) {
  const t = useT();
  const atMin = zoom <= MIN_ZOOM + ZOOM_EPSILON;
  const atMax = zoom >= MAX_ZOOM - ZOOM_EPSILON;
  return (
    <>
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <IconButton
            size="dock"
            label={t("cmd.canvas.zoomOut")}
            disabled={atMin}
            onClick={() => zoomByStep(-1)}
          >
            <Minus />
          </IconButton>
        </TooltipTrigger>
        <TooltipContent>{zoomTooltip("canvas.zoomOut", t)}</TooltipContent>
      </Tooltip>
      <ContextMenu>
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>
              <IconButton
                size="dock"
                label={t("dock.zoomFit")}
                className="w-[52px] text-[length:var(--text-caption)] font-medium tabular-nums"
                onClick={fitView}
              >
                {Math.round(zoom * 100)}%
              </IconButton>
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("dock.zoomFitHint")}</TooltipContent>
        </Tooltip>
        <ContextMenuContent className="z-[var(--z-menu)] w-auto min-w-32">
          {ZOOM_STEPS.map((step) => (
            <ContextMenuItem
              key={step}
              data-checked={Math.abs(zoom - step) < 0.005 ? "true" : undefined}
              onSelect={() => zoomToLevel(step)}
            >
              {Math.round(step * 100)}%
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={fitView}>
            {t("dock.zoomFit")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <IconButton
            size="dock"
            label={t("cmd.canvas.zoomIn")}
            disabled={atMax}
            onClick={() => zoomByStep(1)}
          >
            <Plus />
          </IconButton>
        </TooltipTrigger>
        <TooltipContent>{zoomTooltip("canvas.zoomIn", t)}</TooltipContent>
      </Tooltip>
    </>
  );
}

/** 保存状态：一个 10px 的点，说明只在 Tooltip 里。 */
function SaveDot() {
  const t = useT();
  const saveState = useCanvasStore((state) => state.saveState);
  const label = t(`dock.save.${saveState}`);
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <span
          data-slot="save-dot"
          data-state={saveState}
          role="status"
          aria-label={label}
          className={cn(
            "mx-1 size-2 shrink-0 rounded-full",
            saveState === "error" && "bg-danger",
            saveState === "saving" && "anim-dot-pulse bg-warn",
            saveState === "dirty" && "bg-warn",
            (saveState === "saved" || saveState === "idle") && "bg-success/70",
          )}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
