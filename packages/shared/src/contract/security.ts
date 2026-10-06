import { z } from "zod";

import {
  lockoutListSchema,
  mfaStatusSchema,
  oauthBindingListSchema,
  oauthProviderListSchema,
  passkeyListSchema,
  passkeySchema,
  totpEnrollmentSchema,
} from "../api/identity-security.js";
import { errors } from "./errors.js";
import { jsonObjectSchema, jsonValueSchema } from "./json.js";
import { meta, oc } from "./meta.js";

/**
 * `security.*`（契约 §42.2）：加固那一面（§18.1–§18.6）的会话内动作——本人的
 * passkey、两步验证、会话列表，owner 的锁定、MFA 重置、OAuth 提供方密钥与审计。
 *
 * 登录本身的几步（口令、第二因素、passkey 断言、OAuth 发起与回调）先于会话存在，
 * 留在 REST 匿名面（§42.4）；审计导出是 CSV 字节流，同样留在 REST。
 *
 * 判定不变：本人的东西由身份域按请求主体放行（成员也能管自己的 passkey 与两步
 * 验证），「管别人的」要 `identity:manage`，与旧路径同一份实现。`scope` 一列是
 * 旧路由表的那一档（见 `identity.ts` 的说明）。拒绝里 §18 的具名码（口令策略、
 * passkey、MFA、OAuth）照旧是它们自己的码与状态；限流与锁定答 429，
 * `details.retryAfterSeconds` 是旧路径 `Retry-After` 头的那个数。
 */

const denied = errors.pick("unauthenticated", "forbidden");
const throttled = errors.pick("rate_limited", "account_locked");

const section = (
  scope: "identity:read" | "identity:manage",
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  successStatus?: number,
) =>
  meta({
    scope,
    since: "1.13",
    contract: "§42.2",
    legacy: {
      method,
      path,
      ...(successStatus === undefined ? {} : { successStatus }),
    },
  });

const none = z.object({}).optional();
const codeInput = z.object({ code: z.string() });
const recoveryCodes = z.object({ recoveryCodes: z.array(z.string()) });

/** WebAuthn 的 `PublicKeyCredential{Creation,Request}OptionsJSON`，原样交给页面。 */
export const passkeyOptionsWireSchema = z.object({
  challengeId: z.string(),
  options: jsonObjectSchema,
});

export const auditEntryWireSchema = z.object({
  id: z.number(),
  atMs: z.number(),
  principalId: z.string(),
  deviceId: z.string(),
  action: z.string(),
  target: z.string(),
  workspaceId: z.string(),
  /** 写入时的结构化补充；没有时 `null`。 */
  detail: jsonValueSchema,
});

export const auditPageWireSchema = z.object({
  entries: z.array(auditEntryWireSchema),
  nextBeforeId: z.number(),
});

/** 审计筛选：与旧路径的查询串同名，`action` 可重复。 */
export const auditQueryInputSchema = z.object({
  principalId: z.string().optional(),
  workspaceId: z.string().optional(),
  action: z.array(z.string()).optional(),
  sinceMs: z.number().optional(),
  untilMs: z.number().optional(),
  beforeId: z.number().optional(),
  limit: z.number().optional(),
});

