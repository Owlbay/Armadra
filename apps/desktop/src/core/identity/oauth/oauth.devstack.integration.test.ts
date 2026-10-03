/**
 * OAuth / OIDC 对 dev-stack 的真提供方（契约 §18.5、外部服务 §7.1）：dex（静态
 * 用户、回环公开客户端）与 Keycloak（发现文档有 end_session_endpoint、未验证邮箱
 * 的用户、SSO 登出）。登录页由一个只认 `<form>` 的小客户端填写——和浏览器走的是
 * 同一串 302 与表单提交。
 *
 * `ARMADRA_DEV_STACK=1` 才跑（`pnpm dev-stack up dex keycloak`）；否则 skipped。
 */

import { afterEach, describe, expect, it } from "vitest";
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

const enabled = process.env.ARMADRA_DEV_STACK === "1";
const DEX = "http://127.0.0.1:5556/dex";
const KEYCLOAK = "http://127.0.0.1:8080/realms/armadra";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

/** 一个最小的浏览器：Cookie 罐、手动跟 302、遇到登录表单就填。 */
class Browser {
  private readonly jar = new Map<string, Map<string, string>>();

  private cookies(url: URL): string {
    const own = this.jar.get(url.host);
    return own === undefined
      ? ""
      : [...own].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private remember(url: URL, response: Response): void {
    const own = this.jar.get(url.host) ?? new Map<string, string>();
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (/max-age=0/i.test(line) || value === "") own.delete(name);
      else own.set(name, value);
    }
    this.jar.set(url.host, own);
  }

  async request(
    target: string,
    init: { method?: string; form?: URLSearchParams } = {},
  ): Promise<Response> {
    const url = new URL(target);
    const response = await fetch(url, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: {
        cookie: this.cookies(url),
        ...(init.form === undefined
          ? {}
          : { "content-type": "application/x-www-form-urlencoded" }),
      },
      ...(init.form === undefined ? {} : { body: init.form.toString() }),
    });
    this.remember(url, response);
    return response;
  }

  /**
   * 从 `start` 开始一路跟到「Location 落在 stopAt 上」为止；途中遇到表单就按
   * `fields` 填（没给的字段用表单里的值）。返回那个 Location。
   */
  async drive(
    start: string,
    stopAt: string,
    fields: Record<string, string>,
  ): Promise<string> {
    let next: { url: string; method?: string; form?: URLSearchParams } = {
      url: start,
    };
    for (let hop = 0; hop < 20; hop += 1) {
      const response = await this.request(next.url, next);
      const location = response.headers.get("location");
      if (location !== null) {
        const absolute = new URL(location, next.url).toString();
        if (absolute.startsWith(stopAt)) return absolute;
        next = { url: absolute };
        continue;
      }
      const html = await response.text();
      const form = /<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(
        html,
      );
      if (form === null) {
        throw new Error(
          `第 ${hop} 跳没有跳转也没有表单（HTTP ${response.status}）：${html.slice(0, 300)}`,
        );
      }
      const action = new URL(
        (form[1] as string).replace(/&amp;/g, "&"),
        next.url,
      ).toString();
      const data = new URLSearchParams();
      for (const input of (form[2] as string).matchAll(/<input[^>]*>/gi)) {
        const tag = input[0];
        const name = /name="([^"]*)"/i.exec(tag)?.[1];
        if (name === undefined) continue;
        const value = /value="([^"]*)"/i.exec(tag)?.[1] ?? "";
        data.set(name, fields[name] ?? value.replace(/&amp;/g, "&"));
      }
      for (const [name, value] of Object.entries(fields)) data.set(name, value);
      next = { url: action, method: "POST", form: data };
    }
    throw new Error("跳转太多次");
  }
}

async function roundTrip(
  h: OAuthHarness,
  browser: Browser,
  providerId: string,
  credentials: Record<string, string>,
  body: Record<string, unknown> = {},
  session?: Awaited<ReturnType<typeof owner>>,
) {
  const begun = await start(h, providerId, body, session);
  expect(begun.response.status, await begun.response.clone().text()).toBe(200);
  const location = await browser.drive(
    begun.authorizeUrl,
    `${h.origin}/api/identity/oauth/`,
    credentials,
  );
  return callback(h, location, begun.binding);
}

