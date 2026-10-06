import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { EventBus } from "../bus";
import { openFreshDatabase } from "../db/fresh.fixture";
import { ClientReports } from "../diagnostics/client-report";
import { scrubContext } from "../diagnostics/crash";
import { CLIENT_ERROR_ROUTE, installRoutes } from "../diagnostics/routes";
import { routeScope } from "../http/route-scopes";
import { installContract } from "../http/rpc";
import { CoreServer } from "../http/server";
import {
  type RequestIdentity,
  installRouteGuard,
  resetRouteGuard,
} from "../identity/gate";
import { createRouteGuard } from "../identity/route-access";
import { permits } from "../identity/scopes";
import { createLog, nodePlatform } from "../platform";
import { tempDir } from "../testing/temp-dir";
import {
  type Answer,
  type Kit,
  expectParity,
  startKit,
  text,
} from "./parity-kit";

/**
 * diagnostics 域的对偶测试（契约 §43.8；工程规范化包 §3 ④）。
 *
 * 同一份夹具问三次——路由表里原来那条 handler、旧 REST 路径（经 HTTP，由契约实现
 * 经 `OpenAPIHandler` 答）、新 procedure。成功的答案按 `canonicalJson` 逐字节
 * 相等；失败的码、状态与原话相等（procedure 多一个 `requestId`）。
 *
 * 主题是**上报的内容不外泄**：收下的错误先剥离再交出，家目录、环境里的密钥与会话
 * 令牌都不会出现在交出去的错误里，也不在任何答案里；关着时一条也不收、也不看请求体。
 * 限流按调用方（设备优先）计，时钟可调，三种答法各用一个调用方。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const SECRET = "sk-live-0123456789abcdefABCDEF";

let kit: Kit;
let server: CoreServer;
let on = true;
let clock = 1_800_000_000_000;
const sent: Error[] = [];
const closing: (() => void | Promise<void>)[] = [];

const caller = (name: string): RequestIdentity => ({
  subject: { principalId: name, kind: "member", scopes: [] },
  device: { deviceId: `device-${name}`, deviceName: name },
});

beforeAll(async () => {
  const directory = tempDir("armadra-parity-diagnostics-");
  const opened = openFreshDatabase(join(directory, "canvas.db"), migrationsDir);
  closing.push(opened.close);
  const platform = nodePlatform({
    dataDir: directory,
    appVersion: "0.0.0-test",
    isPackaged: false,
    log: createLog("error"),
  });
  server = new CoreServer({
    platform,
    bus: new EventBus(),
    version: "0.0.0-test",
  });
  closing.push(() => server.close());
  installRoutes(
    server,
    new ClientReports({
      enabled: () => on,
      report: (error) => sent.push(error),
      scrub: () =>
        scrubContext(
          { HOME: "/Users/alice", OPENAI_API_KEY: SECRET },
          "/Users/alice",
        ),
      now: () => clock,
    }),
  );
  installContract(server, { validateOutput: true, platform });
  const identities: Record<string, RequestIdentity | undefined> = {
    a: caller("a"),
    b: caller("b"),
    c: caller("c"),
    owner: { subject: { principalId: "owner", kind: "owner", scopes: [] } },
    anon: { subject: { principalId: "", kind: "member", scopes: [] } },
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
  for (const close of closing.splice(0)) await close();
});

const NAME = "diagnostics.reportClientError";
const report = (extra: Record<string, unknown> = {}) => ({
  kind: "error",
  name: "TypeError",
  message: "boom",
  stack: "",
  ...extra,
});

/** 三种答法各用自己的调用方（互不占对方的限流桶）；每次前把时钟拨过限流窗口。 */
async function three(
  method: string,
  name: string,
  input: unknown,
  callers: readonly [string, string, string] = ["a", "b", "c"],
): Promise<readonly [Answer, Answer, Answer]> {
  clock += 61_000;
  return [
    await kit.table(method, CLIENT_ERROR_ROUTE, input, callers[0]),
    await kit.legacy(method, CLIENT_ERROR_ROUTE, input, callers[1]),
    await kit.procedure(name, input, callers[2]),
  ];
}

describe("clientErrorStatus", () => {
  it("开着答 enabled:true，关着 false；登录即可（没授权的成员也行），本机请求照答", async () => {
    for (const enabled of [true, false]) {
      on = enabled;
      for (const as of ["a", "owner", "local"]) {
        const answers = await three(
          "GET",
          "diagnostics.clientErrorStatus",
          undefined,
          [as, as, as],
        );
        expect(answers[0].body, as).toEqual({ enabled });
        expectParity(answers);
      }
    }
    on = true;
  });

  it("匿名主体 401，三处一样", async () => {
    const answers = await three(
      "GET",
      "diagnostics.clientErrorStatus",
      undefined,
      ["anon", "anon", "anon"],
    );
    expect(answers[0].status).toBe(401);
    expectParity(answers);
  });
});

