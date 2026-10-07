import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { PasswordResetIssued } from "@armadra/shared";
import { toast } from "sonner";

import {
  mailConfigured,
  mailInvitation,
  mailLocaleOf,
  mailPasswordReset,
} from "../../../api/mail";
import { RuntimeRequestError } from "../../../api/request";
import { issuePasswordReset, passwordResetLink } from "../../../api/security";
import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { securityFailure } from "../../../session/sign-in-errors";
import { QrImage } from "./gateway/PairingCard";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";

export interface ResetTarget {
  readonly principalId: string;
  readonly name: string;
}

/**
 * 「签发重置链接」（契约 §25）：打开即签一枚，显示链接、二维码与过期时间，
 * 「复制」；服务器配了邮件时多一行「发送邮件」（契约 §28）。关掉对话框令牌就
 * 不在页面里了——库里只有哈希，要再给就再签一枚（旧的随之作废）。
 */
export function ResetLinkDialog({
  target,
  onClose,
  issued: preset,
  mail,
}: {
  target: ResetTarget | null;
  onClose(): void;
  /** 展示页：直接给签好的结果，不发请求。 */
  issued?: PasswordResetIssued;
  /** 展示页：钉住「配没配邮件」。 */
  mail?: boolean;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const [issued, setIssued] = React.useState<PasswordResetIssued | null>(
    preset ?? null,
  );
  const [error, setError] = React.useState("");
  const principalId = target?.principalId ?? "";

  React.useEffect(() => {
    if (principalId === "" || preset) return;
    let live = true;
    setIssued(null);
    setError("");
    issuePasswordReset(principalId).then(
      (answer) => {
        if (live) setIssued(answer);
      },
      (failure: unknown) => {
        if (live) setError(securityFailure(failure, t));
      },
    );
    return () => {
      live = false;
    };
    // 每换一个人签一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principalId]);

  const link = issued ? passwordResetLink(issued.token) : "";
  const expires = issued
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(issued.expiresAtMs)
    : "";

  return (
    <ResponsiveDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[440px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t("reset.issue")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <div data-slot="reset-link" className="flex flex-col gap-3">
          {target?.name && (
            <p className="text-[13px] font-medium break-words">{target.name}</p>
          )}
          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : !issued ? (
            <div className="flex flex-col items-center gap-3">
              <Skeleton className="size-[200px]" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <>
              <div className="flex justify-center">
                <QrImage text={link} label={t("reset.qr")} />
              </div>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  aria-label={t("reset.link")}
                  value={link}
                  className="font-mono text-[12px]"
                  onFocus={(event) => event.target.select()}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(link)
                      .then(() => toast.success(t("reset.copied")))
                  }
                >
                  {t("reset.copy")}
                </Button>
              </div>
              <p className="text-[12px] text-muted-foreground tabular-nums">
                {t("reset.expires", { time: expires })}
              </p>
              <MailLinkForm
                kind="passwordReset"
                id={principalId}
                token={issued.token}
                {...(mail === undefined ? {} : { configured: mail })}
              />
            </>
          )}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * 「发送邮件」一行：邮箱 + 按钮。服务器没配邮件（或旧 core 不认这条路由）时
 * 整行不出现。错误按 `code` 在输入框下面一行（契约 §28 的错误表）。
 */
export function MailLinkForm({
  kind,
  id,
  token,
  configured: fixed,
}: {
  kind: "passwordReset" | "invitation";
  /** 重置是 principalId，邀请是 invitationId。 */
  id: string;
  token: string;
  configured?: boolean;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const fieldId = React.useId();
  const status = useQuery({
    queryKey: ["mail", "status"],
    queryFn: () => mailConfigured(),
    enabled: fixed === undefined,
    staleTime: 60_000,
    retry: false,
  });
  const [to, setTo] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  if (!(fixed ?? status.data === true)) return null;

  const send = () => {
    const address = to.trim();
    if (busy || address === "") return;
    setBusy(true);
    setError("");
    const input = { token, to: address, locale: mailLocaleOf(locale) };
    (kind === "passwordReset"
      ? mailPasswordReset({ principalId: id, ...input })
      : mailInvitation({ invitationId: id, ...input })
    ).then(
      () => {
        setBusy(false);
        setTo("");
        toast.success(t("mail.sent"));
      },
      (failure: unknown) => {
        setBusy(false);
        setError(mailFailure(failure, t));
      },
    );
  };

  return (
    <form
      className="flex items-start gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Field
        data-invalid={error !== "" || undefined}
        className="min-w-0 flex-1"
      >
        <FieldLabel className="sr-only" htmlFor={fieldId}>
          {t("mail.to")}
        </FieldLabel>
        <Input
          id={fieldId}
          type="email"
          autoComplete="off"
          placeholder={t("mail.to")}
          value={to}
          disabled={busy}
          aria-invalid={error !== "" || undefined}
          onChange={(event) => {
            setTo(event.target.value);
            setError("");
          }}
        />
        <FieldError>{error}</FieldError>
      </Field>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        className="mt-0.5"
        disabled={busy || to.trim() === ""}
      >
        {busy && <Spinner aria-label={t("mail.send")} />}
        {t("mail.send")}
      </Button>
    </form>
  );
}

function mailFailure(error: unknown, t: ReturnType<typeof useT>): string {
  if (error instanceof RuntimeRequestError && error.code) {
    const key = `mail.error.${error.code}`;
    const text = t(key);
    if (text !== key) return text;
  }
  return error instanceof Error && error.message
    ? error.message
    : t("mail.error.mail_send_failed");
}
