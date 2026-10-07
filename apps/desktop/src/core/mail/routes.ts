import {
  CoreFailure,
  coreError,
  fail,
  failureResult,
  rateLimited,
} from "../http/errors";
import type { CoreRequest, HandlerResult } from "../http/router";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import type { CoreServer } from "../http/server";
import type { AuthorizationSubject } from "../identity/authorize";
import { IdentityError } from "../identity/errors";
import { currentSubject, requestIdentity } from "../identity/gate";
import { remoteAddress } from "../identity/http";
import { ID_PATTERN } from "../identity/tokens";
import {
  type LinkKind,
  MailNotConfigured,
  MailRateLimited,
  MailSendFailed,
  type MailService,
  mailLocale,
} from "./service";
import { validAddress } from "./smtp";

/**
 * `/api/mail/*`（契约 §28）。
 *
 * 路由门不判这一段（`http/route-scopes.ts` 的 `SELF_GUARDED`）：「能签发那条
 * 链接的人才能发」是身份域的判定（owner、`identity:manage`、组 admin 对本组），
 * 全局 scope 说不出「本组」。这里只认人：匿名主体 401，其余交给
 * {@link MailService.send} 里身份域的核对。
 *
 * 状态与两种发送收成一份操作（{@link operations}），旧路径的 handler 与
 * `registerProcedures(server, "mail", …)`（契约 §43.5）调同一份，拒绝都是
 * {@link CoreFailure}：码、状态与原话一样；限流的重试秒数在 `details`，HTTP 上同时
 * 给 `Retry-After` 头。令牌与收件地址不进任何答案与日志。
 */

export const MAIL_ROUTES = {
  status: "/api/mail/status",
  invitation: "/api/mail/invitation",
  passwordReset: "/api/mail/password-reset",
} as const;

/** 令牌与邀请 / 重置同形：`<32 位十六进制>.<base64url>`。 */
const TOKEN = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{16,128}$/;

function actor(): AuthorizationSubject {
  const identity = requestIdentity();
  // 桌面壳的本机请求没有请求身份：主体是本机 owner（桌面壳不配邮件，status 答
  // 未配置，发送答 409）。
  if (identity === undefined) return currentSubject();
  const subject = identity.subject;
  if (subject.kind !== "owner" && subject.principalId === "") {
    throw fail("unauthenticated", "需要一个已登录的会话");
  }
  return subject;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function header(request: CoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function send(
  mail: MailService,
  kind: LinkKind,
  readBody: () => unknown,
  request: CoreRequest,
): Promise<{ sent: boolean }> {
  const who = actor();
  if (!mail.supports(kind)) {
    throw fail("not_found", "这台服务器没有口令重置链接");
  }
  const parsed = readBody();
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail("bad_request", "请求体要是一个对象");
  }
  const body = parsed as Record<string, unknown>;
  const idField = kind === "invitation" ? "invitationId" : "principalId";
  const id = text(body[idField]);
  const token = text(body.token);
  const to = text(body.to);
  if (!ID_PATTERN.test(id)) throw fail("bad_request", `${idField} 不对`);
  if (
    !TOKEN.test(token) ||
    (kind === "invitation" && token.split(".")[0] !== id)
  ) {
    throw fail("bad_request", "token 不对");
  }
  if (!validAddress(to)) throw fail("bad_request", "to 不是一个邮箱地址");
  try {
    await mail.send({
      actor: who,
      kind,
      id,
      token,
      to,
      locale: mailLocale(body.locale, header(request, "accept-language")),
      source: remoteAddress(request),
    });
    return { sent: true };
  } catch (error) {
    throw refusal(error);
  }
}

/** 邮件与身份域的失败 → 同码同状态的拒绝；不认识的原样往上抛。 */
function refusal(error: unknown): unknown {
  if (error instanceof MailNotConfigured) {
    return fail("mail_not_configured", "这台服务器没有配置邮件");
  }
  if (error instanceof MailRateLimited) {
    return rateLimited("发得太频繁，稍后再试", error.retryAfterMs);
  }
  if (error instanceof MailSendFailed) {
    return fail("mail_send_failed", "邮件服务器没有收下这封信");
  }
  if (error instanceof IdentityError) {
    switch (error.kind) {
      case "notFound":
        return fail("not_found", "没有这条记录");
      case "conflict":
        return fail("link_invalid", "链接已用过、已过期或令牌不对");
      case "unauthenticated":
        return fail("unauthenticated", "需要一个已登录的会话");
      case "invalid":
        return fail("bad_request", "请求不对");
      default:
        return fail("forbidden", "你不能签发这条链接");
    }
  }
  return error;
}

/** 旧路径：操作抛的拒绝换成响应，坏 JSON 答 400。 */
async function answer(work: () => unknown): Promise<HandlerResult> {
  try {
    return { status: 200, body: await work() };
  } catch (error) {
    if (error instanceof CoreFailure) return failureResult(error);
    if (error instanceof SyntaxError) {
      return coreError(400, "bad_request", "请求体不是合法的 JSON");
    }
    throw error;
  }
}

export function installRoutes(server: CoreServer, mail: MailService): void {
  const { router } = server;
  const status = () => {
    actor();
    return mail.status();
  };
  router.handle("GET", MAIL_ROUTES.status, () => answer(status));
  router.handle("POST", MAIL_ROUTES.invitation, (_match, request) =>
    answer(() => send(mail, "invitation", () => request.json(), request)),
  );
  router.handle("POST", MAIL_ROUTES.passwordReset, (_match, request) =>
    answer(() => send(mail, "passwordReset", () => request.json(), request)),
  );

  // procedure（契约 §43.5）：入参已由门面按契约解析，拒绝抛 `CoreFailure`。
  registerProcedures(server, "mail", {
    status,
    sendInvitation: (input, call) =>
      send(mail, "invitation", () => input, call.request),
    sendPasswordReset: (input, call) =>
      send(mail, "passwordReset", () => input, call.request),
  } satisfies DomainHandlers<"mail">);
}
