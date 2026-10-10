/**
 * 对着一个真的个人中转（armadra-cloud 的 `pnpm relay:personal`，自签 TLS）跑一遍
 * 契约 §31：注册令牌 → `identity.cloud.register` → 状态；中继签的断言 → 绑定 →
 * `cloud/login` 换会话；篡改与重放被拒；分享链接的访客带邀请建号；撤销之后它签的
 * 断言不再被认。真 TLS、真指纹钉扎、真 Ed25519。
 *
 * `ARMADRA_PERSONAL_RELAY=1` 才跑；否则 skipped。其余从环境读（同
 * `sources/personal-relay.devstack.integration.test.ts`）：
 * `ARMADRA_PERSONAL_RELAY_URL`（缺省 `https://127.0.0.1:8102`）、
 * `ARMADRA_PERSONAL_RELAY_FP`、`ARMADRA_PERSONAL_RELAY_ACCOUNT` / `_PASSWORD`。
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installContract } from "../../http/rpc";
import { install as installSources } from "../../sources";
import { networkTransport } from "../../sources/http-client";
import { type Fixture, fixture } from "../../workspaces/fixture";
import { AccountsService } from "../accounts";
import { Authorizer } from "../authorize";
import { allScopes } from "../scopes";
import { IdentityService } from "../service";
import { IdentityStore } from "../store";
import { type CloudService, installCloud } from "./index";

const enabled = process.env.ARMADRA_PERSONAL_RELAY === "1";
const issuer = new URL(
  process.env.ARMADRA_PERSONAL_RELAY_URL?.trim() || "https://127.0.0.1:8102",
).origin;
const fingerprint = process.env.ARMADRA_PERSONAL_RELAY_FP?.trim() ?? "";
const account = process.env.ARMADRA_PERSONAL_RELAY_ACCOUNT?.trim() || "dev";
const password = process.env.ARMADRA_PERSONAL_RELAY_PASSWORD ?? "";

const INSTANCE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://127.0.0.1:1420";

let core: Fixture;
let base: string;
let store: IdentityStore;
let service: IdentityService;
let accounts: AccountsService;
let cloud: CloudService;
let owner: { accessToken: string; principalId: string };
let relayAccess = "";

/** 直接对个人中转（钉指纹）。 */
async function relay(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  token = relayAccess,
) {
  return networkTransport({
    method,
    url: `${issuer}${path}`,
    fingerprint,
    timeoutMs: 10_000,
    ...(body === undefined ? {} : { body }),
    ...(token === "" ? {} : { headers: { authorization: `Bearer ${token}` } }),
  }) as Promise<{ status: number; body: Record<string, unknown> }>;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
}

