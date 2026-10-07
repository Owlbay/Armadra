import * as React from "react";
import {
  ChevronLeft,
  KeyRound,
  Link2,
  LogIn,
  Plus,
  ScanLine,
  Waypoints,
} from "lucide-react";

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
import type {
  RelayEnrollment,
  RelayOutcome,
  RelaySourceChoice,
} from "./connect";
import {
  type ConnectionRow,
  ConnectionList,
  FingerprintStep,
  RelayForm,
  SourcesStep,
} from "./ConnectRelay";
import { isJoinLink, issuerOrigin, parseJoinLink } from "./join-link";

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
  | "rateLimited"
  | "credentials"
  | "locked"
  | "linkInvalid"
  | "linkExpired"
  | "linkExhausted"
  | "linkSecret"
  | "invitation"
  | "fingerprint"
  | "offline"
  | "noSources"
  | "address";

/** 原生 App 里「添加连接」的几个视图（多连接）。 */
export type ConnectView =
  | "list"
  | "add"
  | "link"
  | "code"
  | "relay"
  | "fingerprint"
  | "sources";

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
  /**
   * 个人中转的添加流程（`createRelayEnrollment`）。给了才是多连接形态：
   * 已有的连接列表 + 「添加连接」（扫码 / 配对链接 / 个人中转）。
   */
  readonly relay?: RelayEnrollment;
  readonly connections?: readonly ConnectionRow[];
  readonly activeId?: string | undefined;
  readonly onOpen?: (sourceId: string) => void;
  readonly onRemove?: (sourceId: string) => void;
  /** 收到的是分享深链：一打开就直接挂载（`initialLink`）。 */
  readonly autoJoin?: boolean;
  /** 进来时就带着的失败（选中的连接连不上）；人一动手就清掉，不像 `failure` 那样钉住。 */
  readonly initialFailure?: ConnectFailure;
  /** 展示页用：钉住视图与那一步的内容。 */
  readonly initialView?: ConnectView;
  readonly initialFingerprint?: string;
  readonly initialSources?: readonly RelaySourceChoice[];
  readonly initialRelay?: {
    readonly issuer?: string;
    readonly account?: string;
    readonly password?: string;
  };
}

/**
 * 分享链接那几种失败与桌面、托管页面是同一句话（按错误码的那一套，`errors.ts`），
 * 不在连接页另写一份。
 */
const SHARED_FAILURE_KEY: Partial<Record<ConnectFailure, string>> = {
  linkInvalid: "error.linkInvalid",
  linkExpired: "error.linkExpired",
  linkExhausted: "error.linkExhausted",
  linkSecret: "error.linkSecretInvalid",
  invitation: "error.invitationInvalid",
  fingerprint: "error.fingerprintMismatch",
};

