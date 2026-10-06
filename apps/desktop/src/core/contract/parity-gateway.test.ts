import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { EventBus } from "../bus";
import { openFreshDatabase } from "../db/fresh.fixture";
import { GatewayDomain, gatewayDomainOf, install } from "../gateway";
import { GatewayError, type Gateway } from "../gateway/listener";
import { PairingCodes } from "../gateway/pairing-code";
import { routeScope } from "../http/route-scopes";
import { type RpcHandle, installContract } from "../http/rpc";
import { CoreServer } from "../http/server";
import {
  type AuditEvent,
  installAuditSink,
  resetAuditSink,
} from "../identity/audit";
import {
  type RequestIdentity,
  installRouteGuard,
  resetRouteGuard,
} from "../identity/gate";
import { createRouteGuard } from "../identity/route-access";
import { permits } from "../identity/scopes";
import type { CoreContext } from "../main";
import { type CoreLog, nodePlatform } from "../platform";
import { install as installSettings } from "../settings";
import { tempDir } from "../testing/temp-dir";
import {
  type Answer,
  type Kit,
  expectParity,
  startKit,
  text,
} from "./parity-kit";

/**
 * gateway 域的对偶测试（契约 §43.7；工程规范化包 §3 ④）。
 *
 * 同一份夹具问三次——路由表里原来那条 handler、旧 REST 路径（经 HTTP，由契约实现
 * 经 `OpenAPIHandler` 答）、新 procedure。成功的答案按 `canonicalJson` 逐字节
 * 相等；失败的码、状态与原话相等（procedure 多一个 `requestId`）。Gateway 本身用
 * 一个假的（监听、证书与配对的实现在 `gateway.integration.test.ts` 里用真的验过），
 * 这里验的是线上的形状与权限：只有 owner，成员一律 403；配对票只答给调用方，不进
 * 审计与日志。
 *
 * **匿名面不经 RPC**：配对短码换票只在旧路径上（路由表那条 handler 与旧路径逐字节
 * 相等），`gateway.exchangePairingCode` 在 RPC 上答 `501`、不在 `system.hello` 的
 * procedure 表里；它的旧路径仍是路由表那条 handler 在答（门面不接管）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

let kit: Kit;
let handle: RpcHandle;
let server: CoreServer;
let domain: GatewayDomain;
let events: AuditEvent[];
let logged: unknown[];

const closing: (() => void | Promise<void>)[] = [];

const ISSUED = {
  ticket: `${"a".repeat(32)}.${"b".repeat(43)}`,
  expiresAtMs: Date.now() + 600_000,
  origin: "https://192.168.1.20:8443",
  fingerprint: "f".repeat(64),
  webUrl: "https://192.168.1.20:8443/#pair=x",
  deepLink: "armadra://pair?host=x&ticket=x&fp=x",
};

function fakeGateway(mode: string): Gateway {
  return {
    address: { host: "192.168.1.20", port: 8443 },
    mode,
    publicOrigins: [],
    origin: () => "https://192.168.1.20:8443",
    origins: () => ["https://192.168.1.20:8443"],
    tls: () => ({
      source: "selfSigned",
      fingerprint: "f".repeat(64),
      subject: "CN=192.168.1.20",
      names: ["192.168.1.20"],
      notAfter: "Oct  3 00:00:00 2027 GMT",
      anchor: "pem",
    }),
    pair: (input: { origin?: string }) => {
      if (input.origin === "https://elsewhere.example") {
        throw new GatewayError("invalid_origin", "这个来源不是本 Gateway 的");
      }
      return ISSUED;
    },
  } as unknown as Gateway;
}

beforeAll(async () => {
  const directory = tempDir("armadra-parity-gateway-");
  const opened = openFreshDatabase(join(directory, "canvas.db"), migrationsDir);
  closing.push(opened.close);
  logged = [];
  const log: CoreLog = {
    debug: (message, fields) => logged.push([message, fields]),
    info: (message, fields) => logged.push([message, fields]),
    warn: (message, fields) => logged.push([message, fields]),
    error: (message, fields) => logged.push([message, fields]),
  };
  events = [];
  installAuditSink((event) => events.push(event));
  const bus = new EventBus();
  const platform = nodePlatform({
    dataDir: directory,
    appVersion: "0.0.0-test",
    isPackaged: false,
    log,
  });
  server = new CoreServer({ platform, bus, version: "0.0.0-test" });
  closing.push(() => server.close());
  const context: CoreContext = {
    dataDir: directory,
    db: opened,
    server,
    bus,
    platform,
    log,
  };
  installSettings(context);
  install(context, { pairingCodes: new PairingCodes() });
  domain = gatewayDomainOf(server) as GatewayDomain;
  handle = installContract(server, { validateOutput: true, platform });
  const identities: Record<string, RequestIdentity | undefined> = {
    owner: { subject: { principalId: "owner", kind: "owner", scopes: [] } },
    member: {
      subject: { principalId: "member", kind: "member", scopes: [] },
    },
    local: undefined,
  };
  kit = await startKit(server, (name) => identities[name]);
  installRouteGuard(
    createRouteGuard({
      database: opened.database,
      permits: (who, required) => permits([...who.scopes], required),
      effectiveScopes: (who) => [...who.scopes],
    }),
  );
});

afterAll(async () => {
  resetRouteGuard();
  resetAuditSink();
  for (const close of closing.splice(0)) await close();
});

const VOLATILE = new Set(["code"]);
const PAIRING = "/api/gateway/pairing";
const EXCHANGE = "/api/gateway/pairing-code/exchange";

async function three(
  as: string,
  method: string,
  path: string,
  name: string,
  input: unknown,
  body: unknown = input,
): Promise<readonly [Answer, Answer, Answer]> {
  return [
    await kit.table(method, path, body, as),
    await kit.legacy(method, path, body, as),
    await kit.procedure(name, input, as),
  ];
}

/** 配对票与短码不进审计与日志。 */
function expectNoTicket(): void {
  const trail = JSON.stringify([events, logged]);
  expect(trail).not.toContain(ISSUED.ticket);
  expect(trail).not.toContain(ISSUED.webUrl);
}

