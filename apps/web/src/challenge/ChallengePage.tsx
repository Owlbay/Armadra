import * as React from "react";

import { syncDocumentPreferences, useT } from "../app/preferences-store";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { TurnstileWidget } from "./TurnstileWidget";
import {
  CHALLENGE_MESSAGE,
  CHALLENGE_PATH,
  challengeAction,
} from "./turnstile";

/** 路径是不是挑战页（中继托管的 `/app/challenge`）。 */
export function isChallengePath(pathname: string): boolean {
  return pathname === CHALLENGE_PATH || pathname === `${CHALLENGE_PATH}/`;
}

/**
 * 挑战页（契约 §62.2）：只渲染组件。令牌用 `postMessage` 交给嵌它的页面，且只发给
 * 查询里 `parent` 指明的来源——别的页面把它嵌进去也收不到令牌。挂上时先报一声
 * `ready`，组件失败报 `error`，由嵌它的面板给一次「重试」。
 *
 * `action` 选令牌用途（§63：`armadra-password`，缺省登录）。`mode=copy`（§63.2）不要
 * `parent`：令牌显示在只读输入框里给人复制，供终端里的运维脚本粘贴。
 */
export function ChallengePage({
  search = globalThis.location?.search ?? "",
  post = (message, target) => globalThis.parent?.postMessage(message, target),
  copy = (text) => navigator.clipboard.writeText(text),
}: {
  readonly search?: string;
  readonly post?: (message: unknown, targetOrigin: string) => void;
  readonly copy?: (text: string) => Promise<void>;
}) {
  const t = useT();
  React.useEffect(() => syncDocumentPreferences(), []);
  const query = new URLSearchParams(search);
  const siteKey = query.get("siteKey") ?? "";
  const parent = query.get("parent") ?? "";
  const action = challengeAction(query.get("action"));
  const copyMode = query.get("mode") === "copy";
  const [token, setToken] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const embedded = siteKey !== "" && parent !== "" && !copyMode;
  const postRef = React.useRef(post);
  postRef.current = post;
  // 页面脚本跑起来了：嵌它的面板据此判断没被 `frame-ancestors` 拦下。
  React.useEffect(() => {
    if (embedded)
      postRef.current({ type: CHALLENGE_MESSAGE, status: "ready" }, parent);
  }, [embedded, parent]);
  if (siteKey === "" || (parent === "" && !copyMode)) return null;
  if (copyMode) {
    return (
      <main
        aria-label={t("challenge.title")}
        className="mx-auto flex max-w-md flex-col gap-3 p-4"
      >
        {token === "" ? (
          <TurnstileWidget
            siteKey={siteKey}
            action={action}
            onToken={setToken}
          />
        ) : (
          <div className="flex items-center gap-2">
            <Input
              readOnly
              aria-label={t("challenge.token")}
              value={token}
              className="font-mono text-[12px]"
              onFocus={(event) => event.target.select()}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                void copy(token).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? t("challenge.copied") : t("challenge.copy")}
            </Button>
          </div>
        )}
      </main>
    );
  }
  return (
    <main aria-label={t("challenge.title")} className="p-2">
      <TurnstileWidget
        siteKey={siteKey}
        action={action}
        onToken={(token) => post({ type: CHALLENGE_MESSAGE, token }, parent)}
        onError={() =>
          post({ type: CHALLENGE_MESSAGE, status: "error" }, parent)
        }
      />
    </main>
  );
}
