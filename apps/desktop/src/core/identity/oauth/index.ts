/**
 * OAuth / OIDC 登录与绑定（补全架构 §8.3 的 OAuth 段，契约 §18.5）。
 *
 * 边界：通用 OIDC（授权码 + PKCE + `nonce`）与 GitHub 特例一条代码路径
 * （`providers.ts`）；流程状态与「绑定 / 登录 / 建号」的决定在 `flow.ts`；路由在
 * `http.ts`。提供方在设置 `identity.oauth.providers[]`，`clientSecret` 在
 * SecretStore `armadra-oidc-<id>`，不入库；回调固定在公网来源下，没有公网来源
 * 或没配提供方时答 `oauth_not_configured`。
 *
 * 路由挂法：`context.server.raw("/api/identity/oauth/", …)`——原样路由按最长
 * 前缀匹配，所以它先于身份域整段接管的 `/api/identity/`。
 */

import { allowedOrigins } from "../../http/cors";
import type { CoreContext } from "../../main";
import { type SecretContext, SecretStore, secretsFor } from "../../secrets";
import { completionSettings, settingsDomain } from "../../settings";
import type { OAuthProvider } from "../../settings/schema";
import type { AccountsService } from "../accounts";
import type { IdentitySecurity } from "../accounts-http";
import type { IdentityService } from "../service";
import type { IdentityStore } from "../store";
import { OAuthFlow } from "./flow";
import {
  type ClientSecrets,
  OAUTH_PREFIX,
  OAuthHttp,
  clientSecretRef,
  publicOriginsFrom,
} from "./http";
import type { FetchLike, GithubEndpoints } from "./providers";

export { OAuthFlow } from "./flow";
export { OAuthHttp, OAUTH_PREFIX, callbackUrl, clientSecretRef } from "./http";
export { bindingKey } from "./providers";

/** 身份域装配时交给 OAuth 的东西：同一个库、同一份会话与账号服务。 */
export interface OAuthDeps {
  readonly store: IdentityStore;
  readonly service: IdentityService;
  readonly accounts: AccountsService;
  /** 加固（G1-11）：MFA 第二步与来源 IP 限流。 */
  readonly security?: IdentitySecurity;
  /** 以下只给测试：外呼、GitHub 端点、提供方表、公网来源、client secret。 */
  readonly fetcher?: FetchLike;
  readonly github?: GithubEndpoints;
  readonly providers?: () => readonly OAuthProvider[];
  readonly publicOrigins?: () => readonly string[];
  readonly secrets?: ClientSecrets;
}

function settings() {
  return completionSettings(settingsDomain()?.settings.snapshot() ?? {});
}

export function createOAuthHttp(
  context: SecretContext | undefined,
  deps: OAuthDeps,
): OAuthHttp {
  const secrets: ClientSecrets =
    deps.secrets ??
    (() => {
      if (context === undefined) throw new Error("OAuth 需要 SecretStore");
      const entry = (id: string) =>
        new SecretStore(secretsFor(context).backend, clientSecretRef(id));
      return {
        read: (id) => entry(id).read(),
        write: (id, value) => entry(id).write(value),
        clear: (id) => entry(id).clear(),
      };
    })();
  const flow = new OAuthFlow({
    store: deps.store,
    service: deps.service,
    ...(deps.security === undefined ? {} : { mfa: deps.security.mfa }),
    ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }),
    ...(deps.github === undefined ? {} : { github: deps.github }),
    clientSecret: (id) => secrets.read(id),
  });
  return new OAuthHttp({
    store: deps.store,
    service: deps.service,
    flow,
    secrets,
    providers: deps.providers ?? (() => settings().identity.oauth.providers),
    publicOrigins:
      deps.publicOrigins ??
      (() => {
        const configured = settings().gateway.publicOrigin;
        return publicOriginsFrom(
          configured === "" ? [] : [configured],
          allowedOrigins(),
        );
      }),
    ...(deps.security === undefined
      ? {}
      : { throttle: deps.security.throttle }),
  });
}

export function installOAuth(context: CoreContext, deps: OAuthDeps): void {
  const http = createOAuthHttp(context, deps);
  context.server.raw(OAUTH_PREFIX, (request, response, cors) =>
    http.handle(request, response, cors),
  );
}