describe("Gateway 没在运行（设置托管）", () => {
  it("status：关着，三种答法一样，owner 与本机请求都读得到", async () => {
    for (const as of ["owner", "local"]) {
      const answers = await three(
        as,
        "GET",
        "/api/gateway",
        "gateway.status",
        undefined,
      );
      expect(answers[0].body, as).toMatchObject({
        enabled: false,
        running: false,
        managedBy: "settings",
        address: null,
      });
      expectParity(answers);
    }
  });

  it("pair：没在运行 409 gateway_not_running，三处一样", async () => {
    const answers = await three("owner", "POST", PAIRING, "gateway.pair", {});
    expect(answers[0].status).toBe(409);
    expect(answers[0].body).toMatchObject({ code: "gateway_not_running" });
    expectParity(answers);
  });

  it("exchange：没在运行 409，路由表与旧路径逐字节一样", async () => {
    const old = await kit.table("POST", EXCHANGE, { code: "ABCD2345" });
    const rest = await kit.legacy("POST", EXCHANGE, { code: "ABCD2345" });
    expect(old.status).toBe(409);
    expect(old.body).toMatchObject({ code: "gateway_not_running" });
    expect(rest.status).toBe(409);
    expect(text(rest)).toBe(text(old));
  });

  it("configure：改设置并对账（这里只改不开）；答新状态，三处一样", async () => {
    const patches: readonly object[] = [
      { listen: "private" },
      {
        port: 18_443,
        tls: { source: "file", certFile: "/c.pem", keyFile: "/k.pem" },
      },
      { publicOrigin: "" },
    ];
    for (const patch of patches) {
      const answers = await three(
        "owner",
        "PUT",
        "/api/gateway",
        "gateway.configure",
        patch,
      );
      expect(answers[0].status, JSON.stringify(patch)).toBe(200);
      expect(answers[0].body).toMatchObject({ enabled: false, running: false });
      expectParity(answers);
    }
    expect(
      events.filter((event) => event.action === "gateway.configure"),
    ).toHaveLength(patches.length * 3);
    // 证书与私钥的文件路径不进审计。
    expect(JSON.stringify(events)).not.toContain("/k.pem");
  });

  it("configure 的取值错：listen、端口、publicOrigin、tls 来源；码与原话三处一样，设置原样没动", async () => {
    const before = text(
      await kit.procedure("gateway.status", undefined, "owner"),
    );
    const bad: readonly object[] = [
      { listen: "everywhere" },
      { port: 70_000 },
      { port: 1.5 },
      { publicOrigin: "http://armadra.example" },
      { tls: { source: "magic" } },
    ];
    for (const patch of bad) {
      const answers = await three(
        "owner",
        "PUT",
        "/api/gateway",
        "gateway.configure",
        patch,
      );
      expect(answers[0].status, JSON.stringify(patch)).toBe(400);
      expect(answers[0].body).toMatchObject({ code: "bad_request" });
      expectParity(answers);
    }
    expect(
      text(await kit.procedure("gateway.status", undefined, "owner")),
    ).toBe(before);
  });
});

