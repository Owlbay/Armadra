import type { MessageModule } from "./index";

/**
 * 邮件通道：邀请与重置链接的「发送邮件」（G5-03 / G5-13，契约 §28）。
 *
 * G5-00 先登记空模块，免得各包同时改 `index.ts`；键由实现它的包填，两种语言
 * 同步加。
 */
export const mail: MessageModule = {
  "zh-CN": {
    "mail.send": "发送邮件",
    "mail.to": "邮箱地址",
    "mail.sent": "已发送",
    "mail.error.mail_not_configured": "这台服务器没有配置邮件",
    "mail.error.link_invalid": "链接已失效，请重新签发",
    "mail.error.rate_limited": "发得太频繁，稍后再试",
    "mail.error.mail_send_failed": "邮件没有发出去",
    "mail.error.bad_request": "邮箱地址不对",
  },
  en: {
    "mail.send": "Send email",
    "mail.to": "Email address",
    "mail.sent": "Sent",
    "mail.error.mail_not_configured": "Email isn't configured on this server",
    "mail.error.link_invalid": "This link is no longer valid. Issue a new one",
    "mail.error.rate_limited": "Too many emails. Try again shortly",
    "mail.error.mail_send_failed": "The email wasn't sent",
    "mail.error.bad_request": "That email address isn't valid",
  },
};
