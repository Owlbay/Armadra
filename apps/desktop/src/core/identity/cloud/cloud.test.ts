import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { allowOrigins } from "../../http/cors";
import { installContract } from "../../http/rpc";
import { type Fixture, fixture } from "../../workspaces/fixture";
import { AccountsService } from "../accounts";
import { type AuditEvent, installAuditSink, resetAuditSink } from "../audit";
import { Authorizer } from "../authorize";
import { disableLinkGuests } from "../grant-sync";
import { roleScopes, sessionViewerScopes } from "../roles";
import { allScopes, scope } from "../scopes";
import { IdentityService } from "../service";
import { IdentityStore } from "../store";
import {
  ISSUER,
  REGISTRATION_TOKEN,
  type FakeRelayWorld,
  fakeRelay,
  fakeRelayWorld,
  memoryBackend,
  signAssertion,
} from "./fake.fixture";
import { type CloudService, cloudProvider, installCloud } from "./index";

/**
 * 装配好的云登录域经 HTTP（契约 §31）：登记、撤销、状态、可信来源、绑定与
 * `cloud/login`；procedure 与旧路径同一份实现；凭据（注册令牌、源私钥）不出现在
 * 任何答案里。远程服务是 `fake.fixture.ts` 的假个人中转。
 */

const INSTANCE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://127.0.0.1:1420";

let core: Fixture;
let world: FakeRelayWorld;
let relay: ReturnType<typeof fakeRelay>;
let backend: ReturnType<typeof memoryBackend>;
let store: IdentityStore;
let service: IdentityService;
let accounts: AccountsService;
let cloud: CloudService;
let base: string;
let audits: AuditEvent[];
let orgRole: "viewer" | null;
let owner: { accessToken: string; principalId: string };

