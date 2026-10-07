if (!import.meta.env.DEV) throw new Error("design showcase is dev-only");

import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/ui/tooltip";

/**
 * 浮层安全区探针（`tools/probes/overlay-safe-area.mjs`）的被测页：在展示页里
 * 按需挂一个打开着的浮层，触发器钉在可用区域的某个角上，探针量浮层的几何。
 * 只经探针的动态 import 加载，展示页本身不引用它。抽屉不在这里：`ui/sheet` 只
 * 给登记过的抽屉用，探针去点组件分区里那个现成的。
 */

export type OverlayKind =
  | "popover"
  | "dropdown"
  | "select"
  | "tooltip"
  | "dialog";

export type Corner = "tl" | "tr" | "bl" | "br";

interface Mount {
  readonly kind: OverlayKind;
  readonly corner: Corner;
  /** `true` = 照旧的 0 碰撞边距，用来证明探针量得出差别。 */
  readonly unpadded?: boolean;
}

const ITEMS = Array.from({ length: 40 }, (_, index) => `item ${index + 1}`);

function triggerStyle(corner: Corner): React.CSSProperties {
  // 触发器贴着可用区域（安全区内侧）的角：真实界面的触发器都在根容器里，根
  // 容器已经让开了安全区。
  return {
    position: "fixed",
    width: 24,
    height: 24,
    ...(corner[0] === "t"
      ? { top: "calc(var(--overlay-inset-top) + 2px)" }
      : { bottom: "calc(var(--safe-bottom) + 2px)" }),
    ...(corner[1] === "l"
      ? { left: "calc(var(--safe-left) + 2px)" }
      : { right: "calc(var(--safe-right) + 2px)" }),
  };
}

function Overlay({ kind, corner, unpadded }: Mount) {
  const trigger = (
    <Button
      variant="outline"
      size="sm"
      aria-label="probe"
      data-probe-trigger
      style={triggerStyle(corner)}
    />
  );
  const padding = unpadded ? { collisionPadding: 0 } : {};
  const tall = (
    <div style={{ display: "grid", gap: 4 }}>
      {ITEMS.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
  switch (kind) {
    case "popover":
      return (
        <Popover open>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent data-probe-overlay {...padding}>
            {tall}
          </PopoverContent>
        </Popover>
      );
    case "dropdown":
      return (
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent data-probe-overlay className="w-56" {...padding}>
            {ITEMS.map((item) => (
              <DropdownMenuItem key={item}>{item}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      );
    case "select":
      return (
        <Select open defaultValue={ITEMS[0]}>
          <SelectTrigger aria-label="probe" style={triggerStyle(corner)} />
          <SelectContent data-probe-overlay {...padding}>
            {ITEMS.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "tooltip":
      return (
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
            <TooltipContent data-probe-overlay {...padding}>
              a fairly long tooltip label that needs room
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    case "dialog":
      return (
        <ResponsiveDialog open>
          <ResponsiveDialogContent
            data-probe-overlay
            aria-describedby={undefined}
          >
            <ResponsiveDialogTitle>probe</ResponsiveDialogTitle>
            <div style={{ height: 2000 }} />
          </ResponsiveDialogContent>
        </ResponsiveDialog>
      );
  }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(spec: Mount): void {
  unmount();
  host = document.createElement("div");
  host.dataset.probeHost = "true";
  document.body.append(host);
  root = createRoot(host);
  root.render(<Overlay {...spec} />);
}

function unmount(): void {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

(window as unknown as Record<string, unknown>).__overlayProbe = {
  mount,
  unmount,
};
