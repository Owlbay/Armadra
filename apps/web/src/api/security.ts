import { z } from "zod";
import {
  auditPageSchema,
  lockoutListSchema,
  mfaChallengeSchema,
  mfaStatusSchema,
  oauthBindingListSchema,
  oauthProviderListSchema,
  oauthStartSchema,
  passkeyListSchema,
  passkeyOptionsSchema,
  passkeyRenameSchema,
  passkeySchema,
  passwordResetDoneSchema,
  passwordResetInfoSchema,
  passwordResetIssuedSchema,
  recoveryCodesSchema,
  identitySessionListSchema as sessionRowsSchema,
  totpEnrollmentSchema,
  type AuditPage,
  type AuditQuery,
  type IdentitySessionRow,
  type Lockout,
  type MfaChallenge,
  type MfaStatus,
  type OAuthBinding,
  type OAuthProviderList,
  type OAuthResult,
  type Passkey,
  type PasskeyList,
  type PasswordResetDone,
  type PasswordResetInfo,
  type PasswordResetIssued,
  type TotpEnrollment,
} from "@armadra/shared";

import {
  adoptIdentitySession,
  identityRequest,
  identitySessionSchema,
  identityText,
  type IdentitySession,
} from "./identity";
import { isNativeApp } from "../mobile/native-bridge";
import { startNativeOAuth } from "../mobile/native-oauth";

/**
 * 安全页与登录的客户端：契约 §18.1–§18.6（`/api/identity/` 下的口令登录两步、
 * passkey、MFA、会话、锁定、OAuth 与审计）。传输与凭据在 `identity.ts`。
 */

const ok = z.object({}).passthrough();

/** 登录答案：要么是会话，要么是要第二因素的中间票。 */
export type SignInAnswer =
  | {
      kind: "session";
      session: IdentitySession;
      /** 策略要求第二因素但这个人还没登记（契约 §18.3）。 */
      mfaEnrollmentRequired: boolean;
    }
  | { kind: "mfa"; challenge: MfaChallenge };

const sessionAnswerSchema = identitySessionSchema.extend({
  mfaEnrollmentRequired: z.boolean().optional(),
});

function sessionAnswer(
  value: z.infer<typeof sessionAnswerSchema>,
): SignInAnswer {
  const { mfaEnrollmentRequired, ...session } = value;
  return {
    kind: "session",
    session: adoptIdentitySession(session),
    mfaEnrollmentRequired: mfaEnrollmentRequired === true,
  };
}

/** 这台设备在会话列表里叫什么：浏览器名，不含版本与系统细节。 */
export function browserDeviceName(
  agent = globalThis.navigator?.userAgent ?? "",
): string {
  const browser = /Firefox\//.test(agent)
    ? "Firefox"
    : /Edg\//.test(agent)
      ? "Edge"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  return `Armadra · ${browser}`;
}

/* --------------------------------- 登录 ---------------------------------- */

export async function signInWithPassword(
  principalId: string,
  password: string,
): Promise<SignInAnswer> {
  const answer = await identityRequest(
    "login",
    z.union([mfaChallengeSchema, sessionAnswerSchema]),
    {
      method: "POST",
      anonymous: true,
      body: { principalId, password, deviceName: browserDeviceName() },
    },
  );
  return "mfaRequired" in answer
    ? { kind: "mfa", challenge: answer }
    : sessionAnswer(answer);
}

/** 两步登录的第二步：6 位 TOTP 或恢复码。 */
export async function verifyMfa(
  challengeId: string,
  code: string,
): Promise<SignInAnswer> {
  return sessionAnswer(
    await identityRequest("mfa/verify", sessionAnswerSchema, {
      method: "POST",
      anonymous: true,
      body: { challengeId, code },
    }),
  );
}

export function passkeyLoginOptions() {
  return identityRequest("passkey/login/options", passkeyOptionsSchema, {
    method: "POST",
    anonymous: true,
    body: {},
  });
}

