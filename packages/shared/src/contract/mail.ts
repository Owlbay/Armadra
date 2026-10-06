import { z } from "zod";

import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `mail.*`（契约 §43.5；邮件通道的形状见 §28）：服务器壳配了 SMTP 之后，把刚签出
 * 的邀请 / 口令重置链接发到一个邮箱。桌面壳不配，`status` 答「没配」，发送答
 * `409 mail_not_configured`。
 *
 * 路由门不判这一段（`route-scopes.ts` 的 `SELF_GUARDED`）：「能签发那条链接的人才
 * 能发」是身份域的判定（owner、`identity:manage`、组 admin 对本组成员），全局 scope
 * 说不出「本组」。声明的 scope 与旧路径的清单一致——发送与签发同一档
 * （`identity:manage`），`status` 是 `identity:read`；匿名主体由域答 `401`。
 *
 * 链接令牌（`token`）只在入参里出去一次，答案只有 `{ sent: true }`；收件地址不进
 * 审计明文，令牌与地址都不进日志。限流（`429`）的重试秒数在
 * `details.retryAfterSeconds`，旧路径同时给 `Retry-After` 头。入参只校形状，
 * 取值（id 与令牌的拼法、邮箱地址）仍在域里判。
 */

const base = { since: "1.14", contract: "§43.5" } as const;

const sendFields = {
  token: z.string(),
  to: z.string(),
  locale: z.string().optional(),
};
const sent = z.object({ sent: z.boolean() });
const sendErrors = errors.pick(
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "link_invalid",
  "rate_limited",
  "mail_not_configured",
  "mail_send_failed",
);

export const mail = {
  /** 配没配 SMTP，以及发件人。 */
  status: oc
    .input(z.object({}).optional())
    .output(z.object({ configured: z.boolean(), from: z.string().nullable() }))
    .errors(errors.pick("unauthenticated"))
    .meta(
      meta({
        ...base,
        scope: "identity:read",
        legacy: { method: "GET", path: "/api/mail/status" },
      }),
    ),
  /** 把邀请链接发出去：令牌是签出那一刻交给调用方的那一枚。 */
  sendInvitation: oc
    .input(z.object({ invitationId: z.string(), ...sendFields }))
    .output(sent)
    .errors(sendErrors)
    .meta(
      meta({
        ...base,
        scope: "identity:manage",
        legacy: { method: "POST", path: "/api/mail/invitation" },
      }),
    ),
  /** 把口令重置链接发出去；这台服务器没有重置链接时答 `404`。 */
  sendPasswordReset: oc
    .input(z.object({ principalId: z.string(), ...sendFields }))
    .output(sent)
    .errors(sendErrors)
    .meta(
      meta({
        ...base,
        scope: "identity:manage",
        legacy: { method: "POST", path: "/api/mail/password-reset" },
      }),
    ),
};
