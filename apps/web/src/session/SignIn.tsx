import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";

import type { IdentitySession } from "../api/identity";
import { IdentityRequestError, IdentityTransportError } from "../api/identity";
import {
  oauthProviders,
  passkeyLoginOptions,
  passkeyLoginVerify,
  signInWithPassword,
  startOAuth,
  verifyMfa,
  type SignInAnswer,
} from "../api/security";
import { useT } from "../app/preferences-store";
import { lockoutMinutes, securityFailure } from "./sign-in-errors";
import { getAssertion, webauthnAvailable, webauthnCancelled } from "./webauthn";
import { Alert, AlertTitle } from "@/ui/alert";
import { BrandMark } from "@/ui/brand-mark";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel, FieldSeparator } from "@/ui/field";
import { Input } from "@/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/ui/input-otp";
import { Spinner } from "@/ui/spinner";

export type SignInStep = "account" | "password" | "mfa" | "recovery";

export interface SignInProvider {
  readonly id: string;
  readonly kind: "github" | "oidc";
}

/**
 * 登录（设计系统 §5.9）：账号 → 口令 → 两步验证；或者通行密钥、第三方账号。
 *
 * 错误都在字段下面一行，不弹 toast，也不区分「账号不存在」与「口令不对」。
 * 锁定时整列按钮禁用并倒计时；连不上服务器时顶部一条 Alert。
 *
 * `initial` 接 OAuth 回调的片段（契约 §18.5）：`mfa` 带中间票直接进第二步，
 * `error` 带一行错误。
 */
