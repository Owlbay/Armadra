/**
 * 装配级验收：桌面模式起一个真 core，经设置打开 Gateway（本地 CA，只在回环上
 * 监听），走一遍架构 §7 的那几条路：
 *
 *   1. `PUT /api/gateway` 打开它；端口写回设置；`GET /ca.crt` 匿名拿到 CA，
 *      之后用**只信这张 CA** 的客户端完整验证 TLS 链；配对载荷的 `fp` 就是它；
 *   2. 配对票在 Gateway 上兑换成浏览器会话（Cookie），成员账号访问被共享的
 *      画布，但改 Gateway 配置是 403；
 *   3. 原生 App 的 Bearer 模式：配对拿到 `native` 密钥、不发 Cookie，CORS 只回
 *      App 自己的来源；`ws-ticket` 换一次性票，经 `Sec-WebSocket-Protocol` 升级；
 *   4. 关掉即断流：开着的事件流在 `PUT {enabled:false}` 之后关闭，再连被拒。
 *
 * 不在任何非回环接口上监听。
 */

import { writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { X509Certificate } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { type RunningCore, run } from "../main";
import { settingsDomain } from "../settings";
import { tempDir } from "../testing/temp-dir";
import { fingerprintOf } from "./tls";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const APP = "capacitor://localhost";

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface Person {
  readonly cookie: string;
  readonly csrf: string;
}

let core: RunningCore;
let loopback: string;
let origin: string;
let ca: string;
let owner: Person;
let member: Person;
let workspaceId: string;

function local(method: string, path: string, body?: unknown): Promise<Answer> {
  const url = new URL(path, loopback);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((done, failed) => {
    const client = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers:
          payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              },
      },
      (response) => collect(response, done),
    );
    client.on("error", failed);
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

function collect(
  response: import("node:http").IncomingMessage,
  done: (answer: Answer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer) => chunks.push(chunk));
  response.on("end", () =>
    done({
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    }),
  );
}

/** 经 Gateway 的一次请求。`trust` 给了就只信它（完整验证链），否则不验。 */
function remote(
  path: string,
  options: {
    method?: string;
    origin?: string | null;
    person?: Person;
    bearer?: string;
    body?: unknown;
    headers?: Record<string, string>;
    trust?: string;
  } = {},
): Promise<Answer> {
  const url = new URL(path, origin);
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((done, failed) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.origin !== null) headers.origin = options.origin ?? origin;
    if (options.person !== undefined) {
      headers.cookie = options.person.cookie;
      headers["x-armadra-csrf"] = options.person.csrf;
    }
    if (options.bearer !== undefined) {
      headers.authorization = `Bearer ${options.bearer}`;
    }
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const client = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? "GET",
        headers,
        ...(options.trust === undefined
          ? { rejectUnauthorized: false }
          : { ca: options.trust, rejectUnauthorized: true }),
      },
      (response) => collect(response, done),
    );
    client.on("error", failed);
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

function person(answer: Answer): Person {
  const cookies = answer.headers["set-cookie"] as string[];
  const body = JSON.parse(answer.body) as { csrfToken: string };
  return {
    cookie: cookies
      .map((value) => (value.split(";")[0] as string).trim())
      .join("; "),
    csrf: body.csrfToken,
  };
}

async function pairing(): Promise<{
  origin: string;
  ticket: string;
  fingerprint: string;
  webUrl: string;
  deepLink: string;
}> {
  const answer = await local("POST", "/api/gateway/pairing", {});
  expect(answer.status).toBe(200);
  return JSON.parse(answer.body);
}

function stream(
  path: string,
  options: { headers?: Record<string, string>; protocols?: string[] },
): Promise<
  | { status: number }
  | { status: 101; socket: WebSocket; closed: Promise<number> }
> {
  return new Promise((done) => {
    const socket = new WebSocket(
      `${origin.replace("https:", "wss:")}${path}`,
      options.protocols ?? [],
      { headers: options.headers, rejectUnauthorized: false },
    );
    const closed = new Promise<number>((settle) => {
      socket.on("close", (code) => settle(code));
    });
    socket.on("unexpected-response", (_request, response) => {
      done({ status: response.statusCode ?? 0 });
      socket.terminate();
    });
    socket.on("error", () => {});
    socket.on("open", () => done({ status: 101, socket, closed }));
  });
}

beforeAll(async () => {
  const webRoot = tempDir("armadra-gateway-web-");
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
  vi.stubEnv("ARMADRA_GATEWAY_WEB_ROOT", webRoot);
  const dataDir = tempDir("armadra-gateway-core-");
  core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    env: {
      ARMADRA_CORE: "ts",
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
    },
    stdout: () => {},
  });
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  loopback = `http://${tcp.host}:${tcp.port}`;
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await core?.stop();
});

