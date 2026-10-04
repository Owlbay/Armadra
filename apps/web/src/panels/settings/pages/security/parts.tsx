import * as React from "react";

import { usePreferencesStore, useT } from "../../../../app/preferences-store";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Skeleton } from "@/ui/skeleton";

/** 安全页的一块：标题行（右侧可放一个动作）+ 内容。 */
export function SecuritySection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2 px-0.5">
        <h3 className="text-[13px] font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 分区第一次取数时的占位（设计系统 §5.16 加载态）：标题照常，两行 Skeleton。 */
export function SecuritySectionSkeleton({ title }: { title: string }) {
  return (
    <SecuritySection title={title}>
      <div data-slot="security-loading" className="flex flex-col gap-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </SecuritySection>
  );
}

/** 按当前语言格式化毫秒时间戳；0 显示「—」。 */
export function useDateTime(
  style: "date" | "dateTime" = "dateTime",
): (ms: number) => string {
  const locale = usePreferencesStore((state) => state.locale);
  const format = React.useMemo(
    () =>
      new Intl.DateTimeFormat(
        locale,
        style === "date"
          ? { dateStyle: "medium" }
          : { dateStyle: "medium", timeStyle: "short" },
      ),
    [locale, style],
  );
  return React.useCallback(
    (ms: number) => (ms > 0 ? format.format(ms) : "—"),
    [format],
  );
}

/** 删除 / 退出 / 解绑前的确认。 */
export function ConfirmRemove({
  open,
  title,
  subject,
  action,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  subject: string;
  action: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const t = useT();
  return (
    <ResponsiveAlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
        <ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogTitle>{title}</ResponsiveAlertDialogTitle>
        </ResponsiveAlertDialogHeader>
        {subject && (
          <p className="text-[13px] font-medium break-words">{subject}</p>
        )}
        <ResponsiveAlertDialogFooter>
          <ResponsiveAlertDialogCancel>
            {t("security.cancel")}
          </ResponsiveAlertDialogCancel>
          <ResponsiveAlertDialogAction
            variant="destructive"
            onClick={onConfirm}
          >
            {action}
          </ResponsiveAlertDialogAction>
        </ResponsiveAlertDialogFooter>
      </ResponsiveAlertDialogContent>
    </ResponsiveAlertDialog>
  );
}

/** 把一段文本存成文件（恢复码、审计 CSV）。 */
export function downloadText(
  filename: string,
  text: string,
  type = "text/plain",
): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
