/**
 * 加固那一面（契约 §18.1–§18.4）走真 HTTP：口令策略、锁定、两步登录、passkey、
 * 会话列表。core 用的是同一个 `IdentityHttp`，只是不起整个进程——起进程那条在
 * `accounts.integration.test.ts`。
 *
 * 来源是 `http://localhost:<port>`：原生传输（Bearer 在响应体里），主机是域名，
 * passkey 可用（WebAuthn 认 `localhost`）。
 */

import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import type { CoreRequest } from "../http/router";
import { plainFileBackend } from "../secrets";
import { tempDir } from "../testing/temp-dir";
import { AccountsService } from "./accounts";
import { type SecuritySettings, createIdentitySecurity } from "./accounts-http";
import { IdentityHttp } from "./http";
import { totpAt } from "./mfa/totp";
import { allScopes } from "./scopes";
import { IdentityService } from "./service";
import { startHibp } from "./hibp.fixture";
import { SoftAuthenticator } from "./soft-authenticator.fixture";
import { IdentityStore } from "./store";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const INSTANCE = "0123456789abcdef0123456789abcdef";
const PASSWORD = "correct horse battery";

const closing: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) {
    try {
      await close();
    } catch {
      // Already closed.
    }
  }
});

interface Harness {
  readonly base: string;
  readonly origin: string;
  readonly settings: { value: SecuritySettings };
  readonly service: IdentityService;
  readonly store: IdentityStore;
}

async function harness(origin = "http://localhost:1420"): Promise<Harness> {
  const directory = tempDir("armadra-identity-security-");
  const opened = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  const store = new IdentityStore(opened.database);
  const service = new IdentityService(store, INSTANCE);
  const backend = plainFileBackend(join(directory, "secrets"));
  const settings: { value: SecuritySettings } = {
    value: {
      passwordMinLength: 12,
      rpId: "",
      publicOrigins: [],
      mfaRequireFor: "none",
    },
  };
  const http = new IdentityHttp({
    service,
    instanceId: INSTANCE,
    accounts: new AccountsService({ store }),
    security: createIdentitySecurity({
      store,
      secrets: () => backend,
      settings: () => settings.value,
    }),
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://core");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const core: CoreRequest = {
        method: (request.method ?? "GET").toUpperCase(),
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body,
        raw: request,
        json: <T>() => JSON.parse(body.toString("utf8") || "null") as T,
      };
      void http.handle(core, response, {});
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closing.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}`,
    origin,
    settings,
    service,
    store,
  };
}

interface Credentials {
  readonly accessToken: string;
  readonly csrfToken: string;
  readonly principalId: string;
}

function call(
  fixture: Harness,
  method: string,
  path: string,
  body?: unknown,
  session?: Credentials,
): Promise<Response> {
  return fetch(`${fixture.base}/api/identity/${path}`, {
    method,
    headers: {
      origin: fixture.origin,
      "user-agent": "armadra-test/1.0",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session === undefined
        ? {}
        : {
            authorization: `Bearer ${session.accessToken}`,
            "x-armadra-csrf": session.csrfToken,
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function credentialsOf(response: Response): Promise<Credentials> {
  const body = (await response.json()) as {
    native?: { accessToken: string };
    csrfToken: string;
    device: { principalId: string };
  };
  return {
    accessToken: body.native?.accessToken ?? "",
    csrfToken: body.csrfToken,
    principalId: body.device.principalId,
  };
}

async function owner(fixture: Harness): Promise<Credentials> {
  const ticket = fixture.service.issueBootstrap({
    hostId: fixture.service.hostId(),
    instanceId: INSTANCE,
    origin: fixture.origin,
    deviceName: "本机桌面",
    scopes: allScopes(),
  });
  const response = await call(fixture, "POST", "pair", {
    ticket: ticket.ticket,
  });
  expect(response.status).toBe(200);
  return credentialsOf(response);
}

async function member(
  fixture: Harness,
  admin: Credentials,
  displayName = "同事",
): Promise<string> {
  const created = await call(
    fixture,
    "POST",
    "principals",
    { displayName },
    admin,
  );
  expect(created.status).toBe(201);
  const { principalId } = (await created.json()) as { principalId: string };
  const set = await call(
    fixture,
    "POST",
    "credentials",
    { principalId, kind: "password", password: PASSWORD },
    admin,
  );
  expect(set.status).toBe(201);
  return principalId;
}

function login(fixture: Harness, principalId: string, password = PASSWORD) {
  return call(fixture, "POST", "login", {
    principalId,
    password,
    deviceName: "同事的笔记本",
  });
}

async function code(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe("口令策略（§18.1）", () => {
  it("设口令按策略拒，code 是规则名；注册同样", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const created = await call(
      fixture,
      "POST",
      "principals",
      { displayName: "Margaret" },
      admin,
    );
    const { principalId } = (await created.json()) as { principalId: string };
    for (const [password, expected] of [
      ["short pass", "password_too_short"],
      ["i am margaret, ok", "password_contains_name"],
      ["password1234", "password_too_common"],
    ] as const) {
      const response = await call(
        fixture,
        "POST",
        "credentials",
        { principalId, kind: "password", password },
        admin,
      );
      expect(response.status, password).toBe(400);
      expect(await code(response), password).toBe(expected);
    }
    // 下限可配：调到 10 之后十个字符的口令可以。
    fixture.settings.value = {
      ...fixture.settings.value,
      passwordMinLength: 10,
    };
    expect(
      (
        await call(
          fixture,
          "POST",
          "credentials",
          { principalId, kind: "password", password: "ten chars!" },
          admin,
        )
      ).status,
    ).toBe(201);
  });
});

describe("凭据换会话的那几条也限流（§18.1）", () => {
  it("配对票猜错 20 次后 429；只有失败才扣，成功的刷新不占桶", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    // 成功的请求不扣：连刷 25 次 CSRF 都过。
    const refreshToken = await (async () => {
      const ticket = fixture.service.issueBootstrap({
        hostId: fixture.service.hostId(),
        instanceId: INSTANCE,
        origin: fixture.origin,
        deviceName: "第二台",
        scopes: allScopes(),
      });
      const paired = await call(fixture, "POST", "pair", {
        ticket: ticket.ticket,
      });
      return ((await paired.json()) as { native: { refreshToken: string } })
        .native.refreshToken;
    })();
    for (let index = 0; index < 25; index += 1) {
      const renewed = await fetch(`${fixture.base}/api/identity/session/csrf`, {
        method: "POST",
        headers: {
          origin: fixture.origin,
          authorization: `Bearer ${refreshToken}`,
        },
      });
      expect(renewed.status, `csrf #${index}`).toBe(200);
    }
    for (let index = 0; index < 20; index += 1) {
      const wrong = await call(fixture, "POST", "pair", {
        ticket: `bogus-${index}`,
      });
      expect(wrong.status).not.toBe(429);
    }
    const limited = await call(fixture, "POST", "pair", { ticket: "bogus" });
    expect(limited.status).toBe(429);
    expect(await code(limited)).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // 同一个桶：刷新也挡在门外。
    const refresh = await call(fixture, "POST", "session/refresh", {}, admin);
    expect(refresh.status).toBe(429);
  });
});

