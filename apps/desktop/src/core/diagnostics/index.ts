/**
 * 诊断域：页面错误上报（G5 计划 §3 G5-19，契约 §30）。崩溃剥离规则在
 * `crash.ts`，请求体与限流在 `client-report.ts`，路由在 `routes.ts`。
 *
 * 边界：
 *   * 只在 `diagnostics.reportPageErrors` 打开且壳的崩溃上报真的在发（DSN 合格）
 *     时收，关着不收、不计数。
 *   * `/api/diagnostics/client-error` 登录即可（`http/route-scopes.ts` 的
 *     `SELF_GUARDED`），域自己认会话、限流，服务端再剥离一次才交
 *     `platform.reportError`（来源 `page`）。
 *   * 桌面壳的页面不走这里：它经 IPC `diagnostics:report` 交给主进程
 *     （`main/diagnostics.ts`），那边用同一份 `ClientReports`。
 */

import type { CoreContext } from "../main";
import { type CorePlatform, reportError } from "../platform";
import { settingsDomain } from "../settings";
import { completionSettings } from "../settings/schema";
import { ClientReports } from "./client-report";
import { parseDsn, scrubContext } from "./crash";
import { installRoutes } from "./routes";

/**
 * 收不收：设置打开，且壳答「在发」；壳不回答（桌面壳的 core）就看设置里的 DSN
 * 合不合格——桌面壳主进程收到时还会再判一次。
 */
export function pageErrorsEnabled(
  settings: {
    readonly crashReportDsn: string;
    readonly reportPageErrors: boolean;
  },
  platform: Pick<CorePlatform, "crashReportingActive">,
): boolean {
  if (!settings.reportPageErrors) return false;
  return platform.crashReportingActive !== undefined
    ? platform.crashReportingActive()
    : parseDsn(settings.crashReportDsn) !== null;
}

export function install(context: CoreContext): void {
  const { platform } = context;
  const scrub = scrubContext();
  const reports = new ClientReports({
    enabled: () =>
      pageErrorsEnabled(
        completionSettings(settingsDomain()?.settings.snapshot() ?? {})
          .diagnostics,
        platform,
      ),
    report: (error) => reportError(platform, error, { source: "page" }),
    scrub: () => scrub,
  });
  installRoutes(context.server, reports);
}
