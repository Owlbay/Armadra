/**
 * 托管平台域 W-FORGE：把 GitHub 面推广到 Gitea / Forgejo 与 GitLab（外部服务
 * §10.2、G5 计划 §3 G5-14 / G5-15）。
 *
 * 边界：
 *   * `/api/forge/*` 与 `/api/github/*` 同一档权限（`http/route-scopes.ts`）。
 *   * 令牌只经 SecretStore（`armadra-forge-<id>`），不进库、设置文档与响应。
 *   * 外呼只到用户配置的地址（`net/outbound.ts` 的 `forgeApi`）。契约 §29。
 *   * `/api/github/*` 不改：GitHub 仓库经 {@link GithubForge} 用同一个客户端与凭据。
 */

import type { CoreContext } from "../main";
import { githubDomain } from "../github";
import { secretsFor } from "../secrets";
import { installRoutes } from "./routes";
import { ForgeService } from "./service";
import { ForgeStore } from "./store";

export { FORGE_ROUTES, forgeFailure } from "./routes";
export {
  ForgeService,
  configKey,
  forgeRepo,
  type ForgeDetection,
  type PublicForgeConfig,
} from "./service";
export { ForgeStore } from "./store";
export { GiteaForge, giteaApiBase, giteaWebRoot, splitDiff } from "./gitea";
export { GithubForge } from "./github";
export * from "./types";

export function install(context: CoreContext): ForgeService | undefined {
  // 配置在库里：没过统一库迁移的库没有 `forge_config`，路由留着答 501。
  if (!context.db.unified) {
    context.log.info("托管平台域未装配：统一库迁移尚未应用");
    return undefined;
  }
  const service = new ForgeService({
    store: new ForgeStore(context.db.database),
    secrets: () => secretsFor(context).backend,
    github: () => githubDomain()?.service,
  });
  installRoutes(context.server, service);
  context.log.info("托管平台域已装配");
  return service;
}