beforeEach(async () => {
  world = fakeRelayWorld();
  relay = fakeRelay();
  backend = memoryBackend();
  audits = [];
  orgRole = null;
  installAuditSink((event) => void audits.push(event));
  core = fixture([
    (context) => {
      store = new IdentityStore(context.db.database);
      service = new IdentityService(store, INSTANCE);
      accounts = new AccountsService({ store });
      cloud = installCloud(context, {
        store,
        service,
        accounts,
        authorizer: new Authorizer(store),
        capabilities: () => ["identity.native-session.v1"],
        coreVersion: "0.0.0-test",
        transport: world.transport,
        secrets: () => backend,
        orgDefaultRole: () => orgRole,
      });
      cloud.attachRelay(relay);
    },
  ]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const ticket = service.issueBootstrap({
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: ORIGIN,
    deviceName: "本机桌面",
    scopes: allScopes(),
  });
  const paired = service.consumeBootstrap({
    ticket: ticket.ticket,
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: ORIGIN,
  });
  owner = {
    accessToken: paired.accessToken,
    principalId: paired.principal.principalId,
  };
});

afterEach(async () => {
  resetAuditSink();
  allowOrigins([]);
  await core.server.close();
  core.close();
});

interface Answer {
  status: number;
  text: string;
  body: Record<string, unknown>;
  headers: Headers;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  options: { token?: string; origin?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      origin: options.origin ?? ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
    headers: response.headers,
  };
}

async function rpc(procedure: string, input: unknown = {}): Promise<Answer> {
  const response = await fetch(
    `${base}/api/rpc/${procedure.replaceAll(".", "/")}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    },
  );
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
    headers: response.headers,
  };
}

const asOwner = () => ({ token: owner.accessToken });

async function register(): Promise<Answer> {
  return call(
    "POST",
    "/api/identity/cloud/register",
    { issuer: ISSUER, registrationToken: REGISTRATION_TOKEN, label: "laptop" },
    asOwner(),
  );
}

function assertion(extra: Parameters<typeof signAssertion>[0]["extra"] = {}) {
  return signAssertion({ aud: store.hostId(), nowMs: Date.now(), extra });
}

function sub(value: string) {
  return signAssertion({ aud: store.hostId(), nowMs: Date.now(), sub: value });
}

describe("登记", () => {
  it("成功：写行、起隧道不阻塞、交给远程服务的是本机标识与源公钥", async () => {
    const answer = await register();
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body).toMatchObject({
      issuer: ISSUER,
      sourceId: store.hostId(),
      relayOrigins: [ISSUER],
      trustedOrigins: [ISSUER],
      tunnel: { state: "connecting" },
    });
    expect(relay.started).toEqual([ISSUER]);
    expect(world.registered).toMatchObject({
      sourceId: store.hostId(),
      name: "laptop",
      kind: "desktop",
      coreVersion: "0.0.0-test",
      capabilities: ["identity.native-session.v1"],
      protocol: { major: 1, minor: 1 },
      publicKey: { kty: "OKP", crv: "Ed25519", kid: store.hostId() },
    });
    expect(cloud.registered(ISSUER)).toBe(true);
    // 注册令牌与源私钥不出现在答案里；私钥只在 SecretStore。
    const secret = backend.values.get("armadra-cloud-source-key") ?? "";
    expect(secret.length).toBeGreaterThan(40);
    expect(answer.text).not.toContain(REGISTRATION_TOKEN);
    expect(answer.text).not.toContain(secret);
    expect(audits.map((event) => event.action)).toContain("cloud.register");
    expect(JSON.stringify(audits)).not.toContain(REGISTRATION_TOKEN);
  });

  it("状态：登记行、源公钥与本机标识；procedure 与旧路径同答", async () => {
    await register();
    const legacy = await call(
      "GET",
      "/api/identity/cloud",
      undefined,
      asOwner(),
    );
    expect(legacy.status, legacy.text).toBe(200);
    const procedure = await rpc("identity.cloud.status");
    expect(procedure.status, procedure.text).toBe(200);
    expect(procedure.body.json).toEqual(legacy.body);
    expect(legacy.body).toMatchObject({
      sourceId: store.hostId(),
      sourcePublicKey: { kty: "OKP", crv: "Ed25519", kid: store.hostId() },
      registrations: [
        {
          issuer: ISSUER,
          mode: "personal",
          label: "laptop",
          trustedOrigins: [ISSUER],
          relayOrigins: [ISSUER],
          tunnel: { state: "connecting" },
        },
      ],
    });
    expect(legacy.text).not.toContain(
      backend.values.get("armadra-cloud-source-key") ?? "-",
    );
  });

  it("再登记同一个 issuer：409 cloud_already_registered", async () => {
    await register();
    const again = await register();
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("cloud_already_registered");
  });

  it("旧路径带 fingerprint：先钉扎再登记，登记与取公钥都按它验；失败不留钉", async () => {
    const pin = "ab".repeat(32);
    const pinned = () =>
      call(
        "POST",
        "/api/identity/cloud/register",
        {
          issuer: ISSUER,
          registrationToken: REGISTRATION_TOKEN,
          fingerprint: pin,
        },
        asOwner(),
      );
    world.refuseRegister = { status: 401, code: "registration_token_invalid" };
    expect((await pinned()).status).toBe(401);
    expect(
      core.db.database.prepare("SELECT 1 FROM remote_services").get(),
    ).toBeUndefined();
    const answer = await pinned();
    expect(answer.status, answer.text).toBe(200);
    expect(cloud.fingerprint(ISSUER)).toBe(pin);
    expect(world.requests.every((request) => request.fingerprint === pin)).toBe(
      true,
    );
    expect(answer.text).not.toContain(pin);
    await call(
      "DELETE",
      `/api/identity/cloud/register?issuer=${encodeURIComponent(ISSUER)}`,
      undefined,
      asOwner(),
    );
    const bad = await call(
      "POST",
      "/api/identity/cloud/register",
      { issuer: ISSUER, registrationToken: "x", fingerprint: "zz" },
      asOwner(),
    );
    expect(bad.status).toBe(400);
    const other = await call(
      "POST",
      "/api/identity/cloud/register",
      { issuer: ISSUER, registrationToken: "x", fingerprint: "cd".repeat(32) },
      asOwner(),
    );
    expect(other.body.code).toBe("fingerprint_mismatch");
  });

  it("协议 major 不符 426、自报 issuer 不符 400、SaaS 501，都不留行", async () => {
    world.info = { ...world.info, protocol: { major: 2, minor: 0 } };
    expect((await register()).body.code).toBe("protocol_unsupported");
    expect((await register()).status).toBe(426);
    world.info = {
      ...world.info,
      protocol: { major: 1, minor: 0 },
      issuer: "https://elsewhere.test",
    };
    const mismatch = await register();
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe("cloud_issuer_mismatch");
    world.info = { ...world.info, issuer: ISSUER, mode: "saas" };
    const saas = await register();
    expect(saas.status).toBe(501);
    expect(saas.body.code).toBe("not_implemented");
    expect(cloud.registered(ISSUER)).toBe(false);
    expect(relay.started).toEqual([]);
  });

  it("注册令牌无效透传 401；公钥集指到别处 400；远程服务不可达 502", async () => {
    const bad = await call(
      "POST",
      "/api/identity/cloud/register",
      { issuer: ISSUER, registrationToken: "wrong" },
      asOwner(),
    );
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe("registration_token_invalid");
    world.registerOverride = { jwksUrl: "https://evil.test/jwks.json" };
    const elsewhere = await register();
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body.code).toBe("cloud_issuer_mismatch");
    const offline = await call(
      "POST",
      "/api/identity/cloud/register",
      { issuer: "https://offline.test", registrationToken: "x" },
      asOwner(),
    );
    expect(offline.status).toBe(502);
    expect(offline.body.code).toBe("source_unreachable");
    expect(cloud.registered(ISSUER)).toBe(false);
  });

  it("没有会话 401；成员没有 settings:write 403", async () => {
    const anonymous = await call("POST", "/api/identity/cloud/register", {
      issuer: ISSUER,
      registrationToken: REGISTRATION_TOKEN,
    });
    expect(anonymous.status).toBe(401);
    const member = await memberSession();
    const refused = await call(
      "POST",
      "/api/identity/cloud/register",
      { issuer: ISSUER, registrationToken: REGISTRATION_TOKEN },
      { token: member.accessToken },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("forbidden");
    const status = await call("GET", "/api/identity/cloud", undefined, {
      token: member.accessToken,
    });
    expect(status.status).toBe(403);
    expect(world.requests).toEqual([]);
  });
});

/** 一个经邀请注册、没有任何授予的成员。 */
async function memberSession() {
  const ownerSubject = {
    principalId: owner.principalId,
    kind: "owner" as const,
    scopes: allScopes(),
  };
  const invitation = accounts.issueInvitation(ownerSubject, {
    role: "viewer",
    targetWorkspaceId: "ws-1",
  });
  const joined = accounts.registerWithInvitation({
    invitationId: invitation.invitationId,
    token: invitation.token,
    displayName: "Member",
    password: "correct horse battery staple",
  });
  return service.openSession({
    principalId: joined.principalId,
    hostId: store.hostId(),
    origin: ORIGIN,
    deviceName: "member",
    method: "password",
  });
}

describe("撤销", () => {
  it("停隧道、行记撤销；之后它签的断言 cloud_not_registered；再撤 404", async () => {
    await register();
    const revoked = await call(
      "DELETE",
      "/api/identity/cloud/register",
      { issuer: ISSUER },
      asOwner(),
    );
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.body).toEqual({});
    expect(relay.stopped).toEqual([ISSUER]);
    expect(cloud.registered(ISSUER)).toBe(false);
    const login = await call("POST", "/api/identity/cloud/login", {
      assertion: assertion(),
    });
    expect(login.status).toBe(401);
    expect(login.body.code).toBe("cloud_not_registered");
    const again = await rpc("identity.cloud.revoke", { issuer: ISSUER });
    expect(again.status).toBe(404);
    expect(audits.map((event) => event.action)).toContain("cloud.revoke");
    // 撤销之后可以再登记。
    expect((await register()).status).toBe(200);
  });

  it("没挂删源那一步（没有远程服务会话）：本机照样撤销，记为中继侧待清理", async () => {
    await register();
    const revoked = await rpc("identity.cloud.revoke", { issuer: ISSUER });
    expect(revoked.status, revoked.text).toBe(200);
    expect(cloud.registered(ISSUER)).toBe(false);
    const pending = await call(
      "GET",
      "/api/identity/cloud/relay-pending",
      undefined,
      asOwner(),
    );
    expect(pending.status, pending.text).toBe(200);
    expect(pending.body).toEqual({
      pending: [
        {
          issuer: ISSUER,
          revokedAtMs: expect.any(Number),
          code: "source_unauthorized",
        },
      ],
    });
    expect(
      audits.find((event) => event.action === "cloud.revoke")?.detail,
    ).toEqual({ issuer: ISSUER, relayCleanup: "pending" });
  });

  it("删源成功：中继侧不欠；失败记码，重试成功后清掉；不欠的重试 404", async () => {
    await register();
    const calls: [string, string][] = [];
    let failWith: string | null = "source_unreachable";
    cloud.attachRelayCleaner(async (issuer, sourceId) => {
      calls.push([issuer, sourceId]);
      if (failWith !== null) {
        const { fail } = await import("../../http/errors");
        throw fail(failWith as "source_unreachable", "x");
      }
    });
    expect(
      (await rpc("identity.cloud.revoke", { issuer: ISSUER })).status,
    ).toBe(200);
    expect(calls).toEqual([[ISSUER, store.hostId()]]);
    expect((await rpc("identity.cloud.relayPending")).body.json).toEqual({
      pending: [
        {
          issuer: ISSUER,
          revokedAtMs: expect.any(Number),
          code: "source_unreachable",
        },
      ],
    });
    failWith = "source_unauthorized";
    const retry = await call(
      "POST",
      "/api/identity/cloud/relay-cleanup",
      { issuer: ISSUER },
      asOwner(),
    );
    expect(retry.body).toEqual({ pending: true, code: "source_unauthorized" });
    failWith = null;
    expect(
      (await rpc("identity.cloud.relayCleanup", { issuer: ISSUER })).body.json,
    ).toEqual({ pending: false, code: null });
    expect((await rpc("identity.cloud.relayPending")).body.json).toEqual({
      pending: [],
    });
    expect(
      (await rpc("identity.cloud.relayCleanup", { issuer: ISSUER })).status,
    ).toBe(404);
    // 再登记、再撤销：这次一次删掉，不欠。
    expect((await register()).status).toBe(200);
    expect(
      (await rpc("identity.cloud.revoke", { issuer: ISSUER })).status,
    ).toBe(200);
    expect((await rpc("identity.cloud.relayPending")).body.json).toEqual({
      pending: [],
    });
  });

  it("中继自己撤的（隧道收到 source_revoked）：不去删，也不欠", async () => {
    await register();
    const calls: string[] = [];
    cloud.attachRelayCleaner(async (issuer) => {
      calls.push(issuer);
    });
    await cloud.revoke({ issuer: ISSUER }, undefined, { relaySide: "revoked" });
    expect(calls).toEqual([]);
    expect(cloud.relayPending()).toEqual({ pending: [] });
  });

  it("放弃清理（§31.5）：只删本机的登记，不再去删中继侧；审计 cloud.relayDismiss；不欠的 404", async () => {
    await register();
    const calls: string[] = [];
    cloud.attachRelayCleaner(async (issuer) => {
      calls.push(issuer);
      const { fail } = await import("../../http/errors");
      throw fail("source_unreachable", "x");
    });
    await rpc("identity.cloud.revoke", { issuer: ISSUER });
    expect(cloud.relayPending().pending).toHaveLength(1);
    const dismissed = await call(
      "POST",
      "/api/identity/cloud/relay-dismiss",
      { issuer: ISSUER },
      asOwner(),
    );
    expect(dismissed.status, dismissed.text).toBe(200);
    expect(dismissed.body).toEqual({});
    expect(calls).toEqual([ISSUER]);
    expect(cloud.relayPending()).toEqual({ pending: [] });
    expect(
      audits.find((event) => event.action === "cloud.relayDismiss")?.detail,
    ).toEqual({ issuer: ISSUER });
    expect(
      (await rpc("identity.cloud.relayDismiss", { issuer: ISSUER })).status,
    ).toBe(404);
    expect(
      (await rpc("identity.cloud.relayCleanup", { issuer: ISSUER })).status,
    ).toBe(404);
  });

  it("待清理要 settings:read / settings:write：没有会话 401", async () => {
    expect(
      (await call("GET", "/api/identity/cloud/relay-pending")).status,
    ).toBe(401);
    expect(
      (
        await call("POST", "/api/identity/cloud/relay-cleanup", {
          issuer: ISSUER,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("POST", "/api/identity/cloud/relay-dismiss", {
          issuer: ISSUER,
        })
      ).status,
    ).toBe(401);
  });
});

describe("可信来源", () => {
  it("规范拼法、去重；不合法 400；没登记 404", async () => {
    await register();
    const path = `/api/identity/cloud/${encodeURIComponent(ISSUER)}/trusted-origins`;
    const put = await call(
      "PUT",
      path,
      {
        origins: [
          "https://App.test",
          "https://app.test",
          "http://127.0.0.1:5173",
        ],
      },
      asOwner(),
    );
    expect(put.status, put.text).toBe(200);
    expect(put.body).toEqual({
      origins: ["https://app.test", "http://127.0.0.1:5173"],
    });
    const bad = await call("PUT", path, { origins: ["ftp://x"] }, asOwner());
    expect(bad.status).toBe(400);
    const missing = await rpc("identity.cloud.trustedOrigins", {
      issuer: "https://other.test",
      origins: [],
    });
    expect(missing.status).toBe(404);
  });
});

describe("cloud/login", () => {
  beforeEach(async () => {
    expect((await register()).status).toBe(200);
  });

  it("没有映射也没有邀请：401 cloud_account_unlinked", async () => {
    const answer = await call("POST", "/api/identity/cloud/login", {
      assertion: assertion(),
    });
    expect(answer.status).toBe(401);
    expect(answer.body.code).toBe("cloud_account_unlinked");
  });

  it("owner 绑定之后：断言换 owner 的原生会话，重复登录幂等", async () => {
    const bound = await call(
      "POST",
      "/api/identity/cloud/bind",
      { assertion: assertion() },
      asOwner(),
    );
    expect(bound.status, bound.text).toBe(200);
    expect(bound.body).toEqual({ bound: true });
    for (let round = 0; round < 2; round += 1) {
      const answer = await call("POST", "/api/identity/cloud/login", {
        assertion: assertion(),
      });
      expect(answer.status, answer.text).toBe(200);
      const session = answer.body.session as {
        hostId: string;
        native?: { accessToken: string; refreshToken: string };
      };
      expect(session.hostId).toBe(store.hostId());
      expect(session.native?.refreshToken.length).toBeGreaterThan(20);
      expect(answer.body.principal).toMatchObject({
        principalId: owner.principalId,
        kind: "owner",
      });
      expect(answer.body.created).toBe(false);
      expect(answer.headers.get("set-cookie")).toBeNull();
      // 换来的会话真能用。
      const status = await call("GET", "/api/identity/cloud", undefined, {
        token: session.native!.accessToken,
      });
      expect(status.status).toBe(200);
    }
    const logins = audits.filter((event) => event.action === "cloud.login");
    expect(logins).toHaveLength(0); // 登录审计写在库里，不经 sink。
    const rows = core.database
      .prepare(
        "SELECT action, detail_json FROM audit_log WHERE action IN ('cloud.login', 'cloud.bind', 'identity.login') ORDER BY id",
      )
      .all() as { action: string; detail_json: string }[];
    expect(rows.map((row) => row.action)).toEqual([
      "cloud.bind",
      "identity.login",
      "cloud.login",
      "identity.login",
      "cloud.login",
    ]);
    expect(rows[1]?.detail_json).toBe('{"method":"cloud"}');
    expect(JSON.parse(rows[2]!.detail_json)).toMatchObject({
      iss: ISSUER,
      sub: "acct:dev",
      principalId: owner.principalId,
    });
  });

  it("同一张断言用第二次 401 replayed；篡改过的 401 invalid", async () => {
    await call(
      "POST",
      "/api/identity/cloud/bind",
      { assertion: assertion() },
      asOwner(),
    );
    const token = assertion();
    expect(
      (await call("POST", "/api/identity/cloud/login", { assertion: token }))
        .status,
    ).toBe(200);
    const replayed = await call("POST", "/api/identity/cloud/login", {
      assertion: token,
    });
    expect(replayed.status).toBe(401);
    expect(replayed.body.code).toBe("cloud_assertion_replayed");
    const [head, body, signature] = assertion().split(".");
    const claims = JSON.parse(
      Buffer.from(body as string, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    claims.aud = "f".repeat(32);
    const forged = await call("POST", "/api/identity/cloud/login", {
      assertion: `${head}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`,
    });
    expect(forged.status).toBe(401);
    expect(forged.body.code).toBe("cloud_assertion_invalid");
    const wrongAud = await call("POST", "/api/identity/cloud/login", {
      assertion: signAssertion({ aud: "f".repeat(32), nowMs: Date.now() }),
    });
    expect(wrongAud.body.code).toBe("cloud_assertion_invalid");
    const expired = await call("POST", "/api/identity/cloud/login", {
      assertion: signAssertion({
        aud: store.hostId(),
        nowMs: Date.now() - 20 * 60 * 1000,
      }),
    });
    expect(expired.body.code).toBe("cloud_assertion_invalid");
  });

  it("带邀请：建成员、写映射、兑换邀请，经链接的记 invitation.accept.link", async () => {
    const ownerSubject = {
      principalId: owner.principalId,
      kind: "owner" as const,
      scopes: allScopes(),
    };
    const invitation = accounts.issueInvitation(ownerSubject, {
      role: "viewer",
      targetWorkspaceId: "ws-1",
    });
    const guest = "guest:lnk_1:abc";
    const link = { linkId: "lnk_1", invitationId: invitation.invitationId };
    const answer = await call("POST", "/api/identity/cloud/login", {
      assertion: signAssertion({
        aud: store.hostId(),
        nowMs: Date.now(),
        sub: guest,
        extra: { name: "Guest", link },
      }),
      invitationToken: invitation.token,
    });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.created).toBe(true);
    expect(answer.body.principal).toMatchObject({
      kind: "member",
      displayName: "Guest",
    });
    const principalId = (answer.body.principal as { principalId: string })
      .principalId;
    // 映射写下了：下一次不带邀请也能进，且是同一个人。
    const again = await call("POST", "/api/identity/cloud/login", {
      assertion: signAssertion({
        aud: store.hostId(),
        nowMs: Date.now(),
        sub: guest,
      }),
    });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect((again.body.principal as { principalId: string }).principalId).toBe(
      principalId,
    );
    const mapped = store.transaction((tx) =>
      tx.accounts.liveOAuth(cloudProvider(ISSUER), guest),
    );
    expect(mapped?.principalId).toBe(principalId);
    // 邀请给的那条授予在。
    const grants = store.transaction((tx) =>
      tx.accounts.grantsFor(principalId),
    );
    expect(grants.map((grant) => [grant.workspaceId, grant.role])).toEqual([
      ["ws-1", "viewer"],
    ]);
    const actions = (
      core.database
        .prepare("SELECT action FROM audit_log ORDER BY id")
        .all() as { action: string }[]
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(["cloud.login", "invitation.accept.link"]),
    );
    // 用过的邀请不能再用。
    const reused = await call("POST", "/api/identity/cloud/login", {
      assertion: signAssertion({
        aud: store.hostId(),
        nowMs: Date.now(),
        sub: "guest:lnk_1:other",
      }),
      invitationToken: invitation.token,
    });
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe("invitation_invalid");
  });

  it("链接指向的邀请与令牌不是同一张：invitation_invalid", async () => {
    const ownerSubject = {
      principalId: owner.principalId,
      kind: "owner" as const,
      scopes: allScopes(),
    };
    const invitation = accounts.issueInvitation(ownerSubject, {
      role: "viewer",
      targetWorkspaceId: "ws-1",
    });
    const answer = await call("POST", "/api/identity/cloud/login", {
      assertion: signAssertion({
        aud: store.hostId(),
        nowMs: Date.now(),
        sub: "guest:lnk_2:x",
        extra: { link: { linkId: "lnk_2", invitationId: "f".repeat(32) } },
      }),
      invitationToken: invitation.token,
    });
    expect(answer.status).toBe(401);
    expect(answer.body.code).toBe("invitation_invalid");
  });

  it("组织默认角色：只对新建的人、只在声明带 org 且设了角色时逐条授予", async () => {
    core.database
      .prepare(
        "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, '2026-01-01', '2026-01-01')",
      )
      .run("ws-a", "A", "/tmp/armadra-cloud-ws-a");
    const ownerSubject = {
      principalId: owner.principalId,
      kind: "owner" as const,
      scopes: allScopes(),
    };
    orgRole = "viewer";
    const invitation = accounts.issueInvitation(ownerSubject, {
      role: "editor",
      targetWorkspaceId: "ws-b",
    });
    const answer = await call("POST", "/api/identity/cloud/login", {
      assertion: signAssertion({
        aud: store.hostId(),
        nowMs: Date.now(),
        sub: "acct:org-member",
        extra: { org: { orgId: "org_1", role: "member" } },
      }),
      invitationToken: invitation.token,
    });
    expect(answer.status, answer.text).toBe(200);
    const principalId = (answer.body.principal as { principalId: string })
      .principalId;
    const grants = store
      .transaction((tx) => tx.accounts.grantsFor(principalId))
      .map((grant) => [grant.workspaceId, grant.role])
      .sort();
    expect(grants).toEqual([
      ["ws-a", "viewer"],
      ["ws-b", "editor"],
    ]);
  });

  it("停用的人：403；同一个 sub 一分钟第 6 次：429", async () => {
    await call(
      "POST",
      "/api/identity/cloud/bind",
      { assertion: sub("acct:limited") },
      asOwner(),
    );
    for (let round = 0; round < 4; round += 1) {
      const ok = await call("POST", "/api/identity/cloud/login", {
        assertion: sub("acct:limited"),
      });
      expect(ok.status, ok.text).toBe(200);
    }
    const limited = await call("POST", "/api/identity/cloud/login", {
      assertion: sub("acct:limited"),
    });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(limited.headers.get("retry-after")).not.toBeNull();

    const member = await memberSession();
    await call(
      "POST",
      "/api/identity/cloud/bind",
      { assertion: sub("acct:disabled") },
      { token: member.accessToken },
    );
    accounts.disablePrincipal(
      { principalId: owner.principalId, kind: "owner", scopes: allScopes() },
      member.principal.principalId,
    );
    const disabled = await call("POST", "/api/identity/cloud/login", {
      assertion: sub("acct:disabled"),
    });
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe("forbidden");
  });

  it("绑定：已关联到别人 409；没有会话 401", async () => {
    const member = await memberSession();
    const token = sub("acct:shared");
    expect(
      (
        await call(
          "POST",
          "/api/identity/cloud/bind",
          { assertion: token },
          { token: member.accessToken },
        )
      ).status,
    ).toBe(200);
    const taken = await call(
      "POST",
      "/api/identity/cloud/bind",
      { assertion: sub("acct:shared") },
      asOwner(),
    );
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("conflict");
    const anonymous = await call("POST", "/api/identity/cloud/bind", {
      assertion: sub("acct:other"),
    });
    expect(anonymous.status).toBe(401);
  });

  it("Cookie 来源：发 HttpOnly Cookie，体里没有 native", async () => {
    await call(
      "POST",
      "/api/identity/cloud/bind",
      { assertion: assertion() },
      asOwner(),
    );
    allowOrigins(["https://app.test"]);
    const answer = await call(
      "POST",
      "/api/identity/cloud/login",
      { assertion: assertion() },
      { origin: "https://app.test" },
    );
    expect(answer.status, answer.text).toBe(200);
    const session = answer.body.session as Record<string, unknown>;
    expect(session.native).toBeUndefined();
    expect(typeof session.csrfToken).toBe("string");
    const cookies = answer.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain(`armadra_${store.hostId()}_access=`);
  });

  it("login 不经 RPC：501；没有来源 403；坏体 400", async () => {
    const procedure = await rpc("identity.cloud.login", {
      assertion: assertion(),
    });
    expect(procedure.status).toBe(501);
    const noOrigin = await fetch(`${base}/api/identity/cloud/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: assertion() }),
    });
    expect(noOrigin.status).toBe(403);
    const bad = await call("POST", "/api/identity/cloud/login", {
      assertion: 42,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("bad_request");
    const unknown = await call("GET", "/api/identity/cloud/nothing");
    expect(unknown.status).toBe(404);
  });
});

