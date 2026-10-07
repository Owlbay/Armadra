import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { CredentialsDomain } from "../agent/credentials";
import { installRoutes } from "../agent/credentials/routes";
import { EventBus } from "../bus";
import { openFreshDatabase } from "../db/fresh.fixture";
import { routeScope } from "../http/route-scopes";
import { installContract } from "../http/rpc";
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
import { type CoreLog, nodePlatform } from "../platform";
import type { SecretBackend, SecretBackendKind } from "../secrets/backend";
import { tempDir } from "../testing/temp-dir";
import {
  type Answer,
  type Kit,
  expectParity,
  startKit,
  text,
} from "./parity-kit";

/**
 * credentials 域的对偶测试（契约 §43.6；工程规范化包 §3 ④）。
 *
 * 同一份夹具问三次——路由表里原来那条 handler、旧 REST 路径（经 HTTP，由契约实现
 * 经 `OpenAPIHandler` 答）、新 procedure。成功的答案按 `canonicalJson` 逐字节
 * 相等；失败的码、状态与原话相等（procedure 多一个 `requestId`）。
 *
 * **值只进不出**是这一节的主题：每个答案、每条日志与审计事件都要证明没有凭据的值
 * ——成功的、被拒的、后端坏了的（连抛出来的异常消息里夹着值，也不出去）。
 * 只有 owner（全局 `settings:*`）：成员一律 403，凭据与密钥后端原样没动。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const VALUE = "sk-ant-oat01-PARITY-FAKE-VALUE-0001";
const NEXT_VALUE = "sk-ant-oat01-PARITY-FAKE-VALUE-0002";

const closing: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  resetRouteGuard();
  resetAuditSink();
  for (const close of closing.splice(0)) await close();
});

function memoryBackend(kind: SecretBackendKind = "keychain") {
  const values = new Map<string, string>();
  const backend: SecretBackend & { values: Map<string, string> } = {
    kind,
    values,
    get: (name) => Promise.resolve(values.get(name)),
    set: (name, value) => {
      values.set(name, value);
      return Promise.resolve();
    },
    delete: (name) => {
      values.delete(name);
      return Promise.resolve();
    },
  };
  return backend;
}

interface Setup {
  readonly kit: Kit;
  readonly server: CoreServer;
  readonly domain: CredentialsDomain;
  readonly backend: SecretBackend & { values: Map<string, string> };
  readonly logged: unknown[];
  readonly events: AuditEvent[];
}

async function open(
  options: {
    backend?: SecretBackend & { values: Map<string, string> };
    platform?: NodeJS.Platform;
  } = {},
): Promise<Setup> {
  const directory = tempDir("armadra-parity-credentials-");
  const opened = openFreshDatabase(join(directory, "canvas.db"), migrationsDir);
  closing.push(opened.close);
  const logged: unknown[] = [];
  const log: CoreLog = {
    debug: (message, fields) => logged.push([message, fields]),
    info: (message, fields) => logged.push([message, fields]),
    warn: (message, fields) => logged.push([message, fields]),
    error: (message, fields) => logged.push([message, fields]),
  };
  const events: AuditEvent[] = [];
  installAuditSink((event) => events.push(event));
  const backend = options.backend ?? memoryBackend();
  const platform = nodePlatform({
    dataDir: directory,
    appVersion: "0.0.0-test",
    isPackaged: false,
    log,
  });
  const server = new CoreServer({
    platform,
    bus: new EventBus(),
    version: "0.0.0-test",
  });
  const domain = new CredentialsDomain({
    database: opened.database,
    secrets: backend,
    baseOf: (id) => id,
    platform: options.platform ?? "darwin",
    ...(options.platform === "win32" ? { windowsLauncher: () => false } : {}),
    log: (message, fields) => logged.push([message, fields]),
  });
  installRoutes(server, domain);
  installContract(server, { validateOutput: true, platform });
  closing.push(() => server.close());
  const identities: Record<string, RequestIdentity | undefined> = {
    owner: { subject: { principalId: "owner", kind: "owner", scopes: [] } },
    member: {
      subject: { principalId: "member", kind: "member", scopes: [] },
    },
    local: undefined,
  };
  const kit = await startKit(server, (name) => identities[name]);
  installRouteGuard(
    createRouteGuard({
      database: opened.database,
      permits: (who, required) => permits([...who.scopes], required),
      effectiveScopes: (who) => [...who.scopes],
    }),
  );
  return { kit, server, domain, backend, logged, events };
}

const VOLATILE = new Set(["ref", "lastUsedAt"]);
const PATH = "/api/credentials";
const REF = (ref: string) => `${PATH}/${encodeURIComponent(ref)}`;

/** 三种答法（同一个主体）。 */
async function three(
  setup: Setup,
  as: string,
  method: string,
  path: string,
  name: string,
  input: unknown,
  body: unknown = input,
): Promise<readonly [Answer, Answer, Answer]> {
  return [
    await setup.kit.table(method, path, body, as),
    await setup.kit.legacy(method, path, body, as),
    await setup.kit.procedure(name, input, as),
  ];
}