describe("reportClientError", () => {
  it("收下：答 accepted:true（旧路径 202、procedure 200）；交出去的错误是剥离过的，原文里的家目录与密钥不外泄", async () => {
    sent.length = 0;
    const input = report({
      message: `读 /Users/alice/notes.txt 失败，key=${SECRET}`,
      stack: "TypeError: x\n    at f (/Users/alice/proj/src/a.ts:1:2)",
    });
    const answers = await three("POST", NAME, input);
    expect(answers[0]).toMatchObject({ status: 202, body: { accepted: true } });
    expectParity(answers, { legacyStatus: 202 });
    expect(sent).toHaveLength(3);
    for (const error of sent) {
      const wire = `${error.name}\n${error.message}\n${error.stack}`;
      expect(wire).not.toContain(SECRET);
      expect(wire).not.toContain("/Users/alice");
      expect(error.stack).toContain("a.ts:1:2");
    }
    for (const answer of answers) expect(text(answer)).not.toContain(SECRET);
  });

  it("关着：accepted:false，不看请求体、一条也不交出", async () => {
    on = false;
    sent.length = 0;
    const answers = await three("POST", NAME, report({ message: SECRET }));
    expect(answers[0]).toMatchObject({
      status: 200,
      body: { accepted: false },
    });
    // procedure 恒 200；旧路径经契约登记的成功状态答 202。
    expectParity(answers, { legacyStatus: 202 });
    // 关着时请求体不被解析：连不是 JSON 的体也答 200。
    const garbage = await kit.table(
      "POST",
      CLIENT_ERROR_ROUTE,
      "not json",
      "a",
    );
    expect(garbage.status).toBe(200);
    expect(sent).toHaveLength(0);
    on = true;
  });

  it("体不对 400：未知的键、kind、字段类型与长度；码与原话三处一样，没有交出任何东西", async () => {
    sent.length = 0;
    const bad: readonly Record<string, unknown>[] = [
      report({ extra: 1 }),
      report({ kind: "warning" }),
      report({ name: 5 }),
      report({ message: "x".repeat(2_001) }),
      report({ stack: "x".repeat(8_001) }),
      {},
    ];
    for (const input of bad) {
      const answers = await three("POST", NAME, input);
      expect(answers[0].status, JSON.stringify(input).slice(0, 60)).toBe(400);
      expect(answers[0].body).toMatchObject({ code: "bad_request" });
      expectParity(answers);
    }
    expect(sent).toHaveLength(0);
  });

  it("匿名主体 401，什么都没交出", async () => {
    sent.length = 0;
    const answers = await three("POST", NAME, report(), [
      "anon",
      "anon",
      "anon",
    ]);
    expect(answers[0].status).toBe(401);
    expectParity(answers);
    expect(sent).toHaveLength(0);
  });

  it("限流：同一个调用方每分钟 5 条，第 6 条 429；体里有 details.retryAfterSeconds，三处都带 Retry-After", async () => {
    clock += 61_000;
    const tails: Answer[] = [];
    for (const way of ["table", "legacy", "rpc"] as const) {
      const send = (): Promise<Answer> =>
        way === "table"
          ? kit.table("POST", CLIENT_ERROR_ROUTE, report(), "a")
          : way === "legacy"
            ? kit.legacy("POST", CLIENT_ERROR_ROUTE, report(), "b")
            : kit.procedure(NAME, report(), "c");
      for (let index = 0; index < 5; index += 1) {
        expect((await send()).status, `${way} #${index}`).toBeLessThan(300);
      }
      tails.push(await send());
    }
    for (const answer of tails) {
      expect(answer.status).toBe(429);
      expect(answer.body).toMatchObject({
        code: "rate_limited",
        details: { retryAfterSeconds: 12 },
      });
      expect(answer.retryAfter).toBe("12");
    }
    expectParity([tails[0]!, tails[1]!, tails[2]!]);
    // 窗口过去又收得下；别的调用方不受影响。
    expect((await kit.procedure(NAME, report(), "owner")).status).toBe(200);
    clock += 61_000;
    expect(
      (await kit.legacy("POST", CLIENT_ERROR_ROUTE, report(), "b")).status,
    ).toBe(202);
  });
});

describe("入参形状错：procedure 与旧路径由契约先答 bad_request", () => {
  it("体不是对象：码与状态一致，procedure 带 issues", async () => {
    clock += 61_000;
    const rest = await kit.legacy("POST", CLIENT_ERROR_ROUTE, ["x"], "a");
    const rpc = await kit.procedure(NAME, ["x"], "b");
    for (const answer of [rest, rpc]) {
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ code: "bad_request" });
    }
    const detail = (rpc.body as { details?: { issues?: unknown[] } }).details;
    expect(detail?.issues?.length).toBeGreaterThan(0);
  });
});

describe("契约与 core 的两张表（diagnostics）", () => {
  const entries = contractEntries().filter((entry) =>
    entry.name.startsWith("diagnostics."),
  );

  it("2 条都在契约里，每条都有旧路径", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "diagnostics.clientErrorStatus",
      "diagnostics.reportClientError",
    ]);
    for (const entry of entries) {
      expect(entry.meta.legacy, entry.name).toBeDefined();
    }
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
