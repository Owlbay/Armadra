import {
  createHash,
  createPublicKey,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { isIP } from "node:net";
import type { OAuthProvider } from "../../settings/schema";

/**
 * 提供方的协议面（补全架构 §8.3、契约 §18.5）：通用 OIDC 与 GitHub 特例。
 *
 * 一条代码路径：授权码 + PKCE（S256）+ `state`；OIDC 再加 `nonce` 与 `id_token`
 * 验签。GitHub 不是 OIDC——没有发现文档、没有 `id_token`——所以它是唯一的特例：
 * 换来访问令牌之后读 `GET /user` 与 `GET /user/emails`，主体是数字 `id`。
 *
 * 签名只认 RS256 与 ES256，用 `node:crypto` 验：`alg: none`、HS*（拿 client
 * secret 当对称密钥）与其余算法一律拒。JWKS 按 `kid` 取，遇到不认识的 `kid`
 * 先重取一次（提供方轮换密钥），再不认识就拒。
 */

/** 外呼的超时：发现文档、JWKS、令牌交换、用户信息都是一次往返。 */
export const OAUTH_FETCH_TIMEOUT_MS = 10_000;
/** 发现文档与 JWKS 的缓存时长。 */
export const OAUTH_METADATA_TTL_MS = 60 * 60 * 1000;
/** `exp` / `iat` / `nbf` 容忍的时钟偏差。 */
export const OAUTH_CLOCK_SKEW_MS = 60 * 1000;
/** 两次「不认识的 kid 就重取 JWKS」之间至少隔这么久。 */
const JWKS_REFRESH_GAP_MS = 30 * 1000;

/** GitHub 的端点；测试换成进程内假服务。 */
export interface GithubEndpoints {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly apiBase: string;
}

export const GITHUB_ENDPOINTS: GithubEndpoints = {
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  apiBase: "https://api.github.com",
};

/** 缺省的 scope：OIDC 要 `openid email profile`，GitHub 读邮箱要 `user:email`。 */
export function effectiveScopes(provider: OAuthProvider): string[] {
  if (provider.scopes.length > 0) {
    const scopes = [...provider.scopes];
    if (provider.kind === "oidc" && !scopes.includes("openid")) {
      scopes.unshift("openid");
    }
    return scopes;
  }
  return provider.kind === "oidc"
    ? ["openid", "email", "profile"]
    : ["read:user", "user:email"];
}

/**
 * 绑定在 `identity_credentials.provider` 里记的那个键。
 *
 * 不用设置里的 `id`：`id` 是 owner 随手起的名字，换一个 issuer 而保留同一个 `id`
 * 时，旧绑定的 `subject` 会被新 issuer 的同名主体冒领。OIDC 的主体只在 issuer
 * 之内唯一，所以键由 issuer 派生（列宽 64，取哈希）；GitHub 的数字 id 全站唯一。
 */
export function bindingKey(provider: OAuthProvider): string {
  if (provider.kind === "github") return "github";
  const digest = createHash("sha256")
    .update(normalizeIssuer(provider.issuer ?? ""))
    .digest("base64url");
  return `oidc:${digest.slice(0, 43)}`;
}

/** issuer 比较按逐字节，只去掉末尾斜杠（`…/realms/x/` 与 `…/realms/x` 是一个）。 */
export function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

/**
 * 外呼地址只许 HTTPS，或回环上的明文 HTTP（dev-stack 的 dex / keycloak）。
 * 发现文档里任何一个端点也按这一条查——一份被篡改的发现文档不能把令牌交换指到
 * 一个明文的外部地址上。
 */
export function safeEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return host === "::1";
}

/* ------------------------------- 失败的形状 ------------------------------- */

