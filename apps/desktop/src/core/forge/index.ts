/**
 * 托管平台域 W-FORGE：把 GitHub 面推广到 Gitea / Forgejo 与 GitLab（外部服务
 * §10.2、G5 计划 §3 G5-14 / G5-15）。
 *
 * 边界：
 *   * `/api/forge/*` 与 `/api/github/*` 同一档权限（`http/route-scopes.ts`）。
 *   * 令牌只经 SecretStore（`armadra-forge-<id>`），不进设置文档与响应。
 *   * 外呼只到用户配置的地址（`net/outbound.ts`）。契约 §29。
 *
 * 现在只是骨架（G5-00）：`install` 什么也不登记。G5-14 填。
 */

import type { CoreContext } from "../main";

export function install(_context: CoreContext): void {
  // 骨架：G5-14 填。
}
