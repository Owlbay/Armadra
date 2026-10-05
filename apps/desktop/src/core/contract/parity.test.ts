import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { installContract } from "../http/rpc";
import { routeScope } from "../http/route-scopes";
import { PERMISSIONS } from "../identity/scopes";
import { install as installSettings } from "../settings";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { type JsonValue, canonicalJson } from "./message";

/**
 * 试点域的对偶测试（工程规范化 §2.4 验收①、工程规范化包 §1.7）。
 *
 * 同一份夹具问三次：路由表里原来那条 handler（`router.dispatch`，迁移前的答法）、
 * 旧 REST 路径（经 HTTP，现在由契约实现经 `OpenAPIHandler` 答）、新 procedure
 * （`POST /api/rpc/…`）。成功的答案按 `canonicalJson` 逐字节相等；失败的码、状态
 * 与原话相等（procedure 多一个 `requestId`）。唯一的例外写在最后一组：入参形状
 * 不对时，契约的 schema 先于域拒绝，码与状态一样，原话是字段路径而不是域的那句。
 */

let core: Fixture;
let base: string;

beforeAll(async () => {
  core = fixture([installWorkspaces, installSettings]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await core.server.close();
  core.close();
});

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** 迁移前的答法：路由表里那条 handler。 */
async function table(
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const answer = await core.call(method, path, body);
  return { status: answer.status, body: answer.body };
}

/** 旧路径，经 HTTP。 */
async function legacy(
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? undefined : JSON.parse(text),
  };
}

