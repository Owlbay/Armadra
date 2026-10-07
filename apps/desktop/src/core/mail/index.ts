/**
 * 邮件域 W-MAIL：可选的 SMTP 通知通道（外部服务 §7.5、G5 计划 §3 G5-13）。
 *
 * 边界：
 *   * 只在服务器壳配了 `ARMADRA_SMTP_URL` / `--smtp-url` 时工作：壳解析好配置后
 *     经 {@link mailDomainOf} 交进来（{@link MailDomain.configure}）。桌面壳不配，
 *     `GET /api/mail/status` 答 `configured: false`。
 *   * 只发邀请与口令重置链接：正文只有链接与过期时间；收件地址不进审计明文。
 *   * `/api/mail/*` 自己认身份（`http/route-scopes.ts` 的 `SELF_GUARDED`）：
 *     能签发那条链接的人才能发。契约 §28。
 */

import type { CoreContext } from "../main";
import type { CoreServer } from "../http/server";
import { AccountsService } from "../identity/accounts";
import { IdentityError } from "../identity/errors";
import { IdentityStore } from "../identity/store";
import { secretsFor } from "../secrets";
import { installRoutes } from "./routes";
import { type LinkChecks, MailService } from "./service";
import { type SmtpConfig, smtpSender } from "./smtp";

export { MAIL_ROUTES } from "./routes";
export {
  MailService,
  addressDigest,
  compose,
  linkFor,
  mailLocale,
} from "./service";
export type { LinkChecks, MailConfiguration, MailLocale } from "./service";
export {
  parseSmtpUrl,
  smtpSender,
  validAddress,
  type MailMessage,
  type MailSender,
  type SmtpConfig,
  type SmtpSettings,
} from "./smtp";

export interface MailDomain {
  readonly service: MailService;
  /**
   * 壳给 SMTP 配置与链接的来源。口令引用（`secret://…`）在这台 core 的密钥后端
   * 里现取。
   */
  configure(config: SmtpConfig, origin: () => string): void;
}

const domains = new WeakMap<CoreServer, MailDomain>();

/** 这台 core 的邮件域；没装（库没过统一迁移）时是 `undefined`。 */
export function mailDomainOf(server: CoreServer): MailDomain | undefined {
  return domains.get(server);
}

/**
 * 身份域的两道核对。口令重置：先按签发那一套认调用方（不是能签的人答 403，
 * 没有这个人答 404），再认令牌——令牌认不出、用过、过期，或者不是这个人的，
 * 一律 `conflict`（409 `link_invalid`），不分是哪一种（契约 §25、§28）。
 */
export function linkChecks(accounts: AccountsService): LinkChecks {
  return {
    invitation: (actor, input) => accounts.invitationForDelivery(actor, input),
    passwordReset: (actor, input) => {
      accounts.requirePasswordResetRights(actor, input.principalId);
      let target: { principalId: string; expiresAtMs: number };
      try {
        target = accounts.inspectPasswordReset(input.token);
      } catch {
        throw new IdentityError("conflict");
      }
      if (target.principalId !== input.principalId) {
        throw new IdentityError("conflict");
      }
      return { expiresAtMs: target.expiresAtMs };
    },
  };
}

export function install(context: CoreContext): void {
  // 判定靠身份表：没过统一库迁移的库里没有它们，路由留着答 404。
  if (!context.db.unified) {
    context.log.info("邮件域未装配：统一库迁移尚未应用");
    return;
  }
  const accounts = new AccountsService({
    store: new IdentityStore(context.db.database),
  });
  const service = new MailService(linkChecks(accounts), {
    warn: (message, fields) => context.log.warn(message, fields),
  });
  installRoutes(context.server, service);
  domains.set(context.server, {
    service,
    configure: (config, origin) => {
      const backend = () => secretsFor(context).backend;
      service.configure({
        from: config.settings.from,
        origin,
        send: smtpSender(config, (name) => backend().get(name)),
      });
      context.log.info("邮件通道已配置", {
        host: config.settings.host,
        port: config.settings.port,
        secure: config.settings.secure,
        from: config.settings.from,
      });
    },
  });
}
