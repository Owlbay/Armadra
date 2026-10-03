/**
 * OAuth / OIDC 登录与绑定的挂点（补全架构 §8.3 的 OAuth 段）。
 *
 * 边界：通用 OIDC（授权码 + PKCE + `nonce`）与 GitHub 特例一条代码路径；
 * 提供方在设置 `identity.oauth.providers[]`，`clientSecret` 在 SecretStore
 * `armadra-oidc-<id>`，不入库；回调固定在公网来源下，没有公网来源或没配
 * 提供方时答 `oauth_not_configured`。契约 §18.5。
 *
 * 路由挂法：`context.server.raw("/api/identity/oauth/", …)`——原样路由按最长
 * 前缀匹配，所以它先于身份域整段接管的 `/api/identity/`。
 *
 * 现在只是骨架（G0-3）：身份域装配时调一次，什么也不登记。G1-12 填
 * `providers` / `flow` / `http`，不必再改 `identity/index.ts`。
 */

import type { CoreContext } from "../../main";
import type { AccountsService } from "../accounts";
import type { IdentityService } from "../service";
import type { IdentityStore } from "../store";

/** 身份域装配时交给 OAuth 的东西：同一个库、同一份会话与账号服务。 */
export interface OAuthDeps {
  readonly store: IdentityStore;
  readonly service: IdentityService;
  readonly accounts: AccountsService;
}

export function installOAuth(_context: CoreContext, _deps: OAuthDeps): void {
  // 骨架：G1-12 填。
}
