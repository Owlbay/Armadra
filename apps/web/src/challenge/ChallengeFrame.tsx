import * as React from "react";

import { useT } from "../app/preferences-store";
import { Button } from "@/ui/button";
import { cn } from "@/lib/cn";
import { Spinner } from "@/ui/spinner";
import {
  challengeFrameUrl,
  isChallengeMessage,
  isChallengeStatus,
  TURNSTILE_LOGIN_ACTION,
  type TurnstileApi,
} from "./turnstile";
import { TurnstileWidget } from "./TurnstileWidget";

export interface ChallengeFrameProps {
  /** 要求挑战的中继来源。 */
  readonly issuer: string;
  readonly siteKey: string;
  /** 令牌用途（缺省登录；改口令是 `armadra-password`，契约 §63）。 */
  readonly action?: string;
  readonly onToken: (token: string) => void;
  /** 页面自己的来源（缺省 `location.origin`）；等于 `issuer` 时直接渲染组件。 */
  readonly origin?: string;
  /** 测试注入：换掉从 Cloudflare 载脚本。 */
  readonly load?: () => Promise<TurnstileApi>;
  /** 内嵌挑战页多久没报 `ready` 算加载失败（测试注入）。 */
  readonly readyTimeoutMs?: number;
}

/**
 * 内嵌的挑战页这么久没报 `ready` 就算没载进来：被中继的 `frame-ancestors` 拦下
 * 时 iframe 照样触发 `load`，只能靠页面自己报到来区分。
 */
export const CHALLENGE_READY_TIMEOUT_MS = 10_000;

function originOf(value: string): string {
  try {
    const url = new URL(value);
    // `capacitor://localhost` 这类非特殊协议，`origin` 是 "null"。
    return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
  } catch {
    return value;
  }
}

/**
 * 挑战面板的内容（契约 §62.2）：页面就在中继来源上（中继托管的页面）直接渲染
 * Turnstile；别的来源（桌面窗口、服务器壳网页、手机 App）Turnstile 认不得这个域，
 * 内嵌中继托管的 `/app/challenge`，只收这个 iframe、来自中继来源的 `postMessage`。
 *
 * iframe 在挑战页报 `ready` 之前不显示（被拦下时是一块白），超时或挑战页报
 * `error` 就换成一次「加载失败 / 重试」；不自己重试，`src` 只随中继、站点密钥、
 * 页面来源与用途变，父组件重渲染不会让 iframe 重载。
 */
export function ChallengeFrame({
  issuer,
  siteKey,
  action = TURNSTILE_LOGIN_ACTION,
  onToken,
  origin = globalThis.location?.origin ?? "",
  load,
  readyTimeoutMs = CHALLENGE_READY_TIMEOUT_MS,
}: ChallengeFrameProps) {
  const t = useT();
  const relay = originOf(issuer);
  const parent = originOf(origin);
  const inline = parent === relay;
  // 换一次 key 就重挂：组件载不进来时「重试」重新渲染。
  const [attempt, setAttempt] = React.useState(0);
  const [failed, setFailed] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const frame = React.useRef<HTMLIFrameElement>(null);
  const tokenRef = React.useRef(onToken);
  tokenRef.current = onToken;
  const src = React.useMemo(
    () => challengeFrameUrl(relay, siteKey, parent, action),
    [relay, siteKey, parent, action],
  );

  React.useEffect(() => {
    if (inline || failed) return;
    let reported = false;
    const timer = setTimeout(() => {
      if (!reported) setFailed(true);
    }, readyTimeoutMs);
    const listen = (event: MessageEvent) => {
      if (event.origin !== relay) return;
      if (event.source !== frame.current?.contentWindow) return;
      if (isChallengeMessage(event.data)) {
        tokenRef.current(event.data.token);
      } else if (isChallengeStatus(event.data)) {
        reported = true;
        clearTimeout(timer);
        if (event.data.status === "ready") setReady(true);
        else setFailed(true);
      }
    };
    window.addEventListener("message", listen);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", listen);
    };
  }, [inline, failed, relay, attempt, readyTimeoutMs]);

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-3 py-2">
        <p role="alert" className="text-sm text-muted-foreground">
          {t("challenge.loadFailed")}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setFailed(false);
            setReady(false);
            setAttempt((value) => value + 1);
          }}
        >
          {t("challenge.retry")}
        </Button>
      </div>
    );
  }
  if (inline) {
    return (
      <TurnstileWidget
        key={attempt}
        siteKey={siteKey}
        action={action}
        onToken={onToken}
        onError={() => setFailed(true)}
        {...(load === undefined ? {} : { load })}
      />
    );
  }
  return (
    <div className="relative h-[80px] w-full">
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner aria-label={t("challenge.loading")} />
        </div>
      )}
      <iframe
        key={attempt}
        ref={frame}
        title={t("challenge.title")}
        src={src}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        className={cn("h-full w-full border-0", !ready && "invisible")}
      />
    </div>
  );
}