export async function passkeyLoginVerify(
  challengeId: string,
  response: Record<string, unknown>,
): Promise<SignInAnswer> {
  return sessionAnswer(
    await identityRequest("passkey/login/verify", sessionAnswerSchema, {
      method: "POST",
      anonymous: true,
      body: { challengeId, response, deviceName: browserDeviceName() },
    }),
  );
}

/* -------------------------------- passkey -------------------------------- */

export function listPasskeys(): Promise<PasskeyList> {
  return identityRequest("passkey", passkeyListSchema);
}

export function passkeyRegisterOptions(label: string) {
  return identityRequest("passkey/register/options", passkeyOptionsSchema, {
    method: "POST",
    body: { label },
  });
}

export function passkeyRegisterVerify(
  challengeId: string,
  response: Record<string, unknown>,
  label: string,
): Promise<Passkey> {
  return identityRequest("passkey/register/verify", passkeySchema, {
    method: "POST",
    body: { challengeId, response, label },
  });
}

export async function removePasskey(credentialId: string): Promise<void> {
  await identityRequest(`passkey/${encodeURIComponent(credentialId)}`, ok, {
    method: "DELETE",
  });
}

/** 改名（只有本人；1–64 个字符）。 */
export async function renamePasskey(
  credentialId: string,
  label: string,
): Promise<string> {
  const renamed = await identityRequest(
    `passkey/${encodeURIComponent(credentialId)}`,
    passkeyRenameSchema,
    { method: "PATCH", body: { label } },
  );
  return renamed.label;
}

/* ------------------------------ 口令重置链接 ------------------------------ */

/** owner（或组 admin 对本组成员）签发；明文令牌只在这一次答出来（契约 §25）。 */
export function issuePasswordReset(
  principalId: string,
): Promise<PasswordResetIssued> {
  return identityRequest(
    `principals/${encodeURIComponent(principalId)}/password-reset`,
    passwordResetIssuedSchema,
    { method: "POST", body: {} },
  );
}

/** 打开链接：这是谁的、什么时候过期。认不出答 404 `password_reset_invalid`。 */
export function openPasswordReset(token: string): Promise<PasswordResetInfo> {
  return identityRequest(
    `password-reset/${encodeURIComponent(token)}`,
    passwordResetInfoSchema,
    { anonymous: true },
  );
}

/** 设新口令；成功后这个人的全部会话已撤，拿 `principalId` 与新口令登录。 */
export function completePasswordReset(
  token: string,
  password: string,
): Promise<PasswordResetDone> {
  return identityRequest(
    `password-reset/${encodeURIComponent(token)}`,
    passwordResetDoneSchema,
    { method: "POST", anonymous: true, body: { password } },
  );
}

/** 重置链接：页面根上的 `#reset=<令牌>`。令牌只在片段里，不上请求行。 */
export function passwordResetLink(token: string, origin = location.origin) {
  return `${origin}/#reset=${token}`;
}

const RESET_FRAGMENT = /^#reset=([A-Za-z0-9._~-]+)$/;

/** 地址栏里有没有一条待用的重置链接（不取走）。 */
export function hasPasswordResetFragment(): boolean {
  return RESET_FRAGMENT.test(globalThis.location?.hash ?? "");
}

