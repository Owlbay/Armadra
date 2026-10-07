import * as React from "react";
import type { MfaStatus, TotpEnrollment } from "@armadra/shared";
import { toast } from "sonner";

import { useT } from "../../../../app/preferences-store";
import { QrImage } from "../gateway/PairingCard";
import { SecuritySection, downloadText } from "./parts";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Card } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/ui/input-otp";
import { Spinner } from "@/ui/spinner";

/** 两步验证这一块此刻在哪一步。 */
export type MfaStage =
  | { readonly kind: "idle" }
  | { readonly kind: "enrolling"; readonly enrollment: TotpEnrollment }
  | { readonly kind: "codes"; readonly codes: readonly string[] }
  | { readonly kind: "verify"; readonly purpose: "disable" | "regenerate" };

/**
 * 两步验证（契约 §18.3）：开启 → 扫码 → 输入 6 位确认 → 保存 10 个恢复码；
 * 已开启时可以重新生成恢复码或停用，两样都要当前有效的码。
 *
 * 策略要求而还没开时顶部一条 Alert（登录响应的 `mfaEnrollmentRequired` 把人
 * 带到这里）。密钥与恢复码只在这一次出现：离开这一步就没了。
 */
export function MfaSetup({
  status,
  stage,
  busy,
  error,
  onEnable,
  onConfirm,
  onVerify,
  onRequest,
  onCancel,
}: {
  status: MfaStatus | undefined;
  stage: MfaStage;
  busy: boolean;
  /** 码不对之类，显示在输入框下面。 */
  error: string;
  onEnable(): void;
  onConfirm(code: string): void;
  onVerify(purpose: "disable" | "regenerate", code: string): void;
  onRequest(purpose: "disable" | "regenerate"): void;
  /** 退出当前这一步（含「完成」）。 */
  onCancel(): void;
}) {
  const t = useT();
  if (status === undefined) return null;

  const enabled = status.enrolled;
  return (
    <SecuritySection
      title={t("security.mfa")}
      action={
        stage.kind === "idle" ? (
          <div className="flex items-center gap-2">
            <Badge variant={enabled ? "secondary" : "outline"}>
              {t(enabled ? "security.mfa.on" : "security.mfa.off")}
            </Badge>
            {!enabled && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onEnable}
              >
                {busy && <Spinner aria-label={t("security.mfa.enable")} />}
                {t("security.mfa.enable")}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {status.required && !enabled && stage.kind === "idle" && (
        <Alert variant="destructive">
          <AlertTitle>{t("security.mfa.required")}</AlertTitle>
          <AlertAction>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={onEnable}
            >
              {t("security.mfa.setUp")}
            </Button>
          </AlertAction>
        </Alert>
      )}

      {stage.kind === "idle" && enabled && (
        <Card className="gap-0 overflow-visible rounded-lg border border-border/70 py-0 text-[length:inherit] ring-0 flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
          <span className="text-muted-foreground tabular-nums">
            {t("security.mfa.remaining", {
              count: status.recoveryCodesRemaining,
            })}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onRequest("regenerate")}
            >
              {t("security.mfa.regenerate")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() => onRequest("disable")}
            >
              {t("security.mfa.disable")}
            </Button>
          </div>
        </Card>
      )}

      {stage.kind === "enrolling" && (
        <Card className="gap-0 overflow-visible rounded-lg border border-border/70 py-0 text-[length:inherit] ring-0 flex flex-col gap-4 p-4 sm:flex-row">
          <QrImage
            text={stage.enrollment.otpauthUri}
            label={t("security.mfa.qr")}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <Field>
              <FieldLabel>{t("security.mfa.secret")}</FieldLabel>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1 font-mono text-[12px] break-all select-all">
                  {groupSecret(stage.enrollment.secret)}
                </code>
                <CopyButton text={stage.enrollment.secret} />
              </div>
            </Field>
            <CodeForm
              label={t("auth.mfa.code")}
              submit={t("security.mfa.confirm")}
              busy={busy}
              error={error}
              onSubmit={onConfirm}
              onCancel={onCancel}
            />
          </div>
        </Card>
      )}

      {stage.kind === "verify" && (
        <Card className="gap-0 overflow-visible rounded-lg border border-border/70 py-0 text-[length:inherit] ring-0 p-4">
          <CodeForm
            label={t("auth.mfa.code")}
            submit={t(
              stage.purpose === "disable"
                ? "security.mfa.disable"
                : "security.mfa.regenerate",
            )}
            destructive={stage.purpose === "disable"}
            busy={busy}
            error={error}
            onSubmit={(code) => onVerify(stage.purpose, code)}
            onCancel={onCancel}
          />
        </Card>
      )}

      {stage.kind === "codes" && (
        <Card className="gap-0 overflow-visible rounded-lg border border-border/70 py-0 text-[length:inherit] ring-0 flex flex-col gap-3 p-4">
          <h4 className="text-[13px] font-medium">
            {t("security.mfa.codesTitle")}
          </h4>
          <ol
            aria-label={t("security.mfa.codesTitle")}
            className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[13px] tabular-nums select-all"
          >
            {stage.codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={stage.codes.join("\n")} />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                downloadText(
                  "armadra-recovery-codes.txt",
                  `${stage.codes.join("\n")}\n`,
                )
              }
            >
              {t("security.mfa.download")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              onClick={onCancel}
            >
              {t("security.mfa.done")}
            </Button>
          </div>
        </Card>
      )}
    </SecuritySection>
  );
}

/** 六位码：填满自动提交。 */
function CodeForm({
  label,
  submit,
  destructive = false,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  label: string;
  submit: string;
  destructive?: boolean;
  busy: boolean;
  error: string;
  onSubmit(code: string): void;
  onCancel(): void;
}) {
  const t = useT();
  const [code, setCode] = React.useState("");
  React.useEffect(() => {
    if (error) setCode("");
  }, [error]);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.length === 6 && !busy) onSubmit(code);
      }}
    >
      <Field data-invalid={error !== "" || undefined}>
        <FieldLabel>{label}</FieldLabel>
        <InputOTP
          maxLength={6}
          inputMode="numeric"
          pattern="^[0-9]*$"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          disabled={busy}
          aria-label={label}
          onChange={setCode}
          onComplete={(value: string) => {
            if (!busy) onSubmit(value);
          }}
        >
          <InputOTPGroup>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <InputOTPSlot
                key={index}
                index={index}
                aria-invalid={error !== "" || undefined}
              />
            ))}
          </InputOTPGroup>
        </InputOTP>
        <FieldError>{error}</FieldError>
      </Field>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant={destructive ? "destructive" : "default"}
          disabled={busy || code.length !== 6}
        >
          {busy && <Spinner aria-label={submit} />}
          {submit}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {t("security.cancel")}
        </Button>
      </div>
    </form>
  );
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => toast.success(t("security.copied")),
          () => undefined,
        );
      }}
    >
      {t("security.copy")}
    </Button>
  );
}

/** 32 个 base32 字符按四个一组，手抄时不串行。 */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}
