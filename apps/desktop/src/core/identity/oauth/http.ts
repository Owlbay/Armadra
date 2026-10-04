import { isIP } from "node:net";
import type { ServerResponse } from "node:http";
import type { CoreRequest } from "../../http/router";
import type { OAuthProvider } from "../../settings/schema";
import { audit } from "../audit";
import { IdentityError, identityFailure } from "../errors";
import {
  cookieName,
  credential,
  csrfRequired,
  isSecure,
  nativeRequest,
  remoteAddress,
  sessionCookies,
} from "../http";
import { canonicalOrigin } from "../origin";
import { scope } from "../scopes";
import type { IdentityService, Principal } from "../service";
import type { IdentityStore } from "../store";
import type { Throttle } from "../throttle";
import { validName } from "../tokens";
import { FlowFailure, type FlowMode, OAuthFlow, safeReturnTo } from "./flow";
import { OAuthError, bindingKey } from "./providers";

/**
 * `/api/identity/oauth/*`（契约 §18.5）。
 *
 * 挂在 core 的原样前缀上（比身份域整段接管的 `/api/identity/` 更长，所以先
 * 匹配）。回调是从提供方跳回来的顶层导航：没有 `Origin`、`Sec-Fetch-Site` 是
 * `cross-site`、`SameSite=Strict` 的会话 Cookie 带不上——Gateway 的门对这一条
 * 路径单独放行（`core/gateway/admission.ts`），它的安全性来自一次性的 `state`
 * 加浏览器绑定 Cookie，而不是会话。其余几条照身份域的规矩：恰好一个 `Origin`、
 * 写方法要 CSRF。
 */

export const OAUTH_PREFIX = "/api/identity/oauth/";

/** SecretStore 里 client secret 的条目名。 */
export function clientSecretRef(providerId: string): string {
  return `armadra-oidc-${providerId}`;
}

/** 回调地址：固定在公网来源下。 */
export function callbackUrl(origin: string, providerId: string): string {
  return `${origin}${OAUTH_PREFIX}${providerId}/callback`;
}

/** client secret 的读写；`undefined` = 没设。 */
export interface ClientSecrets {
  read(providerId: string): Promise<string | undefined>;
  write(providerId: string, value: string): Promise<void>;
  clear(providerId: string): Promise<void>;
}

export interface OAuthHttpOptions {
  readonly store: IdentityStore;
  readonly service: IdentityService;
  readonly flow: OAuthFlow;
  readonly secrets: ClientSecrets;
  /** `identity.oauth.providers[]`，每次请求现读。 */
  readonly providers: () => readonly OAuthProvider[];
  /** 可以当回调来源的公网来源，每次请求现读。 */
  readonly publicOrigins: () => readonly string[];
  /** 来源 IP 的令牌桶（G1-11）；有就对匿名的登录发起计数。 */
  readonly throttle?: Throttle;
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * 公网来源：配置的那个，加上壳注入的、主机名不是 IP 字面量的 HTTPS 来源。
 * 私网 IP 会变、提供方也不会让人登记它，所以不算。
 */
export function publicOriginsFrom(
  configured: readonly string[],
  injected: readonly string[],
): string[] {
  const out: string[] = [];
  for (const raw of [...configured, ...injected]) {
    const origin = canonicalOrigin(raw);
    if (origin === undefined || out.includes(origin)) continue;
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const fromSettings = configured.includes(raw);
    if (!fromSettings && (url.protocol !== "https:" || isIP(host) !== 0)) {
      continue;
    }
    out.push(origin);
  }
  return out;
}

export class OAuthHttp {
  constructor(private readonly options: OAuthHttpOptions) {}