describe("Gateway 在运行（服务器壳托管）", () => {
  beforeAll(() => {
    domain.adopt(fakeGateway("private"));
  });

  it("status：报在运行、托管者是壳、地址与证书指纹，三处一样", async () => {
    const answers = await three(
      "owner",
      "GET",
      "/api/gateway",
      "gateway.status",
      undefined,
    );
    expect(answers[0].body).toMatchObject({
      enabled: true,
      running: true,
      managedBy: "shell",
      address: { host: "192.168.1.20", port: 8443 },
      tls: { source: "selfSigned", fingerprint: "f".repeat(64) },
    });
    expectParity(answers);
  });

  it("configure：壳托管时 409 gateway_managed_by_shell，设置没动", async () => {
    const answers = await three(
      "owner",
      "PUT",
      "/api/gateway",
      "gateway.configure",
      { enabled: false },
    );
    expect(answers[0].status).toBe(409);
    expect(answers[0].body).toMatchObject({ code: "gateway_managed_by_shell" });
    expectParity(answers);
  });

  it("pair：私网档答配对票与 XXXX-XXXX 短码（短码每次不同），三处一样；票不进审计与日志", async () => {
    const answers = await three("owner", "POST", PAIRING, "gateway.pair", {
      deviceName: "手机",
    });
    expect(answers[0].status).toBe(200);
    expect(answers[0].body).toMatchObject({
      origin: ISSUED.origin,
      ticket: ISSUED.ticket,
      fingerprint: ISSUED.fingerprint,
    });
    expect((answers[0].body as { code: string }).code).toMatch(
      /^[A-Z2-9]{4}-[A-Z2-9]{4}$/,
    );
    expectParity(answers, { volatile: VOLATILE });
    expect(
      new Set(answers.map((a) => (a.body as { code: string }).code)).size,
    ).toBe(3);
    expectNoTicket();
    expect(
      events.filter((event) => event.action === "gateway.pairing.issue"),
    ).toHaveLength(3);
  });

  it("pair 的拒绝：来源不是本 Gateway 的 400 invalid_origin；deviceName 空或太长 400", async () => {
    const cases: readonly [object, string][] = [
      [{ origin: "https://elsewhere.example" }, "invalid_origin"],
      [{ deviceName: "  " }, "bad_request"],
      [{ deviceName: "x".repeat(65) }, "bad_request"],
    ];
    for (const [input, code] of cases) {
      const answers = await three(
        "owner",
        "POST",
        PAIRING,
        "gateway.pair",
        input,
      );
      expect(answers[0].status, JSON.stringify(input)).toBe(400);
      expect(answers[0].body).toMatchObject({ code });
      expectParity(answers);
    }
  });

  it("exchange：不对的短码 404，扣令牌；用多了 429 带 Retry-After；路由表与旧路径一样", async () => {
    const attempt = { code: "ZZZZ-ZZZZ" };
    const old = await kit.table("POST", EXCHANGE, attempt);
    const rest = await kit.legacy("POST", EXCHANGE, attempt);
    expect(old.status).toBe(404);
    expect(old.body).toMatchObject({ code: "pairing_code_invalid" });
    expect(text(rest)).toBe(text(old));
    expect(rest.status).toBe(404);
    expect(
      events.filter((event) => event.action === "gateway.pairing.code.reject"),
    ).toHaveLength(2);

    let limited: Answer | undefined;
    for (let index = 0; index < 200 && limited === undefined; index += 1) {
      const answer = await kit.legacy("POST", EXCHANGE, attempt);
      if (answer.status === 429) limited = answer;
    }
    expect(limited?.body).toMatchObject({ code: "rate_limited" });
    expect(Number(limited?.retryAfter)).toBeGreaterThan(0);
  });

  it("exchange 的体不对 400；公网 all 档与配了对外来源时 403 pairing_code_disabled", async () => {
    for (const body of [
      {},
      { code: 7 },
      { code: "x".repeat(33) },
      { code: "ABCD2345", extra: 1 },
    ]) {
      const old = await kit.table("POST", EXCHANGE, body);
      const rest = await kit.legacy("POST", EXCHANGE, body);
      expect(old.status, JSON.stringify(body)).toBe(400);
      expect(rest.status).toBe(400);
      expect(text(rest)).toBe(text(old));
    }
    const publicGateway = fakeGateway("all");
    (publicGateway as unknown as { address: { host: string } }).address.host =
      "203.0.113.5";
    domain.adopt(publicGateway);
    const old = await kit.table("POST", EXCHANGE, { code: "ABCD2345" });
    const rest = await kit.legacy("POST", EXCHANGE, { code: "ABCD2345" });
    expect(old.status).toBe(403);
    expect(old.body).toMatchObject({ code: "pairing_code_disabled" });
    expect(text(rest)).toBe(text(old));
    // 公网档的配对票不带短码。
    const pair = await kit.procedure("gateway.pair", {}, "owner");
    expect(pair.body).toMatchObject({ code: null });
    domain.adopt(fakeGateway("private"));
  });
});