/** 输入或链接里的主机（带端口），认不出是 `null`。 */
function hostOf(text: string): string | null {
  const origin = parseJoinLink(text)?.issuer ?? issuerOrigin(text);
  if (origin === null) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
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
  relay,
  connections = [],
  activeId,
  onOpen,
  onRemove,
  autoJoin = false,
  initialFailure,
  initialView,
  initialFingerprint = "",
  initialSources = [],
  initialRelay,
}: ConnectScreenProps) {
  const t = useT();
  const multi = mode === "native" && relay !== undefined;
  const [link, setLink] = React.useState(initialLink);
  const [view, setView] = React.useState<ConnectView>(() => {
    if (initialView) return initialView;
    if (codeFirst && onCode) return "code";
    if (!multi) return "link";
    if (initialLink !== "") return autoJoin ? "add" : "link";
    return connections.length > 0 ? "list" : "add";
  });
  const [fingerprint, setFingerprint] = React.useState(initialFingerprint);
  const [sources, setSources] =
    React.useState<readonly RelaySourceChoice[]>(initialSources);
  const [relayHost, setRelayHost] = React.useState(
    () => hostOf(initialRelay?.issuer ?? "") ?? "",
  );
  const [code, setCode] = React.useState(codeOf(initialCode));
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<ConnectFailure | null>(
    initialFailure ?? null,
  );
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

  const apply = (outcome: RelayOutcome) => {
    switch (outcome.kind) {
      case "fingerprint":
        setFingerprint(outcome.fingerprint);
        setView("fingerprint");
        break;
      case "sources":
        setSources(outcome.sources);
        setView("sources");
        break;
      case "failure":
        setFailure(outcome.failure);
        break;
      case "done":
        break;
    }
  };

  /** 个人中转的一步：忙、清错、套用结果；任何意外都落成「失败」。 */
  const step = async (run: () => Promise<RelayOutcome>) => {
    if (shownBusy) return;
    setBusy(true);
    setFailure(null);
    try {
      apply(await run());
    } catch {
      setFailure("failed");
    } finally {
      setBusy(false);
    }
  };

  /** 链接 / 二维码：个人中转的分享链接直接挂载，其余按配对链接处理。 */
  const submitLink = async (value: string) => {
    if (relay && isJoinLink(value)) {
      setRelayHost(hostOf(value) ?? "");
      await step(() => relay.join(value));
    } else {
      await connect(value);
    }
  };

  const scan = async () => {
    const text = await onScan?.();
    if (!text) return;
    setLink(text);
    await submitLink(text);
  };

  const joinedOnce = React.useRef(false);
  React.useEffect(() => {
    if (!autoJoin || !relay || joinedOnce.current || initialLink === "") return;
    joinedOnce.current = true;
    void submitLink(initialLink);
    // 只在首次挂载时按收到的分享深链挂载一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const back = () => {
    relay?.reset();
    setFailure(null);
    setView(connections.length > 0 ? "list" : "add");
  };

  const message =
    shownFailure === null
      ? null
      : t(
          SHARED_FAILURE_KEY[shownFailure] ??
            `mobileConnect.error.${shownFailure}`,
          { origin: origin ? new URL(origin).host : "" },
        );
  const host = origin ? new URL(origin).host : null;
  const titleKey =
    view === "relay"
      ? "mobileConnect.method.relay"
      : view === "fingerprint"
        ? "mobileConnect.fingerprint.title"
        : view === "sources"
          ? "mobileConnect.sources.title"
          : multi && view === "add" && connections.length > 0
            ? "mobileConnect.add"
            : "mobileConnect.title";
  const panel = multi && view !== "link" && view !== "code";

  const header = (
    <div className="flex flex-col items-center gap-3 text-center">
      <BrandMark className="size-12 rounded-[var(--r-panel)]" />
      <h1 className="text-[length:var(--text-display)] leading-tight font-semibold">
        {t(titleKey)}
      </h1>
      {mode === "web" && host && (
        <p className="font-mono text-[13px] text-muted-foreground tabular-nums">
          {host}
        </p>
      )}
    </div>
  );

  const rootClass =
    "flex min-h-[100dvh] w-full flex-col items-center overflow-y-auto bg-background pt-[max(var(--safe-top),15vh)] pr-[calc(1.5rem+var(--safe-right))] pb-[max(var(--safe-bottom),24px)] pl-[calc(1.5rem+var(--safe-left))]";

  if (panel && relay) {
    const rows = connections;
    return (
      <main data-slot="mobile-connect" className={rootClass}>
        <div className="flex w-full max-w-sm flex-col gap-6">
          {header}
          {view === "list" && (
            <>
              {message && (
                <Alert variant="destructive">
                  <AlertTitle>{message}</AlertTitle>
                </Alert>
              )}
              <ConnectionList
                rows={rows}
                activeId={activeId}
                disabled={shownBusy}
                onOpen={(sourceId) => onOpen?.(sourceId)}
                onRemove={(sourceId) => onRemove?.(sourceId)}
              />
              <Button
                type="button"
                size="lg"
                variant="outline"
                className="h-11 w-full"
                disabled={shownBusy}
                onClick={() => {
                  setFailure(null);
                  setView("add");
                }}
              >
                <Plus data-icon="inline-start" />
                {t("mobileConnect.add")}
              </Button>
            </>
          )}
          {view === "add" && (
            <div className="flex flex-col gap-2">
              {message && (
                <Alert variant="destructive">
                  <AlertTitle>{message}</AlertTitle>
                </Alert>
              )}
              {canScan && (
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
              <Button
                type="button"
                size="lg"
                variant="outline"
                className="h-11 w-full"
                disabled={shownBusy}
                data-connect-method="link"
                onClick={() => {
                  setFailure(null);
                  setView("link");
                }}
              >
                <Link2 data-icon="inline-start" />
                {t("mobileConnect.link")}
              </Button>
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
              <Button
                type="button"
                size="lg"
                variant="outline"
                className="h-11 w-full"
                disabled={shownBusy}
                onClick={() => {
                  setFailure(null);
                  setView("relay");
                }}
              >
                <Waypoints data-icon="inline-start" />
                {t("mobileConnect.method.relay")}
              </Button>
              {connections.length > 0 && (
                <Button
                  type="button"
                  size="lg"
                  variant="ghost"
                  className="h-11 w-full"
                  disabled={shownBusy}
                  onClick={back}
                >
                  <ChevronLeft data-icon="inline-start" />
                  {t("mobileConnect.back")}
                </Button>
              )}
            </div>
          )}
          {view === "relay" && (
            <>
              <RelayForm
                busy={shownBusy}
                message={message}
                errorId={errorId}
                {...(initialRelay ? { initial: initialRelay } : {})}
                onEdit={() => setFailure(null)}
                onSubmit={(input) => {
                  setRelayHost(hostOf(input.issuer) ?? "");
                  void step(() => relay.begin(input));
                }}
              />
              <Button
                type="button"
                size="lg"
                variant="ghost"
                className="h-11 w-full"
                disabled={shownBusy}
                onClick={() => {
                  setFailure(null);
                  setView("add");
                }}
              >
                <ChevronLeft data-icon="inline-start" />
                {t("mobileConnect.back")}
              </Button>
            </>
          )}
          {view === "fingerprint" && (
            <FingerprintStep
              host={relayHost}
              fingerprint={fingerprint}
              busy={shownBusy}
              message={message}
              errorId={errorId}
              onTrust={() => void step(() => relay.trust())}
              onCancel={back}
            />
          )}
          {view === "sources" && (
            <SourcesStep
              sources={sources}
              busy={shownBusy}
              message={message}
              errorId={errorId}
              onMount={(ids) => void step(() => relay.mount(ids))}
            />
          )}
        </div>
      </main>
    );
  }

  return (
    <main data-slot="mobile-connect" className={rootClass}>
      <form
        className="flex w-full max-w-sm flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (view === "code") void submitCode(code);
          else void submitLink(mode === "native" ? link : "");
        }}
      >
        {header}

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
              {multi && (
                <Button
                  type="button"
                  size="lg"
                  variant="ghost"
                  className="h-11 w-full"
                  disabled={shownBusy}
                  onClick={() => {
                    setFailure(null);
                    setView("add");
                  }}
                >
                  <ChevronLeft data-icon="inline-start" />
                  {t("mobileConnect.back")}
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