export const security = {
  passkeys: {
    /** 我的 passkey，以及这台主机上 passkey 能不能用。 */
    list: oc
      .input(none)
      .output(passkeyListSchema)
      .errors(denied)
      .meta(section("identity:read", "GET", "/api/identity/passkey")),
    registerOptions: oc
      .input(z.object({ label: z.string().optional() }).optional())
      .output(passkeyOptionsWireSchema)
      .errors({ ...denied, ...errors.pick("bad_request") })
      .meta(
        section(
          "identity:manage",
          "POST",
          "/api/identity/passkey/register/options",
        ),
      ),
    registerVerify: oc
      .input(
        z.object({
          challengeId: z.string(),
          response: jsonObjectSchema,
          label: z.string().optional(),
        }),
      )
      .output(passkeySchema)
      .errors({ ...denied, ...errors.pick("bad_request", "conflict") })
      .meta(
        section(
          "identity:manage",
          "POST",
          "/api/identity/passkey/register/verify",
          201,
        ),
      ),
    /** 改名：只有本人（别人的与不存在的同样 404）。 */
    rename: oc
      .input(z.object({ credentialId: z.string(), label: z.string() }))
      .output(z.object({ credentialId: z.string(), label: z.string() }))
      .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
      .meta(
        section(
          "identity:manage",
          "PATCH",
          "/api/identity/passkey/{credentialId}",
        ),
      ),
    /** 删除：本人的，或有 `identity:manage` 时任何人的。 */
    remove: oc
      .input(z.object({ credentialId: z.string() }))
      .output(z.object({ credentialId: z.string(), removed: z.literal(true) }))
      .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
      .meta(
        section(
          "identity:manage",
          "DELETE",
          "/api/identity/passkey/{credentialId}",
        ),
      ),
  },
  mfa: {
    status: oc
      .input(none)
      .output(mfaStatusSchema)
      .errors(denied)
      .meta(section("identity:read", "GET", "/api/identity/mfa")),
    /** 开始登记 TOTP：密钥只在这一次出现。 */
    enroll: oc
      .input(none)
      .output(totpEnrollmentSchema)
      .errors({ ...denied, ...errors.pick("conflict") })
      .meta(
        section("identity:manage", "POST", "/api/identity/mfa/totp/enroll"),
      ),
    /** 用第一个码确认登记：恢复码明文只在这一次出现。 */
    confirm: oc
      .input(codeInput)
      .output(recoveryCodes)
      .errors({ ...denied, ...errors.pick("bad_request", "conflict") })
      .meta(
        section("identity:manage", "POST", "/api/identity/mfa/totp/confirm"),
      ),
    /** 本人停用：要一个当前有效的码，码不对计入锁定。 */
    disable: oc
      .input(codeInput)
      .output(z.object({ disabled: z.literal(true) }))
      .errors({ ...denied, ...throttled, ...errors.pick("bad_request") })
      .meta(section("identity:manage", "POST", "/api/identity/mfa/disable")),
    regenerateRecoveryCodes: oc
      .input(codeInput)
      .output(recoveryCodes)
      .errors({ ...denied, ...throttled, ...errors.pick("bad_request") })
      .meta(
        section("identity:manage", "POST", "/api/identity/mfa/recovery-codes"),
      ),
    /** owner 替丢了手机的人清掉 TOTP 与恢复码（`identity:manage`）。 */
    reset: oc
      .input(z.object({ principalId: z.string() }))
      .output(z.object({ principalId: z.string(), reset: z.boolean() }))
      .errors({ ...denied, ...errors.pick("bad_request") })
      .meta(section("identity:manage", "POST", "/api/identity/mfa/reset")),
  },
  sessions: {
    /** 我的活会话；`all` 只给有 `identity:manage` 的人。 */
    list: oc
      .input(z.object({ all: z.boolean().optional() }).optional())
      .output(
        z.object({
          sessions: z.array(
            z.object({
              sessionId: z.string(),
              principalId: z.string(),
              deviceId: z.string(),
              deviceName: z.string(),
              createdAtMs: z.number(),
              lastSeenAtMs: z.number(),
              expiresAtMs: z.number(),
              remoteIp: z.string(),
              userAgent: z.string(),
              current: z.boolean(),
            }),
          ),
        }),
      )
      .errors(denied)
      .meta(section("identity:read", "GET", "/api/identity/sessions")),
    /** 撤一个会话：自己的随便撤，别人的要 `identity:manage`（否则 404）。 */
    revoke: oc
      .input(z.object({ sessionId: z.string() }))
      .output(z.object({ sessionId: z.string(), revoked: z.literal(true) }))
      .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
      .meta(
        section(
          "identity:manage",
          "DELETE",
          "/api/identity/sessions/{sessionId}",
        ),
      ),
    /** 「其它设备全部登出」：答撤了几个。 */
    revokeOthers: oc
      .input(none)
      .output(z.object({ revoked: z.number() }))
      .errors(denied)
      .meta(
        section(
          "identity:manage",
          "POST",
          "/api/identity/sessions/revoke-others",
        ),
      ),
  },
  lockouts: {
    list: oc
      .input(none)
      .output(lockoutListSchema)
      .errors(denied)
      .meta(section("identity:manage", "GET", "/api/identity/lockouts")),
    clear: oc
      .input(z.object({ principalId: z.string() }))
      .output(z.object({ principalId: z.string(), unlocked: z.boolean() }))
      .errors({ ...denied, ...errors.pick("bad_request") })
      .meta(
        section(
          "identity:manage",
          "DELETE",
          "/api/identity/lockouts/{principalId}",
        ),
      ),
  },
  oauth: {
    /**
     * 提供方表（会话内）：有 `identity:manage` 时带回调地址、有没有密钥等；
     * 没有时只有能用的那几个的 `id` 与 `kind`。登录页的匿名读留在 REST。
     */
    providers: oc
      .input(none)
      .output(oauthProviderListSchema)
      .errors(denied)
      .meta(section("identity:read", "GET", "/api/identity/oauth/providers")),
    /** 设 client secret（只进不出：答「有没有」）。 */
    setSecret: oc
      .input(z.object({ providerId: z.string(), clientSecret: z.string() }))
      .output(z.object({ id: z.string(), hasClientSecret: z.boolean() }))
      .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
      .meta(
        section(
          "identity:manage",
          "PUT",
          "/api/identity/oauth/providers/{providerId}/secret",
        ),
      ),
    clearSecret: oc
      .input(z.object({ providerId: z.string() }))
      .output(z.object({ id: z.string(), hasClientSecret: z.boolean() }))
      .errors({ ...denied, ...errors.pick("not_found") })
      .meta(
        section(
          "identity:manage",
          "DELETE",
          "/api/identity/oauth/providers/{providerId}/secret",
        ),
      ),
    /** 我绑定的外部账号。 */
    bindings: oc
      .input(none)
      .output(oauthBindingListSchema)
      .errors(denied)
      .meta(section("identity:read", "GET", "/api/identity/oauth/bindings")),
    unbind: oc
      .input(z.object({ credentialId: z.string() }))
      .output(z.object({ credentialId: z.string(), revoked: z.literal(true) }))
      .errors({ ...denied, ...errors.pick("not_found") })
      .meta(
        section(
          "identity:manage",
          "DELETE",
          "/api/identity/oauth/bindings/{credentialId}",
        ),
      ),
  },
  audit: {
    /**
     * 审计一页，从新到旧：带 `workspaceId` 要那块画布上的 `workspace:share`，
     * 否则要 `identity:manage`。`nextBeforeId` 为 0 表示没有更早的了。
     */
    list: oc
      .input(auditQueryInputSchema.optional())
      .output(auditPageWireSchema)
      .errors({ ...denied, ...errors.pick("bad_request") })
      .meta(section("identity:read", "GET", "/api/identity/audit")),
  },
};
