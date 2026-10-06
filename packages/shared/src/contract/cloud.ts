import {
  cloudBindInputSchema,
  cloudBindOutputSchema,
  cloudLoginInputSchema,
  cloudLoginOutputSchema,
  cloudRegisterInputSchema,
  cloudRegisterOutputSchema,
  cloudRevokeInputSchema,
  cloudRevokeOutputSchema,
  cloudStatusOutputSchema,
  cloudTrustedOriginsInputSchema,
  cloudTrustedOriginsOutputSchema,
  tunnelStatusSchema,
} from "@armadra/platform-protocol/core-api";
import { z } from "zod";

import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `identity.cloud.*`（契约 §31）：本机 core 登记到远程服务（个人中转；SaaS 只留
 * 形状），用远程服务签发的源访问断言换本机会话。
 *
 * 出入参就是协议包 `@armadra/platform-protocol/core-api` 的那一组 schema 对象
 * （cloud 仓与这里同一份）。`login` 是匿名面：只经旧路径
 * `POST /api/identity/cloud/login` 暴露（`scope: null`），RPC 路径不实现。源私钥、
 * 断言原文、刷新令牌只出现在它们的用途本身里（`login` 答的原生会话），不进任何
 * 别的答案、日志与审计。
 */

export {
  cloudLoginInputSchema,
  cloudLoginOutputSchema,
  cloudStatusOutputSchema,
  tunnelStatusSchema,
};

const denied = errors.pick("unauthenticated", "forbidden");

/** 断言被拒的那几种：验签、时间、受众、重放、没登记。 */
const assertionRefused = errors.pick(
  "cloud_not_registered",
  "cloud_assertion_invalid",
  "cloud_assertion_replayed",
);

const section = (
  scope: "settings:read" | "settings:write" | "identity:read" | null,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  contract: "§31.1" | "§31.4" = "§31.1",
) =>
  meta({
    scope,
    since: "1.3",
    contract,
    legacy: { method, path },
  });

/**
 * 中继侧待清理（§31.4 追加）：撤销后没能删掉的中继侧源记录。这两条是 Armadra
 * 自己的，协议包里没有；码是 core 的错误码（页面按码取文案）。
 */
export const relayPendingSchema = z.object({
  issuer: z.string(),
  revokedAtMs: z.number().int(),
  code: z.string(),
});
export const cloudRelayPendingOutputSchema = z.object({
  pending: z.array(relayPendingSchema),
});
export const cloudRelayCleanupOutputSchema = z.object({
  pending: z.boolean(),
  code: z.string().nullable(),
});
export type RelayPending = z.infer<typeof relayPendingSchema>;

export const cloud = {
  /** 匿名：断言（+ 邀请令牌）换本机会话。Bearer 来源答 `session.native`。 */
  login: oc
    .input(cloudLoginInputSchema)
    .output(cloudLoginOutputSchema)
    .errors({
      ...assertionRefused,
      ...errors.pick(
        "bad_request",
        "forbidden",
        "cloud_account_unlinked",
        "invitation_invalid",
        "rate_limited",
      ),
    })
    .meta(section(null, "POST", "/api/identity/cloud/login")),
  /** 登记到一个远程服务：源密钥对、`sources.register`、取 JWKS、起隧道。 */
  register: oc
    .input(cloudRegisterInputSchema)
    .output(cloudRegisterOutputSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "cloud_already_registered",
        "cloud_issuer_mismatch",
        "registration_token_invalid",
        "source_unreachable",
        "fingerprint_mismatch",
        "protocol_unsupported",
        "rate_limited",
        "not_implemented",
      ),
    })
    .meta(section("settings:write", "POST", "/api/identity/cloud/register")),
  /** 撤销登记：停隧道，行记撤销时刻；不删已映射的账号。 */
  revoke: oc
    .input(cloudRevokeInputSchema)
    .output(cloudRevokeOutputSchema)
    .errors({ ...denied, ...errors.pick("not_found") })
    .meta(section("settings:write", "DELETE", "/api/identity/cloud/register")),
  status: oc
    .input(z.object({}).optional())
    .output(cloudStatusOutputSchema)
    .errors(denied)
    .meta(section("settings:read", "GET", "/api/identity/cloud")),
  /** 把断言的 `sub` 映射到当前登录的人（本人）。 */
  bind: oc
    .input(cloudBindInputSchema)
    .output(cloudBindOutputSchema)
    .errors({
      ...denied,
      ...assertionRefused,
      ...errors.pick("bad_request", "conflict", "rate_limited"),
    })
    .meta(section("identity:read", "POST", "/api/identity/cloud/bind")),
  trustedOrigins: oc
    .input(cloudTrustedOriginsInputSchema)
    .output(cloudTrustedOriginsOutputSchema)
    .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
    .meta(
      section(
        "settings:write",
        "PUT",
        "/api/identity/cloud/{issuer}/trusted-origins",
      ),
    ),
  /** 已撤销、中继侧还欠着清理的登记。 */
  relayPending: oc
    .input(z.object({}).optional())
    .output(cloudRelayPendingOutputSchema)
    .errors(denied)
    .meta(
      section(
        "settings:read",
        "GET",
        "/api/identity/cloud/relay-pending",
        "§31.4",
      ),
    ),
  /** 重试删一条待清理的中继侧源记录。 */
  relayCleanup: oc
    .input(cloudRevokeInputSchema)
    .output(cloudRelayCleanupOutputSchema)
    .errors({ ...denied, ...errors.pick("not_found") })
    .meta(
      section(
        "settings:write",
        "POST",
        "/api/identity/cloud/relay-cleanup",
        "§31.4",
      ),
    ),
};
