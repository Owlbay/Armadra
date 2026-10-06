import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { stickyNode } from "../canvas/nodes.fixture";
import { install as installCanvas } from "../canvas/routes";
import { installContract } from "../http/rpc";
import { routeScope } from "../http/route-scopes";
import { install as installRealtime } from "../realtime";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { type JsonValue, canonicalJson } from "./message";

/**
 * `boards` 域的对偶测试（契约 §36，工程规范化包 §3 验收①）。
 *
 * 同一份夹具问三次：路由表里原来那条 handler（`router.dispatch`，迁移前的答法）、
 * 旧 REST 路径（经 HTTP，现在由契约实现经 `OpenAPIHandler` 答）、新 procedure
 * （`POST /api/rpc/…`）。成功的答案按 `canonicalJson` 逐字节相等（新行的 id 与
 * 时刻换成占位）；失败的码、状态与原话相等（procedure 多一个 `requestId`）。唯一
 * 的例外写在最后一组：入参形状不对时，契约的 schema 先于域拒绝，码与状态一样，
 * 原话是字段路径。
 */

let core: Fixture;
let base: string;
let workspaceId: string;

const A = "tab-aaaaaaaaaaaa";
const B = "tab-bbbbbbbbbbbb";

beforeAll(async () => {
  core = fixture([installWorkspaces, installCanvas, installRealtime]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const created = await core.call("POST", "/api/workspaces", {
    name: "Parity",
    rootPath: core.directory,
  });
  workspaceId = (created.body as { id: string }).id;
});

afterAll(async () => {
  await core.server.close();
  core.close();
});

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

async function table(
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const answer = await core.call(method, path, body);
  return { status: answer.status, body: answer.body };
}

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

/** 每次调用都会变的字段（新行的 id、时刻、租约换手的时刻）换成占位。 */
const VOLATILE = [
  "id",
  "boardId",
  "createdAt",
  "updatedAt",
  "lastSeenAt",
  "acquiredAt",
  // 新板排在最后：序号随已有的板数涨，三种答法各建一块所以各不相同。
  "sortOrder",
];

function stable(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = VOLATILE.includes(key) ? "<volatile>" : stable(field);
  }
  return out;
}

const same = (answer: Answer) => canonicalJson(stable(answer.body));

