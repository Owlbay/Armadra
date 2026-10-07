import type {
  UsageEstimateWindow,
  UsageProvider,
  UsageWindow,
} from "@armadra/shared";
import type { Translate } from "../app/preferences-store";
import { formatRelativeTime } from "./format";

export function usageWindowLabel(
  t: Translate,
  window: Pick<UsageWindow, "label" | "group">,
): string {
  const key = `usage.window.${window.label}`;
  const translated = t(key);
  const label = translated === key ? window.label : translated;
  return window.group ? `${window.group} · ${label}` : label;
}

export function usageIsStale(provider: UsageProvider, now: number): boolean {
  const at = Date.parse(provider.fetchedAt ?? "");
  return !Number.isFinite(at) || now - at > 10 * 60_000;
}

export function usageWindowExpired(window: UsageWindow, now: number): boolean {
  return window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
}

export function usagePercent(
  provider: UsageProvider,
  window: UsageWindow,
  now: number,
): number | null {
  if (
    provider.status !== "ok" ||
    usageIsStale(provider, now) ||
    usageWindowExpired(window, now)
  )
    return null;
  return Number.isFinite(window.usedPercent)
    ? Math.min(100, Math.max(0, window.usedPercent))
    : null;
}

export function usageResetLabel(
  t: Translate,
  window: UsageWindow,
  now: number,
): string {
  if (!window.resetsAt || !Number.isFinite(Date.parse(window.resetsAt)))
    return t("usage.resetUnknown");
  if (usageWindowExpired(window, now)) return t("usage.awaitingRefresh");
  return t("usage.resetIn", {
    value: formatRelativeTime(window.resetsAt, now),
  });
}

/** 前端能说清楚的原因代码；Runtime 的 `UsageFailure`（合并前的实现）。 */
const USAGE_REASONS: ReadonlySet<string> = new Set([
  "expired_credentials",
  "unreadable_credentials",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "provider_error",
  "network",
  "parse",
  "no_windows",
  "unsupported",
  "policy_off",
]);

/**
 * `unavailable` 也可能带原因：`policy_off`（出站政策默认关）与 `unsupported`
 * （端点答了网页）。其余 `unavailable` 就是「本机没有凭据」。
 */
export const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  "unsupported",
  "policy_off",
]);

/**
 * `status: "error"` 那一行的 i18n 键。一个 Runtime 新加的、前端还不认识的
 * 代码按通用原因显示，而不是把代码原样打在界面上。
 */
export function usageReasonKey(reason: string | undefined): string {
  const known = reason !== undefined && USAGE_REASONS.has(reason);
  return `usage.reason.${known ? reason : "provider_error"}`;
}

/**
 * 额度端点按政策关着时，core 按本机转录估出来的窗口（契约 §12.1）。只有带了
 * `estimate` 的 `policy_off` 才算。
 */
export function usageLocalEstimate(
  provider: UsageProvider,
): readonly UsageEstimateWindow[] | null {
  return provider.status === "unavailable" &&
    provider.reason === "policy_off" &&
    provider.estimate !== undefined &&
    provider.estimate.windows.length > 0
    ? provider.estimate.windows
    : null;
}

/** 估算窗口的占用百分比；不知道这一档的额度就没有。 */
export function usageEstimatePercent(
  window: UsageEstimateWindow,
): number | null {
  if (window.limit === undefined || !(window.limit > 0)) return null;
  return Math.min(100, Math.max(0, (window.used / window.limit) * 100));
}
