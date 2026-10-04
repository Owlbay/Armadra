/**
 * OAuth / OIDC（契约 §18.5）对进程内假 issuer：start → callback → 绑定 / 登录 /
 * 建号三条路，以及 state、nonce、签名、邮箱验证、域名白名单的拒绝分支。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeIssuer, startFakeIssuer } from "./fake-issuer";
import {
  type OAuthHarness,
  call,
  callback,
  oauthHarness,
  outcome,
  owner,
  provider,
  sessionFrom,
  start,
} from "./harness.fixture";
import { bindingKey } from "./providers";
import { publicOriginsFrom } from "./http";
import {
  MAX_PENDING,
  MAX_PENDING_PER_ADDRESS,
  OAuthFlow,
  addressBucket,
  safeReturnTo,
} from "./flow";
import { installOAuth } from ".";
import type { CoreContext } from "../../main";
import { totpAt } from "../mfa/totp";

const ORIGIN = "http://localhost:1420";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

async function setup(
  fields: Partial<Parameters<typeof provider>[0]> = {},
  alg: "RS256" | "ES256" = "RS256",
): Promise<{ h: OAuthHarness; idp: FakeIssuer }> {
  const idp = await startFakeIssuer({ alg });
  closing.push(() => idp.close());
  const h = await oauthHarness({
    origin: ORIGIN,
    providers: [
      provider({ id: "corp", kind: "oidc", issuer: idp.issuer, ...fields }),
      provider({ id: "github", kind: "github", ...fields, issuer: undefined }),
    ],
    github: idp.github,
  });
  closing.push(() => h.close());
  return { h, idp };
}

/** start → 假 issuer 的 authorize（自动通过）→ callback。 */
async function roundTrip(
  h: OAuthHarness,
  providerId: string,
  body: Record<string, unknown> = {},
  session?: Awaited<ReturnType<typeof owner>>,
) {
  const begun = await start(h, providerId, body, session);
  expect(begun.response.status, await begun.response.clone().text()).toBe(200);
  const authorize = await fetch(begun.authorizeUrl, { redirect: "manual" });
  expect(authorize.status).toBe(302);
  const location = authorize.headers.get("location") ?? "";
  const response = await callback(h, location, begun.binding);
  return { response, location, binding: begun.binding };
}

function audits(h: OAuthHarness, action: string) {
  return h.store.transaction((tx) =>
    tx.accounts
      .auditEntries({ limit: 500 })
      .filter((entry) => entry.action === action),
  );
}

describe("未配置（§18.5）", () => {
  it("没有公网来源时 providers 报 configured=false，start 答 oauth_not_configured", async () => {
    const { h } = await setup();
    h.publicOrigins = [];
    const list = await call(h, "GET", "oauth/providers");
    expect(await list.json()).toEqual({ configured: false, providers: [] });
    const begun = await start(h, "corp");
    expect(begun.response.status).toBe(404);
    expect(((await begun.response.json()) as { code: string }).code).toBe(
      "oauth_not_configured",
    );
  });

  it("不是从公网来源发起、提供方不存在或停用、GitHub 没有 secret，都是 oauth_not_configured", async () => {
    const { h } = await setup();
    const elsewhere = await call(h, "POST", "oauth/corp/start", {}, undefined, {
      origin: "http://localhost:9999",
    });
    expect(((await elsewhere.json()) as { code: string }).code).toBe(
      "oauth_not_configured",
    );
    for (const id of ["nope", "github"]) {
      const begun = await start(h, id);
      expect(begun.response.status, id).toBe(404);
    }
    const anonymous = (await (
      await call(h, "GET", "oauth/providers")
    ).json()) as { providers: { id: string }[] };
    // 匿名只看得到能用的那几个；GitHub 还没设 secret。
    expect(anonymous.providers.map((row) => row.id)).toEqual(["corp"]);
  });

  it("owner 看得到全部细节，能设 / 清 client secret（进 SecretStore，不出接口）", async () => {
    const { h } = await setup();
    const admin = await owner(h);
    const put = await call(
      h,
      "PUT",
      "oauth/providers/github/secret",
      { clientSecret: "s3cret" },
      admin,
    );
    expect(await put.json()).toEqual({ id: "github", hasClientSecret: true });
    expect(h.secrets.get("github")).toBe("s3cret");
    const list = (await (
      await call(h, "GET", "oauth/providers", undefined, admin)
    ).json()) as { providers: Record<string, unknown>[] };
    const github = list.providers.find((row) => row.id === "github");
    expect(github).toMatchObject({
      hasClientSecret: true,
      usable: true,
      callbackUrls: [`${ORIGIN}/api/identity/oauth/github/callback`],
    });
    expect(JSON.stringify(list)).not.toContain("s3cret");
    // CSRF 只在 Cookie 会话上核对：这里的 owner 走 Bearer 传输
    // （回环原生来源），Cookie 会话那一半在 `gateway.integration.test.ts`。
    const cleared = await call(
      h,
      "DELETE",
      "oauth/providers/github/secret",
      undefined,
      admin,
    );
    expect(cleared.status).toBe(200);
    expect(h.secrets.has("github")).toBe(false);
    expect(audits(h, "identity.oauth.secret.set")).toHaveLength(1);
    expect(audits(h, "identity.oauth.secret.clear")).toHaveLength(1);
  });
});