const FIELDS = { providerId: "claude", kind: "oauth-token", label: "Work" };

/** 凭据的值不在答案、日志与审计里。 */
function expectNoValue(setup: Setup, answers: readonly Answer[]): void {
  for (const answer of answers) {
    for (const value of [VALUE, NEXT_VALUE]) {
      expect(text(answer)).not.toContain(value);
    }
  }
  const trail = JSON.stringify([setup.logged, setup.events]);
  for (const value of [VALUE, NEXT_VALUE]) expect(trail).not.toContain(value);
}

describe("list / create / update / remove", () => {
  it("list：没有条目时三种答法一样，种类表里 `enabled: false` 的灰着列出", async () => {
    const setup = await open();
    const answers = await three(
      setup,
      "owner",
      "GET",
      PATH,
      "credentials.list",
      undefined,
    );
    expect(answers[0].body).toMatchObject({
      backend: "keychain",
      available: true,
      entries: [],
    });
    const kinds = (answers[0].body as { kinds: { enabled: boolean }[] }).kinds;
    expect(kinds.some((kind) => !kind.enabled)).toBe(true);
    expectParity(answers);
  });

  it("create：旧路径 201、procedure 200，答的是同一条（只有 isSet）；值进了密钥后端", async () => {
    const setup = await open();
    const answers = await three(
      setup,
      "owner",
      "POST",
      PATH,
      "credentials.create",
      { ...FIELDS, value: VALUE },
    );
    expect(answers[0].status).toBe(201);
    expect(answers[0].body).toMatchObject({ ...FIELDS, isSet: true });
    expectParity(answers, { volatile: VOLATILE, legacyStatus: 201 });
    expectNoValue(setup, answers);
    // 三条各有自己的 ref，值在后端里，不在任何别处。
    expect([...setup.backend.values.values()]).toEqual([VALUE, VALUE, VALUE]);
    const listed = await setup.kit.procedure(
      "credentials.list",
      undefined,
      "owner",
    );
    expect(text(listed)).not.toContain(VALUE);
    expect((listed.body as { entries: unknown[] }).entries).toHaveLength(3);
    expect(
      setup.events.filter((event) => event.action === "credential.create"),
    ).toHaveLength(3);
  });

  it("create 的拒绝：缺字段、不认识的种类、未启用的种类、值不是单行；码与原话三处一样，没有写进后端", async () => {
    const setup = await open();
    const cases: readonly [object, number, string][] = [
      [{ ...FIELDS, label: " ", value: VALUE }, 400, "bad_request"],
      [{ ...FIELDS, kind: "no-such-kind", value: VALUE }, 400, "bad_request"],
      [
        { ...FIELDS, kind: "api-key", value: VALUE },
        400,
        "credential_kind_disabled",
      ],
      [{ ...FIELDS, value: `${VALUE}\nsecond line` }, 400, "bad_request"],
      [{ ...FIELDS, value: "x".repeat(8_193) }, 400, "bad_request"],
    ];
    for (const [input, status, code] of cases) {
      const answers = await three(
        setup,
        "owner",
        "POST",
        PATH,
        "credentials.create",
        input,
      );
      expect(answers[0].status, JSON.stringify(input).slice(0, 80)).toBe(
        status,
      );
      expect(answers[0].body).toMatchObject({ code });
      expectParity(answers);
      expectNoValue(setup, answers);
    }
    expect(setup.backend.values.size).toBe(0);
  });

  it("update：改名、换值、两样一起；两样都没给 400；不存在 404；值不是单行 400", async () => {
    const setup = await open();
    const made = await setup.kit.procedure(
      "credentials.create",
      { ...FIELDS, value: VALUE },
      "owner",
    );
    const ref = (made.body as { ref: string }).ref;
    const cases: readonly [object, number][] = [
      [{ label: "Renamed" }, 200],
      [{ value: NEXT_VALUE }, 200],
      [{ label: "Both", value: VALUE }, 200],
      [{}, 400],
      [{ label: "  " }, 400],
      [{ value: `${VALUE}\r\nx` }, 400],
    ];
    for (const [body, status] of cases) {
      const answers = await three(
        setup,
        "owner",
        "PATCH",
        REF(ref),
        "credentials.update",
        { ref, ...body },
        body,
      );
      expect(answers[0].status, JSON.stringify(body)).toBe(status);
      expectParity(answers, { volatile: VOLATILE });
      expectNoValue(setup, answers);
    }
    const missing = await three(
      setup,
      "owner",
      "PATCH",
      REF("nope"),
      "credentials.update",
      { ref: "nope", label: "x" },
      { label: "x" },
    );
    expect(missing[0].status).toBe(404);
    expect(missing[0].body).toMatchObject({ code: "credential_not_found" });
    expectParity(missing);
    expect(
      setup.events.filter((event) => event.action === "credential.update")
        .length,
    ).toBe(9);
  });

  it("remove：旧路径 204、procedure 200 无体；值从后端删掉；不存在 404", async () => {
    const setup = await open();
    const make = async () =>
      (
        (
          await setup.kit.procedure(
            "credentials.create",
            { ...FIELDS, value: VALUE },
            "owner",
          )
        ).body as { ref: string }
      ).ref;
    const [a, b, c] = [await make(), await make(), await make()];
    expect(setup.backend.values.size).toBe(3);
    const old = await setup.kit.table("DELETE", REF(a), undefined, "owner");
    const rest = await setup.kit.legacy("DELETE", REF(b), undefined, "owner");
    const rpc = await setup.kit.procedure(
      "credentials.remove",
      { ref: c },
      "owner",
    );
    expect([old.status, rest.status, rpc.status]).toEqual([204, 204, 200]);
    for (const answer of [old, rest, rpc]) {
      expect(answer.body ?? null).toBeNull();
    }
    expect(setup.backend.values.size).toBe(0);
    const again = await three(
      setup,
      "owner",
      "DELETE",
      REF(a),
      "credentials.remove",
      { ref: a },
      undefined,
    );
    expect(again[0].status).toBe(404);
    expect(again[0].body).toMatchObject({ code: "credential_not_found" });
    expectParity(again);
  });
});

