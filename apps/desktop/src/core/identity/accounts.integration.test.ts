/**
 * 装配级验收：起一个真 core，账号这一面真答。
 *
 * 三件事：
 *
 *   1. 配对之后 `/api/identity/principals` 答的是真的 owner 行（迁移 0019 在
 *      这个进程里真的应用过）；
 *   2. 建一个成员、设口令、`/api/identity/login` 换出一个会话，而这个会话的
 *      授权就是编译出来的那一份；
 *   3. 做不到的那几条（OAuth 绑定、开放注册）是 **501 且形状一致**的
 *      `{ code, message }`，不是 404 也不是半个实现；
 *   4. 两步登录（契约 §18.3）在装配好的 core 上走得通：登记 TOTP 之后口令只换
 *      中间票，码换会话；回环 IP 来源上 passkey 如实答不可用。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { type RunningCore, run } from "../main";
import { identityInstanceId } from "./index";
import { totpAt } from "./mfa/totp";
import { allScopes } from "./scopes";
import { IdentityService } from "./service";
import { IdentityStore } from "./store";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const running: RunningCore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const core of running.splice(0)) await core.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Session {
  readonly base: string;
  readonly accessToken: string;
  readonly csrfToken: string;
  readonly principalId: string;
}

async function start(): Promise<{ core: RunningCore; base: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-accounts-api-"));
  directories.push(dataDir);
  const core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    env: {
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
    },
    stdout: () => {},
  });
  running.push(core);
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return { core, base: `http://${tcp.host}:${tcp.port}` };
}

/**
 * 走一遍壳的配对：签票（私有通道之外的同一个服务），票换会话。
 *
 * 票在这里是直接签的而不是走那个 0600 的 socket——这条用例要验的是账号这一面，
 * 不是通道；实例标识是同一个进程的，所以签出来的票这个 core 认。
 */
async function pair(core: RunningCore, base: string): Promise<Session> {
  const store = new IdentityStore(core.db.database);
  const service = new IdentityService(store, identityInstanceId());
  const ticket = service.issueBootstrap({
    hostId: store.hostId(),
    instanceId: identityInstanceId(),
    origin: base,
    deviceName: "本机桌面",
    scopes: allScopes(),
  });
  const response = await fetch(`${base}/api/identity/pair`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ ticket: ticket.ticket }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    native?: { accessToken: string };
    csrfToken: string;
    device: { principalId: string };
  };
  return {
    base,
    accessToken: body.native?.accessToken ?? "",
    csrfToken: body.csrfToken,
    principalId: body.device.principalId,
  };
}