/** 协议层的失败；`code` 是契约 §18.5 的拒绝码。 */
export class OAuthError extends Error {
  readonly name = "OAuthError";
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/* --------------------------------- 外呼 ---------------------------------- */

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

async function fetchJson(
  fetcher: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
      headers: { accept: "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    throw new OAuthError(
      "oauth_provider_error",
      `提供方不可达：${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/* ------------------------------- 发现文档 -------------------------------- */

export interface OidcMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly userinfoEndpoint?: string;
  /** RP 发起的登出（Keycloak 有，dex 没有）。 */
  readonly endSessionEndpoint?: string;
}

interface Cached<T> {
  readonly value: T;
  readonly atMs: number;
}

/**
 * 发现文档与 JWKS 的缓存。一轮 core 一份；按 issuer 记。
 */
export class OidcDirectory {
  private readonly metadata = new Map<string, Cached<OidcMetadata>>();
  private readonly keys = new Map<string, Cached<JsonWebKey[]>>();

  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  async discover(issuer: string): Promise<OidcMetadata> {
    const wanted = normalizeIssuer(issuer);
    const cached = this.metadata.get(wanted);
    if (
      cached !== undefined &&
      this.clock() - cached.atMs < OAUTH_METADATA_TTL_MS
    ) {
      return cached.value;
    }
    if (!safeEndpoint(wanted)) {
      throw new OAuthError(
        "oauth_not_configured",
        "issuer 必须是 HTTPS（回环地址除外）",
        404,
      );
    }
    const { status, body } = await fetchJson(
      this.fetcher,
      `${wanted}/.well-known/openid-configuration`,
    );
    const document = object(body);
    if (status !== 200 || document === undefined) {
      throw new OAuthError(
        "oauth_provider_error",
        `发现文档不可用（HTTP ${status}）`,
        502,
      );
    }
    // OIDC Discovery §4.3：文档里的 issuer 必须与请求它的那个逐字节相同。
    if (
      typeof document.issuer !== "string" ||
      normalizeIssuer(document.issuer) !== wanted
    ) {
      throw new OAuthError(
        "oauth_provider_error",
        "发现文档的 issuer 与配置不一致",
        502,
      );
    }
    const endpoints = {
      authorizationEndpoint: document.authorization_endpoint,
      tokenEndpoint: document.token_endpoint,
      jwksUri: document.jwks_uri,
    };
    for (const value of Object.values(endpoints)) {
      if (!safeEndpoint(value)) {
        throw new OAuthError(
          "oauth_provider_error",
          "发现文档缺少端点或端点不安全",
          502,
        );
      }
    }
    const methods = document.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes("S256")) {
      throw new OAuthError(
        "oauth_provider_error",
        "提供方不支持 PKCE S256",
        502,
      );
    }
    const metadata: OidcMetadata = {
      issuer: document.issuer,
      authorizationEndpoint: endpoints.authorizationEndpoint as string,
      tokenEndpoint: endpoints.tokenEndpoint as string,
      jwksUri: endpoints.jwksUri as string,
      ...(safeEndpoint(document.userinfo_endpoint)
        ? { userinfoEndpoint: document.userinfo_endpoint }
        : {}),
      ...(safeEndpoint(document.end_session_endpoint)
        ? { endSessionEndpoint: document.end_session_endpoint }
        : {}),
    };
    this.metadata.set(wanted, { value: metadata, atMs: this.clock() });
    return metadata;
  }

  /** 按 `kid` 找公钥；不认识就重取一次 JWKS。 */
  async key(jwksUri: string, kid: string | undefined, alg: string) {
    const pick = (keys: readonly JsonWebKey[]) => {
      const usable = keys.filter(
        (key) =>
          (key.use === undefined || key.use === "sig") &&
          (key.alg === undefined || key.alg === alg) &&
          key.kty === (alg === "RS256" ? "RSA" : "EC"),
      );
      if (kid !== undefined) return usable.find((key) => key.kid === kid);
      // 没有 kid 时只在恰好一把可用的情况下接受，不去「挨个试」。
      return usable.length === 1 ? usable[0] : undefined;
    };
    const cached = this.keys.get(jwksUri);
    const fresh =
      cached !== undefined &&
      this.clock() - cached.atMs < OAUTH_METADATA_TTL_MS;
    if (fresh) {
      const found = pick(cached.value);
      if (found !== undefined) return found;
      if (this.clock() - cached.atMs < JWKS_REFRESH_GAP_MS) return undefined;
    }
    const { status, body } = await fetchJson(this.fetcher, jwksUri);
    const keys = object(body)?.keys;
    if (status !== 200 || !Array.isArray(keys)) {
      throw new OAuthError("oauth_provider_error", "JWKS 不可用", 502);
    }
    const list = keys.filter(
      (key): key is JsonWebKey => object(key) !== undefined,
    );
    this.keys.set(jwksUri, { value: list, atMs: this.clock() });
    return pick(list);
  }
}

/* ------------------------------- id_token -------------------------------- */

export interface IdTokenClaims {
  readonly sub: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
  readonly preferredUsername?: string;
}

function base64urlJson(part: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

/**
 * 验 `id_token`：签名（RS256 / ES256，按 JWKS）、`iss`、`aud`（多个时 `azp` 必须
 * 是本客户端）、`exp` / `iat` / `nbf`、`nonce`。任何一条不过都是
 * `oauth_token_invalid`。
 */
export async function verifyIdToken(input: {
  readonly token: string;
  readonly directory: OidcDirectory;
  readonly metadata: OidcMetadata;
  readonly clientId: string;
  readonly nonce: string;
  readonly nowMs: number;
}): Promise<IdTokenClaims> {
  const invalid = (why: string) =>
    new OAuthError("oauth_token_invalid", `id_token 无效：${why}`, 401);
  const parts = input.token.split(".");
  if (parts.length !== 3) throw invalid("不是 JWS 紧凑格式");
  const [rawHeader, rawPayload, rawSignature] = parts as [
    string,
    string,
    string,
  ];
  const header = base64urlJson(rawHeader);
  const claims = base64urlJson(rawPayload);
  if (header === undefined || claims === undefined) throw invalid("无法解析");
  const alg = header.alg;
  if (alg !== "RS256" && alg !== "ES256") {
    throw invalid(`不接受的算法 ${String(alg)}`);
  }
  if (header.crit !== undefined) throw invalid("不支持 crit 头");
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const jwk = await input.directory.key(input.metadata.jwksUri, kid, alg);
  if (jwk === undefined) throw invalid("找不到签名公钥");
  let ok = false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    ok = verify(
      "sha256",
      Buffer.from(`${rawHeader}.${rawPayload}`, "ascii"),
      alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key,
      Buffer.from(rawSignature, "base64url"),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw invalid("签名不对");

  if (
    typeof claims.iss !== "string" ||
    normalizeIssuer(claims.iss) !== normalizeIssuer(input.metadata.issuer)
  ) {
    throw invalid("iss 不符");
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(input.clientId)) throw invalid("aud 不含本客户端");
  if (
    (audience.length > 1 || claims.azp !== undefined) &&
    claims.azp !== input.clientId
  ) {
    throw invalid("azp 不是本客户端");
  }
  const seconds = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value)
      ? value * 1000
      : undefined;
  const exp = seconds(claims.exp);
  const iat = seconds(claims.iat);
  const nbf = seconds(claims.nbf);
  if (exp === undefined || exp + OAUTH_CLOCK_SKEW_MS <= input.nowMs) {
    throw invalid("已过期");
  }
  if (iat === undefined || iat - OAUTH_CLOCK_SKEW_MS > input.nowMs) {
    throw invalid("iat 在未来");
  }
  if (nbf !== undefined && nbf - OAUTH_CLOCK_SKEW_MS > input.nowMs) {
    throw invalid("尚未生效");
  }
  if (claims.nonce !== input.nonce) throw invalid("nonce 不符");
  if (typeof claims.sub !== "string" || claims.sub === "") {
    throw invalid("缺少 sub");
  }
  if (claims.sub.length > 256) throw invalid("sub 过长");
  return {
    sub: claims.sub,
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    ...(typeof claims.email_verified === "boolean"
      ? { emailVerified: claims.email_verified }
      : // 有的提供方把它写成字符串（早年的 AWS Cognito、部分 Keycloak 映射器）。
        claims.email_verified === "true"
        ? { emailVerified: true }
        : {}),
    ...(typeof claims.name === "string" ? { name: claims.name } : {}),
    ...(typeof claims.preferred_username === "string"
      ? { preferredUsername: claims.preferred_username }
      : {}),
  };
}

/* ------------------------------- 令牌交换 -------------------------------- */

export interface TokenRequest {
  readonly tokenEndpoint: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  /** 公开客户端没有。 */
  readonly clientSecret?: string;
  readonly codeVerifier: string;
}

export async function exchangeCode(
  fetcher: FetchLike,
  request: TokenRequest,
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: request.clientId,
    code_verifier: request.codeVerifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (request.clientSecret !== undefined) {
    // RFC 6749 §2.3.1：client_secret_basic，两半都先做表单编码。
    const user = encodeURIComponent(request.clientId);
    const pass = encodeURIComponent(request.clientSecret);
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  const { status, body } = await fetchJson(fetcher, request.tokenEndpoint, {
    method: "POST",
    headers,
    body: form.toString(),
  });
  const document = object(body);
  // GitHub 出错时也答 200，错误在 `error` 字段里。
  if (
    status !== 200 ||
    document === undefined ||
    document.error !== undefined
  ) {
    throw new OAuthError(
      "oauth_provider_error",
      `令牌交换失败（HTTP ${status}${typeof document?.error === "string" ? `，${document.error}` : ""}）`,
      502,
    );
  }
  return document;
}

/* -------------------------------- GitHub --------------------------------- */

export interface ExternalIdentity {
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
}

/** GitHub：`GET /user` 给主体，`GET /user/emails` 给已验证的主邮箱。 */
export async function githubIdentity(
  fetcher: FetchLike,
  endpoints: GithubEndpoints,
  accessToken: string,
): Promise<ExternalIdentity> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "Armadra",
  };
  const user = await fetchJson(fetcher, `${endpoints.apiBase}/user`, {
    headers,
  });
  const profile = object(user.body);
  if (
    user.status !== 200 ||
    profile === undefined ||
    typeof profile.id !== "number"
  ) {
    throw new OAuthError(
      "oauth_provider_error",
      `读取 GitHub 用户失败（HTTP ${user.status}）`,
      502,
    );
  }
  const emails = await fetchJson(fetcher, `${endpoints.apiBase}/user/emails`, {
    headers,
  });
  const list = Array.isArray(emails.body) ? emails.body : [];
  const primary = list
    .map(object)
    .find(
      (entry) => entry?.primary === true && typeof entry.email === "string",
    );
  const name =
    typeof profile.name === "string" && profile.name !== ""
      ? profile.name
      : typeof profile.login === "string"
        ? profile.login
        : undefined;
  return {
    subject: String(profile.id),
    ...(primary !== undefined ? { email: primary.email as string } : {}),
    emailVerified: primary?.verified === true,
    ...(name !== undefined ? { displayName: name } : {}),
  };
}

/** OIDC：`id_token` 的声明为准，缺邮箱时补一次 userinfo（`sub` 必须相同）。 */
export async function oidcIdentity(input: {
  readonly fetcher: FetchLike;
  readonly metadata: OidcMetadata;
  readonly claims: IdTokenClaims;
  readonly accessToken: string | undefined;
}): Promise<ExternalIdentity> {
  let { email, emailVerified, name, preferredUsername } = input.claims;
  if (
    email === undefined &&
    input.metadata.userinfoEndpoint !== undefined &&
    input.accessToken !== undefined
  ) {
    const info = await fetchJson(
      input.fetcher,
      input.metadata.userinfoEndpoint,
      { headers: { authorization: `Bearer ${input.accessToken}` } },
    );
    const document = object(info.body);
    // OIDC Core §5.3.2：userinfo 的 sub 必须与 id_token 的相同，否则不能用。
    if (info.status === 200 && document?.sub === input.claims.sub) {
      if (typeof document.email === "string") email = document.email;
      if (typeof document.email_verified === "boolean") {
        emailVerified = document.email_verified;
      }
      if (name === undefined && typeof document.name === "string") {
        name = document.name;
      }
    }
  }
  const displayName = name ?? preferredUsername ?? email;
  return {
    subject: input.claims.sub,
    ...(email !== undefined ? { email } : {}),
    emailVerified: emailVerified === true,
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

/** 邮箱的域名命中白名单（大小写不计，子域不算命中）。 */
export function domainAllowed(
  email: string | undefined,
  allowedDomains: readonly string[],
): boolean {
  if (email === undefined) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains.some((allowed) => allowed.toLowerCase() === domain);
}
