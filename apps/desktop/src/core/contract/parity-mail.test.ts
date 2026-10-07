import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { EventBus } from "../bus";
import { openDatabase } from "../db/open";
import { routeScope } from "../http/route-scopes";
import { installContract } from "../http/rpc";
import { CoreServer } from "../http/server";
import { AccountsService } from "../identity/accounts";
import {
  type AuditEvent,
  installAuditSink,
  resetAuditSink,
} from "../identity/audit";
import type { AuthorizationSubject } from "../identity/authorize";
import {
  type RequestIdentity,
  installRouteGuard,
  resetRouteGuard,
} from "../identity/gate";
import { createRouteGuard } from "../identity/route-access";
import { permits, scope } from "../identity/scopes";
import { IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import { linkChecks } from "../mail";
import { MAIL_ROUTES, installRoutes } from "../mail/routes";
import { MailService, RATE_LIMIT } from "../mail/service";
import type { MailMessage } from "../mail/smtp";
import { createLog, nodePlatform } from "../platform";
import { tempDir } from "../testing/temp-dir";
import {
  type Answer,
  type Kit,
  expectParity,
  startKit,
  text,
} from "./parity-kit";

/**
 * mail 域的对偶测试（契约 §43.5；工程规范化包 §3 ④）。
 *
 * 同一份夹具问三次——路由表里原来那条 handler、旧 REST 路径（经 HTTP，由契约实现
 * 经 `OpenAPIHandler` 答）、新 procedure。成功的答案按 `canonicalJson` 逐字节
 * 相等；失败的码、状态与原话相等（procedure 多一个 `requestId`）。谁在问由名字
 * 决定：`owner`、组 admin `lead`、没有任何授权的 `stranger`、没有 principal 的
 * 匿名 `anon`、桌面壳的本机请求 `local`。发信用进程内的假发送器，收件箱里什么都
 * 看得见——链接、令牌与收件地址不在任何答案与审计里。
 *
 * 限流按来源计，三种答法各有自己的来源（路由表那一路没有套接字）；测试用可调的时钟
 * 把每次发送隔开一分钟，限流一节单独写。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const INSTANCE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://armadra.example.test";

interface Setup {
  readonly kit: Kit;
  readonly server: CoreServer;
  readonly accounts: AccountsService;
  readonly owner: AuthorizationSubject;
  readonly lead: AuthorizationSubject;
  readonly groupId: string;
  readonly outbox: MailMessage[];
  readonly events: AuditEvent[];
  readonly tick: () => void;
}

const closing: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  resetRouteGuard();
  resetAuditSink();
  for (const close of closing.splice(0)) await close();
});

async function open(
  options: { configured?: boolean; reset?: boolean } = {},
): Promise<Setup> {
  const directory = tempDir("armadra-parity-mail-");
  const opened = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  let clock = 1_800_000_000_000;
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
  const member = (name: string): AuthorizationSubject => ({
    principalId: accounts.createPrincipal(owner, { displayName: name })
      .principalId,
    kind: "member",
    scopes: [],
  });
  const group = accounts.createGroup(owner, "研发");
  const lead = member("组长");
  accounts.putGroupMember(owner, group.groupId, lead.principalId, "admin");
  const stranger = member("路人");

  const events: AuditEvent[] = [];
  installAuditSink((event) => events.push(event));
  const outbox: MailMessage[] = [];
  const checks = linkChecks(accounts);
  const mail = new MailService(
    options.reset === false ? { invitation: checks.invitation } : checks,
    { clock: () => clock },
  );
  if (options.configured !== false) {
    mail.configure({
      from: "noreply@armadra.example.test",
      origin: () => ORIGIN,
      send: async (message) => {
        outbox.push(message);
      },
    });
  }
  const platform = nodePlatform({
    dataDir: directory,
    appVersion: "0.0.0-test",
    isPackaged: false,
    log: createLog("error"),
  });
  const server = new CoreServer({
    platform,
    bus: new EventBus(),
    version: "0.0.0-test",
  });
  installRoutes(server, mail);
  installContract(server, { validateOutput: true, platform });
  closing.push(() => server.close());
  const identities: Record<string, RequestIdentity | undefined> = {
    owner: { subject: owner },
    lead: { subject: lead },
    stranger: { subject: stranger },
    anon: { subject: { principalId: "", kind: "member", scopes: [] } },
    local: undefined,
  };
  const kit = await startKit(server, (name) => identities[name]);
  installRouteGuard(
    createRouteGuard({
      database: opened.database,
      permits: (who, required) => permits([...who.scopes], required),
      effectiveScopes: (who) => [...who.scopes],
    }),
  );
  return {
    kit,
    server,
    accounts,
    owner,
    lead,
    groupId: group.groupId,
    outbox,
    events,
    tick: () => {
      clock += RATE_LIMIT.windowMs + 1_000;
    },
  };
}

/** 三种答法（同一个主体）；每次发送前把时钟拨过限流窗口。 */
async function three(
  setup: Setup,
  as: string,
  method: string,
  path: string,
  name: string,
  input: unknown,
  body: unknown = input,
): Promise<readonly [Answer, Answer, Answer]> {
  setup.tick();
  const old = await setup.kit.table(method, path, body, as);
  setup.tick();
  const rest = await setup.kit.legacy(method, path, body, as);
  setup.tick();
  const rpc = await setup.kit.procedure(name, input, as);
  return [old, rest, rpc];
}

const invitation = (setup: Setup, signer = setup.owner) =>
  setup.accounts.issueInvitation(signer, {
    role: "viewer",
    targetWorkspaceId: "default",
  });

describe("status", () => {
  it("配了报发件人，没配 configured=false；匿名 401，本机请求照答", async () => {
    const configured = await open();
    for (const as of ["owner", "lead", "stranger", "local"]) {
      const answers = await three(
        configured,
        as,
        "GET",
        MAIL_ROUTES.status,
        "mail.status",
        undefined,
      );
      expect(answers[0].body, as).toEqual({
        configured: true,
        from: "noreply@armadra.example.test",
      });
      expectParity(answers);
    }
    const anon = await three(
      configured,
      "anon",
      "GET",
      MAIL_ROUTES.status,
      "mail.status",
      undefined,
    );
    expect(anon[0].status).toBe(401);
    expectParity(anon);

    const bare = await open({ configured: false });
    const answers = await three(
      bare,
      "local",
      "GET",
      MAIL_ROUTES.status,
      "mail.status",
      undefined,
    );
    expect(answers[0].body).toEqual({ configured: false, from: null });
    expectParity(answers);
  });
});

describe("sendInvitation", () => {
  it("owner 发：三种答法一样，每种各发一封，正文只有链接与过期时间，审计里没有地址与令牌", async () => {
    const setup = await open();
    const issued = invitation(setup);
    const body = {
      invitationId: issued.invitationId,
      token: issued.token,
      to: "New.Person@example.com",
      locale: "en",
    };
    const answers = await three(
      setup,
      "owner",
      "POST",
      MAIL_ROUTES.invitation,
      "mail.sendInvitation",
      body,
    );
    expect(answers[0]).toMatchObject({ status: 200, body: { sent: true } });
    expectParity(answers);
    expect(setup.outbox).toHaveLength(3);
    for (const message of setup.outbox) {
      expect(message.subject).toBe("Armadra invitation");
      expect(message.text).toContain(`${ORIGIN}/#invite=${issued.token}`);
    }
    // 令牌与地址只在信里，不在任何答案与审计里。
    for (const answer of answers) {
      expect(text(answer)).not.toContain(issued.token);
      expect(text(answer)).not.toContain("example.com");
    }
    expect(JSON.stringify(setup.events)).not.toContain(issued.token);
    expect(JSON.stringify(setup.events)).not.toContain("example.com");
  });

  it("组 admin 发指向自己组的邀请；指向工作空间的、路人、匿名一律被拒，信箱里一封都没多", async () => {
    const setup = await open();
    const forGroup = setup.accounts.issueInvitation(setup.lead, {
      role: "viewer",
      targetGroupId: setup.groupId,
    });
    const send = (token: typeof forGroup) => ({
      invitationId: token.invitationId,
      token: token.token,
      to: "a@example.com",
    });
    const ok = await three(
      setup,
      "lead",
      "POST",
      MAIL_ROUTES.invitation,
      "mail.sendInvitation",
      send(forGroup),
    );
    expect(ok[0].status).toBe(200);
    expectParity(ok);
    const sentBefore = setup.outbox.length;

    const shared = invitation(setup);
    const refused: readonly [string, ReturnType<typeof send>, number][] = [
      ["lead", send(shared), 403],
      ["stranger", send(forGroup), 403],
      ["anon", send(forGroup), 401],
    ];
    for (const [as, input, status] of refused) {
      const answers = await three(
        setup,
        as,
        "POST",
        MAIL_ROUTES.invitation,
        "mail.sendInvitation",
        input,
      );
      expect(answers[0].status, as).toBe(status);
      expectParity(answers);
    }
    expect(setup.outbox).toHaveLength(sentBefore);
  });

  it("令牌不对、被撤销：409 link_invalid；不存在 404；坏字段 400；没配置 409；码与原话三处一样，不发信", async () => {
    const setup = await open();
    const issued = invitation(setup);
    const revoked = invitation(setup);
    setup.accounts.revokeInvitation(setup.owner, revoked.invitationId);
    const missing = "f".repeat(32);
    const cases: readonly [unknown, number, string][] = [
      [
        {
          invitationId: issued.invitationId,
          token: `${issued.invitationId}.${"A".repeat(43)}`,
          to: "a@example.com",
        },
        409,
        "link_invalid",
      ],
      [
        {
          invitationId: revoked.invitationId,
          token: revoked.token,
          to: "a@example.com",
        },
        409,
        "link_invalid",
      ],
      [
        {
          invitationId: missing,
          token: `${missing}.${"A".repeat(43)}`,
          to: "a@example.com",
        },
        404,
        "not_found",
      ],
      [
        { invitationId: "x", token: issued.token, to: "a@example.com" },
        400,
        "bad_request",
      ],
      [
        { invitationId: issued.invitationId, token: "x", to: "a@example.com" },
        400,
        "bad_request",
      ],
      [
        {
          invitationId: issued.invitationId,
          token: issued.token,
          to: "nobody",
        },
        400,
        "bad_request",
      ],
      [
        {
          invitationId: issued.invitationId,
          token: issued.token,
          to: "a@example.com\r\nBcc: b@example.com",
        },
        400,
        "bad_request",
      ],
    ];
    for (const [input, status, code] of cases) {
      const answers = await three(
        setup,
        "owner",
        "POST",
        MAIL_ROUTES.invitation,
        "mail.sendInvitation",
        input,
      );
      expect(answers[0].status, JSON.stringify(input)).toBe(status);
      expect(answers[0].body).toMatchObject({ code });
      expectParity(answers);
    }
    expect(setup.outbox).toHaveLength(0);

    const bare = await open({ configured: false });
    const unissued = invitation(bare);
    const answers = await three(
      bare,
      "owner",
      "POST",
      MAIL_ROUTES.invitation,
      "mail.sendInvitation",
      {
        invitationId: unissued.invitationId,
        token: unissued.token,
        to: "a@example.com",
      },
    );
    expect(answers[0].status).toBe(409);
    expect(answers[0].body).toMatchObject({ code: "mail_not_configured" });
    expectParity(answers);
  });
});

describe("sendPasswordReset", () => {
  it("owner 发刚签的链接：正文是 #reset=；不是这个人的令牌 409，没有这个人 404，不能签的人 403", async () => {
    const setup = await open();
    const target = setup.accounts.createPrincipal(setup.owner, {
      displayName: "同事",
    });
    const other = setup.accounts.createPrincipal(setup.owner, {
      displayName: "别的同事",
    });
    const issued = setup.accounts.issuePasswordReset(
      setup.owner,
      target.principalId,
    );
    const body = {
      principalId: target.principalId,
      token: issued.token,
      to: "colleague@example.com",
    };
    const ok = await three(
      setup,
      "owner",
      "POST",
      MAIL_ROUTES.passwordReset,
      "mail.sendPasswordReset",
      body,
    );
    expect(ok[0]).toMatchObject({ status: 200, body: { sent: true } });
    expectParity(ok);
    expect(setup.outbox).toHaveLength(3);
    expect(setup.outbox[0]?.text).toContain(`${ORIGIN}/#reset=${issued.token}`);
    for (const answer of ok) expect(text(answer)).not.toContain(issued.token);

    const refused: readonly [string, unknown, number][] = [
      ["owner", { ...body, principalId: other.principalId }, 409],
      [
        "owner",
        {
          ...body,
          principalId: "f".repeat(32),
          token: `${"f".repeat(32)}.${"A".repeat(43)}`,
        },
        404,
      ],
      ["stranger", body, 403],
      ["anon", body, 401],
    ];
    const sent = setup.outbox.length;
    for (const [as, input, status] of refused) {
      const answers = await three(
        setup,
        as,
        "POST",
        MAIL_ROUTES.passwordReset,
        "mail.sendPasswordReset",
        input,
      );
      expect(answers[0].status, as).toBe(status);
      expectParity(answers);
    }
    expect(setup.outbox).toHaveLength(sent);
  });

  it("这台服务器没有口令重置链接：404", async () => {
    const setup = await open({ reset: false });
    const answers = await three(
      setup,
      "owner",
      "POST",
      MAIL_ROUTES.passwordReset,
      "mail.sendPasswordReset",
      {
        principalId: "f".repeat(32),
        token: `${"f".repeat(32)}.${"A".repeat(43)}`,
        to: "a@example.com",
      },
    );
    expect(answers[0].status).toBe(404);
    expectParity(answers);
  });
});

describe("限流", () => {
  it("每来源每分钟 5 封，第 6 封 429：体里有 details.retryAfterSeconds，三处都带 Retry-After", async () => {
    const setup = await open();
    const issued = invitation(setup);
    const body = {
      invitationId: issued.invitationId,
      token: issued.token,
      to: "a@example.com",
    };
    const path = MAIL_ROUTES.invitation;
    // 路由表那一路没有套接字，是自己的来源；旧路径与 procedure 同在回环上。
    for (let index = 0; index < RATE_LIMIT.count; index += 1) {
      expect((await setup.kit.table("POST", path, body, "owner")).status).toBe(
        200,
      );
    }
    const old = await setup.kit.table("POST", path, body, "owner");
    for (let index = 0; index < RATE_LIMIT.count; index += 1) {
      expect((await setup.kit.legacy("POST", path, body, "owner")).status).toBe(
        200,
      );
    }
    const rest = await setup.kit.legacy("POST", path, body, "owner");
    const rpc = await setup.kit.procedure("mail.sendInvitation", body, "owner");
    for (const answer of [old, rest, rpc]) {
      expect(answer.status).toBe(429);
      expect(answer.body).toMatchObject({
        code: "rate_limited",
        details: { retryAfterSeconds: 60 },
      });
      expect(answer.retryAfter).toBe("60");
    }
    expectParity([old, rest, rpc]);
    // 一分钟之后又可以发。
    setup.tick();
    expect((await setup.kit.legacy("POST", path, body, "owner")).status).toBe(
      200,
    );
  });
});

describe("入参形状错：procedure 与旧路径由契约先答 bad_request", () => {
  it("类型不对或缺字段：码与状态一致，procedure 带 issues", async () => {
    const setup = await open();
    const cases: readonly [string, string, unknown, string][] = [
      [
        "POST",
        MAIL_ROUTES.invitation,
        { invitationId: 5 },
        "mail.sendInvitation",
      ],
      [
        "POST",
        MAIL_ROUTES.passwordReset,
        { principalId: 5 },
        "mail.sendPasswordReset",
      ],
    ];
    for (const [method, path, input, name] of cases) {
      setup.tick();
      const old = await setup.kit.table(method, path, input, "owner");
      setup.tick();
      const rest = await setup.kit.legacy(method, path, input, "owner");
      setup.tick();
      const rpc = await setup.kit.procedure(name, input, "owner");
      for (const answer of [old, rest, rpc]) {
        expect(answer.status, name).toBe(400);
        expect(answer.body, name).toMatchObject({ code: "bad_request" });
      }
      const detail = (rpc.body as { details?: { issues?: unknown[] } }).details;
      expect(detail?.issues?.length, name).toBeGreaterThan(0);
    }
  });
});

describe("契约与 core 的两张表（mail）", () => {
  const entries = contractEntries().filter((entry) =>
    entry.name.startsWith("mail."),
  );

  it("3 条都在契约里，每条都有旧路径", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "mail.sendInvitation",
      "mail.sendPasswordReset",
      "mail.status",
    ]);
    for (const entry of entries) {
      expect(entry.meta.legacy, entry.name).toBeDefined();
    }
  });

  it("meta.scope 与路由表给旧路径的要求一致；旧路径都在路由表里并有人认领", async () => {
    const setup = await open();
    for (const entry of entries) {
      const legacyRoute = entry.meta.legacy!;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = setup.server.router.match(legacyRoute.path);
      expect(found?.entry.methods ?? []).toContain(legacyRoute.method);
      expect(
        setup.server.router.claimed(
          legacyRoute.method,
          found?.entry.path as string,
        ),
        entry.name,
      ).toBe(true);
    }
  });
});
