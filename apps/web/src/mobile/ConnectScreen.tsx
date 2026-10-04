import * as React from "react";
import { KeyRound, Link2, LogIn, ScanLine } from "lucide-react";

import { useT } from "../app/preferences-store";
import { Alert, AlertTitle } from "@/ui/alert";
import { BrandMark } from "@/ui/brand-mark";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/ui/input-otp";
import { Spinner } from "@/ui/spinner";

/** 连接失败的原因；文案键是 `mobileConnect.error.<原因>`。 */
export type ConnectFailure =
  | "invalid"
  | "noFingerprint"
  | "pin"
  | "expired"
  | "unreachable"
  | "failed"
  | "codeInvalid"
  | "codeDisabled"
  | "codeOrigin"
  | "rateLimited";

export interface ConnectScreenProps {
  /**
   * `native`：原生 App，还没有 Gateway——手输（贴）配对链接或扫码。
   * `web`：手机浏览器扫码打开了 `…/#pair=<票>`，来源就是这个 Gateway，只差一下「连接」。
   */
  readonly mode: "native" | "web";
  /** 要连的来源：网页是页面自己的，原生是上次记下的（可无）。 */
  readonly origin?: string;
  readonly canScan?: boolean;
  /** 原生模式下输入框的初值。 */
  readonly initialLink?: string;
  /** 连接；失败返回原因，成功返回 `null`（之后由调用方跳走）。 */
  readonly onConnect: (link: string) => Promise<ConnectFailure | null>;
  /** 调相机扫码，取消返回 `null`。 */
  readonly onScan?: () => Promise<string | null>;
  /** 网页模式下的 CA 安装引导（`PageCaGuide`）；原生 App 按指纹钉扎，不装 CA。 */
  readonly caGuide?: React.ReactNode;
  /**
   * 配对码（契约 §24）：8 位换票并配对。给了才有「输入配对码」这一入口；原生
   * App 只在已经记下一个 Gateway 来源时给（没钉过信任锚就连不上）。
   */
  readonly onCode?: (code: string) => Promise<ConnectFailure | null>;
  /** 一打开就是配对码：手机浏览器没带 `#pair=` 地打开了 Gateway。 */
  readonly codeFirst?: boolean;
  /** 配对码页上的「账号登录」：有账号的人不用配对码，直接进页面登录。 */
  readonly onSignIn?: () => void;
  /** 展示页用：钉住状态。 */
  readonly busy?: boolean;
  readonly failure?: ConnectFailure | null;
  /** 展示页用：钉住配对码输入框里的字。 */
  readonly initialCode?: string;
}

/** 配对码的 8 位分两组（`XXXX-XXXX`）。 */
const CODE_LENGTH = 8;
/** 输入时放过小写，进状态前转大写；`0` / `1` 不在字母表里（契约 §24）。 */
const CODE_INPUT = "^[A-Za-z2-9]*$";

function codeOf(value: string): string {
  return value
    .replace(/[^A-Za-z2-9]/g, "")
    .toUpperCase()
    .slice(0, CODE_LENGTH);
}

/**
 * 连接页（设计系统 §5.12 末条、§5.13；架构 §10）：登录页的变体——顶部
 * BrandMark、一个标题、一个动作。手机整页，`100dvh`，键盘弹起时整列可滚。
 */