export function SignIn({
  onSignedIn,
  providers,
  passkey = passkeyUsable(),
  initial,
  now: fixedNow,
}: {
  onSignedIn(session: IdentitySession, mfaEnrollmentRequired: boolean): void;
  /** 不给时自己去问 `oauth/providers`。 */
  providers?: readonly SignInProvider[];
  passkey?: boolean;
  initial?: {
    step?: SignInStep;
    challengeId?: string;
    account?: string;
    error?: string;
    lockedUntilMs?: number;
    offline?: boolean;
  };
  /** 钉住时钟（展示页）。 */
  now?: number;
}) {
  const t = useT();
  const fetched = useQuery({
    queryKey: ["identity", "oauth", "providers"],
    queryFn: oauthProviders,
    enabled: providers === undefined,
    retry: false,
    staleTime: 60_000,
  });
  const available = providers ?? fetched.data?.providers ?? [];

  const [step, setStep] = React.useState<SignInStep>(
    initial?.step ?? (initial?.challengeId ? "mfa" : "account"),
  );
  const [account, setAccount] = React.useState(initial?.account ?? "");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [challengeId, setChallengeId] = React.useState(
    initial?.challengeId ?? "",
  );
  const [error, setError] = React.useState(initial?.error ?? "");
  const [offline, setOffline] = React.useState(initial?.offline ?? false);
  const [lockedUntil, setLockedUntil] = React.useState(
    initial?.lockedUntilMs ?? 0,
  );
  const [busy, setBusy] = React.useState<"" | "form" | "passkey" | string>("");
  const now = useClock(fixedNow, lockedUntil);
  const locked = lockedUntil > now;
  const disabled = busy !== "" || locked || offline;

  const finish = (answer: SignInAnswer) => {
    setPassword("");
    setCode("");
    if (answer.kind === "mfa") {
      setChallengeId(answer.challenge.challengeId);
      setStep("mfa");
      setBusy("");
      return;
    }
    setBusy("");
    onSignedIn(answer.session, answer.mfaEnrollmentRequired);
  };

  const fail = (failure: unknown, fallback: string) => {
    setBusy("");
    setCode("");
    const minutes = lockoutMinutes(failure);
    if (minutes !== null) {
      const seconds =
        failure instanceof IdentityRequestError && failure.retryAfterSeconds
          ? failure.retryAfterSeconds
          : minutes * 60;
      setLockedUntil(Date.now() + seconds * 1000);
      setError("");
      return;
    }
    if (failure instanceof IdentityTransportError) {
      setOffline(true);
      return;
    }
    if (failure instanceof IdentityRequestError) {
      if (failure.code === "mfa_challenge_expired") {
        setChallengeId("");
        setStep("account");
        setError(t("auth.error.expired"));
        return;
      }
      if (failure.code === "mfa_invalid_code") {
        setError(t("auth.error.code"));
        return;
      }
      if (
        failure.code === "UNAUTHENTICATED" ||
        failure.code === "INVALID_ARGUMENT"
      ) {
        setError(fallback);
        return;
      }
    }
    setError(securityFailure(failure, t));
  };

  const submitPassword = () => {
    if (disabled || !account.trim() || !password) return;
    setBusy("form");
    setError("");
    signInWithPassword(account.trim(), password).then(finish, (failure) => {
      setPassword("");
      fail(failure, t("auth.error.credentials"));
    });
  };

  const submitCode = (value: string) => {
    if (disabled || !challengeId || !value.trim()) return;
    setBusy("form");
    setError("");
    verifyMfa(challengeId, value.trim()).then(finish, (failure) =>
      fail(failure, t("auth.error.code")),
    );
  };

  const signInWithPasskey = () => {
    if (disabled) return;
    setBusy("passkey");
    setError("");
    void (async () => {
      const begun = await passkeyLoginOptions();
      const response = await getAssertion(begun.options);
      return passkeyLoginVerify(begun.challengeId, response);
    })().then(finish, (failure) => {
      if (webauthnCancelled(failure)) {
        setBusy("");
        return;
      }
      fail(failure, t("auth.error.passkey"));
    });
  };

  const startProvider = (id: string) => {
    if (disabled) return;
    setBusy(id);
    setError("");
    startOAuth(id, "login").catch((failure: unknown) => fail(failure, ""));
  };

  const minutes = Math.max(1, Math.ceil((lockedUntil - now) / 60_000));

  return (
    <div
      data-slot="sign-in"
      className="mx-auto flex w-full max-w-[360px] flex-col gap-5 py-6"
    >
      <div className="flex flex-col items-center gap-3">
        <BrandMark className="size-12" />
        <h1 className="text-[length:var(--text-display)] leading-tight font-semibold">
          {step === "mfa" || step === "recovery"
            ? t("auth.mfa.title")
            : t("auth.title")}
        </h1>
      </div>

      {offline && (
        <Alert variant="destructive">
          <AlertTitle>{t("auth.offline")}</AlertTitle>
        </Alert>
      )}
      {locked && (
        <Alert variant="destructive">
          <AlertTitle className="tabular-nums">
            {t("auth.locked", { minutes })}
          </AlertTitle>
        </Alert>
      )}

      {step === "account" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!account.trim() || disabled) return;
            setError("");
            setStep("password");
          }}
        >
          <Field data-invalid={error !== "" || undefined}>
            <FieldLabel htmlFor="sign-in-account">
              {t("auth.account")}
            </FieldLabel>
            <Input
              id="sign-in-account"
              autoComplete="username webauthn"
              autoFocus
              className="text-base md:text-sm"
              value={account}
              disabled={disabled}
              aria-invalid={error !== "" || undefined}
              onChange={(event) => setAccount(event.target.value)}
            />
            <FieldError>{error}</FieldError>
          </Field>
          <Button
            type="submit"
            className="w-full"
            disabled={disabled || !account.trim()}
          >
            {t("auth.continue")}
          </Button>
          {(passkey || available.length > 0) && (
            <FieldSeparator className="my-1">{t("auth.or")}</FieldSeparator>
          )}
          {passkey && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={disabled}
              onClick={signInWithPasskey}
            >
              {busy === "passkey" ? (
                <Spinner aria-label={t("auth.passkey")} />
              ) : (
                <KeyRound />
              )}
              {t("auth.passkey")}
            </Button>
          )}
          {available.map((provider) => (
            <Button
              key={provider.id}
              type="button"
              variant="outline"
              className="w-full"
              disabled={disabled}
              onClick={() => startProvider(provider.id)}
            >
              {busy === provider.id && (
                <Spinner aria-label={providerLabel(provider, t)} />
              )}
              {providerLabel(provider, t)}
            </Button>
          ))}
        </form>
      )}

      {step === "password" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submitPassword();
          }}
        >
          {/* 账号留在表单里，口令管理器认得出这一对。 */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={account}
            readOnly
            hidden
          />
          <Field data-invalid={error !== "" || undefined}>
            <FieldLabel htmlFor="sign-in-password">
              {t("auth.password")}
            </FieldLabel>
            <Input
              id="sign-in-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              className="text-base md:text-sm"
              value={password}
              disabled={disabled}
              aria-invalid={error !== "" || undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldError>{error}</FieldError>
          </Field>
          <Button
            type="submit"
            className="w-full"
            disabled={disabled || !password}
          >
            {busy === "form" && <Spinner aria-label={t("auth.signIn")} />}
            {t("auth.signIn")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            disabled={busy !== ""}
            onClick={() => {
              setStep("account");
              setPassword("");
              setError("");
            }}
          >
            {t("auth.back")}
          </Button>
        </form>
      )}

      {step === "mfa" && (
        <form
          className="flex flex-col items-center gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submitCode(code);
          }}
        >
          <Field
            data-invalid={error !== "" || undefined}
            className="items-center"
          >
            <FieldLabel className="sr-only" htmlFor="sign-in-otp">
              {t("auth.mfa.code")}
            </FieldLabel>
            <InputOTP
              id="sign-in-otp"
              maxLength={6}
              inputMode="numeric"
              pattern="^[0-9]*$"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              disabled={disabled}
              aria-label={t("auth.mfa.code")}
              onChange={setCode}
              onComplete={(value: string) => submitCode(value)}
            >
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((index) => (
                  <InputOTPSlot
                    key={index}
                    index={index}
                    className="size-10 text-base"
                    aria-invalid={error !== "" || undefined}
                  />
                ))}
              </InputOTPGroup>
            </InputOTP>
            <FieldError className="text-center">{error}</FieldError>
          </Field>
          {busy === "form" && <Spinner aria-label={t("auth.verify")} />}
          <Button
            type="button"
            variant="link"
            disabled={busy !== ""}
            onClick={() => {
              setStep("recovery");
              setCode("");
              setError("");
            }}
          >
            {t("auth.mfa.useRecovery")}
          </Button>
        </form>
      )}

      {step === "recovery" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submitCode(code);
          }}
        >
          <Field data-invalid={error !== "" || undefined}>
            <FieldLabel htmlFor="sign-in-recovery">
              {t("auth.mfa.recovery")}
            </FieldLabel>
            <Input
              id="sign-in-recovery"
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              className="font-mono text-base md:text-sm"
              value={code}
              disabled={disabled}
              aria-invalid={error !== "" || undefined}
              onChange={(event) => setCode(event.target.value)}
            />
            <FieldError>{error}</FieldError>
          </Field>
          <Button
            type="submit"
            className="w-full"
            disabled={disabled || !code.trim()}
          >
            {busy === "form" && <Spinner aria-label={t("auth.verify")} />}
            {t("auth.verify")}
          </Button>
          <Button
            type="button"
            variant="link"
            disabled={busy !== ""}
            onClick={() => {
              setStep("mfa");
              setCode("");
              setError("");
            }}
          >
            {t("auth.mfa.useTotp")}
          </Button>
        </form>
      )}
    </div>
  );
}

function providerLabel(
  provider: SignInProvider,
  t: ReturnType<typeof useT>,
): string {
  return provider.kind === "github"
    ? t("auth.oauth.github")
    : t("auth.oauth.provider", { name: provider.id });
}

/** passkey 要安全上下文、WebAuthn，以及不是 IP 字面量的主机（契约 §18.2）。 */
export function passkeyUsable(
  hostname = globalThis.location?.hostname ?? "",
): boolean {
  return webauthnAvailable() && !ipLiteral(hostname);
}

export function ipLiteral(hostname: string): boolean {
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    hostname.includes(":") ||
    hostname.startsWith("[")
  );
}

/** 锁着时每秒走一次的时钟；钉住时不走。 */
function useClock(fixed: number | undefined, until: number): number {
  const [now, setNow] = React.useState(() => fixed ?? Date.now());
  React.useEffect(() => {
    if (fixed !== undefined) return;
    setNow(Date.now());
    if (until <= Date.now()) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [fixed, until]);
  return fixed ?? now;
}
