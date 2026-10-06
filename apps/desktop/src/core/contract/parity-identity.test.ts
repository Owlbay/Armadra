import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { allowOrigins } from "../http/cors";
import { connectPeer } from "../http/peer.fixture";
import { installContract } from "../http/rpc";
import { routeScope } from "../http/route-scopes";
import { identityInstanceId, installIdentity } from "../identity";
import { cookieName } from "../identity/http";
import { totpAt } from "../identity/mfa/totp";
import { allScopes } from "../identity/scopes";
import { IdentityService } from "../identity/service";
import { SoftAuthenticator } from "../identity/soft-authenticator.fixture";
import { IdentityStore } from "../identity/store";
import { LOCK_THRESHOLD } from "../identity/throttle";
import { WS_TICKET_PROTOCOL } from "../identity/transport";
import { CONTROL_PROTOCOL } from "../http/ws-control";
import { type Fixture, fixture } from "../workspaces/fixture";
import { type JsonValue, canonicalJson } from "./message";

/**
 * 身份三域的对偶测试（契约 §42；工程规范化包 §3 ④）。
 *
 * 真的 core：身份域整个装上（回环准入门、路由门、审计），契约门面装上，监听在
 * 回环。同一件事问两次——旧路径（`/api/identity/…`，身份域的原样路由）与
 * procedure（`/api/rpc/<域>/<组>/<动词>`）。成功的答案按 `canonicalJson` 逐字节
 * 相等（旧路径的 201 对 procedure 的 200）；会改动状态的动作两条路各用自己的
 * 对象，比较前把每次都会变的字段（标识、时刻、令牌）换成占位。拒绝的状态与原话
 * 相等，码按注册表对上（旧路径的大写码 → `unauthenticated` / `forbidden` …，
 * §18 的具名码两边一样）。
 *
 * 安全那几节单独写，旧路径与 procedure 都得拒：
 *
 *   * **无会话**：不带凭据 401（procedure 在回环门上就拒了）。
 *   * **错 CSRF**：Cookie 会话的写，CSRF 不对 403；Bearer 不要 CSRF。
 *   * **成员越权**：成员动不了「管别人的」（建人、锁定、MFA 重置、审计、全部
 *     会话、OAuth 密钥、邀请、共享、撤设备），自己的照常；别人的会话 404。
 *   * **锁定**：口令连错 {@link LOCK_THRESHOLD} 次之后，要码的动作答 429
 *     `account_locked`，旧路径 `Retry-After` 与 procedure 的
 *     `details.retryAfterSeconds` 是同一个数；owner 能看见、能解。
 *   * **会话失效**：会话被撤、账号被停用之后，procedure 下一次就 401（门按会话
 *     再认一次，不吃旧令牌）。控制面上同一条会话照样认得出人。
 */

const PASSWORD = "lantern orbit velvet 93";
const COOKIE_ORIGIN = "https://armadra.test";

let core: Fixture;
let base: string;
let origin: string;
let hostId: string;
let service: IdentityService;

interface Session {
  readonly principalId: string;
  readonly origin: string;
  /** Bearer；Cookie 会话是空串。 */
  readonly accessToken: string;
  readonly csrfToken: string;
  /** Cookie 会话的 `cookie` 头；Bearer 是空串。 */
  readonly cookie: string;
}

let owner: Session;

