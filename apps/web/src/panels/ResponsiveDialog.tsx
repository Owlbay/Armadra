import * as React from "react";

import { cn } from "@/lib/cn";
import { useCompactLayout } from "@/platform/layout";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import {
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/ui/sheet";

/**
 * 对话框的手机形态（设计系统 §5.15、§7 第 10 步）：桌面与平板仍是居中的
 * `Dialog`；≤767 换成 `Sheet side="bottom"`——顶部圆角 14、36×4 的拖柄、
 * 高度随内容、最高 `100dvh - 48px`，底部让出安全区。
 *
 * 两种外壳是同一个 Radix Dialog 根，只换内容层，所以 `open` / `onOpenChange`、
 * 焦点圈定与 Esc 关闭在两种宽度下行为一致。生成的 `ui/dialog`、`ui/sheet`
 * 不改，这里只是组合。用法与 `Dialog` 一一对应：把 `Dialog*` 换成
 * `ResponsiveDialog*` 即可。
 */

const CompactContext = React.createContext(false);

/** 当前这个对话框是否以底部 Sheet 呈现。 */
export function useResponsiveDialogCompact(): boolean {
  return React.useContext(CompactContext);
}

export function ResponsiveDialog(props: React.ComponentProps<typeof Dialog>) {
  const compact = useCompactLayout();
  return (
    <CompactContext.Provider value={compact}>
      <Dialog {...props} />
    </CompactContext.Provider>
  );
}

export const ResponsiveDialogTrigger = DialogTrigger;
export const ResponsiveDialogClose = DialogClose;

export function ResponsiveDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogContent>) {
  const compact = useResponsiveDialogCompact();
  if (!compact)
    return (
      <DialogContent className={className} {...props}>
        {children}
      </DialogContent>
    );
  return (
    <SheetContent
      side="bottom"
      data-responsive="sheet"
      className={cn(
        className,
        // 手机形态压过调用方给桌面对话框定的宽度与高度。
        "inset-x-0 max-h-[calc(100dvh-48px)] w-full max-w-none gap-4 overflow-y-auto sm:max-w-none",
        "rounded-t-[14px] border-t border-border px-4 pt-3",
        "pb-[calc(1rem+env(safe-area-inset-bottom))]",
      )}
      {...props}
    >
      <div
        aria-hidden
        data-slot="responsive-dialog-handle"
        className="mx-auto h-1 w-9 shrink-0 rounded-full bg-[var(--border-strong)]"
      />
      {children}
    </SheetContent>
  );
}

export function ResponsiveDialogHeader(props: React.ComponentProps<"div">) {
  const compact = useResponsiveDialogCompact();
  return compact ? (
    <SheetHeader {...props} className={cn("p-0 pr-8", props.className)} />
  ) : (
    <DialogHeader {...props} />
  );
}

export function ResponsiveDialogFooter(
  props: React.ComponentProps<typeof DialogFooter>,
) {
  const compact = useResponsiveDialogCompact();
  if (!compact) return <DialogFooter {...props} />;
  const { showCloseButton, ...rest } = props;
  void showCloseButton;
  return <SheetFooter {...rest} className={cn("p-0", rest.className)} />;
}

export function ResponsiveDialogTitle(
  props: React.ComponentProps<typeof DialogTitle>,
) {
  const compact = useResponsiveDialogCompact();
  return compact ? <SheetTitle {...props} /> : <DialogTitle {...props} />;
}

export function ResponsiveDialogDescription(
  props: React.ComponentProps<typeof DialogDescription>,
) {
  const compact = useResponsiveDialogCompact();
  return compact ? (
    <SheetDescription {...props} />
  ) : (
    <DialogDescription {...props} />
  );
}
