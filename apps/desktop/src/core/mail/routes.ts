import { coreError } from "../http/errors";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
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
 */

export const MAIL_ROUTES = {
  status: "/api/mail/status",
  invitation: "/api/mail/invitation",
  passwordReset: "/api/mail/password-reset",
} as const;

/** 令牌与邀请 / 重置同形：`<32 位十六进制>.<base64url>`。 */
const TOKEN = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{16,128}$/;

type Actor =
  | { readonly subject: AuthorizationSubject }
  | { readonly refusal: HandlerResult };

function actor(): Actor {
  const identity = requestIdentity();
  // 桌面壳的本机请求没有请求身份：主体是本机 owner（桌面壳不配邮件，status 答
  // 未配置，发送答 409）。
  if (identity === undefined) return { subject: currentSubject() };
  const subject = identity.subject;
  if (subject.kind !== "owner" && subject.principalId === "") {
    return {
      refusal: coreError(401, "unauthenticated", "需要一个已登录的会话"),
    };
  }
  return { subject };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function header(request: CoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendRoute(
  mail: MailService,
  kind: LinkKind,
): (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult> {
  const idField = kind === "invitation" ? "invitationId" : "principalId";
  return async (_match, request) => {
    const who = actor();
    if ("refusal" in who) return who.refusal;
    if (!mail.supports(kind)) {
      return coreError(404, "not_found", "这台服务器没有口令重置链接");
    }
    let body: Record<string, unknown>;
    try {
      const parsed = request.json();
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return coreError(400, "bad_request", "请求体要是一个对象");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return coreError(400, "bad_request", "请求体不是合法的 JSON");
    }
    const id = text(body[idField]);
    const token = text(body.token);
    const to = text(body.to);
    if (!ID_PATTERN.test(id)) {
      return coreError(400, "bad_request", `${idField} 不对`);
    }
    if (
      !TOKEN.test(token) ||
      (kind === "invitation" && token.split(".")[0] !== id)
    ) {
      return coreError(400, "bad_request", "token 不对");
    }
    if (!validAddress(to)) {
      return coreError(400, "bad_request", "to 不是一个邮箱地址");
    }
    try {
      await mail.send({
        actor: who.subject,
        kind,
        id,
        token,
        to,
        locale: mailLocale(body.locale, header(request, "accept-language")),
        source: remoteAddress(request),
      });
      return { status: 200, body: { sent: true } };
    } catch (error) {
      return failure(error);
    }
  };
}

function failure(error: unknown): HandlerResult {
  if (error instanceof MailNotConfigured) {
    return coreError(409, "mail_not_configured", "这台服务器没有配置邮件");
  }
  if (error instanceof MailRateLimited) {
    return {
      ...coreError(429, "rate_limited", "发得太频繁，稍后再试"),
      headers: {
        "retry-after": String(
          Math.max(1, Math.ceil(error.retryAfterMs / 1000)),
        ),
      },
    };
  }
  if (error instanceof MailSendFailed) {
    return coreError(502, "mail_send_failed", "邮件服务器没有收下这封信");
  }
  if (error instanceof IdentityError) {
    switch (error.kind) {
      case "notFound":
        return coreError(404, "not_found", "没有这条记录");
      case "conflict":
        return coreError(409, "link_invalid", "链接已用过、已过期或令牌不对");
      case "unauthenticated":
        return coreError(401, "unauthenticated", "需要一个已登录的会话");
      case "invalid":
        return coreError(400, "bad_request", "请求不对");
      default:
        return coreError(403, "forbidden", "你不能签发这条链接");
    }
  }
  throw error;
}

export function installRoutes(server: CoreServer, mail: MailService): void {
  const { router } = server;
  router.handle("GET", MAIL_ROUTES.status, () => {
    const who = actor();
    if ("refusal" in who) return who.refusal;
    return { status: 200, body: mail.status() };
  });
  router.handle("POST", MAIL_ROUTES.invitation, sendRoute(mail, "invitation"));
  router.handle(
    "POST",
    MAIL_ROUTES.passwordReset,
    sendRoute(mail, "passwordReset"),
  );
}