beforeAll(async () => {
  core = fixture([installIdentity]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const port = (listener.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  // `localhost` 是回环的原生来源（Bearer 在响应体里），也是 WebAuthn 认的 RP。
  origin = `http://localhost:${port}`;
  service = new IdentityService(
    new IdentityStore(core.database),
    identityInstanceId(),
  );
  hostId = service.hostId();
  owner = await pair("本机桌面");
});

afterAll(async () => {
  allowOrigins([]);
  await core.server.close();
  core.close();
});

/* --------------------------------- 两种答法 -------------------------------- */

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

function credentials(session: Session | undefined): Record<string, string> {
  if (session === undefined) return { origin };
  return {
    origin: session.origin,
    ...(session.accessToken === ""
      ? {}
      : { authorization: `Bearer ${session.accessToken}` }),
    ...(session.cookie === "" ? {} : { cookie: session.cookie }),
  };
}

/** 旧路径。`csrf` 给了就带上那一枚（Cookie 会话的写）。 */
async function legacy(
  method: string,
  path: string,
  options: { body?: unknown; as?: Session; csrf?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${base}/api/identity/${path}`, {
    method,
    headers: {
      ...credentials(options.as),
      ...(options.csrf === undefined ? {} : { "x-armadra-csrf": options.csrf }),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? undefined : JSON.parse(text),
    headers: response.headers,
  };
}

/** procedure；成功取 `json`，失败去掉 `requestId`。 */
async function procedure(
  name: string,
  input: unknown,
  options: { as?: Session; csrf?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${base}/api/rpc/${name.split(".").join("/")}`, {
    method: "POST",
    headers: {
      ...credentials(options.as),
      ...(options.csrf === undefined ? {} : { "x-armadra-csrf": options.csrf }),
      "content-type": "application/json",
    },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.ok) {
    return {
      status: response.status,
      body: body.json,
      headers: response.headers,
    };
  }
  // 门上的拒绝（没会话、CSRF 不对）在门面之前答出，没有 `requestId`。
  const { requestId: _requestId, ...rest } = body;
  return { status: response.status, body: rest, headers: response.headers };
}

function stable(value: unknown, volatile: ReadonlySet<string>): JsonValue {
  if (Array.isArray(value)) return value.map((one) => stable(one, volatile));
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    out[key] = volatile.has(key) ? "<volatile>" : stable(field, volatile);
  }
  return out;
}

const NOTHING = new Set<string>();

/** 成功：旧路径 200 / 201，procedure 200，体规范化后逐字节相等。 */
function expectSame(
  rest: Answer,
  rpc: Answer,
  volatile: ReadonlySet<string> = NOTHING,
): void {
  expect(rest.status, JSON.stringify(rest.body)).toBeLessThan(300);
  expect(rpc.status, JSON.stringify(rpc.body)).toBe(200);
  expect(canonicalJson(stable(rpc.body, volatile))).toBe(
    canonicalJson(stable(rest.body, volatile)),
  );
}

/** 旧路径的大写码在注册表里叫什么。 */
const REGISTERED: Readonly<Record<string, string>> = {
  UNAUTHENTICATED: "unauthenticated",
  PERMISSION_DENIED: "forbidden",
  INVALID_ARGUMENT: "bad_request",
  CONFLICT: "conflict",
  NOT_FOUND: "not_found",
  NOT_IMPLEMENTED: "not_implemented",
};

/** 拒绝：状态与原话相等，码按注册表对上。 */
function expectRefused(rest: Answer, rpc: Answer, code: string): void {
  const old = rest.body as { code: string; message: string };
  const now = rpc.body as { code: string; message: string };
  expect(rest.status, JSON.stringify(old)).toBeGreaterThanOrEqual(400);
  expect(rpc.status).toBe(rest.status);
  expect(REGISTERED[old.code] ?? old.code).toBe(code);
  expect(now.code).toBe(code);
  expect(now.message).toBe(old.message);
}

/* --------------------------------- 夹具 --------------------------------- */

/** 本机主人再配一台设备（名字不同就是另一台）。 */
async function pair(deviceName: string): Promise<Session> {
  const { ticket } = service.issueBootstrap({
    hostId,
    instanceId: identityInstanceId(),
    origin,
    deviceName,
    scopes: allScopes(),
  });
  const answer = await legacy("POST", "pair", { body: { ticket } });
  expect(answer.status).toBe(200);
  return sessionOf(answer, origin);
}

function sessionOf(answer: Answer, from: string): Session {
  const body = answer.body as {
    device: { principalId: string };
    csrfToken: string;
    native?: { accessToken: string };
  };
  const cookies = answer.headers.getSetCookie();
  const access = cookieName(hostId, false, "access");
  const cookie =
    cookies
      .map((line) => line.split(";")[0] as string)
      .find((pair) => pair.startsWith(`${access}=`)) ?? "";
  return {
    principalId: body.device.principalId,
    origin: from,
    accessToken: body.native?.accessToken ?? "",
    csrfToken: body.csrfToken,
    cookie,
  };
}

/** owner 建一个成员并设口令。 */
async function member(displayName: string): Promise<string> {
  const created = await legacy("POST", "principals", {
    body: { displayName },
    as: owner,
  });
  expect(created.status).toBe(201);
  const { principalId } = created.body as { principalId: string };
  const set = await legacy("POST", "credentials", {
    body: { principalId, password: PASSWORD },
    as: owner,
  });
  expect(set.status).toBe(201);
  return principalId;
}

/**
 * 一个成员的会话。不走 `POST login`：那一条每次扣来源 IP 的桶（每分钟 20 次），
 * 本文件的锁定一节要留着桶去连错口令。会话与口令登录发的是同一种
 * （`openSession`），Cookie 来源上把访问令牌放进 Cookie。
 */
async function login(principalId: string, from = origin): Promise<Session> {
  const issued = service.openSession({
    principalId,
    hostId,
    origin: from,
    deviceName: "同事的笔记本",
    method: "password",
    remoteIp: "127.0.0.1",
    userAgent: "armadra-test/1.0",
  });
  const cookie = from === COOKIE_ORIGIN;
  return {
    principalId,
    origin: from,
    accessToken: cookie ? "" : issued.accessToken,
    csrfToken: issued.csrfToken,
    cookie: cookie
      ? `${cookieName(hostId, false, "access")}=${issued.accessToken}`
      : "",
  };
}

/* --------------------------------- 契约 --------------------------------- */

const domains = contractEntries().filter(
  (entry) =>
    (entry.path[0] === "identity" && entry.path[1] !== "cloud") ||
    entry.path[0] === "security" ||
    entry.path[0] === "accounts",
);

describe("契约与 core 的两张表", () => {
  it("每条都登记了实现（system.hello 报的表里有）", async () => {
    const hello = await procedure("system.hello", {}, { as: owner });
    const procedures = (hello.body as { procedures: string[] }).procedures;
    for (const entry of domains) {
      expect(procedures, entry.name).toContain(entry.name);
    }
    expect((hello.body as { protocol: unknown }).protocol).toEqual({
      major: 1,
      minor: 14,
    });
  });

  it("meta.scope 与路由表给旧路径的那一档一致", () => {
    for (const entry of domains) {
      const legacyRoute = entry.meta.legacy!;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission,
        entry.name,
      ).toBe(entry.meta.scope);
    }
  });
});

/* -------------------------------- 会话与设备 ------------------------------- */

describe("identity：会话与设备（§42.1）", () => {
  it("session 与 devices.list 两条路答的一样", async () => {
    expectSame(
      await legacy("GET", "session", { as: owner }),
      await procedure("identity.session", undefined, { as: owner }),
    );
    expectSame(
      await legacy("GET", "devices?limit=10", { as: owner }),
      await procedure("identity.devices.list", { limit: 10 }, { as: owner }),
      new Set(["lastSeenAtMs"]),
    );
    expectRefused(
      await legacy("GET", "devices?limit=0", { as: owner }),
      await procedure("identity.devices.list", { limit: 0 }, { as: owner }),
      "bad_request",
    );
  });

  it("devices.revoke：撤掉的那台再也认不出；过期的 epoch 409", async () => {
    const second = await pair("第二台");
    const third = await pair("第三台");
    const devices = (
      (await legacy("GET", "devices", { as: owner })).body as {
        devices: { deviceId: string; name: string; epoch: number }[];
      }
    ).devices;
    const of = (name: string) => devices.find((one) => one.name === name)!;
    expectRefused(
      await legacy("POST", "devices/revoke", {
        body: { deviceId: of("第二台").deviceId, expectedRevision: 99 },
        as: owner,
      }),
      await procedure(
        "identity.devices.revoke",
        { deviceId: of("第三台").deviceId, expectedRevision: 99 },
        { as: owner },
      ),
      "conflict",
    );
    expectSame(
      await legacy("POST", "devices/revoke", {
        body: {
          deviceId: of("第二台").deviceId,
          expectedRevision: of("第二台").epoch,
        },
        as: owner,
      }),
      await procedure(
        "identity.devices.revoke",
        {
          deviceId: of("第三台").deviceId,
          expectedRevision: of("第三台").epoch,
        },
        { as: owner },
      ),
      new Set(["deviceId"]),
    );
    for (const gone of [second, third]) {
      expect((await legacy("GET", "session", { as: gone })).status).toBe(401);
      expect(
        (await procedure("identity.session", undefined, { as: gone })).status,
      ).toBe(401);
    }
  });

  it("控制面上同一条会话认得出人：identity.session 与旧路径一样", async () => {
    const ticket = await legacy("POST", "ws-ticket", { as: owner });
    const peer = await connectPeer(
      base,
      [
        `${WS_TICKET_PROTOCOL}${(ticket.body as { ticket: string }).ticket}`,
        CONTROL_PROTOCOL,
      ],
      { origin },
    );
    const answer = await peer.call("identity.session", {}).response;
    peer.socket.close();
    expect(answer.status).toBe(200);
    expect(canonicalJson(stable(answer.body, NOTHING))).toBe(
      canonicalJson(
        stable((await legacy("GET", "session", { as: owner })).body, NOTHING),
      ),
    );
  });
});

/* ---------------------------------- 账号 ---------------------------------- */

describe("accounts：账号、凭据、邀请、组与共享（§42.3）", () => {
  const ids = new Set([
    "principalId",
    "credentialId",
    "createdAtMs",
    "groupId",
    "grantId",
    "invitationId",
    "token",
    "expiresAtMs",
    "joinedAtMs",
    "revokedAtMs",
  ]);

  it("principals：建、列、停用、签重置链接", async () => {
    const rest = await legacy("POST", "principals", {
      body: { displayName: "乙" },
      as: owner,
    });
    const rpc = await procedure(
      "accounts.principals.create",
      { displayName: "乙" },
      { as: owner },
    );
    expect(rest.status).toBe(201);
    expectSame(rest, rpc, ids);
    expectSame(
      await legacy("GET", "principals", { as: owner }),
      await procedure("accounts.principals.list", undefined, { as: owner }),
    );
    const a = (rest.body as { principalId: string }).principalId;
    const b = (rpc.body as { principalId: string }).principalId;
    const issued = [
      await legacy("POST", `principals/${a}/password-reset`, { as: owner }),
      await procedure(
        "accounts.principals.issuePasswordReset",
        { principalId: b },
        { as: owner },
      ),
    ] as const;
    expect(issued[0].status).toBe(201);
    expectSame(...issued, ids);
    expectSame(
      await legacy("POST", `principals/${a}/disable`, { as: owner }),
      await procedure(
        "accounts.principals.disable",
        { principalId: b },
        { as: owner },
      ),
    );
    expectRefused(
      await legacy("POST", "principals/nope/disable", { as: owner }),
      await procedure(
        "accounts.principals.disable",
        { principalId: "nope" },
        { as: owner },
      ),
      "bad_request",
    );
  });

  it("credentials：设口令（策略拒绝同码）、列、撤；口令不出现在任何答案里", async () => {
    const a = await member("丙");
    const b = await member("丁");
    const set = [
      await legacy("POST", "credentials", {
        body: { principalId: a, password: PASSWORD },
        as: owner,
      }),
      await procedure(
        "accounts.credentials.setPassword",
        { principalId: b, password: PASSWORD },
        { as: owner },
      ),
    ] as const;
    expect(set[0].status).toBe(201);
    expectSame(...set, ids);
    const weak = "zq7";
    const refused = [
      await legacy("POST", "credentials", {
        body: { principalId: a, password: weak },
        as: owner,
      }),
      await procedure(
        "accounts.credentials.setPassword",
        { principalId: b, password: weak },
        { as: owner },
      ),
    ] as const;
    expectRefused(...refused, "password_too_short");
    const unsupported = [
      await legacy("POST", "credentials", {
        body: { principalId: a, password: PASSWORD, kind: "totp" },
        as: owner,
      }),
      await procedure(
        "accounts.credentials.setPassword",
        { principalId: b, password: PASSWORD, kind: "totp" },
        { as: owner },
      ),
    ] as const;
    expectRefused(...unsupported, "not_implemented");
    const shape = await procedure(
      "accounts.credentials.setPassword",
      { principalId: b, password: 42 },
      { as: owner },
    );
    expect(shape.status).toBe(400);
    expect((shape.body as { code: string }).code).toBe("bad_request");
    for (const answer of [...set, ...refused, ...unsupported, shape]) {
      expect(JSON.stringify(answer.body)).not.toContain(PASSWORD);
      expect(JSON.stringify(answer.body)).not.toContain(weak);
    }
    const listed = [
      await legacy("GET", `credentials?principalId=${a}`, { as: owner }),
      await procedure(
        "accounts.credentials.list",
        { principalId: b },
        { as: owner },
      ),
    ] as const;
    expectSame(...listed, ids);
    const live = (answer: Answer) =>
      (
        answer.body as {
          credentials: { credentialId: string; revokedAtMs: number }[];
        }
      ).credentials.find((row) => row.revokedAtMs === 0)!.credentialId;
    expectSame(
      await legacy("DELETE", `credentials/${live(listed[0])}`, { as: owner }),
      await procedure(
        "accounts.credentials.revoke",
        { credentialId: live(listed[1]) },
        { as: owner },
      ),
    );
  });

  it("groups、invitations：建组、改名、加人、邀请、兑换、撤销、删组", async () => {
    const created = [
      await legacy("POST", "groups", { body: { name: "前端" }, as: owner }),
      await procedure(
        "accounts.groups.create",
        { name: "前端" },
        { as: owner },
      ),
    ] as const;
    expect(created[0].status).toBe(201);
    expectSame(...created, ids);
    const [g1, g2] = created.map(
      (answer) => (answer.body as { groupId: string }).groupId,
    ) as [string, string];
    expectSame(
      await legacy("PATCH", `groups/${g1}`, {
        body: { name: "后端" },
        as: owner,
      }),
      await procedure(
        "accounts.groups.rename",
        { groupId: g2, name: "后端" },
        { as: owner },
      ),
      ids,
    );
    const m = await member("戊");
    expectSame(
      await legacy("PUT", `groups/${g1}/members/${m}`, {
        body: { role: "admin" },
        as: owner,
      }),
      await procedure(
        "accounts.groups.putMember",
        { groupId: g2, principalId: m, role: "admin" },
        { as: owner },
      ),
      ids,
    );
    expectSame(
      await legacy("GET", "groups", { as: owner }),
      await procedure("accounts.groups.list", undefined, { as: owner }),
    );

    const issued = [
      await legacy("POST", "invitations", {
        body: { role: "viewer", targetGroupId: g1 },
        as: owner,
      }),
      await procedure(
        "accounts.invitations.issue",
        { role: "viewer", targetGroupId: g2 },
        { as: owner },
      ),
    ] as const;
    expect(issued[0].status).toBe(201);
    expectSame(...issued, new Set([...ids, "targetGroupId"]));
    expectSame(
      await legacy("GET", "invitations", { as: owner }),
      await procedure("accounts.invitations.list", undefined, { as: owner }),
    );
    // 兑换：同一个人拿两张邀请，一张经旧路径、一张经 procedure。
    const joiner = await login(await member("己"));
    const [t1, t2] = issued.map(
      (answer) => answer.body as { invitationId: string; token: string },
    ) as [
      { invitationId: string; token: string },
      { invitationId: string; token: string },
    ];
    expectSame(
      await legacy("POST", `invitations/${t1.invitationId}/accept`, {
        body: { token: t1.token },
        as: joiner,
      }),
      await procedure(
        "accounts.invitations.accept",
        { invitationId: t2.invitationId, token: t2.token },
        { as: joiner },
      ),
      ids,
    );
    expectRefused(
      await legacy("POST", `invitations/${t1.invitationId}/accept`, {
        body: { token: `${t1.invitationId}.wrong` },
        as: joiner,
      }),
      await procedure(
        "accounts.invitations.accept",
        { invitationId: t2.invitationId, token: `${t2.invitationId}.wrong` },
        { as: joiner },
      ),
      "unauthenticated",
    );
    const again = [
      await legacy("POST", "invitations", {
        body: { role: "viewer", targetGroupId: g1, maxUses: 3 },
        as: owner,
      }),
      await procedure(
        "accounts.invitations.issue",
        { role: "viewer", targetGroupId: g2, maxUses: 3 },
        { as: owner },
      ),
    ].map((answer) => (answer.body as { invitationId: string }).invitationId);
    expectSame(
      await legacy("DELETE", `invitations/${again[0]}`, { as: owner }),
      await procedure(
        "accounts.invitations.revoke",
        { invitationId: again[1] },
        { as: owner },
      ),
    );
    expectSame(
      await legacy("DELETE", `groups/${g1}/members/${m}`, { as: owner }),
      await procedure(
        "accounts.groups.removeMember",
        { groupId: g2, principalId: m },
        { as: owner },
      ),
      ids,
    );
    expectSame(
      await legacy("DELETE", `groups/${g1}`, { as: owner }),
      await procedure("accounts.groups.remove", { groupId: g2 }, { as: owner }),
      ids,
    );
  });

  it("grants：共享一块画布、列、撤", async () => {
    const m = await member("庚");
    expectSame(
      await legacy("PUT", "grants", {
        body: {
          workspaceId: "ws-a",
          subjectKind: "principal",
          subjectId: m,
          role: "viewer",
        },
        as: owner,
      }),
      await procedure(
        "accounts.grants.put",
        {
          workspaceId: "ws-b",
          subjectKind: "principal",
          subjectId: m,
          role: "viewer",
        },
        { as: owner },
      ),
      new Set([...ids, "workspaceId"]),
    );
    expectSame(
      await legacy("GET", "grants?workspaceId=ws-a", { as: owner }),
      await procedure(
        "accounts.grants.list",
        { workspaceId: "ws-a" },
        { as: owner },
      ),
    );
    expectSame(
      await legacy("DELETE", "grants", {
        body: { workspaceId: "ws-a", subjectKind: "principal", subjectId: m },
        as: owner,
      }),
      await procedure(
        "accounts.grants.revoke",
        { workspaceId: "ws-b", subjectKind: "principal", subjectId: m },
        { as: owner },
      ),
    );
    expectRefused(
      await legacy("DELETE", "grants", {
        body: { workspaceId: "ws-a", subjectKind: "principal", subjectId: m },
        as: owner,
      }),
      await procedure(
        "accounts.grants.revoke",
        { workspaceId: "ws-b", subjectKind: "principal", subjectId: m },
        { as: owner },
      ),
      "not_found",
    );
  });
});

/* ---------------------------------- 加固 ---------------------------------- */

describe("security：passkey、两步验证、会话、OAuth、审计（§42.2）", () => {
  it("passkey：登记、列、改名、删（软件认证器）", async () => {
    const a = await login(await member("辛"));
    const b = await login(await member("壬"));
    const options = [
      await legacy("POST", "passkey/register/options", {
        body: { label: "笔记本" },
        as: a,
      }),
      await procedure(
        "security.passkeys.registerOptions",
        { label: "笔记本" },
        { as: b },
      ),
    ] as const;
    expectSame(
      ...options,
      new Set(["challengeId", "challenge", "id", "name", "displayName"]),
    );
    const authenticator = new SoftAuthenticator();
    const begun = options.map(
      (answer) =>
        answer.body as {
          challengeId: string;
          options: Parameters<SoftAuthenticator["create"]>[0];
        },
    );
    const added = [
      await legacy("POST", "passkey/register/verify", {
        body: {
          challengeId: begun[0]!.challengeId,
          response: authenticator.create(begun[0]!.options, origin),
        },
        as: a,
      }),
      await procedure(
        "security.passkeys.registerVerify",
        {
          challengeId: begun[1]!.challengeId,
          response: authenticator.create(begun[1]!.options, origin),
        },
        { as: b },
      ),
    ] as const;
    expect(added[0].status).toBe(201);
    expectSame(...added, ids());
    const [k1, k2] = added.map(
      (answer) => (answer.body as { credentialId: string }).credentialId,
    ) as [string, string];
    expectSame(
      await legacy("GET", "passkey", { as: a }),
      await procedure("security.passkeys.list", undefined, { as: a }),
    );
    expectSame(
      await legacy("PATCH", `passkey/${k1}`, {
        body: { label: "台式机" },
        as: a,
      }),
      await procedure(
        "security.passkeys.rename",
        { credentialId: k2, label: "台式机" },
        { as: b },
      ),
      ids(),
    );
    // 别人的钥匙：改名一律 404，不说它在不在。
    expectRefused(
      await legacy("PATCH", `passkey/${k2}`, { body: { label: "x" }, as: a }),
      await procedure(
        "security.passkeys.rename",
        { credentialId: k1, label: "x" },
        { as: b },
      ),
      "not_found",
    );
    expectSame(
      await legacy("DELETE", `passkey/${k1}`, { as: a }),
      await procedure(
        "security.passkeys.remove",
        { credentialId: k2 },
        { as: b },
      ),
      ids(),
    );
  });

  it("两步验证：登记、确认、换恢复码、停用，owner 重置", async () => {
    const a = await login(await member("癸"));
    const b = await login(await member("子"));
    expectSame(
      await legacy("GET", "mfa", { as: a }),
      await procedure("security.mfa.status", undefined, { as: b }),
    );
    const enrolled = [
      await legacy("POST", "mfa/totp/enroll", { as: a }),
      await procedure("security.mfa.enroll", undefined, { as: b }),
    ] as const;
    expectSame(...enrolled, new Set(["secret", "otpauthUri"]));
    const [s1, s2] = enrolled.map(
      (answer) => (answer.body as { secret: string }).secret,
    ) as [string, string];
    const confirmed = [
      await legacy("POST", "mfa/totp/confirm", {
        body: { code: totpAt(s1, Date.now()) },
        as: a,
      }),
      await procedure(
        "security.mfa.confirm",
        { code: totpAt(s2, Date.now()) },
        { as: b },
      ),
    ] as const;
    expectSame(...confirmed, new Set(["recoveryCodes"]));
    const codes = confirmed.map(
      (answer) => (answer.body as { recoveryCodes: string[] }).recoveryCodes,
    ) as [string[], string[]];
    expectSame(
      await legacy("POST", "mfa/recovery-codes", {
        body: { code: codes[0][0] },
        as: a,
      }),
      await procedure(
        "security.mfa.regenerateRecoveryCodes",
        { code: codes[1][0] },
        { as: b },
      ),
      new Set(["recoveryCodes"]),
    );
    // 用过的恢复码再用：同一个具名码。
    expectRefused(
      await legacy("POST", "mfa/disable", {
        body: { code: codes[0][0] },
        as: a,
      }),
      await procedure("security.mfa.disable", { code: codes[1][0] }, { as: b }),
      "mfa_invalid_code",
    );
    expectSame(
      await legacy("POST", "mfa/reset", {
        body: { principalId: a.principalId },
        as: owner,
      }),
      await procedure(
        "security.mfa.reset",
        { principalId: b.principalId },
        { as: owner },
      ),
      ids(),
    );
    expectSame(
      await legacy("GET", "mfa", { as: a }),
      await procedure("security.mfa.status", undefined, { as: b }),
    );
  });

  it("会话：列（本人、全部）、撤一个、撤其它", async () => {
    const a = await member("丑");
    const first = await login(a);
    const second = await login(a);
    expectSame(
      await legacy("GET", "sessions", { as: first }),
      await procedure("security.sessions.list", {}, { as: first }),
      new Set(["lastSeenAtMs"]),
    );
    expectSame(
      await legacy("GET", "sessions?all=1", { as: owner }),
      await procedure("security.sessions.list", { all: true }, { as: owner }),
      new Set(["lastSeenAtMs"]),
    );
    const rows = (
      (await legacy("GET", "sessions", { as: first })).body as {
        sessions: { sessionId: string; current: boolean }[];
      }
    ).sessions;
    const other = rows.find((row) => !row.current)!.sessionId;
    const answer = await procedure(
      "security.sessions.revoke",
      { sessionId: other },
      { as: first },
    );
    expect(answer.body).toEqual({ sessionId: other, revoked: true });
    // 被撤的那条：门认不出它，procedure 下一次就 401。
    expect(
      (await procedure("identity.session", undefined, { as: second })).status,
    ).toBe(401);
    expectSame(
      await legacy("DELETE", `sessions/${other}`, { as: first }),
      await procedure(
        "security.sessions.revoke",
        { sessionId: other },
        { as: first },
      ),
    );
    expectSame(
      await legacy("POST", "sessions/revoke-others", { as: first }),
      await procedure("security.sessions.revokeOthers", undefined, {
        as: first,
      }),
    );
  });

  it("OAuth：提供方表、密钥与绑定（没配提供方时同码拒绝）", async () => {
    const m = await login(await member("寅"));
    for (const who of [owner, m]) {
      expectSame(
        await legacy("GET", "oauth/providers", { as: who }),
        await procedure("security.oauth.providers", undefined, { as: who }),
      );
      expectSame(
        await legacy("GET", "oauth/bindings", { as: who }),
        await procedure("security.oauth.bindings", undefined, { as: who }),
      );
    }
    expectRefused(
      await legacy("PUT", "oauth/providers/github/secret", {
        body: { clientSecret: "s3cret-value" },
        as: owner,
      }),
      await procedure(
        "security.oauth.setSecret",
        { providerId: "github", clientSecret: "s3cret-value" },
        { as: owner },
      ),
      "oauth_not_configured",
    );
    expectRefused(
      await legacy("DELETE", "oauth/providers/github/secret", { as: owner }),
      await procedure(
        "security.oauth.clearSecret",
        { providerId: "github" },
        { as: owner },
      ),
      "oauth_not_configured",
    );
    expectRefused(
      await legacy("DELETE", "oauth/bindings/nope", { as: m }),
      await procedure(
        "security.oauth.unbind",
        { credentialId: "nope" },
        { as: m },
      ),
      "not_found",
    );
  });

  it("审计：同样的筛选读到同一页，写错的筛选同码拒绝", async () => {
    expectSame(
      await legacy(
        "GET",
        "audit?action=identity.principal&action=identity.group&limit=5",
        { as: owner },
      ),
      await procedure(
        "security.audit.list",
        { action: ["identity.principal", "identity.group"], limit: 5 },
        { as: owner },
      ),
    );
    expectRefused(
      await legacy("GET", "audit?sinceMs=-1", { as: owner }),
      await procedure("security.audit.list", { sinceMs: -1 }, { as: owner }),
      "bad_request",
    );
  });
});

function ids(): ReadonlySet<string> {
  return new Set([
    "principalId",
    "credentialId",
    "createdAtMs",
    "challengeId",
    "challenge",
  ]);
}

/* ---------------------------------- 拒绝 ---------------------------------- */

describe("拒绝路径：两条路都拒", () => {
  it("无会话：401", async () => {
    for (const [method, path, name] of [
      ["GET", "session", "identity.session"],
      ["GET", "principals", "accounts.principals.list"],
      ["GET", "passkey", "security.passkeys.list"],
      ["POST", "sessions/revoke-others", "security.sessions.revokeOthers"],
    ] as const) {
      const rest = await legacy(method, path);
      const rpc = await procedure(name, undefined);
      expect(rest.status, path).toBe(401);
      expect((rest.body as { code: string }).code).toBe("UNAUTHENTICATED");
      expect(rpc.status, name).toBe(401);
      expect((rpc.body as { code: string }).code).toBe("unauthenticated");
    }
    // 伪造的 Bearer 同样认不出。
    const forged = { ...owner, accessToken: `${owner.accessToken}x` };
    expect((await legacy("GET", "session", { as: forged })).status).toBe(401);
    expect(
      (await procedure("identity.session", undefined, { as: forged })).status,
    ).toBe(401);
  });

  it("错 CSRF：Cookie 会话的写 403，带对的放行；Bearer 不要 CSRF", async () => {
    allowOrigins([COOKIE_ORIGIN]);
    try {
      const m = await member("卯");
      const cookie = await login(m, COOKIE_ORIGIN);
      expect(cookie.accessToken).toBe("");
      expect(cookie.cookie).not.toBe("");
      const wrong = "A".repeat(43);
      const rest = await legacy("POST", "sessions/revoke-others", {
        as: cookie,
        csrf: wrong,
      });
      const rpc = await procedure("security.sessions.revokeOthers", undefined, {
        as: cookie,
        csrf: wrong,
      });
      expect(rest.status).toBe(403);
      expect((rest.body as { code: string }).code).toBe("PERMISSION_DENIED");
      expect(rpc.status).toBe(403);
      expect((rpc.body as { code: string }).code).toBe("forbidden");
      // 不带 CSRF：procedure 一律是 POST，读也要。
      expect(
        (
          await procedure("security.sessions.list", undefined, {
            as: cookie,
          })
        ).status,
      ).toBe(403);
      expectSame(
        await legacy("POST", "sessions/revoke-others", {
          as: cookie,
          csrf: cookie.csrfToken,
        }),
        await procedure("security.sessions.revokeOthers", undefined, {
          as: cookie,
          csrf: cookie.csrfToken,
        }),
      );
      // Bearer：写也不要 CSRF。
      const bearer = await login(m);
      expect(
        (
          await procedure("security.sessions.revokeOthers", undefined, {
            as: bearer,
          })
        ).status,
      ).toBe(200);
    } finally {
      allowOrigins([]);
    }
  });

  it("成员越权：管别人的一律 403，本人的照常，别人的会话 404", async () => {
    const m = await login(await member("辰"));
    const ownerDevice = (
      (await legacy("GET", "session", { as: owner })).body as {
        device: { deviceId: string };
      }
    ).device.deviceId;
    const forbidden: [string, string, unknown, string, unknown][] = [
      [
        "POST",
        "principals",
        { displayName: "x" },
        "accounts.principals.create",
        { displayName: "x" },
      ],
      ["GET", "lockouts", undefined, "security.lockouts.list", undefined],
      [
        "POST",
        "mfa/reset",
        { principalId: owner.principalId },
        "security.mfa.reset",
        { principalId: owner.principalId },
      ],
      ["GET", "audit", undefined, "security.audit.list", {}],
      [
        "GET",
        "sessions?all=1",
        undefined,
        "security.sessions.list",
        { all: true },
      ],
      [
        "PUT",
        "oauth/providers/github/secret",
        { clientSecret: "x" },
        "security.oauth.setSecret",
        { providerId: "github", clientSecret: "x" },
      ],
      ["GET", "invitations", undefined, "accounts.invitations.list", undefined],
      [
        "PUT",
        "grants",
        {
          workspaceId: "ws-a",
          subjectKind: "principal",
          subjectId: m.principalId,
          role: "driver",
        },
        "accounts.grants.put",
        {
          workspaceId: "ws-a",
          subjectKind: "principal",
          subjectId: m.principalId,
          role: "driver",
        },
      ],
      [
        "POST",
        `principals/${owner.principalId}/password-reset`,
        undefined,
        "accounts.principals.issuePasswordReset",
        { principalId: owner.principalId },
      ],
      [
        "POST",
        "devices/revoke",
        { deviceId: ownerDevice, expectedRevision: 1 },
        "identity.devices.revoke",
        { deviceId: ownerDevice, expectedRevision: 1 },
      ],
    ];
    for (const [method, path, body, name, input] of forbidden) {
      const rest = await legacy(method, path, {
        ...(body === undefined ? {} : { body }),
        as: m,
      });
      const rpc = await procedure(name, input, { as: m });
      expect(rest.status, `${method} ${path}`).toBe(403);
      expectRefused(rest, rpc, "forbidden");
    }
    // 本人的照常。
    for (const [path, name] of [
      ["session", "identity.session"],
      ["passkey", "security.passkeys.list"],
      ["mfa", "security.mfa.status"],
    ] as const) {
      expectSame(
        await legacy("GET", path, { as: m }),
        await procedure(name, undefined, { as: m }),
      );
    }
    // 别人的会话：不说它存不存在。
    const mine = (
      (await legacy("GET", "sessions", { as: owner })).body as {
        sessions: { sessionId: string; current: boolean }[];
      }
    ).sessions.find((row) => row.current)!.sessionId;
    expectRefused(
      await legacy("DELETE", `sessions/${mine}`, { as: m }),
      await procedure(
        "security.sessions.revoke",
        { sessionId: mine },
        { as: m },
      ),
      "not_found",
    );
    // 停用之后，门按会话再认，procedure 下一次就 401。
    await legacy("POST", `principals/${m.principalId}/disable`, { as: owner });
    expect(
      (await procedure("identity.session", undefined, { as: m })).status,
    ).toBe(401);
  });

  it("锁定：连错之后要码的动作 429，等待秒数两条路一样；owner 看得见、解得开", async () => {
    const principalId = await member("巳");
    const m = await login(principalId);
    for (let attempt = 0; attempt < LOCK_THRESHOLD; attempt += 1) {
      const failed = await legacy("POST", "login", {
        body: { principalId, password: "not the password at all" },
        as: { ...owner, accessToken: "" },
      });
      expect(failed.status).toBe(401);
    }
    const rest = await legacy("POST", "mfa/disable", {
      body: { code: "000000" },
      as: m,
    });
    const rpc = await procedure(
      "security.mfa.disable",
      { code: "000000" },
      { as: m },
    );
    expect(rest.status).toBe(429);
    expectRefused(rest, rpc, "account_locked");
    const seconds = Number(rest.headers.get("retry-after"));
    expect(seconds).toBeGreaterThan(0);
    expect(
      (rpc.body as { details: { retryAfterSeconds: number } }).details
        .retryAfterSeconds,
    ).toBeGreaterThanOrEqual(seconds - 1);
    // RPC 门面对任何带 `details.retryAfterSeconds` 的 429 同时给 `Retry-After` 头（E3-8b）。
    expect(Number(rpc.headers.get("retry-after"))).toBeGreaterThan(0);
    const listed = [
      await legacy("GET", "lockouts", { as: owner }),
      await procedure("security.lockouts.list", undefined, { as: owner }),
    ] as const;
    expectSame(...listed);
    expect(JSON.stringify(listed[1].body)).toContain(principalId);
    expect(
      (
        await procedure(
          "security.lockouts.clear",
          { principalId },
          { as: owner },
        )
      ).body,
    ).toEqual({ principalId, unlocked: true });
    expectSame(
      await legacy("DELETE", `lockouts/${principalId}`, { as: owner }),
      await procedure(
        "security.lockouts.clear",
        { principalId },
        { as: owner },
      ),
    );
    // 审计：锁定与解锁都记着，口令不在里面。
    const audit = await procedure(
      "security.audit.list",
      { principalId, action: ["identity.lockout", "identity.login.failed"] },
      { as: owner },
    );
    expect(audit.status).toBe(200);
    const actions = (
      audit.body as { entries: { action: string }[] }
    ).entries.map((entry) => entry.action);
    expect(actions).toContain("identity.lockout");
    expect(JSON.stringify(audit.body)).not.toContain("not the password at all");
  });
});
