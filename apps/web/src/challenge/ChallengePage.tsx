import * as React from "react";

import { syncDocumentPreferences, useT } from "../app/preferences-store";
import { TurnstileWidget } from "./TurnstileWidget";
import { CHALLENGE_MESSAGE, CHALLENGE_PATH } from "./turnstile";

/** 路径是不是挑战页（中继托管的 `/app/challenge`）。 */
export function isChallengePath(pathname: string): boolean {
  return pathname === CHALLENGE_PATH || pathname === `${CHALLENGE_PATH}/`;
}

/**
 * 挑战页（契约 §62.2）：只渲染组件。令牌用 `postMessage` 交给嵌它的页面，且只发给
 * 查询里 `parent` 指明的来源——别的页面把它嵌进去也收不到令牌。
 */
export function ChallengePage({
  search = globalThis.location?.search ?? "",
  post = (message, target) => globalThis.parent?.postMessage(message, target),
}: {
  readonly search?: string;
  readonly post?: (message: unknown, targetOrigin: string) => void;
}) {
  const t = useT();
  React.useEffect(() => syncDocumentPreferences(), []);
  const query = new URLSearchParams(search);
  const siteKey = query.get("siteKey") ?? "";
  const parent = query.get("parent") ?? "";
  if (siteKey === "" || parent === "") return null;
  return (
    <main aria-label={t("challenge.title")} className="p-2">
      <TurnstileWidget
        siteKey={siteKey}
        onToken={(token) => post({ type: CHALLENGE_MESSAGE, token }, parent)}
      />
    </main>
  );
}
