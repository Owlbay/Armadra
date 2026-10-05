import type { ReactNode } from "react";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}
export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex min-h-9 items-center gap-2 text-xs">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
      />
      {label}
    </label>
  );
}
export function ReadError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      className="max-h-[40dvh] space-y-2 overflow-y-auto break-words p-3 text-xs text-destructive"
    >
      <p>{error instanceof Error ? error.message : t("gitRepo.failed")}</p>
      <Button variant="outline" size="sm" onClick={retry}>
        {t("gitRepo.retry")}
      </Button>
    </div>
  );
}
