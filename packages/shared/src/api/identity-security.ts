import { z } from "zod";

/**
 * Identity hardening — password policy, passkeys, MFA, sessions, OAuth / OIDC
 * and audit (contract §18, docs/design/completion-architecture.md §8.3).
 * Skeleton: G1-11, G1-12 and G2-8 fill in their subsections.
 */

/** `identity.mfa.requireFor`: who must pass a second factor at sign-in. */
export const MFA_REQUIREMENTS = ["none", "members", "all"] as const;
export const mfaRequirementSchema = z.enum(MFA_REQUIREMENTS);

export type MfaRequirement = (typeof MFA_REQUIREMENTS)[number];

/* ------------------------------------------------------------------------- */
/* §18.1 口令策略与锁定（G1-11）                                              */
/* ------------------------------------------------------------------------- */

/** 口令策略拒绝的 `code`（400）。`password_breached` 由泄露检查（G3-8）给出。 */
export const PASSWORD_POLICY_CODES = [
  "password_too_short",
  "password_too_long",
  "password_contains_name",
  "password_too_common",
  "password_breached",
] as const;
export const passwordPolicyCodeSchema = z.enum(PASSWORD_POLICY_CODES);
export type PasswordPolicyCode = (typeof PASSWORD_POLICY_CODES)[number];

/** 限流与锁定的 `code`（429，带 `Retry-After` 头，单位秒）。 */
export const THROTTLE_CODES = ["rate_limited", "account_locked"] as const;
export const throttleCodeSchema = z.enum(THROTTLE_CODES);
export type ThrottleCode = (typeof THROTTLE_CODES)[number];

/** `GET /api/identity/lockouts` 的一行（`identity:manage`）。 */
export const lockoutSchema = z.object({
  key: z.string(),
  principalId: z.string(),
  failures: z.number().int().nonnegative(),
  lockedUntilMs: z.number().int().nonnegative(),
});
export type Lockout = z.infer<typeof lockoutSchema>;

export const lockoutListSchema = z.object({ lockouts: z.array(lockoutSchema) });

/* ------------------------------------------------------------------------- */
/* §18.2 passkey（G1-11）                                                     */
/* ------------------------------------------------------------------------- */

/** passkey 那几条路由自己的拒绝 `code`（400）。 */
export const PASSKEY_CODES = [
  "passkey_unavailable_on_ip_host",
  "passkey_rp_id_mismatch",
  "passkey_challenge_expired",
  "passkey_verification_failed",
] as const;
export const passkeyCodeSchema = z.enum(PASSKEY_CODES);
export type PasskeyCode = (typeof PASSKEY_CODES)[number];

export const passkeySchema = z.object({
  credentialId: z.string(),
  label: z.string(),
  aaguid: z.string(),
  transports: z.array(z.string()),
  createdAtMs: z.number().int().positive(),
});
export type Passkey = z.infer<typeof passkeySchema>;

/** `GET /api/identity/passkey`：我的 passkey，以及这台主机上 passkey 能不能用。 */
export const passkeyListSchema = z.object({
  available: z.boolean(),
  /** 可用时的 RP ID；不可用时空串。 */
  rpId: z.string(),
  /** 不可用的原因（{@link PASSKEY_CODES} 之一）；可用时空串。 */
  reason: z.string(),
  passkeys: z.array(passkeySchema),
});
export type PasskeyList = z.infer<typeof passkeyListSchema>;

/**
 * `POST passkey/{register,login}/options` 的答案。`options` 是 WebAuthn 的
 * `PublicKeyCredential{Creation,Request}OptionsJSON`，页面原样交给
 * `PublicKeyCredential.parse{Creation,Request}OptionsFromJSON`。
 */
export const passkeyOptionsSchema = z.object({
  challengeId: z.string(),
  options: z.record(z.string(), z.unknown()),
});
export type PasskeyOptions = z.infer<typeof passkeyOptionsSchema>;

export const passkeyRegisterOptionsRequestSchema = z.object({
  label: z.string().max(128).optional(),
});

/** `response` 是 `PublicKeyCredential.toJSON()`。 */
export const passkeyRegisterVerifyRequestSchema = z.object({
  challengeId: z.string(),
  response: z.record(z.string(), z.unknown()),
  label: z.string().max(128).optional(),
});

