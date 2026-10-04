import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { OAuthProvider } from "../../settings/schema";
import type { Mfa } from "../mfa";
import type { IdentityService, SessionCredentials } from "../service";
import type { IdentityStore } from "../store";
import { newId, validName } from "../tokens";
import {
  GITHUB_ENDPOINTS,
  type ExternalIdentity,
  type FetchLike,
  type GithubEndpoints,
  OAuthError,
  OidcDirectory,
  bindingKey,
  domainAllowed,
  effectiveScopes,
  exchangeCode,
  githubIdentity,
  oidcIdentity,
  verifyIdToken,
} from "./providers";

/**
 * 一次授权码流程的两半（契约 §18.5）：`begin` 记下 `state` / PKCE / `nonce` 并给
 * 出授权地址；`complete` 一次性取回那条记录、换令牌、验身份，再决定是绑定、登录
 * 还是建号。
 *
 * **状态在内存里**：十分钟、一次性（取出即删，不论成败），重启即失效——一次
 * 半途的登录在重启后重来一遍没有代价。记录里还有一份「浏览器绑定」的哈希：
 * `begin` 给这个浏览器发一枚 `SameSite=Lax` 的 Cookie，回调必须带着同一枚，
 * 否则一个攻击者把自己那条 `state` 的回调链接塞给受害者，就能让受害者登进
 * 攻击者的账号（登录 CSRF），或把攻击者的第三方身份绑到受害者名下。
 *
 * 会话 Cookie 是 `SameSite=Strict`，从提供方跳回来的那次导航带不上它，所以
 * 「绑到当前 principal」的那个 principal 在 `begin` 时（同源、带会话与 CSRF
 * 的请求）就记进状态，回调不再认会话。
 */

/** 一条流程记录活多久。 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** 同时挂着的流程上限（全部来源合计）。 */
export const MAX_PENDING = 1000;
/**
 * 一个来源地址（IPv6 按 /64）同时挂着的上限；满了挤掉它自己最老的那条。
 *
 * 安全审查 L4：原来是一张表满了挤最老的，发起只受每地址的限流，从多个地址
 * 撒 `start` 就能把别人半途的登录挤掉。分桶后一个地址只能挤自己；总表满了
 * 挤的是挂得最多的那个地址最老的一条，只挂一两条的正常用户排在最后。
 */
export const MAX_PENDING_PER_ADDRESS = 50;

/**
 * 分桶用的来源键：IPv4（含 IPv4 映射的 IPv6）按整个地址；IPv6 按前 64 位——
 * 一台主机通常拿到整个 /64，按单个地址分桶等于没分。
 */
