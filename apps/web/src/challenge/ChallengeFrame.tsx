import * as React from "react";

import { useT } from "../app/preferences-store";
import { Button } from "@/ui/button";
import {
  challengeFrameUrl,
  isChallengeMessage,
  type TurnstileApi,
} from "./turnstile";
import { TurnstileWidget } from "./TurnstileWidget";

export interface ChallengeFrameProps {
  /** 要求挑战的中继来源。 */
  readonly issuer: string;
  readonly siteKey: string;
  readonly onToken: (token: string) => void;
  /** 页面自己的来源（缺省 `location.origin`）；等于 `issuer` 时直接渲染组件。 */
  readonly origin?: string;
  /** 测试注入：换掉从 Cloudflare 载脚本。 */
  readonly load?: () => Promise<TurnstileApi>;
}

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
 * 内嵌中继托管的 `/app/challenge`，只收来自中继来源的 `postMessage`。
 */
export function ChallengeFrame({
  issuer,
  siteKey,
  onToken,
  origin = globalThis.location?.origin ?? "",
  load,
}: ChallengeFrameProps) {
  const t = useT();
  const relay = originOf(issuer);
  const inline = originOf(origin) === relay;
  // 换一次 key 就重挂：组件载不进来时「重试」重新渲染。
  const [attempt, setAttempt] = React.useState(0);
  const [failed, setFailed] = React.useState(false);
  const tokenRef = React.useRef(onToken);
  tokenRef.current = onToken;

  React.useEffect(() => {
    if (inline) return;
    const listen = (event: MessageEvent) => {
      if (event.origin !== relay || !isChallengeMessage(event.data)) return;
      tokenRef.current(event.data.token);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [inline, relay]);

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
        onToken={onToken}
        onError={() => setFailed(true)}
        {...(load === undefined ? {} : { load })}
      />
    );
  }
  return (
    <iframe
      key={attempt}
      title={t("challenge.title")}
      src={challengeFrameUrl(relay, siteKey, originOf(origin))}
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
      className="h-[80px] w-full border-0"
    />
  );
}