describe("这台主机不存凭据的几种情形", () => {
  it("文件后端（明文）：list 报 available:false 与原因，create 409，三处一样", async () => {
    const setup = await open({ backend: memoryBackend("file") });
    const list = await three(
      setup,
      "owner",
      "GET",
      PATH,
      "credentials.list",
      undefined,
    );
    expect(list[0].body).toMatchObject({
      backend: "file",
      available: false,
      reason: "credential_backend_insecure",
    });
    expectParity(list);
    const created = await three(
      setup,
      "owner",
      "POST",
      PATH,
      "credentials.create",
      { ...FIELDS, value: VALUE },
    );
    expect(created[0].status).toBe(409);
    expect(created[0].body).toMatchObject({
      code: "credential_backend_insecure",
    });
    expectParity(created);
    expectNoValue(setup, created);
    expect(setup.backend.values.size).toBe(0);
  });

  it("Windows 上没有画布启动器：create 400 credential_unsupported_here", async () => {
    const setup = await open({ platform: "win32" });
    const created = await three(
      setup,
      "owner",
      "POST",
      PATH,
      "credentials.create",
      { ...FIELDS, value: VALUE },
    );
    expect(created[0].status).toBe(400);
    expect(created[0].body).toMatchObject({
      code: "credential_unsupported_here",
    });
    expectParity(created);
  });

  it("密钥后端坏了：503 credential_unavailable；异常消息里夹着值也不出去，日志里也没有", async () => {
    const backend = memoryBackend();
    const setup = await open({ backend });
    const made = await setup.kit.procedure(
      "credentials.create",
      { ...FIELDS, value: VALUE },
      "owner",
    );
    const ref = (made.body as { ref: string }).ref;
    backend.set = () =>
      Promise.reject(
        Object.assign(new Error(`/Users/someone/.secrets 打不开 ${VALUE}`), {
          code: "secret_unavailable",
        }),
      );
    const unavailable = await three(
      setup,
      "owner",
      "PATCH",
      REF(ref),
      "credentials.update",
      { ref, value: NEXT_VALUE },
      { value: NEXT_VALUE },
    );
    expect(unavailable[0].status).toBe(503);
    expect(unavailable[0].body).toMatchObject({
      code: "credential_unavailable",
    });
    expectParity(unavailable);
    expectNoValue(setup, unavailable);

    // 后端抛的不是认得的错：500，固定的一句话，异常本身不出去。
    backend.set = () =>
      Promise.reject(new Error(`boom ${VALUE} /Users/someone`));
    const broken = await three(
      setup,
      "owner",
      "PATCH",
      REF(ref),
      "credentials.update",
      { ref, value: NEXT_VALUE },
      { value: NEXT_VALUE },
    );
    expect(broken[0].status).toBe(500);
    expect(broken[0].body).toMatchObject({ code: "internal" });
    expectParity(broken);
    expectNoValue(setup, broken);
    for (const answer of broken) {
      expect(text(answer)).not.toContain("someone");
    }
    expect(JSON.stringify(setup.logged)).not.toContain("someone");
  });
});