export function addressBucket(remoteIp: string): string {
  const raw = remoteIp.trim().toLowerCase();
  const mapped = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  if (isIPv4(mapped)) return mapped;
  if (!isIPv6(raw)) return raw;
  const [head = "", tail] = raw.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

export type FlowMode = "login" | "bind";

export interface FlowRecord {
  readonly providerId: string;
  readonly mode: FlowMode;
  /** `bind` 时是发起者；`login` 时为空。 */
  readonly principalId: string;
  /** 会话与跳回都落在这个公网来源上。 */
  readonly origin: string;
  readonly returnTo: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly bindingHash: Buffer;
  readonly deviceName: string;
  readonly remoteIp: string;
  readonly userAgent: string;
  readonly expiresAtMs: number;
  /**
   * 原生 App 发起的（`start?native=1`，R-56）：授权页开在系统浏览器里，回调只把
   * `state` 与授权码转成 `armadra://oauth` 深链交回 App，由 App 带着
   * `nativeState` 来收尾。`bindingHash` 这时是 `nativeState` 的哈希。
   */
  readonly native: boolean;
}

/** 流程失败：带着跳回的去处（知道的话），页面在那里显示原因。 */
export class FlowFailure extends OAuthError {
  constructor(
    error: OAuthError,
    readonly origin?: string,
    readonly returnTo?: string,
    readonly providerId?: string,
  ) {
    super(error.code, error.message, error.status);
  }
}

export type FlowOutcome =
  | {
      readonly kind: "session";
      readonly credentials: SessionCredentials;
      readonly signedUp: boolean;
      /**
       * `identity.mfa.requireFor` 覆盖这个人而还没登记 TOTP：放进来，页面带去
       * 登记（与口令登录的 `mfaEnrollmentRequired` 同一条，契约 §18.3）。
       */
      readonly mfaEnrollmentRequired: boolean;
      readonly origin: string;
      readonly returnTo: string;
    }
  | {
      readonly kind: "mfa";
      readonly challengeId: string;
      readonly origin: string;
      readonly returnTo: string;
    }
  | {
      readonly kind: "bound";
      readonly origin: string;
      readonly returnTo: string;
    };

export interface OAuthFlowOptions {
  readonly store: IdentityStore;
  readonly service: IdentityService;
  /** 有就接 MFA：登记过 TOTP 的人 OAuth 登录后还要过第二因素。 */
  readonly mfa?: Mfa;
  /** `identity.mfa.requireFor` 是否覆盖这个角色；没有就当不覆盖。 */
  readonly mfaRequired?: (role: "owner" | "member") => boolean;
  readonly fetcher?: FetchLike;
  readonly github?: GithubEndpoints;
  /** `armadra-oidc-<id>` 里的 client secret；公开客户端没有。 */
  readonly clientSecret: (providerId: string) => Promise<string | undefined>;
  readonly clock?: () => number;
}

function hashOf(value: string): Buffer {
  return createHash("sha256")
    .update(`armadra/identity/oauth-binding\u0000${value}`, "utf8")
    .digest();
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** 返回路径只收站内绝对路径：`/` 开头、不是 `//`、不带片段与反斜杠。 */
export function safeReturnTo(value: unknown): string | undefined {
  if (value === undefined) return "/";
  if (typeof value !== "string" || value.length > 512) return undefined;
  if (!/^\/(?![/\\])[^#\s\\]*$/.test(value)) return undefined;
  return value;
}

export class OAuthFlow {
  private readonly pending = new Map<string, FlowRecord>();
  readonly directory: OidcDirectory;
  private readonly fetcher: FetchLike;
  private readonly github: GithubEndpoints;
  private readonly clock: () => number;

  constructor(private readonly options: OAuthFlowOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.github = options.github ?? GITHUB_ENDPOINTS;
    this.clock = options.clock ?? Date.now;
    this.directory = new OidcDirectory(this.fetcher, this.clock);
  }

  /** 测试与诊断：还挂着几条。 */
  pendingCount(): number {
    this.prune();
    return this.pending.size;
  }

  async begin(input: {
    readonly provider: OAuthProvider;
    readonly mode: FlowMode;
    readonly principalId: string;
    readonly origin: string;
    readonly redirectUri: string;
    readonly returnTo: string;
    readonly deviceName: string;
    readonly remoteIp: string;
    readonly userAgent: string;
    readonly native?: boolean;
  }): Promise<{
    authorizeUrl: string;
    binding: string;
    expiresAtMs: number;
  }> {
    const { provider } = input;
    const authorizationEndpoint =
      provider.kind === "github"
        ? this.github.authorizeUrl
        : (await this.directory.discover(provider.issuer ?? ""))
            .authorizationEndpoint;
    this.prune();
    this.makeRoom(addressBucket(input.remoteIp));
    const state = randomBytes(32).toString("base64url");
    const binding = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    const expiresAtMs = this.clock() + OAUTH_STATE_TTL_MS;
    this.pending.set(state, {
      providerId: provider.id,
      mode: input.mode,
      principalId: input.principalId,
      origin: input.origin,
      returnTo: input.returnTo,
      redirectUri: input.redirectUri,
      codeVerifier,
      nonce,
      bindingHash: hashOf(binding),
      deviceName: input.deviceName,
      remoteIp: input.remoteIp,
      userAgent: input.userAgent,
      expiresAtMs,
      native: input.native === true,
    });
    const url = new URL(authorizationEndpoint);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: provider.clientId,
      redirect_uri: input.redirectUri,
      scope: effectiveScopes(provider).join(" "),
      state,
      code_challenge: pkceChallenge(codeVerifier),
      code_challenge_method: "S256",
    };
    if (provider.kind === "oidc") params.nonce = nonce;
    else params.allow_signup = "false";
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return { authorizeUrl: url.toString(), binding, expiresAtMs };
  }

  /**
   * 一次性取回 `state` 对应的记录并核对浏览器绑定（原生流程是 `nativeState`）。
   * 不存在、过期、已用过、绑定不对、浏览器与原生走错了收尾的路，一律
   * `oauth_state_invalid`——取出即删，所以第二次一定不存在。
   */
  take(state: string, binding: string, native = false): FlowRecord {
    const record = this.pending.get(state);
    this.pending.delete(state);
    const invalid = new OAuthError(
      "oauth_state_invalid",
      "登录流程已过期、已用过或不属于这个浏览器",
      400,
    );
    if (
      record === undefined ||
      record.expiresAtMs <= this.clock() ||
      record.native !== native
    ) {
      throw invalid;
    }
    const got = hashOf(binding);
    if (binding === "" || !timingSafeEqual(got, record.bindingHash)) {
      throw new FlowFailure(
        invalid,
        record.origin,
        record.returnTo,
        record.providerId,
      );
    }
    return record;
  }

  /**
   * 原生流程的回调：只看一眼、不取走（收尾要 App 带着 `nativeState` 来）。
   * 不存在、过期或不是原生发起的答 `undefined`。
   */
  nativeRecord(state: string): FlowRecord | undefined {
    const record = this.pending.get(state);
    if (
      record === undefined ||
      !record.native ||
      record.expiresAtMs <= this.clock()
    ) {
      return undefined;
    }
    return record;
  }

  /** 换令牌、验身份。 */
  async identify(
    provider: OAuthProvider,
    record: FlowRecord,
    code: string,
  ): Promise<ExternalIdentity> {
    const clientSecret = await this.options.clientSecret(provider.id);
    if (provider.kind === "github") {
      const tokens = await exchangeCode(this.fetcher, {
        tokenEndpoint: this.github.tokenUrl,
        code,
        redirectUri: record.redirectUri,
        clientId: provider.clientId,
        ...(clientSecret === undefined ? {} : { clientSecret }),
        codeVerifier: record.codeVerifier,
      });
      if (typeof tokens.access_token !== "string") {
        throw new OAuthError("oauth_provider_error", "没有访问令牌", 502);
      }
      return githubIdentity(this.fetcher, this.github, tokens.access_token);
    }
    const metadata = await this.directory.discover(provider.issuer ?? "");
    const tokens = await exchangeCode(this.fetcher, {
      tokenEndpoint: metadata.tokenEndpoint,
      code,
      redirectUri: record.redirectUri,
      clientId: provider.clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
      codeVerifier: record.codeVerifier,
    });
    if (typeof tokens.id_token !== "string") {
      throw new OAuthError(
        "oauth_token_invalid",
        "令牌响应里没有 id_token",
        401,
      );
    }
    const claims = await verifyIdToken({
      token: tokens.id_token,
      directory: this.directory,
      metadata,
      clientId: provider.clientId,
      nonce: record.nonce,
      nowMs: this.clock(),
    });
    return oidcIdentity({
      fetcher: this.fetcher,
      metadata,
      claims,
      accessToken:
        typeof tokens.access_token === "string"
          ? tokens.access_token
          : undefined,
    });
  }

  /**
   * 拿到第三方身份之后的决定：
   *
   *   * `bind`：绑到发起者名下；已绑在别人名下答 `oauth_already_bound`。
   *   * `login`：已绑 → 登录这个 principal（停用了按「没绑」答，不泄露）；没绑且
   *     `allowSignup` → 建一个 member（无授予，owner 再共享）；否则
   *     `oauth_not_bound`。
   *
   * 白名单（`allowedDomains`）配了就对三条路都生效，而且要求邮箱已验证——
   * 「只有这个域的人能进来」是 SSO 的那条策略，不该只在建号时成立。建号额外要求
   * 白名单非空：不设域名的建号等于「有这家账号的任何人都能进」。
   */
  settle(
    provider: OAuthProvider,
    record: FlowRecord,
    identity: ExternalIdentity,
  ): FlowOutcome {
    const fail = (code: string, message: string, status: number) =>
      new FlowFailure(
        new OAuthError(code, message, status),
        record.origin,
        record.returnTo,
        provider.id,
      );
    if (provider.allowedDomains.length > 0) {
      if (!identity.emailVerified) {
        throw fail("oauth_email_unverified", "提供方说这个邮箱没有验证", 403);
      }
      if (!domainAllowed(identity.email, provider.allowedDomains)) {
        throw fail("oauth_domain_not_allowed", "邮箱域名不在白名单里", 403);
      }
    }
    const key = bindingKey(provider);
    const now = this.clock();
    const { store, service } = this.options;

    if (record.mode === "bind") {
      store.transaction((tx) => {
        const owner = tx.accounts.principal(record.principalId);
        if (owner === undefined || owner.disabledAtMs !== 0) {
          throw fail("oauth_state_invalid", "发起绑定的账号已不可用", 400);
        }
        const existing = tx.accounts.liveOAuth(key, identity.subject);
        if (existing !== undefined) {
          if (existing.principalId === record.principalId) return;
          throw fail(
            "oauth_already_bound",
            "这个第三方身份已经绑在别的账号上",
            409,
          );
        }
        const credentialId = newId();
        tx.accounts.createCredential(
          oauthCredential(credentialId, {
            principalId: record.principalId,
            provider: key,
            subject: identity.subject,
            nowMs: now,
          }),
        );
        tx.accounts.appendAudit({
          atMs: now,
          principalId: record.principalId,
          deviceId: "",
          action: "identity.oauth.bind",
          target: credentialId,
          workspaceId: "",
          detailJson: JSON.stringify({ provider: provider.id }),
        });
      });
      return {
        kind: "bound",
        origin: record.origin,
        returnTo: record.returnTo,
      };
    }

    const resolved = store.transaction((tx) => {
      const existing = tx.accounts.liveOAuth(key, identity.subject);
      if (existing !== undefined) {
        const principal = tx.accounts.principal(existing.principalId);
        if (principal === undefined || principal.disabledAtMs !== 0) {
          throw fail("oauth_not_bound", "这个第三方身份没有绑定账号", 401);
        }
        return {
          principalId: principal.principalId,
          role: principal.kind === "owner" ? "owner" : "member",
          signedUp: false,
        } as const;
      }
      if (!provider.allowSignup || provider.allowedDomains.length === 0) {
        throw fail("oauth_not_bound", "这个第三方身份没有绑定账号", 401);
      }
      const principalId = newId();
      tx.accounts.createPrincipal({
        principalId,
        kind: "member",
        displayName: displayNameOf(identity),
        createdAtMs: now,
        disabledAtMs: 0,
      });
      const credentialId = newId();
      tx.accounts.createCredential(
        oauthCredential(credentialId, {
          principalId,
          provider: key,
          subject: identity.subject,
          nowMs: now,
        }),
      );
      tx.accounts.appendAudit({
        atMs: now,
        principalId,
        deviceId: "",
        action: "identity.oauth.signup",
        target: principalId,
        workspaceId: "",
        detailJson: JSON.stringify({ provider: provider.id }),
      });
      return { principalId, role: "member", signedUp: true } as const;
    });

    const mfa = this.options.mfa;
    if (mfa !== undefined && mfa.status(resolved.principalId).enrolled) {
      // 第二因素由 `POST mfa/verify` 收尾，和口令登录的第二步是同一张票。
      const ticket = mfa.beginLogin({
        principalId: resolved.principalId,
        origin: record.origin,
        deviceName: record.deviceName,
        remoteIp: record.remoteIp,
        userAgent: record.userAgent,
      });
      return {
        kind: "mfa",
        challengeId: ticket.challengeId,
        origin: record.origin,
        returnTo: record.returnTo,
      };
    }
    const credentials = service.openSession({
      principalId: resolved.principalId,
      hostId: service.hostId(),
      origin: record.origin,
      deviceName: record.deviceName,
      method: "oauth",
      remoteIp: record.remoteIp,
      userAgent: record.userAgent,
    });
    return {
      kind: "session",
      credentials,
      signedUp: resolved.signedUp,
      mfaEnrollmentRequired: this.options.mfaRequired?.(resolved.role) === true,
      origin: record.origin,
      returnTo: record.returnTo,
    };
  }

  /**
   * 给这个来源腾一个位置：它自己满了挤它自己最老的；总表满了挤挂得最多的
   * 那个来源最老的一条（`pending` 按插入顺序，所以每个桶第一个遇到的就是最老的）。
   */
  private makeRoom(bucket: string): void {
    const counts = new Map<string, number>();
    const oldest = new Map<string, string>();
    for (const [state, record] of this.pending) {
      const key = addressBucket(record.remoteIp);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!oldest.has(key)) oldest.set(key, state);
    }
    if ((counts.get(bucket) ?? 0) >= MAX_PENDING_PER_ADDRESS) {
      this.pending.delete(oldest.get(bucket) as string);
      return;
    }
    if (this.pending.size < MAX_PENDING) return;
    let heaviest: string | undefined;
    for (const [key, count] of counts) {
      if (heaviest === undefined || count > (counts.get(heaviest) ?? 0)) {
        heaviest = key;
      }
    }
    if (heaviest !== undefined)
      this.pending.delete(oldest.get(heaviest) as string);
  }

  private prune(): void {
    const now = this.clock();
    for (const [state, record] of this.pending) {
      if (record.expiresAtMs <= now) this.pending.delete(state);
    }
  }
}

function oauthCredential(
  credentialId: string,
  input: {
    principalId: string;
    provider: string;
    subject: string;
    nowMs: number;
  },
) {
  return {
    credentialId,
    principalId: input.principalId,
    kind: "oauth" as const,
    provider: input.provider,
    subject: input.subject,
    secretHash: Buffer.alloc(0),
    salt: Buffer.alloc(0),
    kdf: "",
    cost: 0,
    block: 0,
    parallel: 0,
    length: 0,
    createdAtMs: input.nowMs,
    revokedAtMs: 0,
  };
}

function displayNameOf(identity: ExternalIdentity): string {
  for (const candidate of [identity.displayName, identity.email]) {
    if (candidate === undefined) continue;
    const trimmed = candidate.trim().slice(0, 64).trim();
    if (validName(trimmed)) return trimmed;
  }
  return "OAuth";
}