describe("泄露检查（§18.1，HIBP fixture）", () => {
  async function setup(mode: "off" | "warn" | "block", base: string) {
    const fixture = await harness();
    const admin = await owner(fixture);
    fixture.settings.value = {
      ...fixture.settings.value,
      breachCheck: mode,
      breachBase: base,
    };
    const created = await call(
      fixture,
      "POST",
      "principals",
      { displayName: "Hibp" },
      admin,
    );
    const { principalId } = (await created.json()) as { principalId: string };
    const set = (password: string) =>
      call(
        fixture,
        "POST",
        "credentials",
        { principalId, kind: "password", password },
        admin,
      );
    const actions = async () =>
      (
        (await (
          await call(fixture, "GET", "audit?limit=100", undefined, admin)
        ).json()) as { entries: { action: string; detail: unknown }[] }
      ).entries;
    return { set, actions };
  }

  it("三档：off 不查、warn 照设并标出、block 拒", async () => {
    const hibp = await startHibp();
    closing.push(() => hibp.close());
    const off = await setup("off", hibp.base);
    const offAnswer = await off.set("armadra-pwned-fixture");
    expect(offAnswer.status).toBe(201);
    expect(await offAnswer.json()).not.toHaveProperty("passwordBreached");

    const warn = await setup("warn", hibp.base);
    const warned = await warn.set("armadra-pwned-fixture");
    expect(warned.status).toBe(201);
    expect(await warned.json()).toMatchObject({ passwordBreached: true });
    const clean = await warn.set("a distinctly unbreached phrase 42");
    expect(await clean.json()).not.toHaveProperty("passwordBreached");
    const entries = await warn.actions();
    const hit = entries.find(
      (entry) => entry.action === "identity.password.breached",
    );
    expect(hit?.detail).toMatchObject({ mode: "warn" });
    // 审计里没有口令，也没有哈希。
    expect(JSON.stringify(entries)).not.toContain("pwned-fixture");

    const block = await setup("block", hibp.base);
    const blocked = await block.set("armadra-pwned-fixture");
    expect(blocked.status).toBe(400);
    expect(await code(blocked)).toBe("password_breached");
    expect((await block.set("a distinctly unbreached phrase 42")).status).toBe(
      201,
    );
  });

  it("离线时不阻止设口令，只记一条审计", async () => {
    const offline = await setup("block", "http://127.0.0.1:9");
    const answer = await offline.set("armadra-pwned-fixture");
    expect(answer.status).toBe(201);
    expect((await offline.actions()).map((entry) => entry.action)).toContain(
      "identity.password.breach_check_failed",
    );
  });
});

