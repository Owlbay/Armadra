import type { UsageEstimateWindow, UsageProvider } from "@armadra/shared";

import { useT } from "../../app/preferences-store";
import { formatTokens } from "../../lib/cost";
import { formatRelativeTime } from "../../lib/format";
import { usageEstimatePercent, usageWindowLabel } from "../../lib/usage";
import { Badge } from "@/ui/badge";

/**
 * 额度端点关着时的本地估算窗口（契约 §12.1）。和额度窗口分开画，并且总带
 * 「本地估算」徽标：这是本机转录累计的 token，不是服务商答的额度。知道额度
 * 才画进度条与百分比，否则只报 token 数。
 */
export function LocalEstimate({
  provider,
  windows,
  now,
}: {
  provider: UsageProvider;
  windows: readonly UsageEstimateWindow[];
  now: number;
}) {
  const t = useT();
  const name = t(`usage.provider.${provider.id}`);
  return (
    <div
      data-slot="usage-local-estimate"
      className="flex min-w-0 flex-col gap-3"
    >
      <Badge variant="secondary" className="self-start">
        {t("usage.estimate.local")}
      </Badge>
      {windows.map((window) => {
        const label = usageWindowLabel(t, window);
        const percent = usageEstimatePercent(window);
        const value =
          percent === null
            ? t("usage.cost.tokenCount", { value: formatTokens(window.used) })
            : t("usage.used", { value: Math.round(percent) });
        return (
          <div key={window.key} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 break-words text-muted-foreground">
                {label}
              </span>
              <span className="shrink-0 font-medium tabular-nums">{value}</span>
            </div>
            {percent !== null && (
              <div
                role="progressbar"
                aria-label={`${name} · ${label} · ${t("usage.estimate.local")}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={value}
                className="h-1 w-full overflow-hidden rounded-full bg-border"
              >
                <div
                  data-level={
                    percent >= 95 ? "danger" : percent >= 80 ? "warn" : "normal"
                  }
                  className="h-full rounded-full bg-brand data-[level=danger]:bg-danger data-[level=warn]:bg-warn"
                  style={{ width: `${percent}%` }}
                />
              </div>
            )}
            {window.resetsAtMs !== undefined && window.resetsAtMs > now && (
              <span
                className="text-xs text-muted-foreground"
                title={new Date(window.resetsAtMs).toLocaleString()}
              >
                {t("usage.resetIn", {
                  value: formatRelativeTime(window.resetsAtMs, now),
                })}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