describe("装配", () => {
  it("没有登记时不联网、不碰 SecretStore", () => {
    expect(world.requests).toEqual([]);
    expect(backend.sets).toBe(0);
    expect(scope("settings:write").Permission).toBe("settings:write");
  });
});

describe("cloud/login 的范围、角色同步与租约（契约 §60）", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ownerSubject = () => ({
    principalId: owner.principalId,
    kind: "owner" as const,
    scopes: allScopes(),
  });
  const login = async (
    subject: string,
    extra: Record<string, unknown>,
    invitationToken?: string,
  ) =>
    call("POST", "/api/identity/cloud/login", {
      assertion: signAssertion({
        aud: store.hostId(),
        nowMs: Date.now(),
        sub: subject,
        extra,
      }),
      ...(invitationToken === undefined ? {} : { invitationToken }),
    });
  const principalOf = (answer: Answer) =>
    (answer.body.principal as { principalId: string }).principalId;
  const grantsOf = (principalId: string, nowMs = Date.now()) =>
    store
      .transaction((tx) => tx.accounts.grantsFor(principalId, nowMs))
      .map((grant) => [
        grant.targetKind,
        grant.workspaceId,
        grant.targetId,
        grant.role,
        grant.origin,
      ])
      .sort();

  beforeEach(async () => {
    expect((await register()).status).toBe(200);
  });

  it("scp 空：邀请照旧兑换，授予记签发方并带租约，编译结果与旧版相同", async () => {
    const invitation = accounts.issueInvitation(ownerSubject(), {
      role: "editor",
      targetWorkspaceId: "ws-1",
    });
    const answer = await login("acct:plain", {}, invitation.token);
    expect(answer.status, answer.text).toBe(200);
    const principalId = principalOf(answer);
    expect(grantsOf(principalId)).toEqual([
      ["workspace", "ws-1", "", "editor", cloudProvider(ISSUER)],
    ]);
    const [row] = store.transaction((tx) => tx.accounts.grantsFor(principalId));
    expect(row!.expiresAtMs).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(accounts.effectiveGrantScopes(principalId)).toEqual(
      roleScopes("editor", "ws-1"),
    );
  });

  it("scp 带 ro：可写的邀请也只兑换成 viewer", async () => {
    const invitation = accounts.issueInvitation(ownerSubject(), {
      role: "editor",
      targetWorkspaceId: "ws-1",
      maxUses: 5,
    });
    const answer = await login(
      "guest:lnk_ro:a",
      { scp: ["ws:ws-1", "ro"] },
      invitation.token,
    );
    expect(answer.status, answer.text).toBe(200);
    expect(grantsOf(principalOf(answer))).toEqual([
      ["workspace", "ws-1", "", "viewer", cloudProvider(ISSUER)],
    ]);
  });

  it("scp 与邀请的终点对不上：invitation_invalid，不建人", async () => {
    const invitation = accounts.issueInvitation(ownerSubject(), {
      role: "viewer",
      targetWorkspaceId: "ws-1",
    });
    const answer = await login(
      "guest:lnk_x:a",
      { scp: ["ws:ws-2"] },
      invitation.token,
    );
    expect(answer.status).toBe(401);
    expect(answer.body.code).toBe("invitation_invalid");
    expect(
      store.transaction((tx) =>
        tx.accounts.liveOAuth(cloudProvider(ISSUER), "guest:lnk_x:a"),
      ),
    ).toBeUndefined();
  });

  it("会话邀请：兑换成只读那一条会话的授予", async () => {
    expect(() =>
      accounts.issueInvitation(ownerSubject(), {
        role: "editor",
        targetWorkspaceId: "ws-1",
        targetSessionId: "t1",
      }),
    ).toThrow();
    const invitation = accounts.issueInvitation(ownerSubject(), {
      role: "viewer",
      targetWorkspaceId: "ws-1",
      targetSessionId: "t1",
    });
    const answer = await login(
      "guest:lnk_s:a",
      { scp: ["ws:ws-1", "sess:t1", "ro"] },
      invitation.token,
    );
    expect(answer.status, answer.text).toBe(200);
    const principalId = principalOf(answer);
    expect(grantsOf(principalId)).toEqual([
      ["session", "ws-1", "t1", "viewer", cloudProvider(ISSUER)],
    ]);
    expect(accounts.effectiveGrantScopes(principalId)).toEqual(
      sessionViewerScopes("ws-1", "t1"),
    );
  });

  it("整台邀请：只有 owner 签得出，兑换成整台授予", async () => {
    const invitation = accounts.issueInvitation(ownerSubject(), {
      role: "operator",
      targetHost: true,
    });
    const answer = await login("guest:lnk_h:a", {}, invitation.token);
    expect(answer.status, answer.text).toBe(200);
    expect(grantsOf(principalOf(answer))).toEqual([
      ["host", "*", "", "operator", cloudProvider(ISSUER)],
    ]);
  });

  it("SaaS：带 org + role 不要邀请就建成员，之后按声明整份同步，本地授予不动", async () => {
    core.database
      .prepare("UPDATE cloud_registrations SET mode = 'saas' WHERE issuer = ?")
      .run(ISSUER);
    const org = { orgId: "org_1", role: "member" };
    const first = await login("acct:saas", { org, role: "editor" });
    expect(first.status, first.text).toBe(200);
    expect(first.body.created).toBe(true);
    const principalId = principalOf(first);
    expect(grantsOf(principalId)).toEqual([
      ["host", "*", "", "editor", cloudProvider(ISSUER)],
    ]);
    accounts.putGrant(ownerSubject(), {
      workspaceId: "ws-local",
      subjectKind: "principal",
      subjectId: principalId,
      role: "driver",
    });
    const second = await login("acct:saas", {
      org,
      team: { teamId: "team_1", role: "member" },
      role: "editor",
      scp: ["ws:ws-1", "ro"],
    });
    expect(second.status, second.text).toBe(200);
    expect(second.body.created).toBe(false);
    expect(grantsOf(principalId)).toEqual([
      ["workspace", "ws-1", "", "viewer", cloudProvider(ISSUER)],
      ["workspace", "ws-local", "", "driver", ""],
    ]);
    const detail = JSON.parse(
      (
        core.database
          .prepare(
            "SELECT detail_json FROM audit_log WHERE action = 'cloud.login' ORDER BY id DESC LIMIT 1",
          )
          .get() as { detail_json: string }
      ).detail_json,
    ) as Record<string, unknown>;
    expect(detail).toMatchObject({
      org: "org_1",
      team: "team_1",
      role: "editor",
      scp: ["ws:ws-1", "ro"],
    });
    expect(typeof detail.jti).toBe("string");
  });

  it("个人中转不带 role：没有邀请仍然 cloud_account_unlinked", async () => {
    const answer = await login("acct:nobody", {
      org: { orgId: "org_1", role: "member" },
      role: "editor",
    });
    expect(answer.status).toBe(401);
    expect(answer.body.code).toBe("cloud_account_unlinked");
  });

  it("租约：到期后授予不再编译；再登录一次续上", async () => {
    const invitation = accounts.issueInvitation(ownerSubject(), {
      role: "viewer",
      targetWorkspaceId: "ws-1",
    });
    const answer = await login("acct:lease", {}, invitation.token);
    const principalId = principalOf(answer);
    const later = Date.now() + 31 * DAY;
    expect(grantsOf(principalId, later)).toEqual([]);
    store.transaction((tx) =>
      tx.accounts.renewGrants(principalId, cloudProvider(ISSUER), Date.now()),
    );
    expect(grantsOf(principalId)).toEqual([]);
    expect((await login("acct:lease", {})).status).toBe(200);
    expect(grantsOf(principalId)).toHaveLength(1);
    expect(grantsOf(principalId, Date.now() + 29 * DAY)).toHaveLength(1);
  });

  it("撤链接连同访客：经这条链接进来的人停用，之后登录 403", async () => {
    const invitation = accounts.issueInvitation(ownerSubject(), {
      role: "viewer",
      targetWorkspaceId: "ws-1",
      maxUses: 5,
    });
    const link = { linkId: "lnk_rv", invitationId: invitation.invitationId };
    for (const guest of ["guest:lnk_rv:a", "guest:lnk_rv:b"]) {
      const joined = await login(guest, { link }, invitation.token);
      expect(joined.status, joined.text).toBe(200);
    }
    const other = await login(
      "guest:lnk_keep:a",
      {},
      accounts.issueInvitation(ownerSubject(), {
        role: "viewer",
        targetWorkspaceId: "ws-1",
      }).token,
    );
    expect(other.status).toBe(200);
    expect(
      disableLinkGuests(store, Date.now(), ownerSubject(), {
        provider: cloudProvider(ISSUER),
        linkId: "lnk_rv",
      }),
    ).toBe(2);
    expect((await login("guest:lnk_rv:a", {})).status).toBe(403);
    expect((await login("guest:lnk_keep:a", {})).status).toBe(200);
    expect(() =>
      disableLinkGuests(
        store,
        Date.now(),
        { principalId: principalOf(other), kind: "member", scopes: [] },
        { provider: cloudProvider(ISSUER), linkId: "lnk_keep" },
      ),
    ).toThrow();
  });
});
