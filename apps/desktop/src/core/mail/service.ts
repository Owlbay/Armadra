import { createHash } from "node:crypto";

import type { AuthorizationSubject } from "../identity/authorize";
import { audit } from "../identity/audit";
import type { MailMessage, MailSender } from "./smtp";

/**
 * 邮件通道的判定与正文（契约 §28）。路由在 `routes.ts`，SMTP 在 `smtp.ts`。
 *
 * 规矩：
 *   * **正文只有链接与过期时间**。没有签发人、没有角色、没有工作空间名——邮件
 *     会被转发、被归档，链接本身已经是全部要交的东西。
 *   * **链接只能是这台服务器签出的那一条**：调用方把刚签到的令牌连同 id 交过来，
 *     身份域核对「这是你能签的、令牌对、还能用」（{@link LinkChecks}），地址的
 *     来源由壳给定，请求里没有任何能改正文的字段。
 *   * **收件地址不进审计明文**，记一个带域分隔的 SHA-256 前缀，够对账、不够还原
 *     成列表。
 *   * 每个来源地址每分钟 5 封，失败的也算（试探 SMTP 一样是在用它）。
 */

export type MailLocale = "zh" | "en";

export type LinkKind = "invitation" | "passwordReset";

/** 身份域给的两道核对；抛 `IdentityError`。 */
export interface LinkChecks {
  invitation(
    actor: AuthorizationSubject,
    input: { invitationId: string; token: string },
  ): { expiresAtMs: number };
  /** 口令重置链接（契约 §25）；核对方不给这一道时路由答 404（测试替身用）。 */
  passwordReset?(
    actor: AuthorizationSubject,
    input: { principalId: string; token: string },
  ): { expiresAtMs: number };
}

export const RATE_LIMIT = { count: 5, windowMs: 60_000 } as const;

/** 收件地址的审计指纹：域分隔 + 小写，取前 32 位十六进制。 */
export function addressDigest(address: string): string {
  return createHash("sha256")
    .update(`armadra/mail/v1\0${address.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

/** `Accept-Language` 或请求体里的 `locale` → 两种之一；认不出按英文。 */
export function mailLocale(
  explicit: unknown,
  acceptLanguage: string | undefined,
): MailLocale {
  if (explicit === "zh" || explicit === "en") return explicit;
  if (typeof explicit === "string" && explicit.toLowerCase().startsWith("zh")) {
    return "zh";
  }
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase();
  return first?.startsWith("zh") ? "zh" : "en";
}

function stamp(ms: number): string {
  // `2026-10-11 08:00 UTC`：收件人在哪个时区不知道，写明 UTC。
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** 正文。只有链接与过期时间。 */
export function compose(
  kind: LinkKind,
  locale: MailLocale,
  link: string,
  expiresAtMs: number,
): Pick<MailMessage, "subject" | "text"> {
  const until = stamp(expiresAtMs);
  if (kind === "invitation") {
    return locale === "zh"
      ? {
          subject: "Armadra 邀请",
          text: `${link}\n\n链接一次有效，${until} 过期。\n`,
        }
      : {
          subject: "Armadra invitation",
          text: `${link}\n\nThis link works once and expires at ${until}.\n`,
        };
  }
  return locale === "zh"
    ? {
        subject: "Armadra 口令重置",
        text: `${link}\n\n链接一次有效，${until} 过期。\n`,
      }
    : {
        subject: "Armadra password reset",
        text: `${link}\n\nThis link works once and expires at ${until}.\n`,
      };
}

/** 链接的片段：与页面认的 `#invite=` / `#reset=` 同一个拼法。 */
export function linkFor(kind: LinkKind, origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/#${kind === "invitation" ? "invite" : "reset"}=${token}`;
}

export interface MailConfiguration {
  readonly from: string;
  readonly send: MailSender;
  /** 链接的来源（Gateway 的对外来源），每封现取。 */
  readonly origin: () => string;
}

export class MailRateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super("mail rate limited");
    this.name = "MailRateLimited";
  }
}

