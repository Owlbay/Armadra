import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRouteGuard, routeGuard } from "../identity/gate";
import { install as installSettings } from "../settings";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { fail } from "./errors";
import {
  type RpcInstallOptions,
  errorEnvelope,
  installContract,
  registerProcedures,
  rpcOptionsFromEnv,
} from "./rpc";

/**
 * RPC 门面（工程规范化包 §1.3）：挂载、只收 POST、错误 envelope、入参校验的
 * `details.issues`、按 procedure 的路由门、旧路径与路由表并存回落、出参校验开关。
 */

let core: Fixture | undefined;
let base: string;

function current(): Fixture {
  if (core === undefined) throw new Error("no core");
  return core;
}

async function listen(
  options: Partial<RpcInstallOptions> = {},
  extra?: (core: Fixture) => void,
): Promise<void> {
  const made = fixture([installWorkspaces, installSettings]);
  core = made;
  extra?.(made);
  installContract(made.server, {
    validateOutput: true,
    platform: made.platform,
    ...options,
  });
  const listener = made.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
}

afterEach(async () => {
  const done = core;
  core = undefined;
  if (done === undefined) return;
  await done.server.close();
  done.close();
});

function rpc(procedure: string, input?: unknown, init: RequestInit = {}) {
  return fetch(`${base}/api/rpc/${procedure.replace(".", "/")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
    ...init,
  });
}

describe("挂载与传输", () => {
  beforeEach(() => listen());

  it("procedure 答上游 RPC 编码（{ json }）", async () => {
    const answer = await rpc("settings.local");
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { json: { paths: string[] } };
    expect(Array.isArray(body.json.paths)).toBe(true);
  });

  it("只收 POST：GET 答 405，形状仍是 envelope", async () => {
    const answer = await fetch(`${base}/api/rpc/settings/get`);
    expect(answer.status).toBe(405);
    const body = await answer.json();
    expect(body).toMatchObject({ code: "method_not_allowed" });
    expect(typeof body.requestId).toBe("string");
  });

  it("没有这条 procedure 答 404 not_found", async () => {
    const answer = await rpc("settings.nothing");
    expect(answer.status).toBe(404);
    expect(await answer.json()).toMatchObject({ code: "not_found" });
  });

  it("契约里有、这次装配没实现的答 501", async () => {
    // fixture 没装身份域，`system.*` 没人登记。
    const answer = await rpc("system.ping", { ts: 1 });
    expect(answer.status).toBe(501);
    expect(await answer.json()).toMatchObject({ code: "not_implemented" });
  });
});

describe("错误 envelope", () => {
  beforeEach(() => listen());

  it("域里的拒绝：码、状态与原话，加 requestId，没有上游的字段", async () => {
    const answer = await rpc("workspaces.open", { workspaceId: "nope" });
    expect(answer.status).toBe(404);
    const body = await answer.json();
    expect(Object.keys(body).sort()).toEqual(["code", "message", "requestId"]);
    expect(body).toMatchObject({
      code: "not_found",
      message: "Workspace was not found",
    });
  });

  it("入参校验失败：bad_request，details.issues 给字段路径", async () => {
    const answer = await rpc("workspaces.update", { name: 3 });
    expect(answer.status).toBe(400);
    const body = await answer.json();
    expect(body.code).toBe("bad_request");
    const paths = (body.details.issues as { path: string[] }[]).map((issue) =>
      issue.path.join("."),
    );
    expect(paths).toEqual(expect.arrayContaining(["workspaceId", "name"]));
    // 不回显入参的值。
    expect(JSON.stringify(body.details)).not.toContain('"input"');
  });

  it("坏的 JSON 是 bad_request，不是 500", async () => {
    const answer = await rpc("settings.get", undefined, { body: "{nope" });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ code: "bad_request" });
  });

  it("errorEnvelope：上游的大写码归到注册表，500 不外泄原话", () => {
    expect(errorEnvelope(new SyntaxError("x"))).toEqual({
      status: 400,
      body: { code: "bad_request", message: "请求体不是合法的 JSON" },
    });
  });
});

describe("路由门", () => {
  let restore: ReturnType<typeof routeGuard>;
  beforeEach(async () => {
    restore = routeGuard();
    await listen();
  });
  afterEach(() => installRouteGuard(restore));

  it("按 meta.scope 判，拒了答 403 forbidden", async () => {
    const asked: string[] = [];
    installRouteGuard((request, requirement) => {
      asked.push(
        `${request.method} ${request.path} ${requirement?.permission}`,
      );
      return { allowed: requirement?.permission !== "settings:write" };
    });
    expect((await rpc("settings.get")).status).toBe(200);
    const refused = await rpc("settings.update", { logs: {} });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "forbidden" });
    // 带旧路径的拿旧路径去问：成员规则（工作空间列表过滤）就写在那条路径上。
    expect(asked).toContain("GET /api/settings settings:read");
    expect(asked).toContain("PATCH /api/settings settings:write");
  });

  it("工作空间键落到授权上，旧路径的 filter 照样作用在答案上", async () => {
    installRouteGuard((request, requirement) => {
      if (request.path === "/api/workspaces" && request.method === "GET") {
        return { allowed: true, filter: () => [] };
      }
      return { allowed: requirement?.workspaceId !== "locked" };
    });
    const listed = await rpc("workspaces.list");
    expect((await listed.json()).json).toEqual([]);
    const locked = await rpc("workspaces.open", { workspaceId: "locked" });
    expect(locked.status).toBe(403);
    const other = await rpc("workspaces.open", { workspaceId: "other" });
    expect(other.status).toBe(404);
  });
});

describe("旧路径与路由表并存", () => {
  beforeEach(() => listen());

  it("迁过来的旧路径照旧答，失败只有 { code, message }", async () => {
    const listed = await fetch(`${base}/api/workspaces`);
    expect(listed.status).toBe(200);
    expect(Array.isArray(await listed.json())).toBe(true);
    const missing = await fetch(`${base}/api/workspaces/nope`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(missing.status).toBe(404);
    expect(Object.keys(await missing.json()).sort()).toEqual([
      "code",
      "message",
    ]);
  });

  it("删除答 204，没有体", async () => {
    const root = join(current().directory, "gone");
    mkdirSync(root);
    const created = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "gone", rootPath: root }),
    });
    const { id } = (await created.json()) as { id: string };
    const removed = await fetch(`${base}/api/workspaces/${id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe("");
  });

  it("不在契约里的路径与方法回落到路由表", async () => {
    // 表里有 PATCH / DELETE，没有 GET：路由表答 405，不是上游的 404。
    const wrongVerb = await fetch(`${base}/api/workspaces/x`);
    expect(wrongVerb.status).toBe(405);
    expect(await wrongVerb.json()).toMatchObject({
      code: "method_not_allowed",
    });
    // 同一前缀下没迁的路由照旧由表里的 handler 答。
    const host = await fetch(`${base}/api/workspaces/nope/execution-host`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(host.status).toBe(404);
    expect(await host.json()).toEqual({
      code: "not_found",
      message: "Workspace was not found",
    });
  });

  it("不报 Content-Type 的 JSON 体照旧被读成 JSON", async () => {
    const answer = await fetch(`${base}/api/settings`, {
      method: "PATCH",
      body: JSON.stringify({ logs: { retentionDays: 3 } }),
    });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({
      code: "bad_request",
      message: "Unknown log retention",
    });
  });
});

