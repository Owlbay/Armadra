/**
 * 口令重置链接（契约 §25，迁移 0036）走真 HTTP：签发权限、一次性、过期、口令
 * 策略、成功后撤掉这个人的全部会话、审计里没有令牌、认不出的令牌扣 IP 桶。
 *
 * 和 `security-http.test.ts` 同一种装法；多一个可拨的时钟给账号服务，用来让
 * 令牌过期。
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import type { CoreRequest } from "../http/router";
import { plainFileBackend } from "../secrets";
import { tempDir } from "../testing/temp-dir";
import { AccountsService } from "./accounts";
import { PASSWORD_RESET_TTL_MS } from "./password-reset";
import {
  PASSKEY_LABEL_MAX,
  type SecuritySettings,
  createIdentitySecurity,
} from "./accounts-http";
import { IdentityHttp } from "./http";
import { allScopes } from "./scopes";
import { DEVICE_PLATFORMS, IdentityService } from "./service";
import { IdentityStore } from "./store";
import { IP_BUCKET_CAPACITY, principalKey } from "./throttle";
import { digest } from "./tokens";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const INSTANCE = "0123456789abcdef0123456789abcdef";
const PASSWORD = "correct horse battery";
const FRESH = "a brand new passphrase";

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
  readonly service: IdentityService;
  readonly store: IdentityStore;
  readonly security: ReturnType<typeof createIdentitySecurity>;
  /** 账号服务看到的「现在」比墙上时间多出的毫秒。 */
  readonly skew: { value: number };
}

