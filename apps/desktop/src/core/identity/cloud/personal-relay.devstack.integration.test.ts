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

async function rpc(procedure: string, input: unknown = {}) {
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

  it("revoke 生效：之后中继签的断言 cloud_not_registered，registered 回到 false", async () => {
    const revoked = await rpc("identity.cloud.revoke", { issuer });
    expect(revoked.status, revoked.text).toBe(200);
    const login = await call("POST", "/api/identity/cloud/login", {
      assertion: await freshAssertion(),
    });
    expect(login.status).toBe(401);
    expect(login.body.code).toBe("cloud_not_registered");
    expect(cloud.registered(issuer)).toBe(false);
    const listed = await rpc("sources.list");
    const remote = (
      listed.body.json as {
        remotes: { registered: boolean; serviceId: string }[];
      }
    ).remotes[0];
    expect(remote?.registered).toBe(false);
    const removed = await rpc("sources.remoteRemove", {
      serviceId: remote?.serviceId,
    });
    expect(removed.status).toBe(200);
  });
});