  async handle(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const action = request.path.slice(OAUTH_PREFIX.length);
    const segments = action.split("/").filter((part) => part !== "");
    const method = request.method.toUpperCase();
    if (
      method === "GET" &&
      segments.length === 2 &&
      segments[1] === "callback"
    ) {
      await this.callback(request, response, segments[0] as string);
      return;
    }
    const origin = single(request, "origin");
    if (origin === undefined) {
      this.json(response, cors, 403, {
        code: "PERMISSION_DENIED",
        message: "Device permission or CSRF check failed",
      });
      return;
    }
    let reply: Reply | undefined;
    try {
      reply = await this.route(method, segments, request, response, origin);
    } catch (error) {
      reply = failure(error);
      const after =
        error instanceof IdentityError
          ? identityFailure(error).retryAfterMs
          : undefined;
      if (after !== undefined) {
        response.setHeader(
          "retry-after",
          String(Math.max(1, Math.ceil(after / 1000))),
        );
      }
    }
    this.json(
      response,
      cors,
      reply?.status ?? 404,
      reply?.body ?? {
        code: "NOT_FOUND",
        message: `没有这个接口：${request.path}`,
      },
    );
  }

  private async route(
    method: string,
    segments: readonly string[],
    request: CoreRequest,
    response: ServerResponse,
    origin: string,
  ): Promise<Reply | undefined> {
    const [head, second, third] = segments;
    if (head === "providers" && segments.length === 1 && method === "GET") {
      return this.providers(request, origin);
    }
    if (
      head === "providers" &&
      segments.length === 3 &&
      third === "secret" &&
      (method === "PUT" || method === "DELETE")
    ) {
      return this.secret(method, request, origin, second as string);
    }
    if (head === "bindings" && segments.length === 1 && method === "GET") {
      return this.bindings(request, origin);
    }
    if (head === "bindings" && segments.length === 2 && method === "DELETE") {
      return this.unbind(request, origin, second as string);
    }
    if (segments.length === 2 && second === "start" && method === "POST") {
      return this.start(request, response, origin, head as string);
    }
    if (segments.length === 2 && second === "logout" && method === "POST") {
      return this.logout(request, origin, head as string);
    }
    return undefined;
  }

  /* ------------------------------- 提供方表 ------------------------------- */

  private async providers(request: CoreRequest, origin: string) {
    const origins = this.options.publicOrigins();
    const manager = this.optionalManager(request, origin);
    const rows = [];
    for (const provider of this.options.providers()) {
      const hasClientSecret =
        (await this.options.secrets.read(provider.id)) !== undefined;
      const usable = this.usable(provider, hasClientSecret, origins);
      if (manager === undefined) {
        if (usable) rows.push({ id: provider.id, kind: provider.kind });
        continue;
      }
      rows.push({
        id: provider.id,
        kind: provider.kind,
        ...(provider.issuer === undefined ? {} : { issuer: provider.issuer }),
        clientId: provider.clientId,
        enabled: provider.enabled,
        allowSignup: provider.allowSignup,
        allowedDomains: [...provider.allowedDomains],
        hasClientSecret,
        usable,
        callbackUrls: origins.map((value) => callbackUrl(value, provider.id)),
      });
    }
    return {
      status: 200,
      body: { configured: origins.length > 0, providers: rows },
    };
  }

  private usable(
    provider: OAuthProvider,
    hasClientSecret: boolean,
    origins: readonly string[],
  ): boolean {
    if (!provider.enabled || origins.length === 0) return false;
    // GitHub 的 OAuth App 换令牌一定要 secret；OIDC 公开客户端（PKCE）可以没有。
    return provider.kind === "oidc" || hasClientSecret;
  }

  private async secret(
    method: string,
    request: CoreRequest,
    origin: string,
    providerId: string,
  ): Promise<Reply> {
    const actor = this.authenticate(request, origin, true, true);
    const provider = this.options
      .providers()
      .find((entry) => entry.id === providerId);
    if (provider === undefined) {
      throw new OAuthError("oauth_not_configured", "没有这个提供方", 404);
    }
    if (method === "PUT") {
      const value = body(request).clientSecret;
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 4096
      ) {
        throw new IdentityError("invalid");
      }
      await this.options.secrets.write(providerId, value);
    } else {
      await this.options.secrets.clear(providerId);
    }
    audit({
      action:
        method === "PUT"
          ? "identity.oauth.secret.set"
          : "identity.oauth.secret.clear",
      principalId: actor.principalId,
      deviceId: actor.deviceId,
      target: providerId,
    });
    return {
      status: 200,
      body: { id: providerId, hasClientSecret: method === "PUT" },
    };
  }

  /* --------------------------------- 绑定 --------------------------------- */

