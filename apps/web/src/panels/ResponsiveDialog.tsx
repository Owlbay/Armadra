import * as React from "react";

import { cn } from "@/lib/cn";
import { useCompactLayout } from "@/platform/layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/ui/alert-dialog";
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
 * 高度随内容、最高 `100dvh - 48px - 顶部安全区`，左右与底部让出安全区。
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
        // 最高处离状态栏下沿 48px；左右与底边让开刘海和主页横条（`--safe-*`）。
        "inset-x-0 max-h-[calc(100dvh-48px-var(--safe-top))] w-full max-w-none gap-4 overflow-y-auto sm:max-w-none",
        "rounded-t-[14px] border-t border-border pt-3 pr-[calc(1rem+var(--safe-right))] pl-[calc(1rem+var(--safe-left))]",
        "pb-[calc(1rem+var(--safe-bottom))]",
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

/* -------------------------------------------------------------------------- */
/* 确认框                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `AlertDialog` 的手机形态（设计系统首行「对话框 ≤767 换成底部 Sheet」）。
 *
 * 根仍是 Radix 的 AlertDialog：`role="alertdialog"`、点遮罩不关、焦点先落在
 * 「取消」，这些确认框该有的行为两种宽度都不变。≤767 只换内容层的外形——贴底、
 * 顶部圆角 14、拖柄、让出安全区——底栏按钮竖排全宽，主操作在上、取消在下
 * （拇指先够到的是取消）。生成的 `ui/alert-dialog` 不改，用法与它一一对应：
 * 把 `AlertDialog*` 换成 `ResponsiveAlertDialog*` 即可。
 */
export function ResponsiveAlertDialog(
  props: React.ComponentProps<typeof AlertDialog>,
) {
  const compact = useCompactLayout();
  return (
    <CompactContext.Provider value={compact}>
      <AlertDialog {...props} />
    </CompactContext.Provider>
  );
}

export const ResponsiveAlertDialogTrigger = AlertDialogTrigger;
export const ResponsiveAlertDialogAction = AlertDialogAction;
export const ResponsiveAlertDialogCancel = AlertDialogCancel;
export const ResponsiveAlertDialogTitle = AlertDialogTitle;
export const ResponsiveAlertDialogDescription = AlertDialogDescription;
export const ResponsiveAlertDialogMedia = AlertDialogMedia;

/** 手机形态的外壳：压过生成组件的居中定位、限宽与缩放动画。 */
const ALERT_SHEET = cn(
  "top-auto bottom-0 left-0 w-full max-w-none sm:max-w-none translate-x-0 translate-y-0",
  "data-[size=default]:max-w-none data-[size=sm]:max-w-none data-[size=default]:sm:max-w-none",
  "max-h-[calc(100dvh-48px-var(--safe-top))] overflow-y-auto",
  "rounded-none rounded-t-[14px] pt-3 pr-[calc(1rem+var(--safe-right))] pb-[calc(1rem+var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))]",
  "data-open:zoom-in-100 data-open:slide-in-from-bottom data-closed:zoom-out-100 data-closed:slide-out-to-bottom",
);

export function ResponsiveAlertDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AlertDialogContent>) {
  const compact = useResponsiveDialogCompact();
  if (!compact)
    return (
      <AlertDialogContent className={className} {...props}>
        {children}
      </AlertDialogContent>
    );
  return (
    <AlertDialogContent
      data-responsive="sheet"
      // 调用方给桌面定的宽度在手机上一律不要：放在前面，被下面的类压掉。
      className={cn(className, ALERT_SHEET)}
      {...props}
    >
      <div
        aria-hidden
        data-slot="responsive-dialog-handle"
        className="mx-auto h-1 w-9 shrink-0 rounded-full bg-[var(--border-strong)]"
      />
      {children}
    </AlertDialogContent>
  );
}

export function ResponsiveAlertDialogHeader(
  props: React.ComponentProps<typeof AlertDialogHeader>,
) {
  const compact = useResponsiveDialogCompact();
  return (
    <AlertDialogHeader
      {...props}
      className={cn(compact && "place-items-start text-left", props.className)}
    />
  );
}

export function ResponsiveAlertDialogFooter(
  props: React.ComponentProps<typeof AlertDialogFooter>,
) {
  const compact = useResponsiveDialogCompact();
  return (
    <AlertDialogFooter
      {...props}
      className={cn(
        props.className,
        compact &&
          "flex flex-col-reverse gap-2 sm:flex-col-reverse sm:justify-start group-data-[size=sm]/alert-dialog-content:flex *:w-full",
      )}
    />
  );
}
