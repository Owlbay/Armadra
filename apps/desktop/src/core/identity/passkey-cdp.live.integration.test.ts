/**
 * passkey 对着一个真 Chromium 的 WebAuthn：CDP 的虚拟认证器（`WebAuthn.*` 域）
 * 代替指纹或安全钥匙，页面里跑的是真的 `navigator.credentials.create / get`。
 *
 * 软件认证器（`soft-authenticator.fixture.ts`）证明的是「按规范拼出来的字节能
 * 过」；这条证明的是「浏览器真正发出来的字节能过」——`clientDataJSON` 的字段
 * 顺序、CBOR 的编码、签名格式都是 Chromium 自己的。没有浏览器的机器上跳过并
 * 说明原因。
 *
 * 页面与接口同源：`http://localhost:<port>`。WebAuthn 认 `localhost` 是安全上下
 * 文，RP ID 就是 `localhost`。
 */

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  CALL_TIMEOUT_MS,
  CdpConnection,
  STARTUP_TIMEOUT_MS,
} from "../browser/headless/connection";
import { discoverBrowser } from "../browser/headless/discover";
import {
  type BrowserProcess,
  spawnChromium,
} from "../browser/headless/process";
import { openDatabase } from "../db/open";
import type { CoreRequest } from "../http/router";
import { plainFileBackend } from "../secrets";
import { tempDir } from "../testing/temp-dir";
import { AccountsService } from "./accounts";
import { createIdentitySecurity } from "./accounts-http";
import { IdentityHttp } from "./http";
import { allScopes } from "./scopes";
import { IdentityService } from "./service";
import { IdentityStore } from "./store";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const INSTANCE = "0123456789abcdef0123456789abcdef";
const found = discoverBrowser(process.env, process.platform, existsSync);

const cleanup: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) {
    try {
      await step();
    } catch {
      // Already gone.
    }
  }
});

/** 页面里跑的那一段：拿选项、调 WebAuthn、把结果交回。 */
const SCRIPT = (accessToken: string, csrfToken: string) => `(async () => {
  const headers = { "content-type": "application/json",
    authorization: "Bearer ${accessToken}", "x-armadra-csrf": "${csrfToken}" };
  const post = (path, body, auth) => fetch("/api/identity/" + path, {
    method: "POST", headers: auth ? headers : { "content-type": "application/json" },
    body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const begun = await post("passkey/register/options", { label: "virtual" }, true);
  const created = await navigator.credentials.create({
    publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(begun.body.options) });
  const added = await post("passkey/register/verify",
    { challengeId: begun.body.challengeId, response: created.toJSON() }, true);
  const login = await post("passkey/login/options", {}, false);
  const asserted = await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(login.body.options) });
  const signedIn = await post("passkey/login/verify",
    { challengeId: login.body.challengeId, response: asserted.toJSON(), deviceName: "virtual" }, false);
  return JSON.stringify({ added: added.status, signedIn: signedIn.status,
    principalId: signedIn.body.device && signedIn.body.device.principalId,
    rpId: begun.body.options.rp.id });
})()`;