  private bindings(request: CoreRequest, origin: string): Reply {
    const actor = this.authenticate(request, origin, false, false);
    const byKey = new Map(
      this.options
        .providers()
        .map((provider) => [bindingKey(provider), provider]),
    );
    const rows = this.options.store.transaction((tx) =>
      tx.accounts
        .credentialsOf(actor.principalId)
        .filter((row) => row.kind === "oauth" && row.revokedAtMs === 0),
    );
    return {
      status: 200,
      body: {
        bindings: rows.map((row) => {
          const provider = byKey.get(row.provider);
          return {
            credentialId: row.credentialId,
            // 提供方从设置里删了（或换了 issuer）时为空串：绑定还在，只是认不出。
            providerId: provider?.id ?? "",
            kind: row.provider === "github" ? "github" : "oidc",
            createdAtMs: row.createdAtMs,
          };
        }),
      },
    };
  }

  private unbind(
    request: CoreRequest,
    origin: string,
    credentialId: string,
  ): Reply {
    const actor = this.authenticate(request, origin, true, false);
    this.options.store.transaction((tx) => {
      const row = tx.accounts.credential(credentialId);
      if (
        row === undefined ||
        row.kind !== "oauth" ||
        row.revokedAtMs !== 0 ||
        row.principalId !== actor.principalId
      ) {
        // 别人的绑定：不说它存不存在。
        throw new IdentityError("notFound");
      }
      const now = Date.now();
      tx.accounts.revokeCredential(credentialId, now);
      tx.accounts.appendAudit({
        atMs: now,
        principalId: actor.principalId,
        deviceId: actor.deviceId,
        action: "identity.oauth.unbind",
        target: credentialId,
        workspaceId: "",
        detailJson: "",
      });
    });
    return { status: 200, body: { credentialId, revoked: true } };
  }

  /* --------------------------------- 流程 --------------------------------- */

