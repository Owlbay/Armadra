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