describe.skipIf(found.path === undefined)("passkey 对真 Chromium", () => {
  it("虚拟认证器：注册 → 登录，服务端用 @simplewebauthn/server 校验通过", async () => {
    const directory = tempDir("armadra-passkey-cdp-");
    const opened = openDatabase({
      file: join(directory, "canvas.db"),
      migrationsDir,
    });
    cleanup.push(opened.close);
    const store = new IdentityStore(opened.database);
    const service = new IdentityService(store, INSTANCE);
    const backend = plainFileBackend(join(directory, "secrets"));
    const http = new IdentityHttp({
      service,
      instanceId: INSTANCE,
      accounts: new AccountsService({ store }),
      security: createIdentitySecurity({
        store,
        secrets: () => backend,
        settings: () => ({
          passwordMinLength: 12,
          rpId: "",
          publicOrigins: [],
          mfaRequireFor: "none",
        }),
      }),
    });
    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://core");
      if (!url.pathname.startsWith("/api/identity/")) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>passkey</title>");
        return;
      }
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
    cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
    const origin = `http://localhost:${(server.address() as { port: number }).port}`;

    // owner 的会话直接签：这条要验的是 WebAuthn，不是配对。
    const ticket = service.issueBootstrap({
      hostId: service.hostId(),
      instanceId: INSTANCE,
      origin,
      deviceName: "本机桌面",
      scopes: allScopes(),
    });
    const session = service.consumeBootstrap({
      ticket: ticket.ticket,
      hostId: service.hostId(),
      instanceId: INSTANCE,
      origin,
    });

    const browser: BrowserProcess = spawnChromium({
      executable: found.path as string,
      profileDir: join(directory, "profile"),
      width: 800,
      height: 600,
    });
    cleanup.push(() => browser.kill());
    const cdp = new CdpConnection(browser.write, browser.read);
    cleanup.push(() => cdp.close());

    // The first command waits for the browser to come up, not for a page.
    // 先开空白页，挂上会话、打开生命周期事件，再自己导航：这样能拿到这次
    // 导航的 loaderId，等的就是目标文档的 load，而不是 about:blank 的。
    const { targetId } = (await cdp.send(
      "Target.createTarget",
      { url: "about:blank" },
      undefined,
      STARTUP_TIMEOUT_MS,
    )) as { targetId: string };
    const { sessionId } = (await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    await cdp.send("WebAuthn.enable", { enableUI: false }, sessionId);
    await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
      sessionId,
    );
    // 等页面落地：同源 fetch 要一个已经加载到目标来源的文档。Windows 上曾在
    // 页面还停在 about:blank 时就 evaluate，相对 URL 解析失败。
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send(
      "Page.setLifecycleEventsEnabled",
      { enabled: true },
      sessionId,
    );
    const loads: { frameId: string; loaderId: string }[] = [];
    let loaded: (() => void) | undefined;
    cdp.on((method, params, from) => {
      if (from !== sessionId || method !== "Page.lifecycleEvent") return;
      const event = params as {
        frameId: string;
        loaderId: string;
        name: string;
      };
      if (event.name !== "load") return;
      loads.push(event);
      loaded?.();
    });
    const navigated = (await cdp.send(
      "Page.navigate",
      { url: `${origin}/` },
      sessionId,
    )) as { frameId: string; loaderId?: string; errorText?: string };
    expect(navigated.errorText).toBeUndefined();
    const isTarget = (each: { frameId: string; loaderId: string }) =>
      each.frameId === navigated.frameId &&
      each.loaderId === navigated.loaderId;
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`页面没在时限内加载完 ${origin}/`)),
        CALL_TIMEOUT_MS,
      );
      loaded = () => {
        if (!loads.some(isTarget)) return;
        clearTimeout(timer);
        done();
      };
      loaded();
    });
    const landed = (await cdp.send(
      "Runtime.evaluate",
      {
        expression: "location.origin + '|' + document.readyState",
        returnByValue: true,
      },
      sessionId,
    )) as { result: { value?: string } };
    expect(landed.result.value).toBe(`${origin}|complete`);
    const evaluated = (await cdp.send(
      "Runtime.evaluate",
      {
        expression: SCRIPT(session.accessToken, session.csrfToken),
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    )) as {
      result: { value?: string };
      exceptionDetails?: { exception?: { description?: string } };
    };
    expect(evaluated.exceptionDetails?.exception?.description).toBeUndefined();
    const outcome = JSON.parse(evaluated.result.value ?? "{}") as {
      added: number;
      signedIn: number;
      principalId: string;
      rpId: string;
    };
    expect(outcome).toMatchObject({
      added: 201,
      signedIn: 200,
      rpId: "localhost",
      principalId: session.principal.principalId,
    });
    // 浏览器的认证器真的推进了计数器，库的判定写回了库。
    const row = store.transaction(
      (tx) => tx.passkeysOf(session.principal.principalId)[0],
    );
    expect(row?.aaguid).toMatch(/^[0-9a-f-]{36}$/);
  });
});
