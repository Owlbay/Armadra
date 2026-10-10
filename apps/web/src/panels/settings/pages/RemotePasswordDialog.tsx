import * as React from "react";
import { toast } from "sonner";

import { changeRemotePassword } from "../../../api/remote-services";
import { useT } from "../../../app/preferences-store";
import { TURNSTILE_PASSWORD_ACTION } from "../../../challenge/turnstile";
import { ChallengeSheet } from "../../../mobile/ChallengeSheet";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";

export interface PasswordTarget {
  readonly serviceId: string;
  readonly issuer: string;
}

/**
 * 改中转账号的口令（契约 §63）：当前口令、新口令、确认。中继要求人机验证时升起挑战
 * 面板，令牌到了带着刚填的内容再提交。成功后这台设备保持登录，其它设备要重新登录。
 */
export function ChangePasswordDialog({
  target,
  onClose,
}: {
  target: PasswordTarget | null;
  onClose(): void;
}) {
  const t = useT();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [siteKey, setSiteKey] = React.useState<string | null>(null);

  React.useEffect(() => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError("");
    setSiteKey(null);
  }, [target]);

  async function submit(challengeToken?: string) {
    if (busy || target === null) return;
    if (next !== confirm) {
      setError(t("remote.password.mismatch"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const answer = await changeRemotePassword({
        serviceId: target.serviceId,
        password: current,
        newPassword: next,
        ...(challengeToken ? { challengeToken } : {}),
      });
      if (answer.kind === "challenge") {
        setSiteKey(answer.siteKey);
        return;
      }
      toast.success(t("remote.password.changed"));
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  const ready = current !== "" && next !== "" && confirm !== "";

  return (
    <ResponsiveDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("remote.password.change")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) void submit();
          }}
        >
          <FieldGroup className="gap-3">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="remote-password-current">
                {t("remote.password.current")}
              </FieldLabel>
              <Input
                id="remote-password-current"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="remote-password-new">
                {t("remote.password.new")}
              </FieldLabel>
              <Input
                id="remote-password-new"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(event) => setNext(event.target.value)}
              />
            </Field>
            <Field className="gap-1.5" data-invalid={error !== ""}>
              <FieldLabel htmlFor="remote-password-confirm">
                {t("remote.password.confirm")}
              </FieldLabel>
              <Input
                id="remote-password-confirm"
                type="password"
                autoComplete="new-password"
                aria-invalid={error !== ""}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </Field>
          </FieldGroup>
          {error && <FieldError>{error}</FieldError>}
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("remote.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {busy && <Spinner data-icon="inline-start" aria-hidden />}
              {t("remote.password.submit")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
        {siteKey !== null && target !== null && (
          <ChallengeSheet
            open
            issuer={target.issuer}
            siteKey={siteKey}
            action={TURNSTILE_PASSWORD_ACTION}
            onCancel={() => setSiteKey(null)}
            onToken={(token) => {
              setSiteKey(null);
              void submit(token);
            }}
          />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
