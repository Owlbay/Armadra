import * as React from "react";

import { usePreferencesStore, useT } from "../../../../app/preferences-store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";

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
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent className="z-[var(--z-dialog)]">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>
        {subject && (
          <p className="text-[13px] font-medium break-words">{subject}</p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("security.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