export const passkeyLoginVerifyRequestSchema = z.object({
  challengeId: z.string(),
  response: z.record(z.string(), z.unknown()),
  deviceName: z.string().min(1).max(256).optional(),
});

/* ------------------------------------------------------------------------- */
/* §18.3 MFA 与两步登录（G1-11）                                              */
/* ------------------------------------------------------------------------- */

export const MFA_CODES = [
  "mfa_invalid_code",
  "mfa_challenge_expired",
  "mfa_already_enrolled",
  "mfa_secret_unavailable",
] as const;
export const mfaCodeSchema = z.enum(MFA_CODES);
export type MfaCode = (typeof MFA_CODES)[number];

/** `POST login` 在有已确认 TOTP 时的答案：不建会话，只给中间票。 */
export const mfaChallengeSchema = z.object({
  mfaRequired: z.literal(true),
  challengeId: z.string(),
  expiresAtMs: z.number().int().positive(),
  methods: z.array(z.enum(["totp", "recovery"])),
});
export type MfaChallenge = z.infer<typeof mfaChallengeSchema>;

export const mfaVerifyRequestSchema = z.object({
  challengeId: z.string(),
  /** 6 位 TOTP，或一个恢复码（`xxxxx-xxxxx`，大小写与连字符不计）。 */
  code: z.string().min(1).max(64),
});

/** `GET /api/identity/mfa`。 */
export const mfaStatusSchema = z.object({
  enrolled: z.boolean(),
  pending: z.boolean(),
  enrolledAtMs: z.number().int().nonnegative(),
  verifiedAtMs: z.number().int().nonnegative(),
  recoveryCodesRemaining: z.number().int().nonnegative(),
  requireFor: mfaRequirementSchema,
  /** `requireFor` 覆盖这个人。 */
  required: z.boolean(),
});
export type MfaStatus = z.infer<typeof mfaStatusSchema>;

/** `POST mfa/totp/enroll`：密钥只在这一次出现。 */
export const totpEnrollmentSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type TotpEnrollment = z.infer<typeof totpEnrollmentSchema>;

/** `POST mfa/totp/confirm` 与 `POST mfa/recovery-codes`：明文只在这一次出现。 */
export const recoveryCodesSchema = z.object({
  recoveryCodes: z.array(z.string()).length(10),
});

/* ------------------------------------------------------------------------- */
/* §18.4 会话列表与撤销（G1-11）                                              */
/* ------------------------------------------------------------------------- */

export const identitySessionSchema = z.object({
  sessionId: z.string(),
  principalId: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  createdAtMs: z.number().int().positive(),
  /** 最近一次认证成功（约一分钟精度）；0 = 没记过（迁移之前的会话）。 */
  lastSeenAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
  remoteIp: z.string(),
  userAgent: z.string(),
  /** 发这个请求的那一个。 */
  current: z.boolean(),
});
export type IdentitySessionRow = z.infer<typeof identitySessionSchema>;

export const identitySessionListSchema = z.object({
  sessions: z.array(identitySessionSchema),
});

/* ------------------------------------------------------------------------- */
/* §18.5 OAuth / OIDC（G1-12）                                                */
/* ------------------------------------------------------------------------- */

/** OAuth 路由的拒绝码（契约 §18.5）；回调把它放在跳回地址的 `#oauth=error&code=`。 */
export const OAUTH_CODES = [
  "oauth_not_configured",
  "oauth_browser_required",
  "oauth_state_invalid",
  "oauth_denied",
  "oauth_provider_error",
  "oauth_token_invalid",
  "oauth_email_unverified",
  "oauth_domain_not_allowed",
  "oauth_not_bound",
  "oauth_already_bound",
] as const;
export const oauthCodeSchema = z.enum(OAUTH_CODES);
export type OAuthCode = (typeof OAUTH_CODES)[number];

/** 回调跳回时片段里的 `oauth=`。 */
export const OAUTH_RESULTS = [
  "signedIn",
  "signedUp",
  "bound",
  "mfa",
  "error",
] as const;
export type OAuthResult = (typeof OAUTH_RESULTS)[number];