describe("锁定（§18.1）", () => {
  it("5 次失败后连对的口令也 429；不存在的账号一样；owner 能解锁", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin);
    for (let index = 0; index < 5; index += 1) {
      const wrong = await login(fixture, principalId, "not the password");
      expect(wrong.status).toBe(401);
    }
    const locked = await login(fixture, principalId);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("60");
    expect(await code(locked)).toBe("account_locked");

    const ghost = "e".repeat(32);
    for (let index = 0; index < 5; index += 1) {
      expect((await login(fixture, ghost)).status).toBe(401);
    }
    const ghostLocked = await login(fixture, ghost);
    expect(ghostLocked.status).toBe(429);
    expect(await code(ghostLocked)).toBe("account_locked");

    const listed = await call(fixture, "GET", "lockouts", undefined, admin);
    expect(listed.status).toBe(200);
    const { lockouts } = (await listed.json()) as {
      lockouts: { principalId: string }[];
    };
    expect(lockouts.map((row) => row.principalId).sort()).toEqual(
      [principalId, ghost].sort(),
    );

    const unlocked = await call(
      fixture,
      "DELETE",
      `lockouts/${principalId}`,
      undefined,
      admin,
    );
    expect(await unlocked.json()).toMatchObject({ unlocked: true });
    expect((await login(fixture, principalId)).status).toBe(200);

    const audit = await call(
      fixture,
      "GET",
      "audit?limit=100",
      undefined,
      admin,
    );
    const actions = (
      (await audit.json()) as { entries: { action: string }[] }
    ).entries.map((entry) => entry.action);
    expect(actions).toContain("identity.login.failed");
    expect(actions).toContain("identity.lockout");
    expect(actions).toContain("identity.lockout.clear");
  });

  it("成员管不了锁定", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin);
    const session = await credentialsOf(await login(fixture, principalId));
    expect(
      (await call(fixture, "GET", "lockouts", undefined, session)).status,
    ).toBe(403);
  });
});

