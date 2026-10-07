/**
 * SMTP 配置与发送（外部服务 §7.5、契约 §28）。
 *
 * 配置是一行地址：`smtp(s)://user:pass@host:port`。口令部分可以写成
 * `secret://armadra-smtp`——那时口令在这台 core 的密钥后端里（服务器壳用
 * `armadra-server secrets set armadra-smtp` 写进去），命令行、服务定义与进程表
 * 里都看不到它。每封信现取一次，换了口令不必重启。
 *
 * `smtp://` 走 STARTTLS：主机不是回环时**要求**升级（服务器不给就失败，口令不在
 * 明文上走），`?requireTLS=false` 才放开——那是给内网里没有 TLS 的中继留的。
 * `smtps://` 一开始就是 TLS（缺省端口 465）。
 *
 * nodemailer 在第一封信时才加载：桌面壳从不配邮件，不该为它多加载一个模块。
 */

import { isIP } from "node:net";

/** 解析好的配置。口令只有引用或「有没有」，明文不在这个对象上。 */
export interface SmtpSettings {
  readonly secure: boolean;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** 口令从哪来：没有、内联（在 {@link SmtpConfig.inlinePassword}）、密钥后端。 */
  readonly password: "none" | "inline" | { readonly secret: string };
  readonly requireTls: boolean;
  /** 发件人地址（`ARMADRA_SMTP_FROM` / `--smtp-from`，缺省是用户名）。 */
  readonly from: string;
}

export interface SmtpConfig {
  readonly settings: SmtpSettings;
  /** 地址里直接写的口令；`settings.password === "inline"` 时才有。 */
  readonly inlinePassword: string;
}

export type SmtpParse =
  | { readonly ok: true; readonly config: SmtpConfig }
  | { readonly ok: false; readonly reason: string };

const SECRET_REFERENCE = /^secret:\/\/(armadra-[A-Za-z0-9._@-]{1,200})$/;

/** 一个收件 / 发件地址：没有空白、尖括号与换行（头注入）。 */
const ADDRESS =
  /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export function validAddress(value: string): boolean {
  return value.length <= 254 && ADDRESS.test(value) && !value.includes("..");
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function loopback(host: string): boolean {
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return host === "::1";
}

/**
 * 解析 `ARMADRA_SMTP_URL`。不用 `URL`：`secret://…` 放在口令位置上本身含 `//`，
 * 按 WHATWG 规则会把主机切错。用户信息取到**最后一个** `@` 为止。
 */
export function parseSmtpUrl(raw: string, fromOption = ""): SmtpParse {
  const text = raw.trim();
  const matched = /^(smtps?):\/\/(?:(.*)@)?([^@/?#]+)\/?(?:\?([^#]*))?$/i.exec(
    text,
  );
  if (matched === null) {
    return {
      ok: false,
      reason: "SMTP 地址要写成 smtp(s)://用户:口令@主机:端口",
    };
  }
  const secure = (matched[1] as string).toLowerCase() === "smtps";
  const userinfo = matched[2] ?? "";
  const hostPort = matched[3] as string;
  const query = new URLSearchParams(matched[4] ?? "");

  let host: string;
  let portText = "";
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return { ok: false, reason: "SMTP 主机的 IPv6 写法不对" };
    host = hostPort.slice(1, close);
    const rest = hostPort.slice(close + 1);
    if (rest !== "" && !rest.startsWith(":")) {
      return { ok: false, reason: "SMTP 主机的 IPv6 写法不对" };
    }
    portText = rest.slice(1);
  } else {
    const colon = hostPort.lastIndexOf(":");
    host = colon < 0 ? hostPort : hostPort.slice(0, colon);
    portText = colon < 0 ? "" : hostPort.slice(colon + 1);
  }
  if (host === "" || !/^[A-Za-z0-9.:-]+$/.test(host)) {
    return { ok: false, reason: "SMTP 主机名不对" };
  }
  const port = portText === "" ? (secure ? 465 : 587) : Number(portText);
  if (!/^\d{0,5}$/.test(portText) || port < 1 || port > 65535) {
    return { ok: false, reason: "SMTP 端口不对" };
  }

  let user = "";
  let password: SmtpSettings["password"] = "none";
  let inlinePassword = "";
  if (userinfo !== "") {
    const colon = userinfo.indexOf(":");
    const userPart = colon < 0 ? userinfo : userinfo.slice(0, colon);
    const passPart = colon < 0 ? "" : userinfo.slice(colon + 1);
    const decodedUser = decode(userPart);
    if (decodedUser === undefined || /[\r\n]/.test(decodedUser)) {
      return { ok: false, reason: "SMTP 用户名编码不对" };
    }
    user = decodedUser;
    if (passPart !== "") {
      const reference = SECRET_REFERENCE.exec(passPart);
      if (reference !== null) {
        password = { secret: reference[1] as string };
      } else if (passPart.startsWith("secret://")) {
        return {
          ok: false,
          reason: "密钥引用要写成 secret://armadra-名字",
        };
      } else {
        const decodedPass = decode(passPart);
        if (decodedPass === undefined) {
          return { ok: false, reason: "SMTP 口令编码不对" };
        }
        password = "inline";
        inlinePassword = decodedPass;
      }
    }
  }

  const tlsOption = (query.get("requireTLS") ?? "").toLowerCase();
  if (tlsOption !== "" && tlsOption !== "true" && tlsOption !== "false") {
    return { ok: false, reason: "requireTLS 只能是 true 或 false" };
  }
  const requireTls = secure
    ? false
    : tlsOption === ""
      ? !loopback(host)
      : tlsOption === "true";

  const from = fromOption.trim() !== "" ? fromOption.trim() : user;
  if (!validAddress(from)) {
    return {
      ok: false,
      reason:
        fromOption.trim() === ""
          ? "用户名不是邮箱地址：给 --smtp-from / ARMADRA_SMTP_FROM"
          : "发件人地址不对",
    };
  }

  return {
    ok: true,
    config: {
      settings: {
        secure,
        host,
        port,
        user,
        password,
        requireTls,
        from,
      },
      inlinePassword,
    },
  };
}

/* --------------------------------- 发送 ---------------------------------- */

export interface MailMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** 发一封信；失败抛错（错误文字不带口令，见 {@link smtpSender}）。 */
export type MailSender = (message: MailMessage) => Promise<void>;

/** 口令不在时（密钥后端里没有那个条目）。 */
export class SmtpPasswordMissing extends Error {
  constructor(readonly secret: string) {
    super(`SMTP password secret ${secret} is not set`);
    this.name = "SmtpPasswordMissing";
  }
}

/**
 * 按配置经 nodemailer 发。每封信建一次连接：量只有邀请与重置，连接池只会让一个
 * 换过口令的进程拿着旧连接。
 */
export function smtpSender(
  config: SmtpConfig,
  secret: (name: string) => Promise<string | undefined>,
): MailSender {
  const settings = config.settings;
  return async (message) => {
    let pass = "";
    if (settings.password === "inline") pass = config.inlinePassword;
    else if (settings.password !== "none") {
      const name = settings.password.secret;
      const value = await secret(name);
      if (value === undefined) throw new SmtpPasswordMissing(name);
      pass = value;
    }
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      requireTLS: settings.requireTls,
      ...(settings.user === "" ? {} : { auth: { user: settings.user, pass } }),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      // 不往日志写协议对话：里面有 AUTH 那一行。
      logger: false,
      debug: false,
    });
    try {
      await transport.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        // 不带 X-Mailer 之类的指纹头。
        xMailer: false,
      });
    } finally {
      transport.close();
    }
  };
}