/** `GET oauth/providers` 的一行。匿名只有 `id` 与 `kind`；owner 看得到其余。 */
export const oauthProviderRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["github", "oidc"]),
  issuer: z.string().optional(),
  clientId: z.string().optional(),
  enabled: z.boolean().optional(),
  allowSignup: z.boolean().optional(),
  allowedDomains: z.array(z.string()).optional(),
  hasClientSecret: z.boolean().optional(),
  /** 开着、有公网来源、（GitHub）有 secret。 */
  usable: z.boolean().optional(),
  /** 要在提供方登记的回调地址，每个公网来源一条。 */
  callbackUrls: z.array(z.string()).optional(),
});
export type OAuthProviderRow = z.infer<typeof oauthProviderRowSchema>;

export const oauthProviderListSchema = z.object({
  /** 有没有公网来源；没有时任何提供方都不可用。 */
  configured: z.boolean(),
  providers: z.array(oauthProviderRowSchema),
});
export type OAuthProviderList = z.infer<typeof oauthProviderListSchema>;

/** `POST oauth/{id}/start` 的请求与答案。 */
export const oauthStartRequestSchema = z.object({
  mode: z.enum(["login", "bind"]).default("login"),
  /** 站内路径，`/` 开头；回调跳回这里。 */
  returnTo: z.string().max(512).optional(),
  deviceName: z.string().max(256).optional(),
});
export type OAuthStartRequest = z.input<typeof oauthStartRequestSchema>;

export const oauthStartSchema = z.object({
  authorizeUrl: z.string(),
  expiresAtMs: z.number().int().positive(),
});
export type OAuthStart = z.infer<typeof oauthStartSchema>;

/** `GET oauth/bindings` 的一行。 */
export const oauthBindingSchema = z.object({
  credentialId: z.string(),
  /** 设置里认不出（删了或换了 issuer）时为空串。 */
  providerId: z.string(),
  kind: z.enum(["github", "oidc"]),
  createdAtMs: z.number().int().positive(),
});
export type OAuthBinding = z.infer<typeof oauthBindingSchema>;

export const oauthBindingListSchema = z.object({
  bindings: z.array(oauthBindingSchema),
});

/** `POST oauth/{id}/logout`：提供方没有 RP 发起的登出时为 null。 */
export const oauthLogoutSchema = z.object({
  endSessionUrl: z.string().nullable(),
});

/* ------------------------------------------------------------------------- */
/* §18.6 审计查询（G2-8）                                                     */
/* ------------------------------------------------------------------------- */

/** `GET audit` 一页的上限；`limit` 超出或缺省时取 100。 */
export const AUDIT_PAGE_MAX = 500;
/** `GET audit/export` 一次最多导出的行数（按 id 从新到旧截断）。 */
export const AUDIT_EXPORT_MAX = 10_000;

/** 审计查询的筛选参数（查询串，全部可选，彼此 AND）。 */
export const auditQuerySchema = z.object({
  principalId: z.string().optional(),
  workspaceId: z.string().optional(),
  /**
   * 动作或动作族：`identity.login` 命中它自己与 `identity.login.*`。可重复，
   * 彼此 OR。
   */
  action: z.array(z.string().min(1).max(128)).optional(),
  /** 含：`at_ms >= sinceMs`。 */
  sinceMs: z.number().int().nonnegative().optional(),
  /** 不含：`at_ms < untilMs`。 */
  untilMs: z.number().int().nonnegative().optional(),
  /** 翻页游标：只要 `id < beforeId` 的。 */
  beforeId: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(AUDIT_PAGE_MAX).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditEntrySchema = z.object({
  id: z.number().int().positive(),
  atMs: z.number().int().nonnegative(),
  principalId: z.string(),
  deviceId: z.string(),
  action: z.string(),
  target: z.string(),
  workspaceId: z.string(),
  /** 写入时的结构化补充；没有时 `null`。 */
  detail: z.unknown(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** `GET audit` 的答案：从新到旧；`nextBeforeId` 为 0 表示没有更早的了。 */
export const auditPageSchema = z.object({
  entries: z.array(auditEntrySchema),
  nextBeforeId: z.number().int().nonnegative(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;
