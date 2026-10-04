/**
 * 诊断域：页面错误上报（G5 计划 §3 G5-19）。崩溃剥离规则在 `crash.ts`。
 *
 * 边界：
 *   * 只在 `diagnostics.reportPageErrors` 打开且 DSN 合格时收，关着不收。
 *   * `POST /api/diagnostics/client-error` 登录即可（`http/route-scopes.ts` 的
 *     `SELF_GUARDED`），域自己认会话、限流，服务端再剥离一次才交
 *     `platform.reportError`。契约 §30。
 *
 * 现在只是骨架（G5-00）：`install` 什么也不登记。G5-19 填。
 */

import type { CoreContext } from "../main";

export function install(_context: CoreContext): void {
  // 骨架：G5-19 填。
}
