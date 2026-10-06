import { z } from "zod";

import { currentClient } from "./client";
import { RUNTIME_VIA_SERVER_SHELL, RuntimeRequestError } from "./request";

/**
 * 邮件通道（契约 §43.5，形状见 §28），经 `mail.*` procedure：把刚签出的邀请 / 重置链接发到一个邮箱。只有服务器壳
 * 能配 SMTP；桌面壳与不认识这条路由的旧 core 都按「没配」处理，页面就不摆
 * 「发送邮件」。
 */
const statusSchema = z.object({
  configured: z.boolean(),
  from: z.string().nullable().default(null),
});

const sentSchema = z.object({ sent: z.boolean() });

export type MailLocale = "zh" | "en";

/** 配没配 SMTP。404（旧 core）与问不到都算没配。 */
export async function mailConfigured(
  server: boolean = RUNTIME_VIA_SERVER_SHELL,
): Promise<boolean> {
  if (!server) return false;
  try {
    return statusSchema.parse(await currentClient().mail.status()).configured;
  } catch (error) {
    if (error instanceof RuntimeRequestError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

/** 把重置链接发出去；令牌是刚签出的那一枚（库里只有哈希）。 */
export async function mailPasswordReset(input: {
  principalId: string;
  token: string;
  to: string;
  locale?: MailLocale;
}): Promise<void> {
  sentSchema.parse(await currentClient().mail.sendPasswordReset(input));
}

/** 把邀请链接发出去。 */
export async function mailInvitation(input: {
  invitationId: string;
  token: string;
  to: string;
  locale?: MailLocale;
}): Promise<void> {
  sentSchema.parse(await currentClient().mail.sendInvitation(input));
}

/** 页面语言 → 邮件语言。 */
export function mailLocaleOf(locale: string): MailLocale {
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}
