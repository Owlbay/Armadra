import * as React from "react";

import { useT } from "../app/preferences-store";
import { Spinner } from "@/ui/spinner";
import {
  loadTurnstile,
  TURNSTILE_LOGIN_ACTION,
  type TurnstileApi,
} from "./turnstile";

export interface TurnstileWidgetProps {
  readonly siteKey: string;
  /** 令牌用途，中继校验 siteverify 回的 action 是否一致。 */
  readonly action?: string;
  readonly onToken: (token: string) => void;
  /** 组件载不进来或判定失败：面板给「重试」。 */
  readonly onError?: () => void;
  /** 测试注入：换掉从 Cloudflare 载脚本。 */
  readonly load?: () => Promise<TurnstileApi>;
}

/** Turnstile 组件本体：隐式无交互时它自己不显示，需要时在这里渲染。 */
export function TurnstileWidget({
  siteKey,
  action = TURNSTILE_LOGIN_ACTION,
  onToken,
  onError,
  load = () => loadTurnstile(),
}: TurnstileWidgetProps) {
  const t = useT();
  const host = React.useRef<HTMLDivElement>(null);
  const [ready, setReady] = React.useState(false);
  const handlers = React.useRef({ onToken, onError });
  handlers.current = { onToken, onError };
  React.useEffect(() => {
    let cancelled = false;
    let widget: string | null = null;
    let api: TurnstileApi | null = null;
    load().then(
      (turnstile) => {
        const element = host.current;
        if (cancelled || element === null) return;
        api = turnstile;
        setReady(true);
        widget = turnstile.render(element, {
          sitekey: siteKey,
          action,
          theme: "auto",
          size: "flexible",
          retry: "never",
          "refresh-expired": "manual",
          callback: (token) => handlers.current.onToken(token),
          "error-callback": () => handlers.current.onError?.(),
          "expired-callback": () => handlers.current.onError?.(),
        });
      },
      () => {
        if (!cancelled) handlers.current.onError?.();
      },
    );
    return () => {
      cancelled = true;
      if (widget !== null) api?.remove(widget);
    };
    // load 是稳定的注入点；换 siteKey 才重渲染。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, action]);
  return (
    <div className="flex min-h-[65px] items-center justify-center">
      {!ready && <Spinner aria-label={t("challenge.loading")} />}
      <div ref={host} className="w-full" />
    </div>
  );
}