async function harness(): Promise<Harness> {
  const origin = "http://localhost:1420";
  const directory = tempDir("armadra-password-reset-");
  const opened = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  const store = new IdentityStore(opened.database);
  const service = new IdentityService(store, INSTANCE);
  const backend = plainFileBackend(join(directory, "secrets"));
  const settings: SecuritySettings = {
    passwordMinLength: 12,
    rpId: "",
    publicOrigins: [],
    mfaRequireFor: "none",
  };
  const skew = { value: 0 };
  const security = createIdentitySecurity({
    store,
    secrets: () => backend,
    settings: () => settings,
  });
  const http = new IdentityHttp({
    service,
    instanceId: INSTANCE,
    accounts: new AccountsService({
      store,
      clock: () => Date.now() + skew.value,
    }),
    security,
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
    service,
    store,
    security,
    skew,
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
  displayName: string,
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

function issue(fixture: Harness, principalId: string, actor: Credentials) {
  return call(
    fixture,
    "POST",
    `principals/${principalId}/password-reset`,
    {},
    actor,
  );
}

async function token(response: Response): Promise<string> {
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

async function code(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe("口令重置链接（§25）", () => {
  it("owner 签发 → 打开看到是谁 → 设新口令：撤掉全部会话、旧口令失效、令牌只能用一次", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin, "Margaret");
    const laptop = await credentialsOf(await login(fixture, principalId));
    const phone = await credentialsOf(await login(fixture, principalId));

    const before = Date.now();
    const issued = await issue(fixture, principalId, admin);
    expect(issued.status).toBe(201);
    const body = (await issued.json()) as {
      token: string;
      expiresAtMs: number;
    };
    expect(body.token).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAtMs).toBeGreaterThanOrEqual(
      before + PASSWORD_RESET_TTL_MS,
    );
    expect(body.expiresAtMs).toBeLessThanOrEqual(
      Date.now() + PASSWORD_RESET_TTL_MS,
    );

    // 打开链接不要会话。
    const opened = await call(fixture, "GET", `password-reset/${body.token}`);
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({
      displayName: "Margaret",
      expiresAtMs: body.expiresAtMs,
    });

    const done = await call(fixture, "POST", `password-reset/${body.token}`, {
      password: FRESH,
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ principalId, revokedSessions: 2 });

    for (const session of [laptop, phone]) {
      expect(
        (await call(fixture, "GET", "sessions", undefined, session)).status,
      ).toBe(401);
    }
    expect((await login(fixture, principalId)).status).toBe(401);
    expect((await login(fixture, principalId, FRESH)).status).toBe(200);

    // 一次性：用过的令牌看也看不到、设也设不了。
    for (const method of ["GET", "POST"] as const) {
      const again = await call(
        fixture,
        method,
        `password-reset/${body.token}`,
        method === "POST" ? { password: "yet another passphrase" } : undefined,
      );
      expect(again.status, method).toBe(404);
      expect(await code(again), method).toBe("password_reset_invalid");
    }
  });

  it("签发权限：owner 对谁都能；组 admin 只对本组 member；成员与越级一律 403", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const lead = await member(fixture, admin, "组长");
    const teammate = await member(fixture, admin, "组员");
    const coLead = await member(fixture, admin, "另一个组长");
    const outsider = await member(fixture, admin, "外人");
    const group = await call(
      fixture,
      "POST",
      "groups",
      { name: "前端" },
      admin,
    );
    const { groupId } = (await group.json()) as { groupId: string };
    for (const [principalId, role] of [
      [lead, "admin"],
      [teammate, "member"],
      [coLead, "admin"],
    ] as const) {
      expect(
        (
          await call(
            fixture,
            "PUT",
            `groups/${groupId}/members/${principalId}`,
            { role },
            admin,
          )
        ).status,
      ).toBe(200);
    }
    const leadSession = await credentialsOf(await login(fixture, lead));
    const outsiderSession = await credentialsOf(await login(fixture, outsider));

    expect((await issue(fixture, teammate, leadSession)).status).toBe(201);
    expect((await issue(fixture, outsider, leadSession)).status).toBe(403);
    expect((await issue(fixture, coLead, leadSession)).status).toBe(403);
    expect((await issue(fixture, admin.principalId, leadSession)).status).toBe(
      403,
    );
    expect((await issue(fixture, teammate, outsiderSession)).status).toBe(403);
    // 没登录：401。
    expect(
      (await call(fixture, "POST", `principals/${teammate}/password-reset`, {}))
        .status,
    ).toBe(401);
    // owner 对任何成员都能签，对不存在的人 404，对写错的 id 400。
    expect((await issue(fixture, outsider, admin)).status).toBe(201);
    expect((await issue(fixture, "f".repeat(32), admin)).status).toBe(404);
    expect((await issue(fixture, "nope", admin)).status).toBe(400);
    // 停用了的人没有口令可重置。
    await call(fixture, "POST", `principals/${outsider}/disable`, {}, admin);
    expect((await issue(fixture, outsider, admin)).status).toBe(400);
  });

  it("签新的作废旧的；过期的打不开；停用之后打不开", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin, "Margaret");
    const first = await token(await issue(fixture, principalId, admin));
    const second = await token(await issue(fixture, principalId, admin));
    expect((await call(fixture, "GET", `password-reset/${first}`)).status).toBe(
      404,
    );
    expect(
      (await call(fixture, "GET", `password-reset/${second}`)).status,
    ).toBe(200);

    fixture.skew.value = PASSWORD_RESET_TTL_MS + 1000;
    const expired = await call(fixture, "POST", `password-reset/${second}`, {
      password: FRESH,
    });
    expect(expired.status).toBe(404);
    expect(await code(expired)).toBe("password_reset_invalid");

    fixture.skew.value = 0;
    const third = await token(await issue(fixture, principalId, admin));
    await call(fixture, "POST", `principals/${principalId}/disable`, {}, admin);
    expect((await call(fixture, "GET", `password-reset/${third}`)).status).toBe(
      404,
    );
  });

  it("新口令过策略：不合格答规则名，令牌不作废、旧口令照旧", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin, "Margaret");
    const reset = await token(await issue(fixture, principalId, admin));
    for (const [password, expected] of [
      ["short pass", "password_too_short"],
      ["i am margaret, ok", "password_contains_name"],
      ["password1234", "password_too_common"],
    ] as const) {
      const refused = await call(fixture, "POST", `password-reset/${reset}`, {
        password,
      });
      expect(refused.status, password).toBe(400);
      expect(await code(refused), password).toBe(expected);
    }
    expect((await call(fixture, "GET", `password-reset/${reset}`)).status).toBe(
      200,
    );
    expect((await login(fixture, principalId)).status).toBe(200);
  });

  it("设成功清掉这个人的登录锁定", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin, "Margaret");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(fixture, principalId, "wrong password!!");
    }
    expect((await login(fixture, principalId)).status).toBe(429);
    const reset = await token(await issue(fixture, principalId, admin));
    expect(
      (
        await call(fixture, "POST", `password-reset/${reset}`, {
          password: FRESH,
        })
      ).status,
    ).toBe(200);
    expect(
      fixture.security.throttle
        .active()
        .some((row) => row.key === principalKey(principalId)),
    ).toBe(false);
    expect((await login(fixture, principalId, FRESH)).status).toBe(200);
  });

  it("审计有签发与使用两条，令牌明文与哈希都不在里面", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin, "Margaret");
    const reset = await token(await issue(fixture, principalId, admin));
    await call(fixture, "POST", `password-reset/${reset}`, { password: FRESH });

    const page = (await (
      await call(
        fixture,
        "GET",
        "audit?action=identity.password.reset",
        undefined,
        admin,
      )
    ).json()) as {
      entries: { action: string; principalId: string; target: string }[];
    };
    expect(page.entries.map((row) => row.action).sort()).toEqual([
      "identity.password.reset.issue",
      "identity.password.reset.use",
    ]);
    expect(page.entries.every((row) => row.target === principalId)).toBe(true);
    const issued = page.entries.find(
      (row) => row.action === "identity.password.reset.issue",
    );
    expect(issued?.principalId).toBe(admin.principalId);

    const everything = JSON.stringify(
      await (await call(fixture, "GET", "audit", undefined, admin)).json(),
    );
    const [, secret] = reset.split(".");
    expect(everything).not.toContain(reset);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(digest("reset", reset).toString("base64"));
    expect(everything).not.toContain(digest("reset", reset).toString("hex"));
    // 库里也只有哈希。
    const row = fixture.store.transaction((tx) =>
      tx.passwordReset(digest("reset", reset)),
    );
    expect(row).toMatchObject({ principalId, issuedBy: admin.principalId });
    expect(row?.usedAtMs).toBeGreaterThan(0);
  });

  it("认不出的令牌扣 IP 桶，扣满了 429；好令牌不扣", async () => {
    const fixture = await harness();
    const admin = await owner(fixture);
    const principalId = await member(fixture, admin, "Margaret");
    const good = await token(await issue(fixture, principalId, admin));
    for (let attempt = 0; attempt < IP_BUCKET_CAPACITY * 2; attempt += 1) {
      const response = await call(fixture, "GET", `password-reset/${good}`);
      expect(response.status).toBe(200);
    }
    const forged = `${"a".repeat(32)}.${"A".repeat(42)}w`;
    let limited = false;
    for (let attempt = 0; attempt <= IP_BUCKET_CAPACITY; attempt += 1) {
      const response = await call(fixture, "GET", `password-reset/${forged}`);
      if (response.status === 429) {
        expect(await code(response)).toBe("rate_limited");
        expect(response.headers.get("retry-after")).not.toBeNull();
        limited = true;
        break;
      }
      expect(response.status).toBe(404);
    }
    expect(limited).toBe(true);
  });
});

describe("与共享层对齐", () => {
  // core 不依赖 `@armadra/shared`（同 `completion-settings.test.ts`），所以这里
  // 读那份源码比对常量。
  it("有效期、passkey 名字上限、设备平台表与 packages/shared 一致", () => {
    const source = readFileSync(
      resolve(
        here,
        "../../../../../packages/shared/src/api/identity-security.ts",
      ),
      "utf8",
    );
    const constant = (name: string) =>
      new RegExp(`export const ${name} = ([^;]+);`).exec(source)?.[1];
    expect(Function(`return ${constant("PASSWORD_RESET_TTL_MS")}`)()).toBe(
      PASSWORD_RESET_TTL_MS,
    );
    expect(Number(constant("PASSKEY_LABEL_MAX"))).toBe(PASSKEY_LABEL_MAX);
    const platforms = /export const DEVICE_PLATFORMS = \[([^\]]+)\]/
      .exec(source)?.[1]
      ?.match(/"[a-z]+"/g)
      ?.map((value) => value.slice(1, -1));
    expect(platforms).toEqual([...DEVICE_PLATFORMS]);
  });
});
