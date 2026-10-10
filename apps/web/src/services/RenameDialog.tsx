import * as React from "react";

import { useT } from "../app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";

/** 名字的上限，与 core 源表 `label` 相同（契约 §61）。 */
export const SERVICE_NAME_MAX = 128;

export interface RenameTarget {
  /** 现在显示的名字。 */
  readonly name: string;
  /** 服务端报的名字：输入框的占位，清空保存即恢复成它。 */
  readonly defaultName: string;
}

/**
 * 重命名一个服务（主机或中转，契约 §61）：名字只存在这台设备上。输入框预填现在
 * 的名字、占位是缺省名；清空保存交出空串，由调用方恢复缺省名。
 */
export function RenameDialog({
  target,
  onClose,
  onSave,
}: {
  readonly target: RenameTarget | null;
  readonly onClose: () => void;
  /** 交出去的是去首尾空白的名字；空串 = 恢复缺省名。失败时抛，消息显示在框下。 */
  readonly onSave: (label: string) => Promise<void> | void;
}) {
  const t = useT();
  const id = React.useId();
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (target === null) return;
    setValue(target.name);
    setError("");
  }, [target]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave(value.trim());
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent
        data-slot="rename-service"
        className="z-[var(--z-dialog)] sm:max-w-[420px]"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t("services.rename")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field className="gap-1.5" data-invalid={error !== ""}>
            <FieldLabel htmlFor={`${id}-name`}>{t("services.name")}</FieldLabel>
            <Input
              id={`${id}-name`}
              autoComplete="off"
              spellCheck={false}
              maxLength={SERVICE_NAME_MAX}
              placeholder={target?.defaultName ?? ""}
              aria-invalid={error !== ""}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("mobileConnect.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner data-icon="inline-start" aria-hidden />}
              {t("services.save")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