describe.skipIf(!enabled)("dev-stack：dex（§18.5）", () => {
  it("回环公开客户端：PKCE 授权码 → 绑定 → 用它登录；状态重放拒绝", async () => {
    const h = await oauthHarness({
      origin: "http://localhost:47811",
      providers: [
        provider({
          id: "dex",
          kind: "oidc",
          issuer: DEX,
          clientId: "armadra-dev-loopback",
        }),
      ],
    });
    closing.push(() => h.close());
    const admin = await owner(h);
    const browser = new Browser();
    const dexLogin = { login: "dev@armadra.test", password: "password" };
    const bound = await roundTrip(
      h,
      browser,
      "dex",
      dexLogin,
      { mode: "bind" },
      admin,
    );
    expect(outcome(bound)).toEqual({ oauth: "bound" });

    const begun = await start(h, "dex");
    const location = await browser.drive(
      begun.authorizeUrl,
      `${h.origin}/api/identity/oauth/`,
      dexLogin,
    );
    const login = await callback(h, location, begun.binding);
    expect(outcome(login)).toEqual({ oauth: "signedIn" });
    const session = await call(h, "GET", "session", undefined, {
      accessToken: sessionFrom(login),
      csrfToken: "",
      principalId: "",
    });
    expect(
      ((await session.json()) as { device: { principalId: string } }).device
        .principalId,
    ).toBe(admin.principalId);
    const replay = await callback(h, location, begun.binding);
    expect(replay.status).toBe(400);

    // dex 的发现文档没有 end_session_endpoint：SSO 登出地址为 null。
    const logout = await call(h, "POST", "oauth/dex/logout", {});
    expect(await logout.json()).toEqual({ endSessionUrl: null });
  });
});

describe.skipIf(!enabled)("dev-stack：Keycloak（§18.5）", () => {
  async function keycloak(
    fields: Partial<Parameters<typeof provider>[0]> = {},
  ) {
    const h = await oauthHarness({
      origin: "http://127.0.0.1:47812",
      providers: [
        provider({
          id: "kc",
          kind: "oidc",
          issuer: KEYCLOAK,
          clientId: "armadra-dev",
          ...fields,
        }),
      ],
    });
    closing.push(() => h.close());
    return h;
  }

  it("建号：allowSignup + 域名白名单，已验证邮箱建 member；未验证邮箱拒绝", async () => {
    const h = await keycloak({
      allowSignup: true,
      allowedDomains: ["armadra.test"],
    });
    const signedUp = await roundTrip(h, new Browser(), "kc", {
      username: "dev",
      password: "password",
    });
    expect(outcome(signedUp)).toEqual({ oauth: "signedUp" });

    const unverified = await roundTrip(h, new Browser(), "kc", {
      username: "unverified",
      password: "password",
    });
    expect(outcome(unverified)).toEqual({
      oauth: "error",
      code: "oauth_email_unverified",
    });
  });

  it("SSO 登出：end_session_endpoint 结束 Keycloak 会话，之后要重新输口令", async () => {
    const h = await keycloak({
      allowSignup: true,
      allowedDomains: ["armadra.test"],
    });
    const browser = new Browser();
    const first = await roundTrip(h, browser, "kc", {
      username: "dev",
      password: "password",
    });
    expect(outcome(first).oauth).toBe("signedUp");

    // SSO 会话还在：第二次不出登录页，直接回调。
    const silent = await start(h, "kc");
    const direct = await browser.request(silent.authorizeUrl);
    expect(direct.headers.get("location") ?? "").toContain(
      `${h.origin}/api/identity/oauth/kc/callback`,
    );

    const logout = (await (
      await call(h, "POST", "oauth/kc/logout", { returnTo: "/" })
    ).json()) as { endSessionUrl: string };
    expect(logout.endSessionUrl).toContain("/protocol/openid-connect/logout");
    const landed = await browser.drive(
      logout.endSessionUrl,
      `${h.origin}/`,
      {},
    );
    expect(landed).toBe(`${h.origin}/`);

    // 会话没了：authorize 又出登录页（200 表单），不再直接跳回。
    const again = await start(h, "kc");
    const page = await browser.request(again.authorizeUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("kc-form-login");
  });
});