  private async start(
    request: CoreRequest,
    response: ServerResponse,
    origin: string,
    providerId: string,
  ): Promise<Reply> {
    // Gateway 的 Bearer 模式（原生 App）：授权页开在系统浏览器里，那里没有这次
    // 发出的绑定 Cookie，回调必然失败——不如现在就说清楚。回环明文 HTTP 的来源
    // 只在被配置成公网来源时走得到这里（开发与 dev-stack）。
    if (nativeRequest(request) && isSecure(request)) {
      throw new OAuthError(
        "oauth_browser_required",
        "OAuth 登录与绑定只在浏览器会话上进行",
        400,
      );
    }
    const input = body(request);
    const mode = input.mode === undefined ? "login" : input.mode;
    if (mode !== "login" && mode !== "bind") {
      throw new IdentityError("invalid");
    }
    const returnTo = safeReturnTo(input.returnTo);
    if (returnTo === undefined) throw new IdentityError("invalid");
    const deviceName =
      input.deviceName === undefined ? "Armadra" : input.deviceName;
    if (typeof deviceName !== "string" || !validName(deviceName)) {
      throw new IdentityError("invalid");
    }
    const remoteIp = remoteAddress(request);
    let principalId = "";
    if (mode === "bind") {
      principalId = this.authenticate(request, origin, true, false).principalId;
    } else {
      this.options.throttle?.admitIp(remoteIp);
    }
    const provider = await this.ready(providerId, origin);
    const begun = await this.options.flow.begin({
      provider,
      mode: mode as FlowMode,
      principalId,
      origin,
      redirectUri: callbackUrl(origin, provider.id),
      returnTo,
      deviceName,
      remoteIp,
      userAgent: (single(request, "user-agent") ?? "").slice(0, 256),
    });
    // 浏览器绑定：Lax 才能在从提供方跳回的顶层导航上带回来。`__Host-` 前缀要求
    // `Path=/`，所以不能收窄到回调路径；值本身没有用途，只用来比对。
    const secure = isSecure(request);
    response.setHeader(
      "set-cookie",
      `${this.flowCookie(secure)}=${begun.binding}; Path=/; Max-Age=${Math.ceil(
        (begun.expiresAtMs - Date.now()) / 1000,
      )}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
    );
    return {
      status: 200,
      body: {
        authorizeUrl: begun.authorizeUrl,
        expiresAtMs: begun.expiresAtMs,
      },
    };
  }

  private async logout(
    request: CoreRequest,
    origin: string,
    providerId: string,
  ): Promise<Reply> {
    const returnTo = safeReturnTo(body(request).returnTo);
    if (returnTo === undefined) throw new IdentityError("invalid");
    const provider = await this.ready(providerId, origin);
    if (provider.kind !== "oidc") {
      return { status: 200, body: { endSessionUrl: null } };
    }
    const metadata = await this.options.flow.directory.discover(
      provider.issuer ?? "",
    );
    if (metadata.endSessionEndpoint === undefined) {
      return { status: 200, body: { endSessionUrl: null } };
    }
    // OIDC RP-Initiated Logout 1.0：没有留 id_token，用 client_id 表明是谁。
    const url = new URL(metadata.endSessionEndpoint);
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("post_logout_redirect_uri", `${origin}${returnTo}`);
    return { status: 200, body: { endSessionUrl: url.toString() } };
  }

  /** 提供方存在、开着、凑得齐，而且请求来自一个公网来源。 */
  private async ready(
    providerId: string,
    origin: string,
  ): Promise<OAuthProvider> {
    const origins = this.options.publicOrigins();
    const provider = this.options
      .providers()
      .find((entry) => entry.id === providerId);
    if (origins.length === 0) {
      throw new OAuthError(
        "oauth_not_configured",
        "没有公网来源，OAuth 回调无处可去",
        404,
      );
    }
    if (!origins.includes(origin)) {
      throw new OAuthError(
        "oauth_not_configured",
        "OAuth 只能从配置的公网来源发起",
        404,
      );
    }
    const hasSecret =
      provider !== undefined &&
      (await this.options.secrets.read(provider.id)) !== undefined;
    if (provider === undefined || !this.usable(provider, hasSecret, origins)) {
      throw new OAuthError("oauth_not_configured", "没有可用的这个提供方", 404);
    }
    return provider;
  }

  private async callback(
    request: CoreRequest,
    response: ServerResponse,
    providerId: string,
  ): Promise<void> {
    const state = request.query.get("state") ?? "";
    const secure = isSecure(request);
    const binding = cookieValue(request, this.flowCookie(secure));
    const clearBinding = `${this.flowCookie(secure)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
    let record;
    try {
      record = this.options.flow.take(state, binding);
    } catch (error) {
      this.failed(providerId, "", error);
      if (error instanceof FlowFailure && error.origin !== undefined) {
        this.redirect(
          response,
          error.origin,
          error.returnTo ?? "/",
          {
            oauth: "error",
            code: error.code,
          },
          [clearBinding],
        );
        return;
      }
      const reply = failure(error);
      this.json(response, {}, reply.status, reply.body, [clearBinding]);
      return;
    }
    const finish = (fields: Record<string, string>) =>
      this.redirect(response, record.origin, record.returnTo, fields, [
        clearBinding,
      ]);
    try {
      if (record.providerId !== providerId) {
        throw new OAuthError(
          "oauth_state_invalid",
          "回调与发起的提供方不一致",
          400,
        );
      }
      const providerError = request.query.get("error");
      if (providerError !== null) {
        throw new OAuthError(
          providerError === "access_denied"
            ? "oauth_denied"
            : "oauth_provider_error",
          `提供方拒绝：${providerError.slice(0, 64)}`,
          providerError === "access_denied" ? 403 : 502,
        );
      }
      const code = request.query.get("code") ?? "";
      if (code === "" || code.length > 2048) {
        throw new OAuthError("oauth_state_invalid", "回调没有授权码", 400);
      }
      const provider = await this.ready(providerId, record.origin);
      const identity = await this.options.flow.identify(provider, record, code);
      const outcome = this.options.flow.settle(provider, record, identity);
      if (outcome.kind === "session") {
        sessionCookies(
          request,
          response,
          this.options.service.hostId(),
          outcome.credentials,
        );
        finish({
          oauth: outcome.signedUp ? "signedUp" : "signedIn",
          // 策略要求第二因素而还没登记：页面带去登记（契约 §18.5）。
          ...(outcome.mfaEnrollmentRequired
            ? { mfaEnrollmentRequired: "true" }
            : {}),
        });
        return;
      }
      if (outcome.kind === "mfa") {
        finish({ oauth: "mfa", challengeId: outcome.challengeId });
        return;
      }
      finish({ oauth: "bound" });
    } catch (error) {
      this.failed(providerId, record.principalId, error);
      const code =
        error instanceof OAuthError
          ? error.code
          : error instanceof IdentityError
            ? identityFailure(error).code
            : "oauth_provider_error";
      finish({ oauth: "error", code });
    }
  }

  private failed(
    providerId: string,
    principalId: string,
    error: unknown,
  ): void {
    audit({
      action: "identity.oauth.failed",
      principalId,
      target: providerId.slice(0, 64),
      detail: {
        code:
          error instanceof OAuthError
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown",
      },
    });
  }

  private flowCookie(secure: boolean): string {
    return cookieName(this.options.service.hostId(), secure, "oauth");
  }

  /* --------------------------------- 认证 --------------------------------- */

  private actorFor(
    request: CoreRequest,
    origin: string,
    write: boolean,
    manage: boolean,
  ) {
    const hostId = this.options.service.hostId();
    return {
      accessToken: credential(request, hostId, "access"),
      hostId,
      origin,
      csrfToken: single(request, "x-armadra-csrf") ?? "",
      // Cookie 会话上的写要 CSRF；Bearer 传输不要（`identity/http.ts`）。
      requireCsrf: write && csrfRequired(request),
      ...(manage ? { requiredScopes: [scope("identity:manage")] } : {}),
    };
  }

  private authenticate(
    request: CoreRequest,
    origin: string,
    write: boolean,
    manage: boolean,
  ): Principal {
    return this.options.service.authenticate(
      this.actorFor(request, origin, write, manage),
    );
  }

  /** 有 `identity:manage` 的调用方；没凭据或不够就当匿名。 */
  private optionalManager(
    request: CoreRequest,
    origin: string,
  ): Principal | undefined {
    try {
      return this.authenticate(request, origin, false, true);
    } catch {
      return undefined;
    }
  }

  /* --------------------------------- 输出 --------------------------------- */

  private redirect(
    response: ServerResponse,
    origin: string,
    returnTo: string,
    fields: Record<string, string>,
    cookies: readonly string[],
  ): void {
    appendCookies(response, cookies);
    const fragment = new URLSearchParams(fields).toString();
    response.writeHead(302, {
      location: `${origin}${returnTo}#${fragment}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-length": "0",
    });
    response.end();
  }

  private json(
    response: ServerResponse,
    cors: Record<string, string>,
    status: number,
    payload: unknown,
    cookies: readonly string[] = [],
  ): void {
    appendCookies(response, cookies);
    const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
    response.writeHead(status, {
      ...cors,
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
    });
    response.end(bytes);
  }
}

function failure(error: unknown): Reply {
  if (error instanceof OAuthError) {
    return {
      status: error.status,
      body: { code: error.code, message: error.message },
    };
  }
  const mapped = identityFailure(
    error instanceof SyntaxError ? new IdentityError("invalid") : error,
  );
  return {
    status: mapped.status,
    body: { code: mapped.code, message: mapped.message },
  };
}

function appendCookies(response: ServerResponse, cookies: readonly string[]) {
  if (cookies.length === 0) return;
  const existing = response.getHeader("set-cookie");
  const list =
    existing === undefined
      ? []
      : Array.isArray(existing)
        ? existing.map(String)
        : [String(existing)];
  response.setHeader("set-cookie", [...list, ...cookies]);
}

function single(request: CoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function cookieValue(request: CoreRequest, name: string): string {
  const raw = request.headers.cookie;
  if (typeof raw !== "string") return "";
  const found = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return found.length === 1 ? (found[0] as string).slice(name.length + 1) : "";
}

function body(request: CoreRequest): Record<string, unknown> {
  if (request.body.byteLength === 0) return {};
  let parsed: unknown;
  try {
    parsed = request.json();
  } catch {
    throw new IdentityError("invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IdentityError("invalid");
  }
  return parsed as Record<string, unknown>;
}
