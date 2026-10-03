/**
 * 推送域：设备注册、Web Push / APNs / FCM / 中继四种传输与触发规则（补全架构
 * §10）。
 *
 * 边界：
 *   * 只发给对该工作空间有 `canvas:read` 的 principal 的设备；正文不含终端
 *     原文与文件内容。
 *   * 没配置时传输是 `log`（设置 `push.transport`），接口照常答 `queued`。
 *   * 密钥只存文件路径（`push.apns.keyFile`、`push.fcm.serviceAccountFile`）。
 *   * `/api/push/*` 登录即可：路由门不判 scope（`http/route-scopes.ts` 的
 *     `SELF_GUARDED`），本域只操作请求主体自己的设备，必须自己认请求身份。
 *     契约 §19。
 *
 * 现在只是骨架（G0-3）：`install` 什么也不登记。G1-13 填。
 */

import type { CoreContext } from "../main";

export function install(_context: CoreContext): void {
  // 骨架：G1-13 填。
}
