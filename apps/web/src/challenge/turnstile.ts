/**
 * Turnstile 的页面端（契约 §62）：显式渲染，脚本由 Cloudflare 提供。
 *
 * 只有中继托管的页面（来源就是中继）直接渲染；其余来源内嵌中继的
 * `/app/challenge` 页（`ChallengeFrame`），那一页也走这里。令牌一次性、300 秒内有效。
 */

export const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      theme?: "auto" | "light" | "dark";
      size?: "normal" | "flexible" | "compact";
      callback(token: string): void;
      "error-callback"?(): void;
      "expired-callback"?(): void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** 载入 Turnstile 脚本（只载一次）；载不进来（离线、被拦）reject。 */
export function loadTurnstile(
  doc: Document = document,
  src: string = TURNSTILE_SCRIPT,
): Promise<TurnstileApi> {
  const ready = doc.defaultView?.turnstile;
  if (ready !== undefined) return Promise.resolve(ready);
  if (loading !== null) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      const api = doc.defaultView?.turnstile;
      if (api === undefined) reject(new Error("turnstile unavailable"));
      else resolve(api);
    };
    script.onerror = () => reject(new Error("turnstile failed to load"));
    doc.head.appendChild(script);
  }).catch((error: unknown) => {
    // 失败不记死：下一次打开面板可以重试。
    loading = null;
    throw error;
  });
  return loading;
}

/** 挑战页与页面之间的 `postMessage` 形状。 */
export const CHALLENGE_MESSAGE = "armadra-challenge";

export interface ChallengeMessage {
  readonly type: typeof CHALLENGE_MESSAGE;
  readonly token: string;
}

export function isChallengeMessage(value: unknown): value is ChallengeMessage {
  const message = value as Partial<ChallengeMessage> | null;
  return (
    message !== null &&
    typeof message === "object" &&
    message.type === CHALLENGE_MESSAGE &&
    typeof message.token === "string" &&
    message.token !== ""
  );
}

/** 中继托管的挑战页路径（与 `/app/` 一起托管）。 */
export const CHALLENGE_PATH = "/app/challenge";

/** 内嵌挑战页的地址：站点密钥与页面自己的来源（令牌只发给它）放在查询里。 */
export function challengeFrameUrl(
  issuer: string,
  siteKey: string,
  parentOrigin: string,
): string {
  const url = new URL(CHALLENGE_PATH, issuer);
  url.searchParams.set("siteKey", siteKey);
  url.searchParams.set("parent", parentOrigin);
  return url.toString();
}
