/**
 * The usage snapshot and the two bars the tray strip reads.
 *
 * Ported from the shape half of the pre-merge implementation. What is *not*
 * here is the fetching: the three provider modules read a CLI's stored
 * credentials and call a quota endpoint, and that — along with the cost scan
 * and the Copilot device flow — is the usage domain's own phase.
 *
 * What this batch owes is the contract, and the contract's most important case
 * is the one with no data in it. Three rules from the Rust module apply
 * verbatim and are the reason this file exists at all:
 *
 *  1. **Tokens never leave the module that read them.** Nothing here holds,
 *     caches or serialises a credential; a provider reports only *where* its
 *     token was found (`keychain` / `file` / `none`).
 *  2. **Only percentages and reset times reach the API.** The upstream payloads
 *     carry account ids, e-mail addresses and plan names; none of that is
 *     mapped into a snapshot.
 *  3. **A failure carries a reason code, never a message.** A user who sees
 *     「取不到用量」and nothing else cannot tell an expired sign-in from a proxy
 *     problem. `unavailable` with no reason means "no credentials on this
 *     machine", which is a different thing again and is what an empty snapshot
 *     reports.
 */

import type { LocalWindowEstimates } from "./local-window";

/** Every provider the core has a module for, in the order the snapshot lists them. */
export const USAGE_PROVIDER_IDS = ["claude", "codex", "copilot"] as const;

export type UsageProviderId = (typeof USAGE_PROVIDER_IDS)[number];

export type UsageStatus = "ok" | "unavailable" | "error";

/** Where a provider's token was found. Only the *location* is ever reported. */
export type CredentialSource = "keychain" | "file" | "none";

/** Why a provider is `error`, as a code. Nothing here names an account or a URL. */
export type UsageFailure =
  | "expired_credentials"
  | "unreadable_credentials"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "provider_error"
  | "network"
  | "parse"
  | "no_windows"
  /**
   * 端点答了一页 HTML（挑战页、改版）。和下一个一样随 `unavailable` 报，
   * 不算错误。
   */
  | "unsupported"
  /**
   * 这家的额度端点要借用 CLI 的登录令牌，有条款风险，出站政策默认关
   * （`usage.claudeUsage` / `usage.copilotUsage`，外部服务 §9.3）。
   */
  | "policy_off";

/**
 * One rate-limit window. `label` is a unit abbreviation (`5h`, `7d`), not
 * prose: the web maps it through i18n and falls back to it verbatim.
 */
export interface UsageWindow {
  readonly key: string;
  readonly label: string;
  readonly group?: string;
  /** 0–100, already rounded to one decimal by the provider module. */
  readonly usedPercent: number;
  /**
   * A bucket with no ceiling. `usedPercent` is 0 and means nothing; the UI
   * prints 无限制 rather than an empty bar.
   */
  readonly unlimited?: boolean;
  /** RFC 3339, or `null` when the provider does not say. */
  readonly resetsAt: string | null;
}

export interface UsageCredits {
  readonly balance: number;
}

export interface ProviderUsage {
  readonly id: UsageProviderId;
  readonly status: UsageStatus;
  /**
   * With `status: "error"`; with `unavailable` only `unsupported` or
   * `policy_off`.
   */
  readonly reason?: UsageFailure;
  readonly credentialSource: CredentialSource;
  readonly windows: readonly UsageWindow[];
  readonly credits?: UsageCredits;
  readonly viaCli?: boolean;
  readonly fetchedAt: string | null;
  /**
   * 只跟着 `reason: "policy_off"` 出现：额度端点关着，用本机转录估出来的窗口
   * （`local-window.ts`，契约 §12.1）。不是额度端点的答案，界面标「本地估算」。
   */
  readonly estimate?: LocalWindowEstimates;
}

export interface UsageSnapshot {
  readonly providers: readonly ProviderUsage[];
  readonly refreshAvailableAt: string | null;
}

function unavailable(id: UsageProviderId): ProviderUsage {
  return {
    id,
    status: "unavailable",
    credentialSource: "none",
    windows: [],
    fetchedAt: null,
  };
}

/**
 * What the API answers before the first fetch, and whenever `usage.enabled` is
 * off: every provider `unavailable`, which is exactly the state in which the
 * pill does not render.
 */
export function emptySnapshot(): UsageSnapshot {
  return {
    providers: USAGE_PROVIDER_IDS.map(unavailable),
    refreshAvailableAt: null,
  };
}