describe("出参校验开关", () => {
  const broken = (core: Fixture) =>
    registerProcedures(core.server, "system", {
      // 故意不合契约：`ts` 应该是数。
      ping: () => ({ ts: "x", serverTs: 0 }) as never,
      hello: () => {
        throw fail("not_found", "没有");
      },
    });

  it("开着：不合契约的出参答 500 internal，原话不外泄", async () => {
    await listen({ validateOutput: true }, broken);
    const answer = await rpc("system.ping", { ts: 1 });
    expect(answer.status).toBe(500);
    const body = await answer.json();
    expect(body).toMatchObject({
      code: "internal",
      message: "核心处理请求时失败",
    });
    expect(body.details).toBeUndefined();
  });

  it("关着：原样发出去", async () => {
    await listen({ validateOutput: false }, broken);
    const answer = await rpc("system.ping", { ts: 1 });
    expect(answer.status).toBe(200);
    expect((await answer.json()).json).toEqual({ ts: "x", serverTs: 0 });
  });

  it("fail() 的状态来自注册表", async () => {
    await listen({}, broken);
    const answer = await rpc("system.hello", {});
    expect(answer.status).toBe(404);
    expect(await answer.json()).toMatchObject({
      code: "not_found",
      message: "没有",
    });
  });

  it("域有意答的 5xx（对端不在）不记错误、不报给壳；没接住的异常照报", async () => {
    const reported: string[] = [];
    await listen(
      {
        platform: {
          log: { error: () => undefined } as never,
          reportError: (error: unknown) => {
            reported.push(
              error instanceof Error ? error.message : String(error),
            );
          },
        },
      },
      (made) =>
        registerProcedures(made.server, "system", {
          ping: () => {
            throw fail("source_unreachable", "对端不在");
          },
          hello: () => {
            throw new Error("没人接住");
          },
        }),
    );
    const unreachable = await rpc("system.ping", { ts: 1 });
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toMatchObject({
      code: "source_unreachable",
    });
    expect(reported).toEqual([]);
    expect((await rpc("system.hello", {})).status).toBe(500);
    expect(reported).toEqual(["没人接住"]);
  });

  it("环境变量：缺省按是否打包，1 / 0 显式开关", () => {
    const platform = { isPackaged: false } as never;
    expect(rpcOptionsFromEnv({}, platform).validateOutput).toBe(true);
    expect(
      rpcOptionsFromEnv({}, {
        ...(platform as object),
        isPackaged: true,
      } as never).validateOutput,
    ).toBe(false);
    expect(
      rpcOptionsFromEnv({ ARMADRA_RPC_VALIDATE_OUTPUT: "0" }, platform)
        .validateOutput,
    ).toBe(false);
    expect(rpcOptionsFromEnv({ ARMADRA_RPC_TRACE: "1" }, platform).trace).toBe(
      true,
    );
  });
});