describe("拒绝路径：只有 owner", () => {
  it("成员读、写、改、删一律 403，条目与后端里的值原样没动", async () => {
    const setup = await open();
    const made = await setup.kit.procedure(
      "credentials.create",
      { ...FIELDS, value: VALUE },
      "owner",
    );
    const ref = (made.body as { ref: string }).ref;
    const before = {
      list: text(
        await setup.kit.procedure("credentials.list", undefined, "owner"),
        VOLATILE,
      ),
      values: [...setup.backend.values.entries()],
    };
    const attempts: readonly [string, string, string, unknown, unknown][] = [
      ["GET", PATH, "credentials.list", undefined, undefined],
      [
        "POST",
        PATH,
        "credentials.create",
        { ...FIELDS, value: NEXT_VALUE },
        undefined,
      ],
      [
        "PATCH",
        REF(ref),
        "credentials.update",
        { ref, value: NEXT_VALUE },
        { value: NEXT_VALUE },
      ],
      ["DELETE", REF(ref), "credentials.remove", { ref }, undefined],
    ];
    for (const [method, path, name, input, body] of attempts) {
      // 路由门在 HTTP 服务器上，路由表直接派发的那一路不经它。
      const answers = [
        await setup.kit.legacy(method, path, body ?? input, "member"),
        await setup.kit.procedure(name, input, "member"),
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
      text(
        await setup.kit.procedure("credentials.list", undefined, "owner"),
        VOLATILE,
      ),
    ).toBe(before.list);
    expect([...setup.backend.values.entries()]).toEqual(before.values);
    expectNoValue(setup, []);
  });
});

describe("入参形状错：procedure 与旧路径由契约先答 bad_request", () => {
  it("类型不对：码与状态一致，procedure 带 issues，值不进 issues", async () => {
    const setup = await open();
    const cases: readonly [string, string, unknown, string, unknown][] = [
      [
        "POST",
        PATH,
        { providerId: 5, value: VALUE },
        "credentials.create",
        { providerId: 5, value: VALUE },
      ],
      [
        "PATCH",
        REF("r"),
        { value: 5 },
        "credentials.update",
        { ref: "r", value: 5 },
      ],
    ];
    for (const [method, path, body, name, input] of cases) {
      const rest = await setup.kit.legacy(method, path, body, "owner");
      const rpc = await setup.kit.procedure(name, input, "owner");
      for (const answer of [rest, rpc]) {
        expect(answer.status, name).toBe(400);
        expect(answer.body, name).toMatchObject({ code: "bad_request" });
        expect(text(answer)).not.toContain(VALUE);
      }
      const detail = (rpc.body as { details?: { issues?: unknown[] } }).details;
      expect(detail?.issues?.length, name).toBeGreaterThan(0);
    }
  });
});

describe("契约与 core 的两张表（credentials）", () => {
  const entries = contractEntries().filter((entry) =>
    entry.name.startsWith("credentials."),
  );

  it("4 条都在契约里，每条都有旧路径", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      ["create", "list", "remove", "update"].map(
        (name) => `credentials.${name}`,
      ),
    );
    for (const entry of entries) {
      expect(entry.meta.legacy, entry.name).toBeDefined();
    }
  });

  it("meta.scope 与路由表给旧路径的要求一致；旧路径都在路由表里并有人认领", async () => {
    const setup = await open();
    for (const entry of entries) {
      const legacyRoute = entry.meta.legacy!;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = setup.server.router.match(legacyRoute.path);
      expect(found?.entry.methods ?? []).toContain(legacyRoute.method);
      expect(
        setup.server.router.claimed(
          legacyRoute.method,
          found?.entry.path as string,
        ),
        entry.name,
      ).toBe(true);
    }
  });
});