/** 新 procedure；成功取 `json`，失败去掉 `requestId`。 */
async function procedure(name: string, input?: unknown): Promise<Answer> {
  const response = await fetch(`${base}/api/rpc/${name.replace(".", "/")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.ok) return { status: response.status, body: body.json };
  expect(typeof body.requestId).toBe("string");
  const { requestId: _requestId, ...rest } = body;
  return { status: response.status, body: rest };
}

/** 每次调用都会变的字段（新行的 id、时刻、临时目录）换成占位。 */
function stable(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = [
      "id",
      "rootPath",
      "createdAt",
      "updatedAt",
      "lastOpenedAt",
    ].includes(key)
      ? "<volatile>"
      : stable(field);
  }
  return out;
}

const same = (answer: Answer) => canonicalJson(stable(answer.body));

/** 三种答法：状态一样（procedure 成功恒为 200），体规范化后逐字节相等。 */
function expectParity(
  [old, rest, rpc]: readonly [Answer, Answer, Answer],
  options: { readonly volatile?: boolean } = {},
): void {
  expect(rest.status, "旧路径的状态").toBe(old.status);
  expect(rpc.status, "procedure 的状态").toBe(
    old.status >= 400 ? old.status : 200,
  );
  const text = (answer: Answer) =>
    options.volatile === true
      ? same(answer)
      : canonicalJson((answer.body ?? null) as JsonValue);
  expect(text(rest), "旧路径的体").toBe(text(old));
  expect(text(rpc), "procedure 的体").toBe(text(old));
}

const defaultId = async (): Promise<string> =>
  ((await table("GET", "/api/workspaces")).body as { id: string }[])[0]!.id;

describe("settings", () => {
  it("get / local", async () => {
    expectParity([
      await table("GET", "/api/settings"),
      await legacy("GET", "/api/settings"),
      await procedure("settings.get"),
    ]);
    expectParity([
      await table("GET", "/api/settings/local"),
      await legacy("GET", "/api/settings/local"),
      await procedure("settings.local"),
    ]);
  });

  it("update：合并后的整份文档", async () => {
    const patch = {
      terminal: { backend: "auto" },
      logs: { retentionDays: 30 },
    };
    expectParity([
      await table("PATCH", "/api/settings", patch),
      await legacy("PATCH", "/api/settings", patch),
      await procedure("settings.update", patch),
    ]);
  });

  it("update 的两条封闭选项被拒：码与原话一致", async () => {
    for (const patch of [
      { terminal: { backend: "nope" } },
      { logs: { retentionDays: 3 } },
    ]) {
      const answers = [
        await table("PATCH", "/api/settings", patch),
        await legacy("PATCH", "/api/settings", patch),
        await procedure("settings.update", patch),
      ] as const;
      expect(answers[0].status).toBe(400);
      expectParity(answers);
    }
  });
});

describe("workspaces", () => {
  it("list", async () => {
    expectParity([
      await table("GET", "/api/workspaces"),
      await legacy("GET", "/api/workspaces"),
      await procedure("workspaces.list"),
    ]);
  });

  it("open / update：同一行，只有时刻在变", async () => {
    const id = await defaultId();
    expectParity(
      [
        await table("POST", `/api/workspaces/${id}/open`),
        await legacy("POST", `/api/workspaces/${id}/open`),
        await procedure("workspaces.open", { workspaceId: id }),
      ],
      { volatile: true },
    );
    const patch = { name: "Renamed", color: "#2E7CF6" };
    expectParity(
      [
        await table("PATCH", `/api/workspaces/${id}`, patch),
        await legacy("PATCH", `/api/workspaces/${id}`, patch),
        await procedure("workspaces.update", { workspaceId: id, ...patch }),
      ],
      { volatile: true },
    );
  });

  it("openDirectory 对同一个根目录是幂等的：三次答同一行", async () => {
    const root = join(core.directory, "same-root");
    mkdirSync(root);
    const body = { name: "same", rootPath: root };
    expectParity(
      [
        await table("POST", "/api/workspaces/open-directory", body),
        await legacy("POST", "/api/workspaces/open-directory", body),
        await procedure("workspaces.openDirectory", body),
      ],
      { volatile: true },
    );
  });

  it("create 与 delete", async () => {
    const created = [] as Answer[];
    for (const [index, ask] of [
      (body: unknown) => table("POST", "/api/workspaces", body),
      (body: unknown) => legacy("POST", "/api/workspaces", body),
      (body: unknown) => procedure("workspaces.create", body),
    ].entries()) {
      created.push(
        await ask({
          name: "made",
          rootPath: join(core.directory, `made-${index}`),
          createDirectory: true,
          permissions: { read: true, write: true, execute: false },
        }),
      );
    }
    expectParity(created as unknown as [Answer, Answer, Answer], {
      volatile: true,
    });
    const [one, two, three] = created.map(
      (answer) => (answer.body as { id: string }).id,
    );
    const removed = [
      await table("DELETE", `/api/workspaces/${one}`),
      await legacy("DELETE", `/api/workspaces/${two}`),
      await procedure("workspaces.delete", { workspaceId: three }),
    ] as const;
    expect(removed[0].status).toBe(204);
    expect(removed[1].status).toBe(204);
    expect(removed[2]).toEqual({ status: 200, body: undefined });
  });

  it("域里的拒绝：码、状态与原话一致", async () => {
    expectParity([
      await table("POST", "/api/workspaces/nope/open"),
      await legacy("POST", "/api/workspaces/nope/open"),
      await procedure("workspaces.open", { workspaceId: "nope" }),
    ]);
    expectParity([
      await table("DELETE", "/api/workspaces/nope"),
      await legacy("DELETE", "/api/workspaces/nope"),
      await procedure("workspaces.delete", { workspaceId: "nope" }),
    ]);
    const unnamed = { name: "  ", rootPath: core.directory };
    expectParity([
      await table("POST", "/api/workspaces", unnamed),
      await legacy("POST", "/api/workspaces", unnamed),
      await procedure("workspaces.create", unnamed),
    ]);
    const colour = { color: "red" };
    const id = await defaultId();
    expectParity([
      await table("PATCH", `/api/workspaces/${id}`, colour),
      await legacy("PATCH", `/api/workspaces/${id}`, colour),
      await procedure("workspaces.update", { workspaceId: id, ...colour }),
    ]);
  });

  it("入参形状不对：码与状态一致，原话换成字段路径", async () => {
    const answers = [
      await table("POST", "/api/workspaces", { name: "x" }),
      await legacy("POST", "/api/workspaces", { name: "x" }),
      await procedure("workspaces.create", { name: "x" }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(400);
      expect((answer.body as { code: string }).code).toBe("bad_request");
    }
    expect((answers[0]!.body as { message: string }).message).toBe(
      "Workspace root is required",
    );
    expect(
      (answers[2]!.body as { details: { issues: { path: string[] }[] } })
        .details.issues[0]!.path,
    ).toEqual(["rootPath"]);
  });
});

describe("契约与 core 的两张表", () => {
  it("带旧路径的 procedure，meta.scope 与路由表给那条路径的要求一致", () => {
    for (const entry of contractEntries()) {
      const legacyRoute = entry.meta.legacy;
      if (legacyRoute === undefined) continue;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
    }
  });

  it("旧路径都在路由表里", () => {
    for (const entry of contractEntries()) {
      const legacyRoute = entry.meta.legacy;
      if (legacyRoute === undefined) continue;
      const found = core.server.router.match(legacyRoute.path);
      expect(found?.entry.path, entry.name).toBe(legacyRoute.path);
      expect(found?.entry.methods, entry.name).toContain(legacyRoute.method);
    }
  });

  it("契约的授权词汇表就是 core 的那一张", async () => {
    const { SCOPES } = await import("@armadra/shared");
    expect([...SCOPES].sort()).toEqual([...PERMISSIONS].sort());
  });
});