describe("桌面 Gateway：设置驱动、本地 CA、配对", () => {
  it("缺省关着；PUT 打开它，端口写回设置", async () => {
    const before = JSON.parse((await local("GET", "/api/gateway")).body);
    expect(before.running).toBe(false);
    expect(before.managedBy).toBe("settings");
    expect(before.tls.source).toBe("localCa");

    const opened = await local("PUT", "/api/gateway", {
      enabled: true,
      listen: "loopback",
    });
    expect(opened.status).toBe(200);
    const status = JSON.parse(opened.body);
    expect(status.running).toBe(true);
    expect(status.error).toBeNull();
    expect(status.address.host).toBe("127.0.0.1");
    expect(status.tls.source).toBe("localCa");
    expect(status.tls.caAvailable).toBe(true);
    expect(status.tls.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    origin = status.origin;
    expect(origin).toBe(`https://127.0.0.1:${status.address.port}`);
    // 端口 0 → 内核分配之后写回，下次固定。
    const saved = settingsDomain()?.settings.snapshot().gateway as {
      port: number;
    };
    expect(saved.port).toBe(status.address.port);
  });

  it("值错了答 400，不让规范化悄悄退回缺省", async () => {
    for (const body of [
      { listen: "public" },
      { port: 70_000 },
      { publicOrigin: "http://example.com" },
      { tls: { source: "magic" } },
      { surprise: true },
    ]) {
      expect((await local("PUT", "/api/gateway", body)).status).toBe(400);
    }
  });

  it("GET /ca.crt 匿名；只信这张 CA 的客户端能完整验证链，指纹与配对载荷一致", async () => {
    const answer = await remote("/ca.crt", { origin: null });
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("application/x-x509-ca-cert");
    ca = answer.body;
    const parsed = new X509Certificate(ca);
    expect(parsed.ca).toBe(true);

    const verified = await remote("/health", { trust: ca });
    expect(verified.status).toBe(200);

    const payload = await pairing();
    expect(payload.fingerprint).toBe(fingerprintOf(parsed));
    expect(payload.origin).toBe(origin);
    expect(payload.webUrl).toBe(
      `${origin}/#pair=${payload.ticket}&fp=${payload.fingerprint}`,
    );
    const deep = new URL(payload.deepLink);
    expect(deep.protocol).toBe("armadra:");
    expect(deep.searchParams.get("host")).toBe(new URL(origin).host);
    expect(deep.searchParams.get("ticket")).toBe(payload.ticket);
    expect(deep.searchParams.get("fp")).toBe(payload.fingerprint);
  });

  it("配对成 owner，成员访问被共享的画布，但改 Gateway 是 403", async () => {
    const payload = await pairing();
    const paired = await remote("/api/identity/pair", {
      method: "POST",
      body: { ticket: payload.ticket },
      trust: ca,
    });
    expect(paired.status).toBe(200);
    owner = person(paired);

    const root = tempDir("armadra-gateway-ws-");
    writeFileSync(join(root, "README.md"), "shared");
    const created = await remote("/api/workspaces", {
      method: "POST",
      person: owner,
      body: { name: "shared", rootPath: root },
    });
    expect(created.status).toBe(200);
    workspaceId = (JSON.parse(created.body) as { id: string }).id;

    const invited = await remote("/api/identity/invitations", {
      method: "POST",
      person: owner,
      body: { role: "viewer", targetWorkspaceId: workspaceId },
    });
    expect(invited.status).toBe(201);
    const registered = await remote("/api/identity/register", {
      method: "POST",
      body: {
        token: (JSON.parse(invited.body) as { token: string }).token,
        displayName: "成员",
        password: "correct horse battery",
      },
    });
    expect(registered.status).toBe(201);
    member = person(registered);

    expect(
      (
        await remote(`/api/workspaces/${workspaceId}/boards`, {
          person: member,
        })
      ).status,
    ).toBe(200);
    expect((await remote("/api/gateway", { person: owner })).status).toBe(200);
    expect((await remote("/api/gateway", { person: member })).status).toBe(403);
    expect(
      (
        await remote("/api/gateway", {
          method: "PUT",
          person: member,
          body: { enabled: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await remote("/api/gateway/pairing", {
          method: "POST",
          person: member,
          body: {},
        })
      ).status,
    ).toBe(403);
  });
});

describe("原生 App 的 Bearer 模式", () => {
  let accessToken: string;

  it("配对拿到 native 密钥、不发 Cookie，CORS 只回 App 的来源", async () => {
    const payload = await pairing();
    const paired = await remote("/api/identity/pair", {
      method: "POST",
      origin: APP,
      body: { ticket: payload.ticket },
    });
    expect(paired.status).toBe(200);
    expect(paired.headers["set-cookie"]).toBeUndefined();
    expect(paired.headers["access-control-allow-origin"]).toBe(APP);
    const body = JSON.parse(paired.body) as {
      native: { accessToken: string; refreshToken: string };
    };
    accessToken = body.native.accessToken;
    expect(accessToken).not.toBe("");

    const listed = await remote("/api/workspaces", {
      origin: APP,
      bearer: accessToken,
    });
    expect(listed.status).toBe(200);
    expect(listed.headers["access-control-allow-origin"]).toBe(APP);

    const preflight = await remote("/api/workspaces", {
      method: "OPTIONS",
      origin: APP,
      headers: { "access-control-request-headers": "authorization" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(APP);
    expect(preflight.headers["access-control-allow-headers"]).toContain(
      "authorization",
    );
  });

  it("没有 Bearer、或只带 Cookie，都是 401；别的来源 403", async () => {
    expect((await remote("/api/workspaces", { origin: APP })).status).toBe(401);
    expect(
      (await remote("/api/workspaces", { origin: APP, person: owner })).status,
    ).toBe(401);
    expect(
      (
        await remote("/api/workspaces", {
          origin: "https://evil.example",
          bearer: accessToken,
        })
      ).status,
    ).toBe(403);
  });

  it("ws-ticket 换一次性票，经 Sec-WebSocket-Protocol 升级；票用过就没", async () => {
    const issued = await remote("/api/identity/ws-ticket", {
      method: "POST",
      origin: APP,
      bearer: accessToken,
    });
    expect(issued.status).toBe(200);
    const { ticket } = JSON.parse(issued.body) as { ticket: string };
    const path = `/api/workspaces/${workspaceId}/events`;
    const opened = await stream(path, {
      headers: { origin: APP },
      protocols: [`armadra-ticket.${ticket}`],
    });
    expect(opened.status).toBe(101);
    if ("socket" in opened) {
      expect(opened.socket.protocol).toBe(`armadra-ticket.${ticket}`);
      opened.socket.close();
    }
    const replay = await stream(path, {
      headers: { origin: APP },
      protocols: [`armadra-ticket.${ticket}`],
    });
    expect(replay.status).toBe(401);

    // 网页端一律走 Cookie：它要票是 400。
    expect(
      (
        await remote("/api/identity/ws-ticket", {
          method: "POST",
          person: owner,
        })
      ).status,
    ).toBe(400);
  });
});

describe("关掉即断流", () => {
  it("开着的事件流在关掉的那一刻关闭，之后连不上", async () => {
    const opened = await stream(`/api/workspaces/${workspaceId}/events`, {
      headers: { origin, cookie: owner.cookie },
    });
    expect(opened.status).toBe(101);
    if (!("socket" in opened)) return;
    const closed = await local("PUT", "/api/gateway", { enabled: false });
    expect(closed.status).toBe(200);
    expect(JSON.parse(closed.body).running).toBe(false);
    await opened.closed;
    await expect(remote("/health")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("证书来源：ACME 与缺文件的「指定文件」报原因不开；指定文件时指纹是叶证书的", async () => {
    const acme = JSON.parse(
      (
        await local("PUT", "/api/gateway", {
          enabled: true,
          tls: { source: "acme" },
        })
      ).body,
    );
    expect(acme.running).toBe(false);
    expect(acme.error.code).toBe("acme_unavailable");
    const missing = JSON.parse(
      (await local("PUT", "/api/gateway", { tls: { source: "file" } })).body,
    );
    expect(missing.running).toBe(false);
    expect(missing.error.code).toBe("tls_files_missing");

    // 用本地 CA 签过的那张叶证书当「运维给的文件」：只有一张，没有可以发出去的根。
    const dataDir = core.dataDir;
    const fromFile = JSON.parse(
      (
        await local("PUT", "/api/gateway", {
          tls: {
            source: "file",
            certFile: join(dataDir, "tls", "leaf.crt"),
            keyFile: join(dataDir, "tls", "leaf.key"),
          },
        })
      ).body,
    );
    expect(fromFile.running).toBe(true);
    expect(fromFile.tls.source).toBe("file");
    expect(fromFile.tls.caAvailable).toBe(false);
    expect(fromFile.tls.fingerprint).not.toBe(fingerprintOf(ca));
    expect((await remote("/ca.crt", { origin: null })).status).toBe(404);
    // 叶证书仍由那张 CA 签：只信 CA 的客户端照样验得过。
    expect((await remote("/health", { trust: ca })).status).toBe(200);

    await local("PUT", "/api/gateway", {
      enabled: false,
      tls: { source: "localCa", certFile: "", keyFile: "" },
    });
  });

  it("再打开时 CA 不变、端口沿用", async () => {
    const reopened = JSON.parse(
      (await local("PUT", "/api/gateway", { enabled: true })).body,
    );
    expect(reopened.running).toBe(true);
    expect(reopened.origin).toBe(origin);
    expect(reopened.tls.fingerprint).toBe(fingerprintOf(ca));
  });
});
