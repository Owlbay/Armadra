/**
 * Gateway 域：对外 HTTPS 监听、准入（Cookie / Bearer）、本地 CA 与叶证书、
 * 配对票与二维码（补全架构 §7）。
 *
 * 边界：
 *   * 服务器壳的 `serve` 最终只是「解析参数 → `openGateway`」；准入、TLS、
 *     CSP、页面根目录从 `apps/server/src/` 下沉到这里。
 *   * 配置在设置 `gateway.*`；关掉即刻停止监听并断开流。
 *   * `/api/gateway*` 只有 owner（全局 `settings:*`，成员只有工作空间授权，
 *     所以一律 403）。契约 §17。
 *   * 装配在所有域之后：开始对外监听时，每条路由都必须已经登记。
 *
 * 现在只是骨架（G0-3）：`install` 什么也不登记、不监听。G1-10 填。
 */

import type { CoreContext } from "../main";

export function install(_context: CoreContext): void {
  // 骨架：G1-10 填。
}