describe("匿名面不经 RPC", () => {
  it("gateway.exchangePairingCode 在 RPC 上答 501，不在 system.hello 的表里", async () => {
    const answer = await kit.procedure(
      "gateway.exchangePairingCode",
      { code: "ABCD2345" },
      "owner",
    );
    expect(answer.status).toBe(501);
    expect(answer.body).toMatchObject({ code: "not_implemented" });
    // `system.hello` 报的就是这张表。
    expect(handle.implemented).toContain("gateway.status");
    expect(handle.implemented).not.toContain("gateway.exchangePairingCode");
  });

  it("旧路径上匿名（没有会话）也过得了路由门，由 Gateway 域自己限流与判档位", async () => {
    const rest = await kit.legacy("POST", EXCHANGE, { code: "ABCD2345" });
    expect([404, 409, 429]).toContain(rest.status);
  });
});

describe("拒绝路径：只有 owner", () => {
  it("成员读状态、改配置、铸票一律 403，配置与配对表原样没动", async () => {
    const before = text(
      await kit.procedure("gateway.status", undefined, "owner"),
    );
    const issued = events.filter(
      (e) => e.action === "gateway.pairing.issue",
    ).length;
    const attempts: readonly [string, string, string, unknown][] = [
      ["GET", "/api/gateway", "gateway.status", undefined],
      ["PUT", "/api/gateway", "gateway.configure", { enabled: true }],
      ["POST", PAIRING, "gateway.pair", {}],
    ];
    for (const [method, path, name, input] of attempts) {
      // 路由门在 HTTP 服务器上，路由表直接派发的那一路不经它。
      const answers = [
        await kit.legacy(method, path, input, "member"),
        await kit.procedure(name, input, "member"),
      ];
      for (const answer of answers) {
        expect(answer.status, name).toBe(403);
        expect(answer.body, name).toEqual({
          code: "forbidden",
          message: "没有这项权限",
        });
      }
    }
    expect(
      text(await kit.procedure("gateway.status", undefined, "owner")),
    ).toBe(before);
    expect(
      events.filter((e) => e.action === "gateway.pairing.issue"),
    ).toHaveLength(issued);
  });
});

describe("入参形状错：procedure 与旧路径由契约先答 bad_request", () => {
  it("类型不对或多出来的键：码与状态一致，procedure 带 issues", async () => {
    const cases: readonly [string, string, unknown, string][] = [
      ["PUT", "/api/gateway", { enabled: "yes" }, "gateway.configure"],
      ["PUT", "/api/gateway", { surprise: true }, "gateway.configure"],
      ["PUT", "/api/gateway", { tls: { source: 3 } }, "gateway.configure"],
      ["POST", PAIRING, { origin: 1 }, "gateway.pair"],
    ];
    for (const [method, path, input, name] of cases) {
      const old = await kit.table(method, path, input, "owner");
      const rest = await kit.legacy(method, path, input, "owner");
      const rpc = await kit.procedure(name, input, "owner");
      for (const answer of [old, rest, rpc]) {
        expect(answer.status, name).toBe(400);
        expect(answer.body, name).toMatchObject({ code: "bad_request" });
      }
      const detail = (rpc.body as { details?: { issues?: unknown[] } }).details;
      expect(detail?.issues?.length, name).toBeGreaterThan(0);
    }
  });
});

describe("契约与 core 的两张表（gateway）", () => {
  const entries = contractEntries().filter((entry) =>
    entry.name.startsWith("gateway."),
  );

  it("4 条都在契约里，每条都有旧路径；只有换票是匿名的", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "gateway.configure",
      "gateway.exchangePairingCode",
      "gateway.pair",
      "gateway.status",
    ]);
    for (const entry of entries) {
      expect(entry.meta.legacy, entry.name).toBeDefined();
    }
    expect(
      entries.filter((entry) => entry.meta.scope === null).map((e) => e.name),
    ).toEqual(["gateway.exchangePairingCode"]);
  });

  it("meta.scope 与路由表给旧路径的要求一致；旧路径都在路由表里并有人认领", () => {
    for (const entry of entries) {
      const legacyRoute = entry.meta.legacy!;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = server.router.match(legacyRoute.path);
      expect(found?.entry.methods ?? []).toContain(legacyRoute.method);
      expect(
        server.router.claimed(legacyRoute.method, found?.entry.path as string),
        entry.name,
      ).toBe(true);
    }
  });
});