describe("登记", () => {
  it("同一条登记两次、或不在契约里的名字，是装配错误", () => {
    const made = fixture([installWorkspaces]);
    core = made;
    expect(() =>
      registerProcedures(made.server, "workspaces", {
        list: () => [],
      } as never),
    ).toThrow(/登记了两次/);
    registerProcedures(made.server, "settings", { nothing: () => 1 } as never);
    expect(() =>
      installContract(made.server, {
        validateOutput: true,
        platform: made.platform,
      }),
    ).toThrow(/不在契约里/);
  });
});

describe("装配好的 core", () => {
  it("system.hello / ping 经回环会话可调；没带会话是准入门的 401", async () => {
    const { run } = await import("../main");
    const { tempDir } = await import("../testing/temp-dir");
    const { loopbackSession } = await import("../testing/loopback-session");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const migrations = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../db/migrations",
    );
    const running = await run({
      argv: [
        "--listen",
        "tcp:127.0.0.1:0",
        "--data-dir",
        tempDir("armadra-rpc-"),
      ],
      env: { ARMADRA_CORE_MIGRATIONS_DIR: migrations, ARMADRA_LOG: "error" },
      stdout: () => undefined,
    });
    try {
      const tcp = running.bound.find((spec) => spec.kind === "tcp");
      if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
      const root = `http://${tcp.host}:${tcp.port}`;
      const session = await loopbackSession(running, root);
      const hello = await session.fetch("/api/rpc/system/hello", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      });
      expect(hello.status).toBe(200);
      const body = (await hello.json()).json;
      expect(body.procedures).toEqual(
        expect.arrayContaining([
          "system.hello",
          "workspaces.list",
          "settings.get",
        ]),
      );
      expect(body.protocol).toEqual({ major: 1, minor: 9 });
      expect(body.heartbeatMs).toBe(25_000);
      expect(typeof body.sessionExpiresAtMs).toBe("number");
      expect(body.sourceId).not.toBe("");

      const ping = await session.fetch("/api/rpc/system/ping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { ts: 7 } }),
      });
      expect((await ping.json()).json).toMatchObject({ ts: 7 });

      const anonymous = await fetch(`${root}/api/rpc/system/ping`, {
        method: "POST",
        headers: { origin: session.origin, "content-type": "application/json" },
        body: JSON.stringify({ json: { ts: 7 } }),
      });
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ code: "unauthenticated" });
    } finally {
      await running.stop();
    }
  });
});
