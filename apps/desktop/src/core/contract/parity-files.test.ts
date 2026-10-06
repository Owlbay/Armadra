import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { installReveal } from "../files/reveal";
import { install as installFiles } from "../files/routes";
import { releaseWorkspace } from "../files/watch";
import { installContract } from "../http/rpc";
import { routeScope } from "../http/route-scopes";
import { install as installImports } from "../imports/routes";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { type JsonValue, canonicalJson } from "./message";

/**
 * files 域的对偶测试（契约 §37；工程规范化包 §3 ④）。
 *
 * 与 `parity.test.ts` 同一个做法：同一份夹具问三次——路由表里原来那条 handler、
 * 旧 REST 路径（经 HTTP，由契约实现经 `OpenAPIHandler` 答）、新 procedure。
 * 成功的答案按 `canonicalJson` 逐字节相等；失败的码、状态与原话相等（procedure
 * 多一个 `requestId`）。会改动磁盘的操作（写、建、改名、删、恢复、导入）每个
 * 答法各用自己的文件名，比较前把名字换成同一个占位。
 */

let core: Fixture;
let base: string;
let root: string;
let id: string;
let readOnlyId: string;
const revealed: string[] = [];

beforeAll(async () => {
  core = fixture([
    installWorkspaces,
    installFiles,
    installImports,
    (context) =>
      installReveal(context, {
        platform: "darwin",
        launch: async (command) => {
          revealed.push(command.args.join(" "));
        },
      }),
  ]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  root = join(core.directory, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/note.txt"), "hello\nworld\n");
  writeFileSync(join(root, "readme.md"), "# readme\nneedle in a haystack\n");
  id = (
    (
      await core.call("POST", "/api/workspaces", {
        name: "files",
        rootPath: root,
      })
    ).body as { id: string }
  ).id;
  const frozen = join(core.directory, "frozen");
  mkdirSync(frozen);
  readOnlyId = (
    (
      await core.call("POST", "/api/workspaces", {
        name: "frozen",
        rootPath: frozen,
        permissions: { read: true, write: false, execute: false },
      })
    ).body as { id: string }
  ).id;
});

afterAll(async () => {
  releaseWorkspace(id);
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

const query = (fields: Record<string, string>): string =>
  `?${new URLSearchParams(fields).toString()}`;
const ws = (workspace = id): string => `/api/workspaces/${workspace}`;

/** 每次调用都会变的字段（回收站条目的 id、时刻）换成占位。 */
function stable(value: unknown, mask: (text: string) => string): JsonValue {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((one) => stable(one, mask));
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = ["id", "deletedAt"].includes(key)
      ? "<volatile>"
      : stable(field, mask);
  }
  return out;
}

const text = (answer: Answer, mask: (text: string) => string = (t) => t) =>
  canonicalJson(stable(answer.body, mask));

/** 三种答法：状态一样（procedure 成功恒为 200），体规范化后逐字节相等。 */
function expectParity(
  [old, rest, rpc]: readonly [Answer, Answer, Answer],
  options: { readonly masks?: readonly [string, string, string] } = {},
): void {
  expect(rest.status, "旧路径的状态").toBe(old.status);
  expect(rpc.status, "procedure 的状态").toBe(
    old.status >= 400 ? old.status : 200,
  );
  const masked = (answer: Answer, index: number) =>
    text(answer, (value) =>
      options.masks === undefined
        ? value
        : value
            .replaceAll(options.masks[index]!, "X")
            .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uuid>"),
    );
  expect(masked(rest, 1), "旧路径的体").toBe(masked(old, 0));
  expect(masked(rpc, 2), "procedure 的体").toBe(masked(old, 0));
}

describe("只读：浏览、读、信息、版本、索引、回收站列表", () => {
  const reads: readonly [string, string, string, Record<string, string>][] = [
    ["list", "files", "GET", { path: "." }],
    ["list", "files", "GET", { path: "src" }],
    ["list", "files", "GET", {}],
    ["info", "file-info", "GET", { path: "src/note.txt" }],
    ["read", "file", "GET", { path: "src/note.txt" }],
    ["version", "file-version", "GET", { path: "src/note.txt" }],
    ["version", "file-version", "GET", { path: "src/gone.txt" }],
  ];

  it.each(reads)("%s %j", async (name, route, method, input) => {
    const path = `${ws()}/${route}${query(input)}`;
    expectParity([
      await table(method, path),
      await legacy(method, path),
      await procedure(`files.${name}`, { workspaceId: id, ...input }),
    ]);
  });

  it("域里的拒绝：不存在、越界、不是目录", async () => {
    for (const [name, route, input] of [
      ["list", "files", { path: "nowhere" }],
      ["list", "files", { path: "../outside" }],
      ["list", "files", { path: "readme.md" }],
      ["read", "file", { path: "nowhere.txt" }],
      ["read", "file", { path: "src" }],
      ["info", "file-info", { path: "nowhere.txt" }],
    ] as const) {
      const path = `${ws()}/${route}${query(input)}`;
      const answers = [
        await table("GET", path),
        await legacy("GET", path),
        await procedure(`files.${name}`, { workspaceId: id, ...input }),
      ] as const;
      expect(answers[0].status, `${name} ${input.path}`).toBeGreaterThanOrEqual(
        400,
      );
      expectParity(answers);
    }
  });

  it("工作空间不存在：同一个 not_found", async () => {
    const path = `${ws("nope")}/files`;
    const answers = [
      await table("GET", path),
      await legacy("GET", path),
      await procedure("files.list", { workspaceId: "nope" }),
    ] as const;
    expect(answers[0].status).toBe(404);
    expectParity(answers);
  });

  it("index：有无查询、带上限、上限不合法", async () => {
    const inputs: Record<string, string>[] = [
      { query: "note" },
      { query: "" },
      { query: "e", limit: "1" },
    ];
    for (const input of inputs) {
      const path = `${ws()}/file-index${query(input)}`;
      expectParity([
        await table("GET", path),
        await legacy("GET", path),
        await procedure("files.index", {
          workspaceId: id,
          query: input.query,
          ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
        }),
      ]);
    }
    const bad = `${ws()}/file-index${query({ query: "a", limit: "-1" })}`;
    const answers = [
      await table("GET", bad),
      await legacy("GET", bad),
      await procedure("files.index", {
        workspaceId: id,
        query: "a",
        limit: -1,
      }),
    ] as const;
    expect(answers[0].status).toBe(400);
    expectParity(answers);
  });

  it("trashList：没有读权限的工作空间之外都能列", async () => {
    const path = `${ws()}/file-entries/trash`;
    expectParity([
      await table("GET", path),
      await legacy("GET", path),
      await procedure("files.trashList", { workspaceId: id }),
    ]);
  });
});

describe("写：内容版本与拒绝", () => {
  it("同一份内容、同一个版本：三次答同一个 {path,size,sha256}", async () => {
    const read = await table(
      "GET",
      `${ws()}/file${query({ path: "src/note.txt" })}`,
    );
    const sha = (read.body as { sha256: string }).sha256;
    const body = {
      path: "src/note.txt",
      content: "hello\nworld\n",
      expectedSha256: sha,
    };
    expectParity([
      await table("PUT", `${ws()}/file`, body),
      await legacy("PUT", `${ws()}/file`, body),
      await procedure("files.write", { workspaceId: id, ...body }),
    ]);
  });

  it("新建一个文件；已存在的不带版本是 409；只带 expectedSize 是 400", async () => {
    const answers = [] as Answer[];
    for (const [index, ask] of [
      (name: string) =>
        table("PUT", `${ws()}/file`, { path: name, content: "x" }),
      (name: string) =>
        legacy("PUT", `${ws()}/file`, { path: name, content: "x" }),
      (name: string) =>
        procedure("files.write", { workspaceId: id, path: name, content: "x" }),
    ].entries()) {
      answers.push(await ask(`fresh-${index}.txt`));
    }
    expect(answers[0]!.status).toBe(200);
    expectParity(answers as unknown as [Answer, Answer, Answer], {
      masks: ["fresh-0", "fresh-1", "fresh-2"],
    });

    const clash = { path: "readme.md", content: "y" };
    const stale = [
      await table("PUT", `${ws()}/file`, clash),
      await legacy("PUT", `${ws()}/file`, clash),
      await procedure("files.write", { workspaceId: id, ...clash }),
    ] as const;
    expect(stale[0].status).toBe(409);
    expectParity(stale);

    const sizeOnly = { path: "readme.md", content: "y", expectedSize: 3 };
    const refused = [
      await table("PUT", `${ws()}/file`, sizeOnly),
      await legacy("PUT", `${ws()}/file`, sizeOnly),
      await procedure("files.write", { workspaceId: id, ...sizeOnly }),
    ] as const;
    expect(refused[0].status).toBe(400);
    expectParity(refused);
  });

  it("只读工作空间：403 与同一句话", async () => {
    const body = { path: "a.txt", content: "x" };
    const answers = [
      await table("PUT", `${ws(readOnlyId)}/file`, body),
      await legacy("PUT", `${ws(readOnlyId)}/file`, body),
      await procedure("files.write", { workspaceId: readOnlyId, ...body }),
    ] as const;
    expect(answers[0].status).toBe(403);
    expectParity(answers);
  });
});

/** 一条通道上的整套条目操作。 */
interface Channel {
  create(path: string, kind: string): Promise<Answer>;
  rename(from: string, to: string): Promise<Answer>;
  trash(path: string): Promise<Answer>;
  trashList(): Promise<Answer>;
  restore(entry: string): Promise<Answer>;
}

const channels: readonly Channel[] = [
  {
    create: (path, kind) =>
      table("POST", `${ws()}/file-entries`, { path, kind }),
    rename: (from, to) =>
      table("POST", `${ws()}/file-entries/rename`, { from, to }),
    trash: (path) => table("POST", `${ws()}/file-entries/trash`, { path }),
    trashList: () => table("GET", `${ws()}/file-entries/trash`),
    restore: (entry) =>
      table("POST", `${ws()}/file-entries/restore`, { id: entry }),
  },
  {
    create: (path, kind) =>
      legacy("POST", `${ws()}/file-entries`, { path, kind }),
    rename: (from, to) =>
      legacy("POST", `${ws()}/file-entries/rename`, { from, to }),
    trash: (path) => legacy("POST", `${ws()}/file-entries/trash`, { path }),
    trashList: () => legacy("GET", `${ws()}/file-entries/trash`),
    restore: (entry) =>
      legacy("POST", `${ws()}/file-entries/restore`, { id: entry }),
  },
  {
    create: (path, kind) =>
      procedure("files.create", { workspaceId: id, path, kind }),
    rename: (from, to) =>
      procedure("files.rename", { workspaceId: id, from, to }),
    trash: (path) => procedure("files.trash", { workspaceId: id, path }),
    trashList: () => procedure("files.trashList", { workspaceId: id }),
    restore: (entry) =>
      procedure("files.restore", { workspaceId: id, id: entry }),
  },
];

describe("条目：新建、改名、删到回收站、恢复", () => {
  it("每条通道各走一遍，答案换掉名字后逐字节相等", async () => {
    const runs = [] as Answer[][];
    for (const [index, channel] of channels.entries()) {
      const name = `entry-${index}`;
      const steps: Answer[] = [];
      steps.push(await channel.create(`${name}.txt`, "file"));
      steps.push(await channel.create(`${name}.txt`, "file")); // 409
      steps.push(await channel.create(`${name}-dir`, "directory"));
      steps.push(await channel.rename(`${name}.txt`, `${name}-b.txt`));
      steps.push(await channel.rename(`${name}-dir`, `${name}-dir/inner`)); // 400
      steps.push(await channel.trash(`${name}-b.txt`));
      const listed = await channel.trashList();
      const mine = (listed.body as { id: string; originalPath: string }[]).find(
        (one) => one.originalPath === `${name}-b.txt`,
      );
      expect(mine, `${name} 在回收站里`).toBeDefined();
      steps.push(await channel.restore(mine!.id));
      steps.push(await channel.restore("missing")); // 404
      steps.push(await channel.trash("nowhere")); // 404
      runs.push(steps);
    }
    expect(runs[0]!.map((step) => step.status)).toEqual([
      200, 409, 200, 200, 400, 200, 200, 404, 404,
    ]);
    for (const step of runs[0]!.keys()) {
      expectParity(
        [runs[0]![step]!, runs[1]![step]!, runs[2]![step]!] as const,
        { masks: ["entry-0", "entry-1", "entry-2"] },
      );
    }
  });

  it("只读工作空间的写操作：403", async () => {
    const answers = [
      await table("POST", `${ws(readOnlyId)}/file-entries`, {
        path: "a",
        kind: "file",
      }),
      await legacy("POST", `${ws(readOnlyId)}/file-entries`, {
        path: "a",
        kind: "file",
      }),
      await procedure("files.create", {
        workspaceId: readOnlyId,
        path: "a",
        kind: "file",
      }),
    ] as const;
    expect(answers[0].status).toBe(403);
    expectParity(answers);
  });

  it("kind 不对：码与状态一致，原话换成字段路径", async () => {
    const body = { path: "x", kind: "symlink" };
    const answers = [
      await table("POST", `${ws()}/file-entries`, body),
      await legacy("POST", `${ws()}/file-entries`, body),
      await procedure("files.create", { workspaceId: id, ...body }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(400);
      expect((answer.body as { code: string }).code).toBe("bad_request");
    }
  });
});

describe("项目搜索", () => {
  it("命中、没命中、分页", async () => {
    for (const body of [
      { query: "needle" },
      { query: "nothing-like-this" },
      { query: "e", limit: 1, offset: 0 },
      { query: "HELLO", caseSensitive: true },
      { query: "n.+e", regex: true, include: "*.md" },
    ]) {
      const path = `${ws()}/file-search`;
      expectParity([
        await table("POST", path, body),
        await legacy("POST", path, body),
        await procedure("files.search", { workspaceId: id, ...body }),
      ]);
    }
  });

  it("域里的拒绝：过长的 glob", async () => {
    const body = { query: "a", include: "x".repeat(201) };
    const path = `${ws()}/file-search`;
    const answers = [
      await table("POST", path, body),
      await legacy("POST", path, body),
      await procedure("files.search", { workspaceId: id, ...body }),
    ] as const;
    expect(answers[0].status).toBe(400);
    expectParity(answers);
  });
});

describe("监听", () => {
  it("登记与注销：同一份版本，注销答空", async () => {
    const watch = `${ws()}/file-watch`;
    const body = { path: "src/note.txt", nodeId: "node-1" };
    const registered = [
      await table("POST", watch, body),
      await legacy("POST", watch, body),
      await procedure("files.watch", { workspaceId: id, ...body }),
    ] as const;
    expect(registered[0].status).toBe(200);
    expectParity(registered);
    const closed = `${watch}${query(body)}`;
    expect((await table("DELETE", closed)).status).toBe(204);
    expect((await legacy("DELETE", closed)).status).toBe(204);
    expect(
      await procedure("files.unwatch", { workspaceId: id, ...body }),
    ).toEqual({ status: 200, body: undefined });
  });

  it("没有读权限：同一个拒绝", async () => {
    const body = { path: "a.txt", nodeId: "n" };
    // 只读工作空间有读权限；用一个读权限被关掉的工作空间。
    const closedId = (
      (
        await core.call("POST", "/api/workspaces", {
          name: "dark",
          rootPath: join(core.directory, "dark"),
          createDirectory: true,
          permissions: { read: false, write: false, execute: false },
        })
      ).body as { id: string }
    ).id;
    const answers = [
      await table("POST", `${ws(closedId)}/file-watch`, body),
      await legacy("POST", `${ws(closedId)}/file-watch`, body),
      await procedure("files.watch", { workspaceId: closedId, ...body }),
    ] as const;
    expect(answers[0].status).toBe(403);
    expectParity(answers);
  });
});

describe("显示与按路径导入", () => {
  it("reveal：根、文件、越界", async () => {
    for (const path of [".", "src/note.txt", "../outside"]) {
      expectParity([
        await table("POST", `${ws()}/reveal`, { path }),
        await legacy("POST", `${ws()}/reveal`, { path }),
        await procedure("files.reveal", { workspaceId: id, path }),
      ]);
    }
    expect(revealed.length).toBeGreaterThanOrEqual(6);
  });

  it("importLocal：各用各的源文件，答案换掉名字后相等；空清单是 400", async () => {
    const answers = [] as Answer[];
    for (const [index, ask] of [
      (paths: string[]) => table("POST", `${ws()}/imports/local`, { paths }),
      (paths: string[]) => legacy("POST", `${ws()}/imports/local`, { paths }),
      (paths: string[]) =>
        procedure("files.importLocal", { workspaceId: id, paths }),
    ].entries()) {
      const source = join(core.directory, `source-${index}.txt`);
      writeFileSync(source, "imported");
      answers.push(await ask([source]));
    }
    expect(answers[0]!.status).toBe(200);
    expectParity(answers as unknown as [Answer, Answer, Answer], {
      masks: ["source-0", "source-1", "source-2"],
    });
    expectParity([
      await table("POST", `${ws()}/imports/local`, { paths: [] }),
      await legacy("POST", `${ws()}/imports/local`, { paths: [] }),
      await procedure("files.importLocal", { workspaceId: id, paths: [] }),
    ]);
  });
});

describe("契约与 core 的两张表（files）", () => {
  const entries = contractEntries().filter((entry) =>
    entry.name.startsWith("files."),
  );

  it("16 条都在契约里，且都绑工作空间", () => {
    expect(entries).toHaveLength(16);
    for (const entry of entries) {
      expect(entry.meta.workspaceKey, entry.name).toBe("workspaceId");
    }
  });

  it("带旧路径的，meta.scope 与路由表给那条路径的要求一致；旧路径都在路由表里", () => {
    for (const entry of entries) {
      const legacyRoute = entry.meta.legacy;
      if (legacyRoute === undefined) continue;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = core.server.router.match(legacyRoute.path);
      expect(found?.entry.methods, entry.name).toContain(legacyRoute.method);
    }
  });

  it("没有旧路径的 unwatch：路由表里的 DELETE 要的也是 files:write", () => {
    expect(
      routeScope("DELETE", "/api/workspaces/{workspaceId}/file-watch")
        ?.permission,
    ).toBe("files:write");
  });
});