describe("三条路（§18.5）", () => {
  it("绑定 → 用它登录：会话落在同一个 principal，审计 method=oauth", async () => {
    const { h } = await setup();
    const admin = await owner(h);
    const bound = await roundTrip(h, "corp", { mode: "bind" }, admin);
    expect(bound.response.status).toBe(302);
    expect(outcome(bound.response)).toEqual({ oauth: "bound" });
    expect(bound.response.headers.get("location")).toBe(
      `${ORIGIN}/#oauth=bound`,
    );

    const list = (await (
      await call(h, "GET", "oauth/bindings", undefined, admin)
    ).json()) as { bindings: { providerId: string; kind: string }[] };
    expect(list.bindings).toEqual([
      expect.objectContaining({ providerId: "corp", kind: "oidc" }),
    ]);

    const login = await roundTrip(h, "corp", { returnTo: "/w/abc" });
    expect(login.response.headers.get("location")).toBe(
      `${ORIGIN}/w/abc#oauth=signedIn`,
    );
    const access = sessionFrom(login.response);
    expect(access).not.toBe("");
    const session = await call(h, "GET", "session", undefined, {
      accessToken: access,
      csrfToken: "",
      principalId: "",
    });
    expect(session.status).toBe(200);
    const body = (await session.json()) as {
      device: { principalId: string; role: string };
    };
    expect(body.device.principalId).toBe(admin.principalId);
    expect(body.device.role).toBe("owner");
    const logins = audits(h, "identity.login").filter((entry) =>
      entry.detailJson.includes('"oauth"'),
    );
    expect(logins).toHaveLength(1);
    expect(audits(h, "identity.oauth.bind")).toHaveLength(1);
  });

  it("没绑定、没开 allowSignup：oauth_not_bound，不建号", async () => {
    const { h } = await setup();
    const login = await roundTrip(h, "corp");
    expect(outcome(login.response)).toEqual({
      oauth: "error",
      code: "oauth_not_bound",
    });
    expect(sessionFrom(login.response)).toBe("");
    expect(audits(h, "identity.oauth.failed")).toHaveLength(1);
  });

  it("allowSignup + 域名白名单：首次登录建 member（无授予），第二次登录同一个", async () => {
    const { h, idp } = await setup({
      allowSignup: true,
      allowedDomains: ["armadra.test"],
    });
    idp.user = {
      sub: "new-1",
      email: "Ada@Armadra.test",
      emailVerified: true,
      name: "Ada",
    };
    const first = await roundTrip(h, "corp");
    expect(outcome(first.response)).toEqual({ oauth: "signedUp" });
    const access = sessionFrom(first.response);
    const session = (await (
      await call(h, "GET", "session", undefined, {
        accessToken: access,
        csrfToken: "",
        principalId: "",
      })
    ).json()) as {
      device: { principalId: string; role: string };
      scopes: { permission: string }[];
    };
    expect(session.device.role).toBe("member");
    expect(session.scopes.map((entry) => entry.permission)).toEqual([
      "identity:read",
    ]);
    const principal = h.store.transaction((tx) =>
      tx.accounts.principal(session.device.principalId),
    );
    expect(principal).toMatchObject({ kind: "member", displayName: "Ada" });

    const again = await roundTrip(h, "corp");
    expect(outcome(again.response)).toEqual({ oauth: "signedIn" });
    expect(audits(h, "identity.oauth.signup")).toHaveLength(1);
  });

  it("建号要求白名单非空：allowSignup 但没配域名仍是 oauth_not_bound", async () => {
    const { h } = await setup({ allowSignup: true });
    const login = await roundTrip(h, "corp");
    expect(outcome(login.response).code).toBe("oauth_not_bound");
  });

  it("GitHub 特例：设了 secret 后走 /user 与 /user/emails，数字 id 当主体", async () => {
    const { h, idp } = await setup({
      allowSignup: true,
      allowedDomains: ["armadra.test"],
    });
    idp.clientSecret = "gh-secret";
    h.secrets.set("github", "gh-secret");
    idp.user = {
      sub: "583231",
      email: "octo@armadra.test",
      emailVerified: true,
      name: "Octo",
    };
    const first = await roundTrip(h, "github");
    expect(outcome(first.response)).toEqual({ oauth: "signedUp" });
    const rows = h.store.transaction((tx) =>
      tx.accounts.liveOAuth("github", "583231"),
    );
    expect(rows).toBeDefined();
    // secret 不对时令牌交换失败（GitHub 答 200 + error）。
    h.secrets.set("github", "wrong");
    const failed = await roundTrip(h, "github");
    expect(outcome(failed.response).code).toBe("oauth_provider_error");
  });

  it("已绑在别人名下的身份不能再绑：oauth_already_bound", async () => {
    const { h, idp } = await setup({
      allowSignup: true,
      allowedDomains: ["armadra.test"],
    });
    const admin = await owner(h);
    idp.user = { sub: "taken", email: "t@armadra.test", emailVerified: true };
    await roundTrip(h, "corp"); // 建了一个 member
    const bind = await roundTrip(h, "corp", { mode: "bind" }, admin);
    expect(outcome(bind.response).code).toBe("oauth_already_bound");
  });

  it("解绑：只能解自己的，之后这个身份登录不进来", async () => {
    const { h } = await setup();
    const admin = await owner(h);
    await roundTrip(h, "corp", { mode: "bind" }, admin);
    const list = (await (
      await call(h, "GET", "oauth/bindings", undefined, admin)
    ).json()) as { bindings: { credentialId: string }[] };
    const id = list.bindings[0]?.credentialId as string;
    const removed = await call(
      h,
      "DELETE",
      `oauth/bindings/${id}`,
      undefined,
      admin,
    );
    expect(removed.status).toBe(200);
    const again = await call(
      h,
      "DELETE",
      `oauth/bindings/${id}`,
      undefined,
      admin,
    );
    expect(again.status).toBe(404);
    const login = await roundTrip(h, "corp");
    expect(outcome(login.response).code).toBe("oauth_not_bound");
    expect(audits(h, "identity.oauth.unbind")).toHaveLength(1);
  });

  it("登记过 TOTP 的人 OAuth 登录后还要过第二因素：跳回带 challengeId，不发会话", async () => {
    const { h } = await setup();
    const admin = await owner(h);
    await roundTrip(h, "corp", { mode: "bind" }, admin);
    const enrolled = await h.security.mfa.begin(admin.principalId, "owner");
    await h.security.mfa.confirm(
      admin.principalId,
      totpAt(enrolled.secret, Date.now()),
    );
    const login = await roundTrip(h, "corp");
    const result = outcome(login.response);
    expect(result.oauth).toBe("mfa");
    expect(result.challengeId).toMatch(/^[0-9a-f]{32}$/);
    expect(sessionFrom(login.response)).toBe("");
  });
});

