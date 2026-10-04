import * as React from "react";
import { ShieldAlert } from "lucide-react";

import { IdentityRequestError } from "../api/identity";
import type { PasswordResetInfo } from "@armadra/shared";
import { completePasswordReset, openPasswordReset } from "../api/security";
import { usePreferencesStore, useT } from "../app/preferences-store";
import { passwordFailure, securityFailure } from "./sign-in-errors";
import { Alert, AlertTitle } from "@/ui/alert";
import { BrandMark } from "@/ui/brand-mark";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";

export type ResetStage =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "ready"; info: PasswordResetInfo }
  | { kind: "done"; principalId: string; breached: boolean };

/**
 * 整页「设置新口令」（契约 §25，`#reset=<令牌>`）：先 `GET` 看这是谁的、什么时候
 * 过期；认不出（用过、作废、过期）就只说链接已失效。设好之后这个人的全部会话
 * 已撤，按钮带去登录；泄露检查 `warn` 档命中时多一条 Alert。
 *
 * 版式与登录同一列（设计系统 §5.9：360 宽、BrandMark 居中）。
 */
export function ResetPassword({
  token,
  onSignIn,
  initial,
  autoFocus: focus = true,
}: {
  token: string;
  /** 去登录；`principalId` 是刚设好口令的那个人（设好之前为空）。 */
  onSignIn(principalId: string): void;
  /** 展示页直接给一个阶段，不发请求。 */
  initial?: ResetStage;
  autoFocus?: boolean;
}) {
  const t = useT();
  const id = React.useId();
  const locale = usePreferencesStore((state) => state.locale);
  const [stage, setStage] = React.useState<ResetStage>(
    initial ?? { kind: "loading" },
  );
  const [password, setPassword] = React.useState("");
  const [repeat, setRepeat] = React.useState("");
  const [error, setError] = React.useState("");
  const [mismatch, setMismatch] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (initial !== undefined) return;
    let live = true;
    openPasswordReset(token).then(
      (info) => {
        if (live) setStage({ kind: "ready", info });
      },
      (failure: unknown) => {
        if (!live) return;
        setStage({ kind: "invalid" });
        // 404 就是「链接已失效」；别的（离线、限流）说出原因。
        if (
          !(failure instanceof IdentityRequestError && failure.status === 404)
        ) {
          setError(securityFailure(failure, t));
        }
      },
    );
    return () => {
      live = false;
    };
    // 令牌只在挂载时认一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    if (busy || !password || !repeat) return;
    if (password !== repeat) {
      setMismatch(true);
      return;
    }
    setBusy(true);
    setError("");
    completePasswordReset(token, password).then(
      (done) => {
        setBusy(false);
        setPassword("");
        setRepeat("");
        setStage({
          kind: "done",
          principalId: done.principalId,
          breached: done.passwordBreached === true,
        });
      },
      (failure: unknown) => {
        setBusy(false);
        if (
          failure instanceof IdentityRequestError &&
          failure.code === "password_reset_invalid"
        ) {
          setStage({ kind: "invalid" });
          return;
        }
        setError(passwordFailure(failure, t) ?? securityFailure(failure, t));
      },
    );
  };

  const expires = (ms: number) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(ms);

  return (
    <div
      data-slot="reset-password"
      className="mx-auto flex w-full max-w-[360px] flex-col gap-5 py-6"
    >
      <div className="flex flex-col items-center gap-3">
        <BrandMark className="size-12" />
        <h1 className="text-[length:var(--text-display)] leading-tight font-semibold">
          {stage.kind === "done"
            ? t("reset.done")
            : stage.kind === "invalid"
              ? t("reset.invalid")
              : t("reset.title")}
        </h1>
        {stage.kind === "ready" && (
          <p className="flex flex-col items-center gap-0.5 text-center text-[13px] text-muted-foreground">
            {stage.info.displayName && (
              <span className="font-medium text-foreground">
                {stage.info.displayName}
              </span>
            )}
            <span className="tabular-nums">
              {t("reset.expires", { time: expires(stage.info.expiresAtMs) })}
            </span>
          </p>
        )}
        {stage.kind === "invalid" && (
          <p className="text-center text-[13px] text-muted-foreground">
            {error || t("reset.invalidHint")}
          </p>
        )}
      </div>

      {stage.kind === "loading" && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}

      {stage.kind === "ready" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field data-invalid={error !== "" || undefined}>
            <FieldLabel htmlFor={`${id}-password`}>
              {t("reset.password")}
            </FieldLabel>
            <Input
              id={`${id}-password`}
              type="password"
              autoComplete="new-password"
              autoFocus={focus}
              className="text-base md:text-sm"
              value={password}
              disabled={busy}
              aria-invalid={error !== "" || undefined}
              onChange={(event) => {
                setPassword(event.target.value);
                setError("");
              }}
            />
            <FieldError>{error}</FieldError>
          </Field>
          <Field data-invalid={mismatch || undefined}>
            <FieldLabel htmlFor={`${id}-repeat`}>
              {t("reset.repeat")}
            </FieldLabel>
            <Input
              id={`${id}-repeat`}
              type="password"
              autoComplete="new-password"
              className="text-base md:text-sm"
              value={repeat}
              disabled={busy}
              aria-invalid={mismatch || undefined}
              onChange={(event) => {
                setRepeat(event.target.value);
                setMismatch(false);
              }}
            />
            <FieldError>{mismatch ? t("reset.mismatch") : ""}</FieldError>
          </Field>
          <Button
            type="submit"
            className="w-full"
            disabled={busy || !password || !repeat}
          >
            {busy && <Spinner aria-label={t("reset.submit")} />}
            {t("reset.submit")}
          </Button>
        </form>
      )}

      {stage.kind === "done" && (
        <div className="flex flex-col gap-3">
          {stage.breached && (
            <Alert>
              <ShieldAlert />
              <AlertTitle>{t("security.password.breached")}</AlertTitle>
            </Alert>
          )}
          <Button
            type="button"
            className="w-full"
            autoFocus={focus}
            onClick={() => onSignIn(stage.principalId)}
          >
            {t("reset.signIn")}
          </Button>
        </div>
      )}

      {stage.kind === "invalid" && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => onSignIn("")}
        >
          {t("reset.signIn")}
        </Button>
      )}
    </div>
  );
}