describe("两步登录（§18.3）", () => {
  it("登记 TOTP → 口令换中间票 → 码换会话；重放与错码拒；恢复码可用一次", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin);
    const first = await credentialsOf(await login(fixture, principalId));

    const enrolled = await call(fixture, "POST", "mfa/totp/enroll", {}, first);
    expect(enrolled.status).toBe(200);
    const { secret, otpauthUri } = (await enrolled.json()) as {
      secret: string;
      otpauthUri: string;
    };
    expect(otpauthUri).toContain("issuer=Armadra");
    const confirmed = await call(
      fixture,
      "POST",
      "mfa/totp/confirm",
      { code: totpAt(secret, Date.now()) },
      first,
    );
    expect(confirmed.status).toBe(200);
    const { recoveryCodes } = (await confirmed.json()) as {
      recoveryCodes: string[];
    };
    expect(recoveryCodes).toHaveLength(10);
    const status = await call(fixture, "GET", "mfa", undefined, first);
    expect(await status.json()).toMatchObject({
      enrolled: true,
      recoveryCodesRemaining: 10,
      requireFor: "none",
      required: false,
    });

    // 口令对了也不建会话，只给中间票。
    const step = await login(fixture, principalId);
    expect(step.status).toBe(200);
    const ticket = (await step.json()) as {
      mfaRequired: boolean;
      challengeId: string;
      native?: unknown;
    };
    expect(ticket.mfaRequired).toBe(true);
    expect(ticket.native).toBeUndefined();

    const wrong = await call(fixture, "POST", "mfa/verify", {
      challengeId: ticket.challengeId,
      code: "000000",
    });
    expect(wrong.status).toBe(401);
    expect(await code(wrong)).toBe("mfa_invalid_code");

    // 下一个时间步的码（确认用掉了当前这个）。
    const next = totpAt(secret, Date.now() + 30_000);
    const passed = await call(fixture, "POST", "mfa/verify", {
      challengeId: ticket.challengeId,
      code: next,
    });
    expect(passed.status).toBe(200);
    const session = await credentialsOf(passed);
    expect(session.principalId).toBe(principalId);

    // 票用过即废；同一个码再走一遍也拒（重放）。
    const reused = await call(fixture, "POST", "mfa/verify", {
      challengeId: ticket.challengeId,
      code: next,
    });
    expect(await code(reused)).toBe("mfa_challenge_expired");
    const again = (await (await login(fixture, principalId)).json()) as {
      challengeId: string;
    };
    const replay = await call(fixture, "POST", "mfa/verify", {
      challengeId: again.challengeId,
      code: next,
    });
    expect(await code(replay)).toBe("mfa_invalid_code");
    const recovered = await call(fixture, "POST", "mfa/verify", {
      challengeId: again.challengeId,
      code: recoveryCodes[0],
    });
    expect(recovered.status).toBe(200);

    // 停用要一个当前有效的码；之后登录回到一步。
    const refused = await call(
      fixture,
      "POST",
      "mfa/disable",
      { code: recoveryCodes[0] },
      session,
    );
    expect(refused.status).toBe(401);
    const disabled = await call(
      fixture,
      "POST",
      "mfa/disable",
      { code: recoveryCodes[1] },
      session,
    );
    expect(disabled.status).toBe(200);
    const plain = (await (await login(fixture, principalId)).json()) as {
      mfaRequired?: boolean;
      native?: unknown;
    };
    expect(plain.mfaRequired).toBeUndefined();
    expect(plain.native).toBeDefined();
  });

  it("策略要求而没登记：放进来，带 mfaEnrollmentRequired", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin);
    fixture.settings.value = {
      ...fixture.settings.value,
      mfaRequireFor: "members",
    };
    const body = (await (await login(fixture, principalId)).json()) as {
      mfaEnrollmentRequired?: boolean;
    };
    expect(body.mfaEnrollmentRequired).toBe(true);
  });

  it("owner 能替人重置 MFA", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin);
    const session = await credentialsOf(await login(fixture, principalId));
    const { secret } = (await (
      await call(fixture, "POST", "mfa/totp/enroll", {}, session)
    ).json()) as { secret: string };
    await call(
      fixture,
      "POST",
      "mfa/totp/confirm",
      { code: totpAt(secret, Date.now()) },
      session,
    );
    expect(
      (await call(fixture, "POST", "mfa/reset", { principalId }, session))
        .status,
    ).toBe(403);
    const reset = await call(
      fixture,
      "POST",
      "mfa/reset",
      { principalId },
      admin,
    );
    expect(await reset.json()).toMatchObject({ reset: true });
    expect(
      (
        (await (await login(fixture, principalId)).json()) as {
          mfaRequired?: boolean;
        }
      ).mfaRequired,
    ).toBeUndefined();
  });
});