export function ConnectScreen({
  mode,
  origin,
  canScan = false,
  initialLink = "",
  onConnect,
  onScan,
  caGuide,
  busy: pinnedBusy,
  failure: pinnedFailure,
  onCode,
  codeFirst = false,
  onSignIn,
  initialCode = "",
}: ConnectScreenProps) {
  const t = useT();
  const [link, setLink] = React.useState(initialLink);
  const [view, setView] = React.useState<"link" | "code">(
    codeFirst && onCode ? "code" : "link",
  );
  const [code, setCode] = React.useState(codeOf(initialCode));
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<ConnectFailure | null>(null);
  const shownBusy = pinnedBusy ?? busy;
  const shownFailure = pinnedFailure ?? failure;
  const fieldId = React.useId();
  const codeId = `${fieldId}-code`;
  const errorId = `${fieldId}-error`;

  const connect = async (value: string) => {
    if (shownBusy) return;
    setBusy(true);
    setFailure(null);
    try {
      setFailure(await onConnect(value));
    } catch {
      setFailure("failed");
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (value: string) => {
    if (shownBusy || !onCode || value.length !== CODE_LENGTH) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await onCode(value);
      setFailure(result);
      // 码是一次性的：没成功就清空重输，免得人对着一枚已作废的码再点一次。
      if (result !== null) setCode("");
    } catch {
      setFailure("failed");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: "link" | "code") => {
    setView(next);
    setFailure(null);
  };

  const scan = async () => {
    const text = await onScan?.();
    if (!text) return;
    setLink(text);
    await connect(text);
  };

  const message =
    shownFailure === null
      ? null
      : t(`mobileConnect.error.${shownFailure}`, {
          origin: origin ? new URL(origin).host : "",
        });
  const host = origin ? new URL(origin).host : null;

  return (
    <main
      data-slot="mobile-connect"
      className="flex min-h-[100dvh] w-full flex-col items-center overflow-y-auto bg-background px-6 pt-[max(env(safe-area-inset-top),15vh)] pb-[max(env(safe-area-inset-bottom),24px)]"
    >
      <form
        className="flex w-full max-w-sm flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (view === "code") void submitCode(code);
          else void connect(mode === "native" ? link : "");
        }}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-12 rounded-[var(--r-panel)]" />
          <h1 className="text-[length:var(--text-display)] leading-tight font-semibold">
            {t("mobileConnect.title")}
          </h1>
          {mode === "web" && host && (
            <p className="font-mono text-[13px] text-muted-foreground tabular-nums">
              {host}
            </p>
          )}
        </div>

        {view === "code" ? (
          <Field data-invalid={shownFailure !== null || undefined}>
            <FieldLabel htmlFor={codeId} className="justify-center">
              {t("mobileConnect.code")}
            </FieldLabel>
            <InputOTP
              id={codeId}
              maxLength={CODE_LENGTH}
              pattern={CODE_INPUT}
              pasteTransformer={codeOf}
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="one-time-code"
              // 展示页钉住了字时不抢焦点。
              autoFocus={initialCode === ""}
              value={code}
              disabled={shownBusy}
              aria-describedby={message ? errorId : undefined}
              containerClassName="justify-center gap-2"
              onChange={(value: string) => {
                setCode(codeOf(value));
                setFailure(null);
              }}
              onComplete={(value: string) => void submitCode(codeOf(value))}
            >
              {[0, 4].map((offset) => (
                <React.Fragment key={offset}>
                  {offset > 0 && <InputOTPSeparator />}
                  <InputOTPGroup>
                    {[0, 1, 2, 3].map((index) => (
                      <InputOTPSlot
                        key={index}
                        index={offset + index}
                        // 触屏命中区与 16px 输入（设计系统 §2.3、§5.13）。
                        className="size-10 font-mono text-[length:var(--text-input-touch)]"
                        aria-invalid={shownFailure !== null || undefined}
                      />
                    ))}
                  </InputOTPGroup>
                </React.Fragment>
              ))}
            </InputOTP>
            {message && (
              <FieldError id={errorId} className="text-center">
                {message}
              </FieldError>
            )}
          </Field>
        ) : (
          <>
            {mode === "native" && (
              <Field data-invalid={shownFailure !== null || undefined}>
                <FieldLabel htmlFor={fieldId}>
                  {t("mobileConnect.link")}
                </FieldLabel>
                <Input
                  id={fieldId}
                  value={link}
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://…/#pair=…"
                  aria-invalid={shownFailure !== null || undefined}
                  aria-describedby={message ? errorId : undefined}
                  disabled={shownBusy}
                  // iOS 聚焦时小于 16px 的输入会放大整页（设计系统 §2.3）。
                  className="h-11 text-[length:var(--text-input-touch)] md:text-[length:var(--text-input-touch)]"
                  onChange={(event) => {
                    setLink(event.target.value);
                    setFailure(null);
                  }}
                />
                {message && <FieldError id={errorId}>{message}</FieldError>}
              </Field>
            )}

            {mode === "web" && message && (
              <Alert variant="destructive">
                <AlertTitle>{message}</AlertTitle>
              </Alert>
            )}

            <div className="flex flex-col gap-2">
              <Button
                type="submit"
                size="lg"
                className="h-11 w-full"
                disabled={
                  shownBusy || (mode === "native" && link.trim() === "")
                }
              >
                {shownBusy && (
                  <Spinner aria-label={t("mobileConnect.connecting")} />
                )}
                {t("mobileConnect.connect")}
              </Button>
              {mode === "native" && canScan && (
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  className="h-11 w-full"
                  disabled={shownBusy}
                  onClick={() => void scan()}
                >
                  <ScanLine data-icon="inline-start" />
                  {t("mobileConnect.scan")}
                </Button>
              )}
              {onCode && (
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  className="h-11 w-full"
                  disabled={shownBusy}
                  onClick={() => switchTo("code")}
                >
                  <KeyRound data-icon="inline-start" />
                  {t("mobileConnect.enterCode")}
                </Button>
              )}
            </div>
          </>
        )}

        {view === "code" && (
          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              size="lg"
              className="h-11 w-full"
              disabled={shownBusy || code.length !== CODE_LENGTH}
            >
              {shownBusy && (
                <Spinner aria-label={t("mobileConnect.connecting")} />
              )}
              {t("mobileConnect.connect")}
            </Button>
            {!codeFirst && (
              <Button
                type="button"
                size="lg"
                variant="ghost"
                className="h-11 w-full"
                disabled={shownBusy}
                onClick={() => switchTo("link")}
              >
                <Link2 data-icon="inline-start" />
                {t("mobileConnect.useLink")}
              </Button>
            )}
            {onSignIn && (
              <Button
                type="button"
                size="lg"
                variant="ghost"
                className="h-11 w-full"
                disabled={shownBusy}
                onClick={onSignIn}
              >
                <LogIn data-icon="inline-start" />
                {t("mobileConnect.signIn")}
              </Button>
            )}
          </div>
        )}

        {mode === "web" && caGuide}
      </form>
    </main>
  );
}
