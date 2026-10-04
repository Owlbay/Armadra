/**
 * 邮件域 W-MAIL：可选的 SMTP 通知通道（外部服务 §7.5、G5 计划 §3 G5-13）。
 *
 * 边界：
 *   * 只在服务器壳配了 `ARMADRA_SMTP_URL` / `--smtp-url` 时工作；桌面壳不配，
 *     `GET /api/mail/status` 答 `configured: false`。
 *   * 只发邀请与口令重置链接：正文只有链接与过期时间；收件地址不进审计明文。
 *   * `/api/mail/*` 自己认身份（`http/route-scopes.ts` 的 `SELF_GUARDED`）：
 *     能签发那条链接的人才能发。契约 §28。
 *
 * 现在只是骨架（G5-00）：`install` 什么也不登记。G5-13 填。
 */

import type { CoreContext } from "../main";

export function install(_context: CoreContext): void {
  // 骨架：G5-13 填。
}