function expectParity(
  [old, rest, rpc]: readonly [Answer, Answer, Answer],
  options: { readonly volatile?: boolean; readonly status?: number } = {},
): void {
  expect(rest.status, "旧路径的状态").toBe(options.status ?? old.status);
  expect(old.status, "原 handler 的状态").toBe(options.status ?? old.status);
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

const boardsPath = () => `/api/workspaces/${workspaceId}/boards`;

/** 三种答法各建一块板，返回它们的 id（原 handler、旧路径、procedure）。 */
async function threeBoards(name: string): Promise<[string, string, string]> {
  const made = [
    await table("POST", boardsPath(), { name }),
    await legacy("POST", boardsPath(), { name }),
    await procedure("boards.create", { workspaceId, name }),
  ] as const;
  expectParity(made, { volatile: true });
  return made.map((answer) => (answer.body as { id: string }).id) as [
    string,
    string,
    string,
  ];
}

describe("boards：画布列表", () => {
  it("list", async () => {
    expectParity([
      await table("GET", boardsPath()),
      await legacy("GET", boardsPath()),
      await procedure("boards.list", { workspaceId }),
    ]);
  });

  it("create / update / delete", async () => {
    const [one, two, three] = await threeBoards("Parity board");
    const patch = { name: "Renamed", sortOrder: 7 };
    expectParity(
      [
        await table("PATCH", `${boardsPath()}/${one}`, patch),
        await legacy("PATCH", `${boardsPath()}/${two}`, patch),
        await procedure("boards.update", {
          workspaceId,
          boardId: three,
          ...patch,
        }),
      ],
      { volatile: true },
    );
    const renamed = (await table("GET", `${boardsPath()}/${one}/document`))
      .body as { board: { name: string; sortOrder: number } };
    expect(renamed.board).toMatchObject({ name: "Renamed", sortOrder: 7 });
    // `null` 的排序与缺席同义（旧路径一直这样读）。
    expectParity(
      [
        await table("PATCH", `${boardsPath()}/${one}`, {
          name: "Again",
          sortOrder: null,
        }),
        await legacy("PATCH", `${boardsPath()}/${two}`, {
          name: "Again",
          sortOrder: null,
        }),
        await procedure("boards.update", {
          workspaceId,
          boardId: three,
          name: "Again",
          sortOrder: null,
        }),
      ],
      { volatile: true },
    );
    const removed = [
      await table("DELETE", `${boardsPath()}/${one}`),
      await legacy("DELETE", `${boardsPath()}/${two}`),
      await procedure("boards.delete", { workspaceId, boardId: three }),
    ] as const;
    expect(removed[0].status).toBe(204);
    expect(removed[1].status).toBe(204);
    expect(removed[2]).toEqual({ status: 200, body: undefined });
  });

  it("域里的拒绝：码、状态与原话一致", async () => {
    const missing = "no-such-board";
    expectParity([
      await table("PATCH", `${boardsPath()}/${missing}`, { name: "x" }),
      await legacy("PATCH", `${boardsPath()}/${missing}`, { name: "x" }),
      await procedure("boards.update", {
        workspaceId,
        boardId: missing,
        name: "x",
      }),
    ]);
    expectParity([
      await table("DELETE", `${boardsPath()}/${missing}`),
      await legacy("DELETE", `${boardsPath()}/${missing}`),
      await procedure("boards.delete", { workspaceId, boardId: missing }),
    ]);
    expectParity([
      await table("GET", "/api/workspaces/nope/boards"),
      await legacy("GET", "/api/workspaces/nope/boards"),
      await procedure("boards.list", { workspaceId: "nope" }),
    ]);
    const blank = { name: "   " };
    expectParity([
      await table("POST", boardsPath(), blank),
      await legacy("POST", boardsPath(), blank),
      await procedure("boards.create", { workspaceId, ...blank }),
    ]);
    // 最后一块板删不掉：409。
    const only = await core.call("POST", "/api/workspaces", {
      name: "Single",
      rootPath: core.directory,
      createDirectory: false,
    });
    const single = (only.body as { id: string }).id;
    const lone = (
      (await core.call("GET", `/api/workspaces/${single}/boards`)).body as {
        id: string;
      }[]
    )[0]!.id;
    const path = `/api/workspaces/${single}/boards/${lone}`;
    expectParity([
      await table("DELETE", path),
      await legacy("DELETE", path),
      await procedure("boards.delete", { workspaceId: single, boardId: lone }),
    ]);
  });
});

describe("boards：文档", () => {
  it("load 与 save：同一份文档，只有 id 与时刻在变", async () => {
    const [one, two, three] = await threeBoards("Doc");
    const loaded = [
      await table("GET", `${boardsPath()}/${one}/document`),
      await legacy("GET", `${boardsPath()}/${two}/document`),
      await procedure("boards.load", { workspaceId, boardId: three }),
    ] as const;
    expectParity(loaded, { volatile: true });

    const saved = [] as Answer[];
    for (const [index, id] of [one, two, three].entries()) {
      const document = loaded[index]!.body as {
        board: { updatedAt: string };
      };
      const body = {
        expectedUpdatedAt: document.board.updatedAt,
        nodes: [stickyNode(id)],
        edges: [],
        viewport: { x: 10, y: 20, zoom: 1.5 },
        whiteboard: '{"shapes":[]}',
      };
      saved.push(
        index === 0
          ? await table("PUT", `${boardsPath()}/${id}/document`, body)
          : index === 1
            ? await legacy("PUT", `${boardsPath()}/${id}/document`, body)
            : await procedure("boards.save", {
                workspaceId,
                boardId: id,
                ...body,
              }),
      );
    }
    const volatileNode = (answer: Answer) => {
      const body = answer.body as {
        nodes: { id: string; boardId: string }[];
      };
      return { ...answer, body: { ...body, nodes: body.nodes.length } };
    };
    expectParity(
      saved.map(volatileNode) as unknown as [Answer, Answer, Answer],
      { volatile: true },
    );
    expect((saved[0]!.body as { nodes: unknown[] }).nodes).toHaveLength(1);
    expect(
      (saved[2]!.body as { board: { whiteboard: string } }).board.whiteboard,
    ).toBe('{"shapes":[]}');
  });

  it("save 的拒绝：已退役的 kanban、旧修订号、不存在的板，码与原话一致", async () => {
    const [one, two, three] = await threeBoards("Doc refusals");
    const document = (await table("GET", `${boardsPath()}/${one}/document`))
      .body as { board: { updatedAt: string } };
    const stale = {
      expectedUpdatedAt: "2020-01-01T00:00:00Z",
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const retired = { ...stale, expectedUpdatedAt: document.board.updatedAt };
    for (const [body, status] of [
      [{ ...retired, kanban: { columns: [] } }, 400],
      [stale, 409],
    ] as const) {
      const answers = [
        await table("PUT", `${boardsPath()}/${one}/document`, body),
        await legacy("PUT", `${boardsPath()}/${two}/document`, body),
        await procedure("boards.save", {
          workspaceId,
          boardId: three,
          ...body,
        }),
      ] as const;
      expect(answers[0].status).toBe(status);
      expectParity(answers, { volatile: true });
    }
    const ghost = "no-such-board";
    expectParity([
      await table("PUT", `${boardsPath()}/${ghost}/document`, stale),
      await legacy("PUT", `${boardsPath()}/${ghost}/document`, stale),
      await procedure("boards.save", {
        workspaceId,
        boardId: ghost,
        ...stale,
      }),
    ]);
    expectParity([
      await table("GET", `${boardsPath()}/${ghost}/document`),
      await legacy("GET", `${boardsPath()}/${ghost}/document`),
      await procedure("boards.load", { workspaceId, boardId: ghost }),
    ]);
  });

  it("入参形状不对：码与状态一致，原话换成字段路径", async () => {
    const [one, two, three] = await threeBoards("Doc shape");
    const answers = [
      await table("PUT", `${boardsPath()}/${one}/document`, { nodes: [] }),
      await legacy("PUT", `${boardsPath()}/${two}/document`, { nodes: [] }),
      await procedure("boards.save", {
        workspaceId,
        boardId: three,
        nodes: [],
      }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(400);
      expect((answer.body as { code: string }).code).toBe("bad_request");
    }
    expect((answers[0]!.body as { message: string }).message).toBe(
      "expectedUpdatedAt is required",
    );
    expect(
      (answers[2]!.body as { details: { issues: { path: string[] }[] } })
        .details.issues[0]!.path,
    ).toEqual(["expectedUpdatedAt"]);
  });
});

describe("boards：实时状态", () => {
  it("realtime", async () => {
    const [one, two, three] = await threeBoards("Realtime");
    expectParity([
      await table("GET", `${boardsPath()}/${one}/realtime`),
      await legacy("GET", `${boardsPath()}/${two}/realtime`),
      await procedure("boards.realtime", { workspaceId, boardId: three }),
    ]);
    expectParity([
      await table("GET", `${boardsPath()}/ghost/realtime`),
      await legacy("GET", `${boardsPath()}/ghost/realtime`),
      await procedure("boards.realtime", { workspaceId, boardId: "ghost" }),
    ]);
  });
});

describe("boards：在线设备与租约", () => {
  it("heartbeat 与 leave：同一份在线表", async () => {
    const [one, two, three] = await threeBoards("Presence");
    const beat = { clientId: A, deviceName: "MacBook", active: true };
    expectParity(
      [
        await table("POST", `${boardsPath()}/${one}/presence`, beat),
        await legacy("POST", `${boardsPath()}/${two}/presence`, beat),
        await procedure("boards.heartbeat", {
          workspaceId,
          boardId: three,
          ...beat,
        }),
      ],
      { volatile: true },
    );
    expectParity(
      [
        await table("DELETE", `${boardsPath()}/${one}/presence/${A}`),
        await legacy("DELETE", `${boardsPath()}/${two}/presence/${A}`),
        await procedure("boards.leave", {
          workspaceId,
          boardId: three,
          clientId: A,
        }),
      ],
      { volatile: true },
    );
  });

  it("acquireLease：拿、被拒（423）、接管", async () => {
    const [one, two, three] = await threeBoards("Lease");
    const asks = (body: Record<string, unknown>) =>
      [
        () => table("POST", `${boardsPath()}/${one}/lease`, body),
        () => legacy("POST", `${boardsPath()}/${two}/lease`, body),
        () =>
          procedure("boards.acquireLease", {
            workspaceId,
            boardId: three,
            ...body,
          }),
      ] as const;
    const run = async (body: Record<string, unknown>) => {
      const [a, b, c] = asks(body);
      return [await a(), await b(), await c()] as const;
    };
    expectParity(await run({ clientId: A, deviceName: "Mac" }), {
      volatile: true,
    });
    const refused = await run({ clientId: B, deviceName: "iPad" });
    expect(refused[0].status).toBe(423);
    expect((refused[0].body as { code: string }).code).toBe(
      "canvas_lease_held",
    );
    expectParity(refused, { volatile: true });
    expectParity(await run({ clientId: B, takeover: true }), {
      volatile: true,
    });
  });

  it("clientId 不合字符集：码与原话一致", async () => {
    const [one, two, three] = await threeBoards("Presence refusals");
    const bad = { clientId: "x" };
    expectParity([
      await table("POST", `${boardsPath()}/${one}/presence`, bad),
      await legacy("POST", `${boardsPath()}/${two}/presence`, bad),
      await procedure("boards.heartbeat", {
        workspaceId,
        boardId: three,
        ...bad,
      }),
    ]);
    expectParity([
      await table("POST", `${boardsPath()}/ghost/presence`, { clientId: A }),
      await legacy("POST", `${boardsPath()}/ghost/presence`, { clientId: A }),
      await procedure("boards.heartbeat", {
        workspaceId,
        boardId: "ghost",
        clientId: A,
      }),
    ]);
  });
});

describe("契约与 core 的两张表", () => {
  it("boards 的 procedure：meta.scope 与路由表给那条旧路径的要求一致", () => {
    const entries = contractEntries().filter(
      (entry) => entry.path[0] === "boards",
    );
    expect(entries.length).toBeGreaterThan(8);
    for (const entry of entries) {
      const legacyRoute = entry.meta.legacy;
      if (legacyRoute === undefined) continue;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = core.server.router.match(legacyRoute.path);
      expect(found?.entry.path, entry.name).toBe(legacyRoute.path);
      expect(found?.entry.methods, entry.name).toContain(legacyRoute.method);
    }
  });
});
