import { z } from "zod";
import {
  type JsonValue,
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
  identityDevicesSchema,
  identityRequest,
  identitySessionSchema,
  identityText,
  type IdentityDevicePage,
  type IdentitySession,
} from "./identity";
import { identityRpc } from "./identity-rpc";
import { isNativeApp } from "../mobile/native-bridge";
import { startNativeOAuth } from "../mobile/native-oauth";

/**
 * 安全页与登录的客户端：契约 §18.1–§18.6（口令登录两步、passkey、MFA、会话、
 * 锁定、OAuth 与审计）。
 *
 * 会话内的动作是 `security.*` / `identity.devices.*` procedure（契约 §42），经本机
 * 源的契约客户端发（`identity-rpc.ts`）；凭据换会话的那几条（登录两步、passkey
 * 断言、OAuth 发起、重置链接、登录页的匿名提供方表）与审计导出（CSV）留在
 * REST，传输与凭据在 `identity.ts`。
 */

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

export async function listPasskeys(): Promise<PasskeyList> {
  return passkeyListSchema.parse(
    await identityRpc((client) => client.security.passkeys.list()),
  );
}

export async function passkeyRegisterOptions(label: string) {
  return passkeyOptionsSchema.parse(
    await identityRpc((client) =>
      client.security.passkeys.registerOptions({ label }),
    ),
  );
}

export async function passkeyRegisterVerify(
  challengeId: string,
  response: Record<string, unknown>,
  label: string,
): Promise<Passkey> {
  return passkeySchema.parse(
    await identityRpc((client) =>
      client.security.passkeys.registerVerify({
        challengeId,
        // `PublicKeyCredential.toJSON()`：一份纯 JSON。
        response: response as Record<string, JsonValue>,
        label,
      }),
    ),
  );
}

export async function removePasskey(credentialId: string): Promise<void> {
  await identityRpc((client) =>
    client.security.passkeys.remove({ credentialId }),
  );
}

/** 改名（只有本人；1–64 个字符）。 */
export async function renamePasskey(
  credentialId: string,
  label: string,
): Promise<string> {
  const renamed = passkeyRenameSchema.parse(
    await identityRpc((client) =>
      client.security.passkeys.rename({ credentialId, label }),
    ),
  );
  return renamed.label;
}

/* ------------------------------ 口令重置链接 ------------------------------ */