describe("拒绝分支（§18.5）", () => {
  it("state 一次性：同一个回调重放答 oauth_state_invalid，不再换令牌", async () => {
    const { h, idp } = await setup();
    const admin = await owner(h);
    const first = await roundTrip(h, "corp", { mode: "bind" }, admin);
    expect(outcome(first.response).oauth).toBe("bound");
    const calls = idp.tokenCalls();
    const replay = await callback(h, first.location, first.binding);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { code: string }).code).toBe(
      "oauth_state_invalid",
    );
    expect(idp.tokenCalls()).toBe(calls);
  });

  it("浏览器绑定 Cookie 不对或缺失：oauth_state_invalid（登录 CSRF）", async () => {
    const { h } = await setup();
    const admin = await owner(h);
    const begun = await start(h, "corp", { mode: "bind" }, admin);
    const authorize = await fetch(begun.authorizeUrl, { redirect: "manual" });
    const location = authorize.headers.get("location") ?? "";
    const forged = await callback(
      h,
      location,
      `${begun.binding.split("=")[0]}=attacker`,
    );
    expect(outcome(forged).code).toBe("oauth_state_invalid");
    // 取出即删：带对的 Cookie 再来也没有了。
    const late = await callback(h, location, begun.binding);
    expect(late.status).toBe(400);
  });

  it("未知 state、缺 state：JSON 400", async () => {
    const { h } = await setup();
    const response = await callback(
      h,
      `${ORIGIN}/api/identity/oauth/corp/callback?state=nope&code=x`,
      "",
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "oauth_state_invalid",
    );
  });

  it("email_verified = false：建号与白名单都拒", async () => {
    const { h, idp } = await setup({
      allowSignup: true,
      allowedDomains: ["armadra.test"],
    });
    idp.user = { sub: "u2", email: "u2@armadra.test", emailVerified: false };
    const login = await roundTrip(h, "corp");
    expect(outcome(login.response).code).toBe("oauth_email_unverified");
  });

  it("域名不在白名单：oauth_domain_not_allowed（绑定同样受限）", async () => {
    const { h, idp } = await setup({ allowedDomains: ["armadra.test"] });
    const admin = await owner(h);
    idp.user = { sub: "u3", email: "u3@evil.test", emailVerified: true };
    const bind = await roundTrip(h, "corp", { mode: "bind" }, admin);
    expect(outcome(bind.response).code).toBe("oauth_domain_not_allowed");
    // 子域不算命中。
    idp.user = { sub: "u3", email: "u3@x.armadra.test", emailVerified: true };
    const sub = await roundTrip(h, "corp", { mode: "bind" }, admin);
    expect(outcome(sub.response).code).toBe("oauth_domain_not_allowed");
  });

  for (const fault of [
    "badSignature",
    "wrongNonce",
    "wrongAudience",
    "expired",
    "algNone",
  ] as const) {
    it(`id_token ${fault}：oauth_token_invalid，不绑定`, async () => {
      const { h, idp } = await setup();
      const admin = await owner(h);
      idp.faults = { [fault]: true };
      const bind = await roundTrip(h, "corp", { mode: "bind" }, admin);
      expect(outcome(bind.response).code).toBe("oauth_token_invalid");
      const list = (await (
        await call(h, "GET", "oauth/bindings", undefined, admin)
      ).json()) as { bindings: unknown[] };
      expect(list.bindings).toEqual([]);
    });
  }

  it("ES256 签名同样验得过", async () => {
    const { h } = await setup({}, "ES256");
    const admin = await owner(h);
    const bind = await roundTrip(h, "corp", { mode: "bind" }, admin);
    expect(outcome(bind.response)).toEqual({ oauth: "bound" });
  });

  it("发现文档的 issuer 与配置不一致：start 答 oauth_provider_error", async () => {
    const { h, idp } = await setup();
    idp.faults = { wrongIssuer: true };
    const begun = await start(h, "corp");
    expect(begun.response.status).toBe(502);
    expect(((await begun.response.json()) as { code: string }).code).toBe(
      "oauth_provider_error",
    );
  });

  it("用户在提供方取消：oauth_denied", async () => {
    const { h } = await setup();
    const begun = await start(h, "corp");
    const state = new URL(begun.authorizeUrl).searchParams.get("state");
    const response = await callback(
      h,
      `${ORIGIN}/api/identity/oauth/corp/callback?state=${state}&error=access_denied`,
      begun.binding,
    );
    expect(outcome(response).code).toBe("oauth_denied");
  });

  it("bind 要会话与 CSRF；returnTo 只收站内路径", async () => {
    const { h } = await setup();
    const anonymous = await start(h, "corp", { mode: "bind" });
    expect(anonymous.response.status).toBe(401);
    for (const returnTo of ["//evil.test", "https://evil.test", "/a#b", "x"]) {
      const begun = await start(h, "corp", { returnTo });
      expect(begun.response.status, returnTo).toBe(400);
    }
  });

  it("授权地址带 PKCE S256、nonce、state 与固定回调", async () => {
    const { h } = await setup({ scopes: ["email"] });
    const begun = await start(h, "corp");
    const url = new URL(begun.authorizeUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("nonce")).not.toBeNull();
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/identity/oauth/corp/callback`,
    );
    expect(begun.binding).toMatch(/_oauth=/);
  });

  it("SSO 登出：有 end_session_endpoint 时给地址，GitHub 为 null", async () => {
    const { h, idp } = await setup();
    h.secrets.set("github", "x");
    const oidc = (await (
      await call(h, "POST", "oauth/corp/logout", { returnTo: "/" })
    ).json()) as { endSessionUrl: string };
    const url = new URL(oidc.endSessionUrl);
    expect(url.origin + url.pathname).toBe(
      `${idp.issuer.replace(/\/oidc$/, "")}/oidc/logout`,
    );
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(`${ORIGIN}/`);
    const gh = await (await call(h, "POST", "oauth/github/logout", {})).json();
    expect(gh).toEqual({ endSessionUrl: null });
  });
});

describe("挂起的 state 按来源地址分桶（安全审查 L4）", () => {
  const github = provider({ id: "github", kind: "github" });
  function flow(): OAuthFlow {
    // `begin` 只碰内存表与 GitHub 的授权地址：库与会话服务用不到。
    return new OAuthFlow({
      store: undefined as never,
      service: undefined as never,
      clientSecret: async () => undefined,
    });
  }
  async function begin(target: OAuthFlow, remoteIp: string) {
    const begun = await target.begin({
      provider: github,
      mode: "login",
      principalId: "",
      origin: ORIGIN,
      redirectUri: `${ORIGIN}/api/identity/oauth/github/callback`,
      returnTo: "/",
      deviceName: "browser",
      remoteIp,
      userAgent: "test",
    });
    const state = new URL(begun.authorizeUrl).searchParams.get("state") ?? "";
    return { state, binding: begun.binding };
  }

  it("多个地址撒 start 挤不掉别人半途的登录", async () => {
    const target = flow();
    const victim = await begin(target, "198.51.100.7");
    // 原来是一张表满了挤最老的：受害者那条最老，第 1001 次 start 就把它挤掉。
    for (let address = 0; address < 40; address += 1) {
      for (let i = 0; i < MAX_PENDING_PER_ADDRESS; i += 1) {
        await begin(target, `203.0.113.${address}`);
      }
    }
    expect(target.pendingCount()).toBe(MAX_PENDING);
    expect(target.take(victim.state, victim.binding).remoteIp).toBe(
      "198.51.100.7",
    );
  });

  it("一个地址满了只挤它自己最老的那条", async () => {
    const target = flow();
    const other = await begin(target, "198.51.100.7");
    const first = await begin(target, "203.0.113.1");
    for (let i = 0; i < MAX_PENDING_PER_ADDRESS; i += 1) {
      await begin(target, "203.0.113.1");
    }
    expect(target.pendingCount()).toBe(MAX_PENDING_PER_ADDRESS + 1);
    expect(() => target.take(first.state, first.binding)).toThrow();
    expect(target.take(other.state, other.binding).remoteIp).toBe(
      "198.51.100.7",
    );
  });

  it("IPv6 按 /64 分桶，IPv4 映射地址按 IPv4", async () => {
    expect(addressBucket("2001:db8:0:1::1")).toBe("2001:db8:0:1::/64");
    expect(addressBucket("2001:0db8:0000:0001:ffff::9")).toBe(
      "2001:db8:0:1::/64",
    );
    expect(addressBucket("::1")).toBe("0:0:0:0::/64");
    expect(addressBucket("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(addressBucket("192.0.2.1")).toBe("192.0.2.1");
    // 同一个 /64 里换地址也挤不出去别人，只挤自己。
    const target = flow();
    const victim = await begin(target, "2001:db8:1:2::5");
    for (let i = 0; i < MAX_PENDING_PER_ADDRESS + 5; i += 1) {
      await begin(target, `2001:db8:9:9::${(i + 1).toString(16)}`);
    }
    expect(target.pendingCount()).toBe(MAX_PENDING_PER_ADDRESS + 1);
    expect(target.take(victim.state, victim.binding).remoteIp).toBe(
      "2001:db8:1:2::5",
    );
  });
});

describe("纯函数", () => {
  it("源码里出现的每个 oauth_* 拒绝码都在共享层的 OAUTH_CODES 里", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // core 不依赖共享层的包，按源码读那张表（和 completion-settings 的做法一样）。
    const shared = readFileSync(
      join(
        here,
        "../../../../../../packages/shared/src/api/identity-security.ts",
      ),
      "utf8",
    );
    const table = /OAUTH_CODES = \[([^\]]*)\]/.exec(shared)?.[1] ?? "";
    const OAUTH_CODES = [...table.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const seen = new Set<string>();
    for (const file of ["providers.ts", "flow.ts", "http.ts"]) {
      const text = readFileSync(join(here, file), "utf8");
      for (const match of text.matchAll(/"(oauth_[a-z_]+)"/g)) {
        seen.add(match[1] as string);
      }
    }
    expect(seen.size).toBeGreaterThan(5);
    for (const code of seen) {
      expect(OAUTH_CODES, code).toContain(code);
    }
  });

  it("绑定键由 issuer 派生、去掉末尾斜杠；GitHub 固定", () => {
    const a = bindingKey(
      provider({ id: "a", kind: "oidc", issuer: "https://idp.test/x" }),
    );
    const b = bindingKey(
      provider({ id: "b", kind: "oidc", issuer: "https://idp.test/x/" }),
    );
    const c = bindingKey(
      provider({ id: "a", kind: "oidc", issuer: "https://other.test/x" }),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(bindingKey(provider({ id: "g", kind: "github" }))).toBe("github");
  });

  it("公网来源：设置里的照收，注入的只收 HTTPS 域名", () => {
    expect(
      publicOriginsFrom(
        ["https://armadra.example.com"],
        [
          "https://armadra.example.com",
          "https://192.168.1.4:8443",
          "https://box.lan:8443",
        ],
      ),
    ).toEqual(["https://armadra.example.com", "https://box.lan:8443"]);
  });

  it("installOAuth 在比身份域更长的原样前缀上登记", async () => {
    const { h } = await setup();
    const prefixes: string[] = [];
    installOAuth(
      {
        server: { raw: (prefix: string) => prefixes.push(prefix) },
        dataDir: "/nonexistent",
        platform: {},
      } as unknown as CoreContext,
      {
        store: h.store,
        service: h.service,
        accounts: undefined as never,
      },
    );
    expect(prefixes).toEqual(["/api/identity/oauth/"]);
  });

  it("returnTo", () => {
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo("/w/1?x=2")).toBe("/w/1?x=2");
    expect(safeReturnTo("/\\evil")).toBeUndefined();
  });
});