function call(
  session: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${session.base}${path}`, {
    method,
    headers: {
      origin: session.base,
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
      "x-armadra-csrf": session.csrfToken,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("账号这一面", () => {
  it("principals 答的是真的 owner 行", async () => {
    const { core, base } = await start();
    const session = await pair(core, base);
    const response = await call(session, "GET", "/api/identity/principals");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      principals: { principalId: string; kind: string }[];
    };
    expect(body.principals).toHaveLength(1);
    expect(body.principals[0]).toMatchObject({
      principalId: session.principalId,
      kind: "owner",
    });
  });

  it("建成员、设口令、登录，授权每次现编", async () => {
    const { core, base } = await start();
    const session = await pair(core, base);
    const created = await call(session, "POST", "/api/identity/principals", {
      displayName: "同事",
    });
    expect(created.status).toBe(201);
    const member = (await created.json()) as { principalId: string };

    expect(
      (
        await call(session, "POST", "/api/identity/credentials", {
          principalId: member.principalId,
          kind: "password",
          password: "correct horse battery",
        })
      ).status,
    ).toBe(201);

    // 一块画布上的 editor。
    const granted = await call(session, "PUT", "/api/identity/grants", {
      workspaceId: "w1",
      subjectKind: "principal",
      subjectId: member.principalId,
      role: "editor",
    });
    expect(granted.status).toBe(200);
    expect((await granted.json()) as { permissions: string[] }).toMatchObject({
      role: "editor",
    });

    const login = await fetch(`${base}/api/identity/login`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        principalId: member.principalId,
        password: "correct horse battery",
        deviceName: "同事的笔记本",
      }),
    });
    expect(login.status).toBe(200);
    const issued = (await login.json()) as {
      scopes: { permission: string; workspaceId: string }[];
      device: { role: string };
      native?: { accessToken: string };
    };
    expect(issued.device.role).toBe("member");
    // 快照只有底线；共享得来的授权每次现编，`GET session` 报的是现编之后那份。
    expect(issued.scopes.map((value) => value.permission)).toEqual([
      "identity:read",
    ]);
    const current = await fetch(`${base}/api/identity/session`, {
      headers: {
        origin: base,
        authorization: `Bearer ${issued.native?.accessToken ?? ""}`,
      },
    });
    expect(current.status).toBe(200);
    const effective = (await current.json()) as {
      scopes: { permission: string; workspaceId: string }[];
    };
    expect(
      effective.scopes.map(
        (value) => `${value.permission}@${value.workspaceId}`,
      ),
    ).toContain("canvas:write@w1");
    expect(effective.scopes.map((value) => value.permission)).not.toContain(
      "terminal:drive",
    );

    // 口令错了是 401，而且答的是同一个信封。
    const refused = await fetch(`${base}/api/identity/login`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        principalId: member.principalId,
        password: "wrong password",
      }),
    });
    expect(refused.status).toBe(401);
    expect((await refused.json()) as { code: string }).toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("审计里查得到刚才那几次动作", async () => {
    const { core, base } = await start();
    const session = await pair(core, base);
    const member = (await (
      await call(session, "POST", "/api/identity/principals", {
        displayName: "同事",
      })
    ).json()) as { principalId: string };
    await call(session, "PUT", "/api/identity/grants", {
      workspaceId: "w1",
      subjectKind: "principal",
      subjectId: member.principalId,
      role: "viewer",
    });
    const response = await call(session, "GET", "/api/identity/audit");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: { action: string }[] };
    expect(body.entries.map((entry) => entry.action)).toContain(
      "share.grant.set",
    );
  });

  it("做不到的那几条是 501，形状和其余失败一致", async () => {
    const { core, base } = await start();
    const session = await pair(core, base);
    // passkey 的旧占位路径（`credentials/passkey/*`）随 §18.2 做实一起退役，
    // 现在的路由在 `passkey/*`，见下一条用例与 `security-http.test.ts`。
    for (const [method, path] of [
      ["POST", "/api/identity/credentials/oauth/github/start"],
      ["POST", "/api/identity/credentials/oauth/github/callback"],
      ["POST", "/api/identity/register"],
    ] as const) {
      const response = await call(session, method, path, {});
      expect(response.status, path).toBe(501);
      const body = (await response.json()) as {
        code: string;
        message: string;
      };
      expect(body.code, path).toBe("NOT_IMPLEMENTED");
      expect(typeof body.message).toBe("string");
    }
  });

  it("两步登录：登记 TOTP 后口令只换中间票，码换会话", async () => {
    const { core, base } = await start();
    const session = await pair(core, base);
    const member = (await (
      await call(session, "POST", "/api/identity/principals", {
        displayName: "同事",
      })
    ).json()) as { principalId: string };
    await call(session, "POST", "/api/identity/credentials", {
      principalId: member.principalId,
      kind: "password",
      password: "correct horse battery",
    });
    const signIn = () =>
      fetch(`${base}/api/identity/login`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({
          principalId: member.principalId,
          password: "correct horse battery",
        }),
      });
    const first = (await (await signIn()).json()) as {
      csrfToken: string;
      native: { accessToken: string };
    };
    const own: Session = {
      base,
      accessToken: first.native.accessToken,
      csrfToken: first.csrfToken,
      principalId: member.principalId,
    };
    const { secret } = (await (
      await call(own, "POST", "/api/identity/mfa/totp/enroll", {})
    ).json()) as { secret: string };
    expect(
      (
        await call(own, "POST", "/api/identity/mfa/totp/confirm", {
          code: totpAt(secret, Date.now()),
        })
      ).status,
    ).toBe(200);

    const step = (await (await signIn()).json()) as {
      mfaRequired: boolean;
      challengeId: string;
    };
    expect(step.mfaRequired).toBe(true);
    const verified = await fetch(`${base}/api/identity/mfa/verify`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: step.challengeId,
        code: totpAt(secret, Date.now() + 30_000),
      }),
    });
    expect(verified.status).toBe(200);
    const issued = (await verified.json()) as {
      device: { principalId: string };
    };
    expect(issued.device.principalId).toBe(member.principalId);

    // 回环 IP 来源：passkey 如实不可用，而不是让浏览器抛错。
    const passkey = await call(
      session,
      "POST",
      "/api/identity/passkey/register/options",
      {},
    );
    expect(passkey.status).toBe(400);
    expect((await passkey.json()) as { code: string }).toMatchObject({
      code: "passkey_unavailable_on_ip_host",
    });
  });

  it("不存在的账号接口仍然是 404，不是 501", async () => {
    const { core, base } = await start();
    const session = await pair(core, base);
    const response = await call(session, "GET", "/api/identity/nonsense");
    expect(response.status).toBe(404);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
