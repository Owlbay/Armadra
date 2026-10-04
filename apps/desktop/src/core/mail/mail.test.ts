import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import { Router, emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import { AccountsService } from "../identity/accounts";
import {
  type AuditEvent,
  installAuditSink,
  resetAuditSink,
} from "../identity/audit";
import type { AuthorizationSubject } from "../identity/authorize";
import { type RequestIdentity, runAs } from "../identity/gate";
import { scope } from "../identity/scopes";
import { IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import { tempDir } from "../testing/temp-dir";
import { startFakeSmtp } from "./fake-smtp.fixture";
import { linkChecks } from "./index";
import { MAIL_ROUTES, installRoutes } from "./routes";
import {
  MailService,
  RATE_LIMIT,
  addressDigest,
  compose,
  linkFor,
  mailLocale,
} from "./service";
import {
  type MailMessage,
  type MailSender,
  SmtpPasswordMissing,
  parseSmtpUrl,
  smtpSender,
  validAddress,
} from "./smtp";

/**
 * 邮件通道（契约 §28）：配置解析、正文只有链接与过期时间、只有能签那条链接的
 * 人能发、地址不进审计明文、限流；发送走 nodemailer 的 stream transport（看真
 * MIME）与进程内的假 SMTP（看 AUTH 与密钥引用）。Mailpit 那条在
 * `mail.devstack.integration.test.ts`。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const INSTANCE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://armadra.example.test";

const closing: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  resetAuditSink();
  for (const close of closing.splice(0)) await close();
});

/* --------------------------------- 配置 ---------------------------------- */

describe("ARMADRA_SMTP_URL", () => {
  it("smtps 缺省 465、smtp 缺省 587，口令按百分号解码", () => {
    const secure = parseSmtpUrl(
      "smtps://bot%40example.com:p%40ss@mail.example.com",
    );
    expect(secure.ok && secure.config.settings).toMatchObject({
      secure: true,
      host: "mail.example.com",
      port: 465,
      user: "bot@example.com",
      password: "inline",
      requireTls: false,
      from: "bot@example.com",
    });
    expect(secure.ok && secure.config.inlinePassword).toBe("p@ss");
    const plain = parseSmtpUrl(
      "smtp://relay.example.com",
      "noreply@example.com",
    );
    expect(plain.ok && plain.config.settings).toMatchObject({
      secure: false,
      port: 587,
      user: "",
      password: "none",
      requireTls: true,
      from: "noreply@example.com",
    });
  });

  it("口令可以是密钥引用，明文不在配置上", () => {
    const parsed = parseSmtpUrl(
      "smtps://bot@example.com:secret://armadra-smtp@mail.example.com:2465",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.settings.password).toEqual({ secret: "armadra-smtp" });
    expect(parsed.config.settings.host).toBe("mail.example.com");
    expect(parsed.config.settings.port).toBe(2465);
    expect(parsed.config.inlinePassword).toBe("");
    expect(
      parseSmtpUrl("smtps://u@x.com:secret://smtp@mail.example.com").ok,
    ).toBe(false);
  });

  it("回环不强制 STARTTLS，别的主机强制；requireTLS 可以显式改", () => {
    const local = parseSmtpUrl("smtp://127.0.0.1:1025", "a@b.test");
    expect(local.ok && local.config.settings.requireTls).toBe(false);
    const ipv6 = parseSmtpUrl("smtp://[::1]:1025", "a@b.test");
    expect(ipv6.ok && ipv6.config.settings).toMatchObject({
      host: "::1",
      port: 1025,
      requireTls: false,
    });
    const relaxed = parseSmtpUrl(
      "smtp://relay.lan:25?requireTLS=false",
      "a@b.test",
    );
    expect(relaxed.ok && relaxed.config.settings.requireTls).toBe(false);
    expect(
      parseSmtpUrl("smtp://relay.lan?requireTLS=maybe", "a@b.test").ok,
    ).toBe(false);
  });

  it("拒绝的写法", () => {
    for (const bad of [
      "",
      "http://mail.example.com",
      "smtp://",
      "smtp://mail.example.com:99999",
      "smtp://mail.example.com:abc",
      "smtp://bad host",
    ]) {
      expect(parseSmtpUrl(bad, "a@b.test").ok, bad).toBe(false);
    }
    // 用户名不是地址又没给发件人。
    expect(parseSmtpUrl("smtp://apikey:x@mail.example.com").ok).toBe(false);
    expect(parseSmtpUrl("smtp://mail.example.com", "not an address").ok).toBe(
      false,
    );
  });

  it("地址校验挡掉头注入", () => {
    expect(validAddress("someone@example.com")).toBe(true);
    expect(validAddress("someone@example.com\r\nBcc: x@y.z")).toBe(false);
    expect(validAddress("Some One <someone@example.com>")).toBe(false);
    expect(validAddress("a@b..c")).toBe(false);
  });
});

/* --------------------------------- 正文 ---------------------------------- */

describe("正文", () => {
  it("只有链接与过期时间，中英两种", () => {
    const at = Date.UTC(2026, 9, 11, 8, 0);
    const zh = compose("invitation", "zh", "https://h/#invite=t", at);
    expect(zh.subject).toBe("Armadra 邀请");
    expect(zh.text).toBe(
      "https://h/#invite=t\n\n链接一次有效，2026-10-11 08:00 UTC 过期。\n",
    );
    const en = compose("passwordReset", "en", "https://h/#reset=t", at);
    expect(en.subject).toBe("Armadra password reset");
    expect(en.text).toContain("https://h/#reset=t");
    expect(en.text).toContain("2026-10-11 08:00 UTC");
  });

  it("链接与页面认的片段同一个拼法；语言按请求体、再按 Accept-Language", () => {
    expect(linkFor("invitation", "https://h/", "a.b")).toBe(
      "https://h/#invite=a.b",
    );
    expect(linkFor("passwordReset", "https://h", "a.b")).toBe(
      "https://h/#reset=a.b",
    );
    expect(mailLocale("zh", "en-US")).toBe("zh");
    expect(mailLocale("zh-CN", undefined)).toBe("zh");
    expect(mailLocale(undefined, "zh-CN,zh;q=0.9")).toBe("zh");
    expect(mailLocale(undefined, "fr")).toBe("en");
  });

  it("地址指纹不分大小写、不是地址本身", () => {
    const digest = addressDigest("Someone@Example.com");
    expect(digest).toBe(addressDigest(" someone@example.com "));
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
    expect(digest).not.toContain("example");
  });
});

/* ------------------------------ 路由与判定 -------------------------------- */

let clock = 1_800_000_000_000;

function harness(options: { sender?: MailSender; configured?: boolean } = {}) {
  const directory = tempDir("armadra-mail-");
  const opened = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  clock = 1_800_000_000_000;
  const store = new IdentityStore(opened.database);
  const service = new IdentityService(store, INSTANCE, () => clock);
  const accounts = new AccountsService({ store, clock: () => clock });
  const ticket = service.issueBootstrap({
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: "http://127.0.0.1:1420",
    deviceName: "本机桌面",
    scopes: [scope("identity:manage"), scope("identity:read")],
  });
  const paired = service.consumeBootstrap({
    ticket: ticket.ticket,
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: "http://127.0.0.1:1420",
  });
  const owner: AuthorizationSubject = {
    principalId: paired.principal.principalId,
    kind: "owner",
    scopes: paired.principal.scopes,
  };

  const events: AuditEvent[] = [];
  installAuditSink((event) => events.push(event));
  const outbox: MailMessage[] = [];
  const mail = new MailService(linkChecks(accounts), { clock: () => clock });
  if (options.configured !== false) {
    mail.configure({
      from: "noreply@armadra.example.test",
      origin: () => ORIGIN,
      send:
        options.sender ??
        (async (message) => {
          outbox.push(message);
        }),
    });
  }
  const router = new Router();
  installRoutes({ router } as unknown as CoreServer, mail);

  const call = async (
    who: AuthorizationSubject | undefined,
    method: string,
    path: string,
    body?: unknown,
    source = "203.0.113.7",
  ) => {
    const request = {
      ...emptyRequest(method, path),
      headers: { "accept-language": "zh-CN" },
      raw: { socket: { remoteAddress: source } } as never,
      json: <T>() => {
        if (body === "not json") throw new SyntaxError("bad");
        return body as T;
      },
    };
    const run = () => router.dispatch(method, path, request);
    const identity: RequestIdentity | undefined =
      who === undefined ? undefined : { subject: who };
    const answer = await (identity === undefined
      ? run()
      : runAs(identity, run));
    return answer as {
      status: number;
      body: any;
      headers?: Record<string, string>;
    };
  };

  const member = (name: string): AuthorizationSubject => {
    const created = accounts.createPrincipal(owner, { displayName: name });
    return { principalId: created.principalId, kind: "member", scopes: [] };
  };

  return { accounts, owner, mail, call, events, outbox, member };
}

describe("/api/mail/status", () => {
  it("没配时 configured=false；配了报发件人；匿名 401", async () => {
    const off = harness({ configured: false });
    expect(await off.call(off.owner, "GET", MAIL_ROUTES.status)).toMatchObject({
      status: 200,
      body: { configured: false, from: null },
    });
    const on = harness();
    expect(await on.call(on.owner, "GET", MAIL_ROUTES.status)).toMatchObject({
      status: 200,
      body: { configured: true, from: "noreply@armadra.example.test" },
    });
    const anonymous = await on.call(
      { principalId: "", kind: "member", scopes: [] },
      "GET",
      MAIL_ROUTES.status,
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe("unauthenticated");
  });
});

describe("POST /api/mail/invitation", () => {
  it("owner 发：正文只有链接与过期时间，审计只有地址指纹", async () => {
    const h = harness();
    const issued = h.accounts.issueInvitation(h.owner, {
      role: "viewer",
      targetWorkspaceId: "default",
    });
    const answer = await h.call(h.owner, "POST", MAIL_ROUTES.invitation, {
      invitationId: issued.invitationId,
      token: issued.token,
      to: "New.Person@example.com",
    });
    expect(answer).toMatchObject({ status: 200, body: { sent: true } });
    expect(h.outbox).toHaveLength(1);
    const message = h.outbox[0] as MailMessage;
    expect(message.from).toBe("noreply@armadra.example.test");
    expect(message.to).toBe("New.Person@example.com");
    // Accept-Language 是 zh-CN。
    expect(message.subject).toBe("Armadra 邀请");
    expect(message.text).toBe(
      `${ORIGIN}/#invite=${issued.token}\n\n链接一次有效，${new Date(issued.expiresAtMs).toISOString().slice(0, 16).replace("T", " ")} UTC 过期。\n`,
    );
    const sent = h.events.filter(
      (event) => event.action === "mail.invitation.send",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toBe(issued.invitationId);
    expect(sent[0]?.detail).toEqual({
      toHash: addressDigest("new.person@example.com"),
      delivered: true,
    });
    expect(JSON.stringify(h.events)).not.toContain("example.com");
    expect(JSON.stringify(h.events)).not.toContain(issued.token);
  });

  it("请求体里的 locale 优先", async () => {
    const h = harness();
    const issued = h.accounts.issueInvitation(h.owner, {
      role: "viewer",
      targetWorkspaceId: "default",
    });
    await h.call(h.owner, "POST", MAIL_ROUTES.invitation, {
      invitationId: issued.invitationId,
      token: issued.token,
      to: "a@example.com",
      locale: "en",
    });
    expect(h.outbox[0]?.subject).toBe("Armadra invitation");
  });

  it("组 admin 能发指向自己组的邀请；普通成员 403", async () => {
    const h = harness();
    const group = h.accounts.createGroup(h.owner, "研发");
    const lead = h.member("组长");
    h.accounts.putGroupMember(
      h.owner,
      group.groupId,
      lead.principalId,
      "admin",
    );
    const issued = h.accounts.issueInvitation(lead, {
      role: "viewer",
      targetGroupId: group.groupId,
    });
    expect(
      (
        await h.call(lead, "POST", MAIL_ROUTES.invitation, {
          invitationId: issued.invitationId,
          token: issued.token,
          to: "a@example.com",
        })
      ).status,
    ).toBe(200);
    const stranger = h.member("路人");
    const refused = await h.call(stranger, "POST", MAIL_ROUTES.invitation, {
      invitationId: issued.invitationId,
      token: issued.token,
      to: "a@example.com",
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("forbidden");
    // 指向工作空间的邀请要 `workspace:share`，组 admin 没有。
    const shared = h.accounts.issueInvitation(h.owner, {
      role: "viewer",
      targetWorkspaceId: "default",
    });
    expect(
      (
        await h.call(lead, "POST", MAIL_ROUTES.invitation, {
          invitationId: shared.invitationId,
          token: shared.token,
          to: "a@example.com",
        })
      ).status,
    ).toBe(403);
    expect(h.outbox).toHaveLength(1);
  });

  it("令牌不对、用过、过期：409 link_invalid；不存在 404；不发信", async () => {
    const h = harness();
    const issued = h.accounts.issueInvitation(h.owner, {
      role: "viewer",
      targetWorkspaceId: "default",
      ttlMs: 60_000,
    });
    const forged = `${issued.invitationId}.${"A".repeat(43)}`;
    const wrong = await h.call(h.owner, "POST", MAIL_ROUTES.invitation, {
      invitationId: issued.invitationId,
      token: forged,
      to: "a@example.com",
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe("link_invalid");

    const other = h.accounts.issueInvitation(h.owner, {
      role: "viewer",
      targetWorkspaceId: "default",
    });
    h.accounts.revokeInvitation(h.owner, other.invitationId);
    expect(
      (
        await h.call(h.owner, "POST", MAIL_ROUTES.invitation, {
          invitationId: other.invitationId,
          token: other.token,
          to: "a@example.com",
        })
      ).body.code,
    ).toBe("link_invalid");

    clock += 61_000;
    expect(
      (
        await h.call(h.owner, "POST", MAIL_ROUTES.invitation, {
          invitationId: issued.invitationId,
          token: issued.token,
          to: "a@example.com",
        })
      ).body.code,
    ).toBe("link_invalid");

    const missing = "f".repeat(32);
    const absent = await h.call(h.owner, "POST", MAIL_ROUTES.invitation, {
      invitationId: missing,
      token: `${missing}.${"A".repeat(43)}`,
      to: "a@example.com",
    });
    expect(absent.status).toBe(404);
    expect(h.outbox).toHaveLength(0);
  });

  it("请求体不对 400；没配置 409；匿名 401", async () => {
    const h = harness();
    const issued = h.accounts.issueInvitation(h.owner, {
      role: "viewer",
      targetWorkspaceId: "default",
    });
    for (const body of [
      "not json",
      [],
      { invitationId: "x", token: issued.token, to: "a@example.com" },
      { invitationId: issued.invitationId, token: "x", to: "a@example.com" },
      { invitationId: issued.invitationId, token: issued.token, to: "nobody" },
      {
        invitationId: issued.invitationId,
        token: issued.token,
        to: "a@example.com\r\nBcc: b@example.com",
      },
    ]) {
      const answer = await h.call(
        h.owner,
        "POST",
        MAIL_ROUTES.invitation,
        body,
      );
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    const off = harness({ configured: false });
    const again = off.accounts.issueInvitation(off.owner, {
      role: "viewer",
      targetWorkspaceId: "default",
    });
    const unconfigured = await off.call(
      off.owner,
      "POST",
      MAIL_ROUTES.invitation,
      {
        invitationId: again.invitationId,
        token: again.token,
        to: "a@example.com",
      },
    );
    expect(unconfigured.status).toBe(409);
    expect(unconfigured.body.code).toBe("mail_not_configured");
    expect(
      (
        await h.call(
          { principalId: "", kind: "member", scopes: [] },
          "POST",
          MAIL_ROUTES.invitation,
          {
            invitationId: issued.invitationId,
            token: issued.token,
            to: "a@example.com",
          },
        )
      ).status,
    ).toBe(401);
  });

  it("每来源每分钟 5 封，第 6 封 429 带 Retry-After；别的来源不受影响", async () => {
    const h = harness();
    const issued = h.accounts.issueInvitation(h.owner, {
      role: "viewer",
      targetWorkspaceId: "default",
    });
    const body = {
      invitationId: issued.invitationId,
      token: issued.token,
      to: "a@example.com",
    };
    for (let index = 0; index < RATE_LIMIT.count; index += 1) {
      expect(
        (await h.call(h.owner, "POST", MAIL_ROUTES.invitation, body)).status,
      ).toBe(200);
    }
    clock += 20_000;
    const limited = await h.call(h.owner, "POST", MAIL_ROUTES.invitation, body);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(limited.headers?.["retry-after"]).toBe("40");
    expect(
      (
        await h.call(
          h.owner,
          "POST",
          MAIL_ROUTES.invitation,
          body,
          "198.51.100.2",
        )
      ).status,
    ).toBe(200);
    clock += 40_001;
    expect(
      (await h.call(h.owner, "POST", MAIL_ROUTES.invitation, body)).status,
    ).toBe(200);
  });

  it("SMTP 失败：502，审计记 delivered=false，错误里没有地址", async () => {
    const h = harness({
      sender: async () => {
        throw Object.assign(new Error("550 a@example.com rejected"), {
          code: "EENVELOPE",
        });
      },
    });
    const issued = h.accounts.issueInvitation(h.owner, {
      role: "viewer",
      targetWorkspaceId: "default",
    });
    const answer = await h.call(h.owner, "POST", MAIL_ROUTES.invitation, {
      invitationId: issued.invitationId,
      token: issued.token,
      to: "a@example.com",
    });
    expect(answer.status).toBe(502);
    expect(answer.body).toEqual({
      code: "mail_send_failed",
      message: expect.any(String),
    });
    expect(JSON.stringify(answer.body)).not.toContain("example.com");
    expect(
      h.events.find((event) => event.action === "mail.invitation.send")?.detail,
    ).toMatchObject({
      delivered: false,
    });
  });
});

describe("POST /api/mail/password-reset", () => {
  it("接到身份域：owner 发刚签的链接，正文是 #reset=，审计只有指纹", async () => {
    const h = harness();
    const target = h.member("同事");
    const issued = h.accounts.issuePasswordReset(h.owner, target.principalId);
    const answer = await h.call(h.owner, "POST", MAIL_ROUTES.passwordReset, {
      principalId: target.principalId,
      token: issued.token,
      to: "colleague@example.com",
    });
    expect(answer).toMatchObject({ status: 200, body: { sent: true } });
    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0]?.subject).toBe("Armadra 口令重置");
    expect(h.outbox[0]?.text).toContain(`${ORIGIN}/#reset=${issued.token}`);
    const sent = h.events.filter(
      (event) => event.action === "mail.password-reset.send",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toBe(target.principalId);
    expect(JSON.stringify(h.events)).not.toContain(issued.token);
    expect(JSON.stringify(h.events)).not.toContain("example.com");
  });

  it("令牌不是这个人的、已用过或认不出：409 link_invalid，不发信", async () => {
    const h = harness();
    const first = h.member("甲");
    const second = h.member("乙");
    const issued = h.accounts.issuePasswordReset(h.owner, first.principalId);
    const send = (principalId: string, token: string) =>
      h.call(h.owner, "POST", MAIL_ROUTES.passwordReset, {
        principalId,
        token,
        to: "a@example.com",
      });
    const crossed = await send(second.principalId, issued.token);
    expect(crossed.status).toBe(409);
    expect(crossed.body.code).toBe("link_invalid");
    const forged = await send(
      first.principalId,
      `${"0".repeat(32)}.${"A".repeat(43)}`,
    );
    expect(forged.status).toBe(409);
    // 签新的作废旧的。
    h.accounts.issuePasswordReset(h.owner, first.principalId);
    const superseded = await send(first.principalId, issued.token);
    expect(superseded.status).toBe(409);
    expect(h.outbox).toHaveLength(0);
  });

  it("不能签这条链接的人 403；没有这个人 404", async () => {
    const h = harness();
    const target = h.member("丙");
    const bystander = h.member("路人");
    const issued = h.accounts.issuePasswordReset(h.owner, target.principalId);
    const refused = await h.call(
      bystander,
      "POST",
      MAIL_ROUTES.passwordReset,
      { principalId: target.principalId, token: issued.token, to: "a@x.test" },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("forbidden");
    const missing = await h.call(h.owner, "POST", MAIL_ROUTES.passwordReset, {
      principalId: "f".repeat(32),
      token: issued.token,
      to: "a@x.test",
    });
    expect(missing.status).toBe(404);
    expect(h.outbox).toHaveLength(0);
  });

  it("有核对时按它判：链接指向 #reset=，主题是口令重置", async () => {
    const outbox: MailMessage[] = [];
    const seen: unknown[] = [];
    const mail = new MailService({
      invitation: () => {
        throw new Error("unused");
      },
      passwordReset: (actor, input) => {
        seen.push({ actor: actor.principalId, ...input });
        return { expiresAtMs: Date.UTC(2026, 9, 5, 12, 0) };
      },
    });
    mail.configure({
      from: "noreply@x.test",
      origin: () => ORIGIN,
      send: async (message) => {
        outbox.push(message);
      },
    });
    const router = new Router();
    installRoutes({ router } as unknown as CoreServer, mail);
    const principalId = "a".repeat(32);
    const token = `${"b".repeat(32)}.${"C".repeat(43)}`;
    const answer = (await router.dispatch("POST", MAIL_ROUTES.passwordReset, {
      ...emptyRequest("POST", MAIL_ROUTES.passwordReset),
      raw: { socket: { remoteAddress: "127.0.0.1" } } as never,
      json: <T>() => ({ principalId, token, to: "a@x.test" }) as T,
    })) as { status: number };
    expect(answer.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(outbox[0]?.subject).toBe("Armadra password reset");
    expect(outbox[0]?.text).toContain(`${ORIGIN}/#reset=${token}`);
    expect(outbox[0]?.text).toContain("2026-10-05 12:00 UTC");
  });
});

/* -------------------------------- 真发送 --------------------------------- */

describe("nodemailer 组出来的信", () => {
  it("stream transport：头只有收发件人与主题，正文解出来就是那两行", async () => {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "unix",
    });
    const text = compose(
      "invitation",
      "zh",
      `${ORIGIN}/#invite=${"a".repeat(32)}.${"B".repeat(43)}`,
      Date.UTC(2026, 9, 11, 8, 0),
    ).text;
    const info = await transport.sendMail({
      from: "noreply@x.test",
      to: "a@x.test",
      subject: "Armadra 邀请",
      text,
      xMailer: false,
    });
    const raw = (info.message as Buffer).toString("utf8");
    const [head, ...rest] = raw.split("\n\n");
    expect(head).toMatch(/^From: noreply@x\.test$/m);
    expect(head).toMatch(/^To: a@x\.test$/m);
    expect(head).not.toMatch(/^X-Mailer/m);
    const body = rest.join("\n\n");
    const decoded = /Content-Transfer-Encoding: base64/i.test(head as string)
      ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")
      : Buffer.from(
          body
            .replace(/=\r?\n/g, "")
            .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
              String.fromCharCode(Number.parseInt(hex, 16)),
            ),
          "latin1",
        ).toString("utf8");
    expect(decoded.replace(/\r\n/g, "\n")).toBe(text);
  });
});

async function fakeSmtp(options: { rejectAuth?: boolean } = {}) {
  const smtp = await startFakeSmtp(options);
  closing.push(smtp.close);
  return smtp;
}

describe("smtpSender", () => {
  it("口令引用在发信时从密钥后端取，AUTH 带的是它", async () => {
    const smtp = await fakeSmtp();
    const parsed = parseSmtpUrl(
      `smtp://bot@x.test:secret://armadra-smtp@127.0.0.1:${smtp.port}`,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const asked: string[] = [];
    const send = smtpSender(parsed.config, async (name) => {
      asked.push(name);
      return "s3cret";
    });
    await send({
      from: "bot@x.test",
      to: "a@x.test",
      subject: "Armadra 邀请",
      text: "https://h/#invite=t\n",
    });
    expect(asked).toEqual(["armadra-smtp"]);
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0]?.auth).toBe("\0bot@x.test\0s3cret");
    expect(smtp.received[0]?.from).toContain("<bot@x.test>");
    expect(smtp.received[0]?.to).toEqual(["RCPT TO:<a@x.test>"]);
    expect(smtp.received[0]?.data).toContain("Subject: =?UTF-8?");
  });

  it("引用的条目不在：不连服务器，抛 SmtpPasswordMissing", async () => {
    const smtp = await fakeSmtp();
    const parsed = parseSmtpUrl(
      `smtp://bot@x.test:secret://armadra-smtp@127.0.0.1:${smtp.port}`,
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    const send = smtpSender(parsed.config, async () => undefined);
    await expect(
      send({ from: "bot@x.test", to: "a@x.test", subject: "s", text: "t" }),
    ).rejects.toBeInstanceOf(SmtpPasswordMissing);
    expect(smtp.received).toHaveLength(0);
  });

  it("服务器拒绝 AUTH：抛错，错误里没有口令", async () => {
    const smtp = await fakeSmtp({ rejectAuth: true });
    const parsed = parseSmtpUrl(
      `smtp://bot@x.test:hunter2@127.0.0.1:${smtp.port}`,
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    const send = smtpSender(parsed.config, async () => undefined);
    const error = await send({
      from: "bot@x.test",
      to: "a@x.test",
      subject: "s",
      text: "t",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("hunter2");
  });
});