/** owner（或组 admin 对本组成员）签发；明文令牌只在这一次答出来（契约 §25）。 */
export async function issuePasswordReset(
  principalId: string,
): Promise<PasswordResetIssued> {
  return passwordResetIssuedSchema.parse(
    await identityRpc((client) =>
      client.accounts.principals.issuePasswordReset({ principalId }),
    ),
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

export async function mfaStatus(): Promise<MfaStatus> {
  return mfaStatusSchema.parse(
    await identityRpc((client) => client.security.mfa.status()),
  );
}

export async function enrollTotp(): Promise<TotpEnrollment> {
  return totpEnrollmentSchema.parse(
    await identityRpc((client) => client.security.mfa.enroll()),
  );
}

export async function confirmTotp(code: string): Promise<string[]> {
  return recoveryCodesSchema.parse(
    await identityRpc((client) => client.security.mfa.confirm({ code })),
  ).recoveryCodes;
}

export async function regenerateRecoveryCodes(code: string): Promise<string[]> {
  return recoveryCodesSchema.parse(
    await identityRpc((client) =>
      client.security.mfa.regenerateRecoveryCodes({ code }),
    ),
  ).recoveryCodes;
}

export async function disableMfa(code: string): Promise<void> {
  await identityRpc((client) => client.security.mfa.disable({ code }));
}

/**
 * 替丢了手机的人清掉 TOTP 与恢复码（`identity:manage`，契约 §18.3）。答这个人
 * 原来有没有开两步验证。
 */
export async function resetMfa(principalId: string): Promise<boolean> {
  return z
    .object({ reset: z.boolean().default(false) })
    .parse(
      await identityRpc((client) => client.security.mfa.reset({ principalId })),
    ).reset;
}

/* --------------------------------- 会话 ---------------------------------- */

export async function listSessions(all = false): Promise<IdentitySessionRow[]> {
  return sessionRowsSchema.parse(
    await identityRpc((client) =>
      client.security.sessions.list(all ? { all } : {}),
    ),
  ).sessions;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await identityRpc((client) => client.security.sessions.revoke({ sessionId }));
}

export async function revokeOtherSessions(): Promise<number> {
  return (
    await identityRpc((client) => client.security.sessions.revokeOthers())
  ).revoked;
}

/* --------------------------------- 设备 ---------------------------------- */

/**
 * 这个 principal 配过的设备，按 id 分页（`identity.devices.list`）。给了 `signal`
 * 就能被中途取消：配对成功时查询要作废重取，而这一次可能还停在换 CSRF 上。
 */
export async function listIdentityDevices(
  afterId = "",
  limit = 50,
  signal?: AbortSignal,
): Promise<IdentityDevicePage> {
  return identityDevicesSchema.parse(
    await identityRpc((client) =>
      client.identity.devices.list(
        { limit, ...(afterId ? { afterId } : {}) },
        signal === undefined ? undefined : { signal },
      ),
    ),
  );
}

/**
 * 撤销一台设备。
 *
 * `expectedRevision` 是读到那一行时的 epoch：两台设备同时撤销同一台是两个
 * 决定，输的那个要知道自己输了，而不是把一次已经发生的撤销再执行一遍。
 */
export async function revokeIdentityDevice(
  deviceId: string,
  expectedRevision: number,
): Promise<void> {
  await identityRpc((client) =>
    client.identity.devices.revoke({ deviceId, expectedRevision }),
  );
}

/* --------------------------------- 锁定 ---------------------------------- */

export async function listLockouts(): Promise<Lockout[]> {
  return lockoutListSchema.parse(
    await identityRpc((client) => client.security.lockouts.list()),
  ).lockouts;
}

export async function clearLockout(principalId: string): Promise<void> {
  await identityRpc((client) =>
    client.security.lockouts.clear({ principalId }),
  );
}

/* --------------------------------- OAuth --------------------------------- */

/**
 * 提供方。匿名时只有 `id` 与 `kind`；带着有 `identity:manage` 的会话再多出
 * 回调地址、有没有密钥等（契约 §18.5）。
 */
export async function oauthProviders(
  anonymous = true,
): Promise<OAuthProviderList> {
  // 登录页还没有会话：匿名读留在 REST；会话内（设置页）走 procedure。
  if (anonymous) {
    return identityRequest("oauth/providers", oauthProviderListSchema, {
      anonymous,
    });
  }
  return oauthProviderListSchema.parse(
    await identityRpc((client) => client.security.oauth.providers()),
  );
}

export async function setOAuthSecret(
  providerId: string,
  clientSecret: string,
): Promise<void> {
  await identityRpc((client) =>
    client.security.oauth.setSecret({ providerId, clientSecret }),
  );
}

export async function clearOAuthSecret(providerId: string): Promise<void> {
  await identityRpc((client) =>
    client.security.oauth.clearSecret({ providerId }),
  );
}

export async function oauthBindings(): Promise<OAuthBinding[]> {
  return oauthBindingListSchema.parse(
    await identityRpc((client) => client.security.oauth.bindings()),
  ).bindings;
}

export async function removeOAuthBinding(credentialId: string): Promise<void> {
  await identityRpc((client) => client.security.oauth.unbind({ credentialId }));
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

export async function readAudit(query: AuditQuery): Promise<AuditPage> {
  return auditPageSchema.parse(
    await identityRpc((client) => client.security.audit.list(query)),
  );
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
  return memberListSchema.parse(
    await identityRpc((client) => client.accounts.principals.list()),
  ).principals;
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