async function rpc(procedure: string, input: unknown = {}, token?: string) {
  const response = await fetch(
    `${base}/api/rpc/${procedure.replaceAll(".", "/")}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 签邀请要一个真的签发人（`issued_by` 外键）：带 owner 的会话。
        ...(token === undefined
          ? {}
          : { origin: ORIGIN, authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ json: input }),
    },
  );
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

async function freshAssertion(): Promise<string> {
  const answer = await relay(
    "POST",
    `/v1/sources/${store.hostId()}/assertion`,
    {
      sourceId: store.hostId(),
      device: { platform: "desktop", name: "devstack" },
    },
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.assertion as string;
}

describe.skipIf(!enabled)("个人中转联调（契约 §31）", () => {
  beforeAll(async () => {
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
          coreVersion: "0.0.0-devstack",
        });
      },
      (context) => void installSources(context),
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
      deviceName: "devstack",
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
    const login = await relay(
      "POST",
      "/v1/auth/login",
      {
        account,
        password,
        device: { platform: "desktop", name: "devstack" },
      },
      "",
    );
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    relayAccess = (login.body.session as { accessToken: string }).accessToken;
    // 先把个人中转加成远程服务：登记按它的 CA 指纹钉扎。
    const added = await rpc("sources.remoteAdd", {
      kind: "personal",
      issuer,
      account,
      password,
      fingerprint,
    });
    expect(added.status, added.text).toBe(200);
  });

  afterAll(async () => {
    if (core === undefined) return;
    // 把这台临时 core 从中继的源目录里撤掉，不留开发数据。
    if (relayAccess !== "") {
      await relay("DELETE", `/v1/sources/${store.hostId()}`).catch(
        () => undefined,
      );
    }
    await core.server.close();
    core.close();
  });

  it("注册令牌 → register 成功，状态与源表的 registered 正确", async () => {
    const token = await relay("POST", "/v1/sources/registration-tokens", {});
    expect(token.status, JSON.stringify(token.body)).toBe(200);
    const registrationToken = token.body.registrationToken as string;
    const wrong = await call(
      "POST",
      "/api/identity/cloud/register",
      { issuer, registrationToken: `${registrationToken}x` },
      owner.accessToken,
    );
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("registration_token_invalid");
    const registered = await call(
      "POST",
      "/api/identity/cloud/register",
      { issuer, registrationToken, label: "devstack" },
      owner.accessToken,
    );
    expect(registered.status, registered.text).toBe(200);
    expect(registered.body).toMatchObject({
      issuer,
      sourceId: store.hostId(),
      relayOrigins: [issuer],
    });
    expect(registered.text).not.toContain(registrationToken);
    const status = await call(
      "GET",
      "/api/identity/cloud",
      undefined,
      owner.accessToken,
    );
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      sourceId: store.hostId(),
      registrations: [{ issuer, mode: "personal", label: "devstack" }],
    });
    const listed = await rpc("sources.list");
    expect(
      (listed.body.json as { remotes: { registered: boolean }[] }).remotes[0]
        ?.registered,
    ).toBe(true);
    // 中继的源目录里有这台 core，名字是登记时给的。
    const sources = await relay("GET", "/v1/me/sources");
    expect(
      (sources.body.sources as { sourceId: string; name: string }[]).find(
        (one) => one.sourceId === store.hostId(),
      )?.name,
    ).toBe("devstack");
  });

  it("中继签的断言：绑定到 owner，之后 cloud/login 换到 owner 的会话", async () => {
    const bound = await call(
      "POST",
      "/api/identity/cloud/bind",
      { assertion: await freshAssertion() },
      owner.accessToken,
    );
    expect(bound.status, bound.text).toBe(200);
    const assertion = await freshAssertion();
    const login = await call("POST", "/api/identity/cloud/login", {
      assertion,
    });
    expect(login.status, login.text).toBe(200);
    expect(login.body.principal).toMatchObject({
      principalId: owner.principalId,
      kind: "owner",
    });
    const session = login.body.session as {
      hostId: string;
      native: { accessToken: string };
    };
    expect(session.hostId).toBe(store.hostId());
    const status = await call(
      "GET",
      "/api/identity/cloud",
      undefined,
      session.native.accessToken,
    );
    expect(status.status).toBe(200);
    // 同一张再用一次：重放。
    const replayed = await call("POST", "/api/identity/cloud/login", {
      assertion,
    });
    expect(replayed.status).toBe(401);
    expect(replayed.body.code).toBe("cloud_assertion_replayed");
  });

  it("篡改过的断言被拒", async () => {
    const [head, body, signature] = (await freshAssertion()).split(".");
    const claims = JSON.parse(
      Buffer.from(body as string, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    claims.sub = "acct:intruder";
    const forged = await call("POST", "/api/identity/cloud/login", {
      assertion: `${head}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`,
    });
    expect(forged.status).toBe(401);
    expect(forged.body.code).toBe("cloud_assertion_invalid");
  });

  it("分享链接的访客：带 core 邀请令牌建成员，记 invitation.accept.link", async () => {
    const invitation = accounts.issueInvitation(
      { principalId: owner.principalId, kind: "owner", scopes: allScopes() },
      { role: "viewer", targetWorkspaceId: "ws-devstack" },
    );
    const link = await relay("POST", "/v1/links", {
      kind: "source_invite",
      sourceId: store.hostId(),
      invitationId: invitation.invitationId,
      label: "Guest",
      role: "viewer",
      expiresAtMs: Date.now() + 60 * 60 * 1000,
      maxUses: 1,
    });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const accepted = await relay(
      "POST",
      `/v1/links/${link.body.linkId as string}/accept`,
      {
        linkId: link.body.linkId,
        secret: link.body.secret,
        device: { platform: "desktop", name: "guest" },
      },
      "",
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const login = await call("POST", "/api/identity/cloud/login", {
      assertion: accepted.body.assertion,
      invitationToken: invitation.token,
    });
    expect(login.status, login.text).toBe(200);
    expect(login.body.created).toBe(true);
    expect(login.body.principal).toMatchObject({ kind: "member" });
    const actions = (
      core.database
        .prepare("SELECT action FROM audit_log ORDER BY id")
        .all() as { action: string }[]
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(["cloud.login", "invitation.accept.link"]),
    );
    await relay("DELETE", `/v1/links/${link.body.linkId as string}`);
  });

  /** JWS 的声明段（不验签，只看中继签了什么）。 */
  function claimsOf(token: string): Record<string, unknown> {
    return JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  }

  it("会话范围的链接（契约 §60）：经 core 建链接，中继签 scp 与 ro，core 授予只读会话；撤链接连同访客停用", async () => {
    const { serviceId } = await remoteRow();
    const created = await rpc(
      "sources.shareLinkCreate",
      {
        serviceId,
        target: "session",
        workspaceId: "ws-devstack",
        sessionId: "t-devstack",
        role: "driver",
        ttlMs: 60 * 60 * 1000,
        maxUses: 2,
        label: "session",
      },
      owner.accessToken,
    );
    expect(created.status, created.text).toBe(200);
    const { link, url } = (
      created.body as {
        json: {
          link: { linkId: string; role: string; target?: string };
          url: string;
        };
      }
    ).json;
    expect(link).toMatchObject({ role: "viewer", target: "session" });
    const fragment = new URL(url).hash.slice(1);
    const dot = fragment.indexOf(".");
    const secret = fragment.slice(0, dot);
    const invitationToken = fragment.slice(dot + 1);
    const listed = await relay("GET", `/v1/links?sourceId=${store.hostId()}`);
    expect(
      (listed.body.links as { linkId: string; scope?: unknown }[]).find(
        (one) => one.linkId === link.linkId,
      )?.scope,
    ).toEqual({
      workspaceId: "ws-devstack",
      sessionId: "t-devstack",
      readOnly: true,
    });

    const accepted = await relay(
      "POST",
      `/v1/links/${link.linkId}/accept`,
      {
        linkId: link.linkId,
        secret,
        device: { platform: "desktop", name: "guest" },
      },
      "",
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(claimsOf(accepted.body.assertion as string).scp).toEqual([
      "ws:ws-devstack",
      "sess:t-devstack",
      "ro",
    ]);
    expect(claimsOf(accepted.body.relayToken as string).ro).toBe(true);
    const login = await call("POST", "/api/identity/cloud/login", {
      assertion: accepted.body.assertion,
      invitationToken,
    });
    expect(login.status, login.text).toBe(200);
    const principalId = (login.body.principal as { principalId: string })
      .principalId;
    const grants = store.transaction((tx) =>
      tx.accounts.grantsFor(principalId),
    );
    expect(
      grants.map((grant) => [
        grant.targetKind,
        grant.workspaceId,
        grant.targetId,
        grant.role,
      ]),
    ).toEqual([["session", "ws-devstack", "t-devstack", "viewer"]]);

    const revoked = await rpc(
      "sources.shareLinkRevoke",
      { serviceId, linkId: link.linkId },
      owner.accessToken,
    );
    expect(revoked.status, revoked.text).toBe(200);
    expect(
      store.transaction((tx) => tx.accounts.principal(principalId))
        ?.disabledAtMs,
    ).toBeGreaterThan(0);
  });

  /** 中继的源目录（owner 视角）里有没有这台 core。 */
  async function listedOnRelay(): Promise<boolean> {
    const sources = await relay("GET", "/v1/me/sources");
    expect(sources.status, JSON.stringify(sources.body)).toBe(200);
    return (sources.body.sources as { sourceId: string }[]).some(
      (one) => one.sourceId === store.hostId(),
    );
  }

  async function registerAgain(): Promise<void> {
    const token = await relay("POST", "/v1/sources/registration-tokens", {});
    expect(token.status, JSON.stringify(token.body)).toBe(200);
    const registered = await rpc("identity.cloud.register", {
      issuer,
      registrationToken: token.body.registrationToken,
      label: "devstack",
    });
    expect(registered.status, registered.text).toBe(200);
    expect(await listedOnRelay()).toBe(true);
  }

  async function remoteRow(): Promise<{
    registered: boolean;
    serviceId: string;
  }> {
    const listed = await rpc("sources.list");
    return (
      listed.body.json as {
        remotes: { registered: boolean; serviceId: string }[];
      }
    ).remotes[0] as { registered: boolean; serviceId: string };
  }

  it("revoke：本机撤销，并用远程服务会话删掉中继侧的源记录（§31.4）", async () => {
    expect(await listedOnRelay()).toBe(true);
    const revoked = await rpc("identity.cloud.revoke", { issuer });
    expect(revoked.status, revoked.text).toBe(200);
    expect(cloud.registered(issuer)).toBe(false);
    expect((await remoteRow()).registered).toBe(false);
    // 中继目录里已经没有这台 core，也不再为它签断言。
    expect(await listedOnRelay()).toBe(false);
    const assertion = await relay(
      "POST",
      `/v1/sources/${store.hostId()}/assertion`,
      {
        sourceId: store.hostId(),
        device: { platform: "desktop", name: "devstack" },
      },
    );
    expect(assertion.body.code).toBe("source_revoked");
    const pending = await rpc("identity.cloud.relayPending");
    expect(pending.body.json).toEqual({ pending: [] });
  });

  it("没有会话时撤销：本机照样完成、记中继侧待清理；登录回来重试即清掉", async () => {
    await registerAgain();
    const { serviceId } = await remoteRow();
    expect((await rpc("sources.remoteLogout", { serviceId })).status).toBe(200);
    const revoked = await rpc("identity.cloud.revoke", { issuer });
    expect(revoked.status, revoked.text).toBe(200);
    expect(cloud.registered(issuer)).toBe(false);
    expect(await listedOnRelay()).toBe(true);
    const pending = await rpc("identity.cloud.relayPending");
    expect(pending.body.json).toEqual({
      pending: [
        {
          issuer,
          revokedAtMs: expect.any(Number),
          code: "source_unauthorized",
        },
      ],
    });
    const again = await rpc("sources.remoteAdd", {
      kind: "personal",
      issuer,
      account,
      password,
      fingerprint,
    });
    expect(again.status, again.text).toBe(200);
    const retried = await rpc("identity.cloud.relayCleanup", { issuer });
    expect(retried.body.json).toEqual({ pending: false, code: null });
    expect(await listedOnRelay()).toBe(false);
    expect((await rpc("identity.cloud.relayPending")).body.json).toEqual({
      pending: [],
    });
  });

  it("remoteRemove：先撤销（连同中继侧），再删行", async () => {
    await registerAgain();
    const { serviceId } = await remoteRow();
    const removed = await rpc("sources.remoteRemove", { serviceId });
    expect(removed.status, removed.text).toBe(200);
    expect(cloud.registered(issuer)).toBe(false);
    expect(await listedOnRelay()).toBe(false);
    expect((await rpc("identity.cloud.relayPending")).body.json).toEqual({
      pending: [],
    });
    const listed = await rpc("sources.list");
    expect((listed.body.json as { remotes: unknown[] }).remotes).toEqual([]);
  });
});