describe("passkey（§18.2）", () => {
  it("软件认证器：登记 → 列表 → 匿名登录换会话 → 删除", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin);
    const session = await credentialsOf(await login(fixture, principalId));
    const authenticator = new SoftAuthenticator();

    const begun = await call(
      fixture,
      "POST",
      "passkey/register/options",
      { label: "笔记本" },
      session,
    );
    expect(begun.status).toBe(200);
    const registration = (await begun.json()) as {
      challengeId: string;
      options: { challenge: string; rp: { id: string }; user: { id: string } };
    };
    expect(registration.options.rp.id).toBe("localhost");
    const added = await call(
      fixture,
      "POST",
      "passkey/register/verify",
      {
        challengeId: registration.challengeId,
        response: authenticator.create(registration.options, fixture.origin),
      },
      session,
    );
    expect(added.status).toBe(201);
    const { credentialId } = (await added.json()) as { credentialId: string };

    const listed = await call(fixture, "GET", "passkey", undefined, session);
    expect(await listed.json()).toMatchObject({
      available: true,
      rpId: "localhost",
      passkeys: [{ credentialId, label: "笔记本", transports: ["internal"] }],
    });

    const options = (await (
      await call(fixture, "POST", "passkey/login/options", {})
    ).json()) as {
      challengeId: string;
      options: { challenge: string; rpId: string };
    };
    const signedIn = await call(fixture, "POST", "passkey/login/verify", {
      challengeId: options.challengeId,
      response: authenticator.get(options.options, fixture.origin),
      deviceName: "手机",
    });
    expect(signedIn.status).toBe(200);
    expect((await credentialsOf(signedIn)).principalId).toBe(principalId);
    const row = fixture.store.transaction((tx) => tx.passkey(credentialId));
    expect(row?.signCount).toBe(1);

    const removed = await call(
      fixture,
      "DELETE",
      `passkey/${credentialId}`,
      undefined,
      session,
    );
    expect(removed.status).toBe(200);
    const after = (await (
      await call(fixture, "POST", "passkey/login/options", {})
    ).json()) as {
      challengeId: string;
      options: { challenge: string; rpId: string };
    };
    const refused = await call(fixture, "POST", "passkey/login/verify", {
      challengeId: after.challengeId,
      response: authenticator.get(after.options, fixture.origin),
    });
    expect(refused.status).toBe(401);
  });

  it("IP 主机：列表如实报不可用，选项接口答 passkey_unavailable_on_ip_host", async () => {
    const fixture = await harness("http://127.0.0.1:1420");
    const admin = await owner(fixture);
    const listed = await call(fixture, "GET", "passkey", undefined, admin);
    expect(await listed.json()).toMatchObject({
      available: false,
      reason: "passkey_unavailable_on_ip_host",
    });
    for (const path of ["passkey/register/options", "passkey/login/options"]) {
      const response = await call(fixture, "POST", path, {}, admin);
      expect(response.status, path).toBe(400);
      expect(await code(response), path).toBe("passkey_unavailable_on_ip_host");
    }
  });

  it("没登录不能登记", async () => {
    const fixture = await harness();
    const response = await call(
      fixture,
      "POST",
      "passkey/register/options",
      {},
    );
    expect(response.status).toBe(401);
  });
});

describe("会话列表与撤销（§18.4）", () => {
  it("列出我的会话（带 IP 与 UA），撤一个、其它全部登出；成员看不了全部", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin);
    const one = await credentialsOf(await login(fixture, principalId));
    const two = await credentialsOf(await login(fixture, principalId));
    const three = await credentialsOf(await login(fixture, principalId));

    const listed = await call(fixture, "GET", "sessions", undefined, one);
    const { sessions } = (await listed.json()) as {
      sessions: {
        sessionId: string;
        current: boolean;
        remoteIp: string;
        userAgent: string;
        deviceName: string;
      }[];
    };
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((row) => row.current)).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      remoteIp: "127.0.0.1",
      userAgent: "armadra-test/1.0",
      deviceName: "同事的笔记本",
    });
    expect(
      (await call(fixture, "GET", "sessions?all=1", undefined, one)).status,
    ).toBe(403);

    const target = sessions.find((row) => !row.current)?.sessionId ?? "";
    expect(
      (await call(fixture, "DELETE", `sessions/${target}`, undefined, one))
        .status,
    ).toBe(200);
    const revoked = await call(
      fixture,
      "POST",
      "sessions/revoke-others",
      {},
      one,
    );
    expect(await revoked.json()).toMatchObject({ revoked: 1 });
    for (const other of [two, three]) {
      expect(
        (await call(fixture, "GET", "sessions", undefined, other)).status,
      ).toBe(401);
    }
    expect(
      (await call(fixture, "GET", "sessions", undefined, one)).status,
    ).toBe(200);

    // owner 看全部，也能撤别人的。
    const all = (await (
      await call(fixture, "GET", "sessions?all=1", undefined, admin)
    ).json()) as { sessions: { sessionId: string; principalId: string }[] };
    const members = all.sessions.filter(
      (row) => row.principalId === principalId,
    );
    expect(members).toHaveLength(1);
    expect(
      (
        await call(
          fixture,
          "DELETE",
          `sessions/${members[0]?.sessionId}`,
          undefined,
          admin,
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(fixture, "GET", "sessions", undefined, one)).status,
    ).toBe(401);
  });

  it("Bearer 传输的写不核对 CSRF（不是环境凭据）；Cookie 会话那一半在 gateway.integration", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    // 桌面壳与原生 App 的页面在 Bearer 传输上不发 CSRF 头（契约 §17.4）：
    // 要求它只会让这两种传输上的每一次写都 403。
    const response = await call(
      fixture,
      "POST",
      "sessions/revoke-others",
      {},
      { ...admin, csrfToken: "" },
    );
    expect(response.status).toBe(200);
    // 没有凭据仍是 401。
    expect(
      (await call(fixture, "POST", "sessions/revoke-others", {})).status,
    ).toBe(401);
  });
});