export class MailNotConfigured extends Error {
  constructor() {
    super("mail is not configured");
    this.name = "MailNotConfigured";
  }
}

export class MailSendFailed extends Error {
  constructor() {
    super("mail send failed");
    this.name = "MailSendFailed";
  }
}

export interface SendRequest {
  readonly actor: AuthorizationSubject;
  readonly kind: LinkKind;
  /** 邀请 id 或被重置的人。 */
  readonly id: string;
  readonly token: string;
  readonly to: string;
  readonly locale: MailLocale;
  /** 限流的桶：来源地址。 */
  readonly source: string;
}

export class MailService {
  private configuration: MailConfiguration | undefined;
  private readonly sent = new Map<string, number[]>();

  constructor(
    private readonly checks: LinkChecks,
    private readonly options: {
      readonly clock?: () => number;
      readonly warn?: (
        message: string,
        fields: Record<string, unknown>,
      ) => void;
    } = {},
  ) {}

  /** 壳配好 SMTP 之后交进来；`undefined` = 撤掉。 */
  configure(configuration: MailConfiguration | undefined): void {
    this.configuration = configuration;
  }

  status(): { configured: boolean; from: string | null } {
    return this.configuration === undefined
      ? { configured: false, from: null }
      : { configured: true, from: this.configuration.from };
  }

  supports(kind: LinkKind): boolean {
    return kind === "invitation" || this.checks.passwordReset !== undefined;
  }

  async send(request: SendRequest): Promise<void> {
    const configuration = this.configuration;
    if (configuration === undefined) throw new MailNotConfigured();
    // 先核对链接，再扣限流：一个打错 id 的人不该把自己这一分钟的额度用光。
    const { expiresAtMs } =
      request.kind === "invitation"
        ? this.checks.invitation(request.actor, {
            invitationId: request.id,
            token: request.token,
          })
        : (
            this.checks.passwordReset as NonNullable<
              LinkChecks["passwordReset"]
            >
          )(request.actor, { principalId: request.id, token: request.token });
    this.take(request.source);
    const message = compose(
      request.kind,
      request.locale,
      linkFor(request.kind, configuration.origin(), request.token),
      expiresAtMs,
    );
    const action =
      request.kind === "invitation"
        ? "mail.invitation.send"
        : "mail.password-reset.send";
    const toHash = addressDigest(request.to);
    try {
      await configuration.send({
        from: configuration.from,
        to: request.to,
        ...message,
      });
    } catch (error) {
      // 错误文字可能带服务器的答复；不带口令（nodemailer 不回显 AUTH 那一行），
      // 但收件地址可能在里面，所以日志只记错误的名字与代码。
      this.options.warn?.("邮件发送失败", {
        kind: request.kind,
        error: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: unknown })?.code ?? "",
      });
      audit({
        action,
        principalId: request.actor.principalId,
        target: request.id,
        detail: { toHash, delivered: false },
      });
      throw new MailSendFailed();
    }
    audit({
      action,
      principalId: request.actor.principalId,
      target: request.id,
      detail: { toHash, delivered: true },
    });
  }

  private take(source: string): void {
    const now = (this.options.clock ?? Date.now)();
    const recent = (this.sent.get(source) ?? []).filter(
      (at) => now - at < RATE_LIMIT.windowMs,
    );
    if (recent.length >= RATE_LIMIT.count) {
      this.sent.set(source, recent);
      throw new MailRateLimited(
        RATE_LIMIT.windowMs - (now - (recent[0] as number)),
      );
    }
    recent.push(now);
    this.sent.set(source, recent);
    // 表只留还在窗口里的来源，免得一夜的扫描把它撑大。
    if (this.sent.size > 1024) {
      for (const [key, stamps] of this.sent) {
        if (stamps.every((at) => now - at >= RATE_LIMIT.windowMs)) {
          this.sent.delete(key);
        }
      }
    }
  }
}