/** 取走地址栏里的重置令牌并把片段抹掉，免得它留在历史与分享出去的链接里。 */
export function takePasswordResetToken(): string {
  const location = globalThis.location;
  const found = RESET_FRAGMENT.exec(location?.hash ?? "");
  if (!found) return "";
  try {
    globalThis.history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}`,
    );
  } catch {
    /* 抹不掉地址栏不该让重置失败。 */
  }
  return found[1] as string;
}

/* ---------------------------------- MFA ---------------------------------- */

export function mfaStatus(): Promise<MfaStatus> {
  return identityRequest("mfa", mfaStatusSchema);
}

export function enrollTotp(): Promise<TotpEnrollment> {
  return identityRequest("mfa/totp/enroll", totpEnrollmentSchema, {
    method: "POST",
  });
}

export async function confirmTotp(code: string): Promise<string[]> {
  return (
    await identityRequest("mfa/totp/confirm", recoveryCodesSchema, {
      method: "POST",
      body: { code },
    })
  ).recoveryCodes;
}

export async function regenerateRecoveryCodes(code: string): Promise<string[]> {
  return (
    await identityRequest("mfa/recovery-codes", recoveryCodesSchema, {
      method: "POST",
      body: { code },
    })
  ).recoveryCodes;
}

export async function disableMfa(code: string): Promise<void> {
  await identityRequest("mfa/disable", ok, { method: "POST", body: { code } });
}

/* --------------------------------- 会话 ---------------------------------- */

export async function listSessions(all = false): Promise<IdentitySessionRow[]> {
  return (
    await identityRequest(
      all ? "sessions?all=1" : "sessions",
      sessionRowsSchema,
    )
  ).sessions;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await identityRequest(`sessions/${encodeURIComponent(sessionId)}`, ok, {
    method: "DELETE",
  });
}

export async function revokeOtherSessions(): Promise<number> {
  return (
    await identityRequest(
      "sessions/revoke-others",
      z.object({ revoked: z.number() }),
      { method: "POST" },
    )
  ).revoked;
}

/* --------------------------------- 锁定 ---------------------------------- */

export async function listLockouts(): Promise<Lockout[]> {
  return (await identityRequest("lockouts", lockoutListSchema)).lockouts;
}

export async function clearLockout(principalId: string): Promise<void> {
  await identityRequest(`lockouts/${encodeURIComponent(principalId)}`, ok, {
    method: "DELETE",
  });
}

/* --------------------------------- OAuth --------------------------------- */

/**
 * 提供方。匿名时只有 `id` 与 `kind`；带着有 `identity:manage` 的会话再多出
 * 回调地址、有没有密钥等（契约 §18.5）。
 */
export function oauthProviders(anonymous = true): Promise<OAuthProviderList> {
  return identityRequest("oauth/providers", oauthProviderListSchema, {
    anonymous,
  });
}

export async function setOAuthSecret(
  providerId: string,
  clientSecret: string,
): Promise<void> {
  await identityRequest(
    `oauth/providers/${encodeURIComponent(providerId)}/secret`,
    ok,
    { method: "PUT", body: { clientSecret } },
  );
}

export async function clearOAuthSecret(providerId: string): Promise<void> {
  await identityRequest(
    `oauth/providers/${encodeURIComponent(providerId)}/secret`,
    ok,
    { method: "DELETE" },
  );
}

export async function oauthBindings(): Promise<OAuthBinding[]> {
  return (await identityRequest("oauth/bindings", oauthBindingListSchema))
    .bindings;
}

export async function removeOAuthBinding(credentialId: string): Promise<void> {
  await identityRequest(
    `oauth/bindings/${encodeURIComponent(credentialId)}`,
    ok,
    { method: "DELETE" },
  );
}

/**
 * 发起授权：拿到提供方地址后整页跳过去，回来时落在 `returnTo#oauth=…`。
 * 原生 App 里改由系统浏览器打开，结果经 `armadra://oauth` 深链回来
 * （`mobile/native-oauth.ts`，R-56）。`navigate` 留给测试。
 */
export async function startOAuth(
  providerId: string,
  mode: "login" | "bind",
  navigate: (url: string) => void = (url) => globalThis.location.assign(url),
): Promise<void> {
  if (isNativeApp())
    return startNativeOAuth(providerId, mode, browserDeviceName());
  const location = globalThis.location;
  const started = await identityRequest(
    `oauth/${encodeURIComponent(providerId)}/start`,
    oauthStartSchema,
    {
      method: "POST",
      anonymous: mode === "login",
      body: {
        mode,
        returnTo: `${location?.pathname || "/"}${location?.search ?? ""}`,
        deviceName: browserDeviceName(),
      },
    },
  );
  navigate(started.authorizeUrl);
}

/** 回调跳回来带的片段（契约 §18.5）。 */
export interface OAuthOutcome {
  readonly result: OAuthResult;
  /** `error` 时的拒绝码。 */
  readonly code: string;
  /** `mfa` 时接 `mfa/verify` 的中间票。 */
  readonly challengeId: string;
}

const OAUTH_RESULT_SET: ReadonlySet<string> = new Set([
  "signedIn",
  "signedUp",
  "bound",
  "mfa",
  "error",
]);

export function parseOAuthFragment(hash: string): OAuthOutcome | null {
  if (!hash.startsWith("#oauth=")) return null;
  const fields = new URLSearchParams(hash.slice(1));
  const result = fields.get("oauth") ?? "";
  if (!OAUTH_RESULT_SET.has(result)) return null;
  return {
    result: result as OAuthResult,
    code: fields.get("code") ?? "",
    challengeId: fields.get("challengeId") ?? "",
  };
}

/** 地址栏里有没有 OAuth 回调的片段（不取走）。 */
export function hasOAuthFragment(): boolean {
  return parseOAuthFragment(globalThis.location?.hash ?? "") !== null;
}

/** 取走片段并从地址栏抹掉：中间票不该留在历史与分享出去的链接里。 */
export function takeOAuthFragment(): OAuthOutcome | null {
  const location = globalThis.location;
  const found = parseOAuthFragment(location?.hash ?? "");
  if (!found) return null;
  try {
    globalThis.history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}`,
    );
  } catch {
    /* 抹不掉地址栏不该让登录失败。 */
  }
  return found;
}

/* --------------------------------- 审计 ---------------------------------- */

function auditSearch(query: AuditQuery): string {
  const search = new URLSearchParams();
  if (query.principalId) search.set("principalId", query.principalId);
  if (query.workspaceId) search.set("workspaceId", query.workspaceId);
  for (const action of query.action ?? []) search.append("action", action);
  if (query.sinceMs !== undefined) search.set("sinceMs", String(query.sinceMs));
  if (query.untilMs !== undefined) search.set("untilMs", String(query.untilMs));
  if (query.beforeId !== undefined)
    search.set("beforeId", String(query.beforeId));
  if (query.limit !== undefined) search.set("limit", String(query.limit));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function readAudit(query: AuditQuery): Promise<AuditPage> {
  return identityRequest(`audit${auditSearch(query)}`, auditPageSchema);
}

/** 同样的筛选导出 CSV（不分页，最多一万行）。 */
export function exportAudit(
  query: Omit<AuditQuery, "beforeId" | "limit">,
): Promise<string> {
  return identityText(`audit/export${auditSearch(query)}`);
}

/* --------------------------------- 成员 ---------------------------------- */

const memberListSchema = z.object({
  principals: z.array(
    z.object({
      principalId: z.string(),
      displayName: z.string().default(""),
    }),
  ),
});

/** 成员表（`identity:manage`）：审计与会话的成员列用来显示名字。 */
export async function listMembers(): Promise<
  { principalId: string; displayName: string }[]
> {
  return (await identityRequest("principals", memberListSchema)).principals;
}

/** 新登记的 passkey 叫什么：浏览器 · 系统，可以之后在系统里认出来。 */
export function passkeyLabel(
  agent = globalThis.navigator?.userAgent ?? "",
): string {
  const browser = browserDeviceName(agent).replace(/^Armadra · /, "");
  const system = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Mac OS X|Macintosh/.test(agent)
        ? "macOS"
        : /Windows/.test(agent)
          ? "Windows"
          : /Linux|X11|CrOS/.test(agent)
            ? "Linux"
            : "";
  return system ? `${browser} · ${system}` : browser;
}
