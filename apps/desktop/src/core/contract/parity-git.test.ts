import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { installContract } from "../http/rpc";
import { routeScope } from "../http/route-scopes";
import { ROUTES } from "../http/routes";
import { invalidateAll } from "../git/discovery";
import {
  type Repo,
  cleanupFixtures,
  repository,
  temporaryDirectory,
} from "../git/fixture";
import { install as installGit } from "../git/index";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import {
  type WorkspacePermissions,
  createWorkspace,
} from "../workspaces/table";
import { type JsonValue, canonicalJson } from "./message";

/**
 * git 域的对偶测试（契约 §40.1；工程规范化包 §3 ④）。
 *
 * 与 `parity-terminals.test.ts` 同一个做法：同一份夹具问三次——路由表里原来那条
 * handler、旧 REST 路径（经 HTTP，由契约实现经 `OpenAPIHandler` 答）、新
 * procedure。成功的答案按 `canonicalJson` 逐字节相等；失败的码、状态与原话相等
 * （procedure 多一个 `requestId`）。会改仓库的写（暂存、还原、提交、按块写、
 * 初始化）每个答法之间把仓库拨回同一个状态，或各用自己的仓库；提交的对象 id
 * 每次都不同，比较前换成占位。
 *
 * 只有一类差别是有意的：入参的**形状**错（缺字段、类型不对）在 procedure 与旧路径
 * 上由契约的入参校验先答 `bad_request`（带 `details.issues`），路由表原 handler 答
 * 它自己的那句话。这一类只比码与状态，在最后一节单独写出来。
 *
 * 仓库级的读与操作（`gitRepository.*`，§40.2）是 E3-5 的第二部分，对偶测试在
 * `parity-git-repository.test.ts`。
 */

let core: Fixture;
let base: string;
const savedPath = process.env.PATH;

beforeAll(async () => {
  invalidateAll();
  // AI 提交信息的提供方按 PATH 找 `claude`：放一个只会打印一行的替身在最前面，
  // 答案与机器上装没装真的 CLI 无关，也不会去跑它。
  const bin = temporaryDirectory("parity-git-bin");
  const fake = join(bin, "claude");
  writeFileSync(fake, "#!/bin/sh\necho usage\n");
  chmodSync(fake, 0o755);
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;

  core = fixture([installWorkspaces, installGit]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  // 不按空闲超时关连接。git 夹具是 spawnSync，和这台服务器、和 fetch 的连接池
  // 共用一个事件循环：夹具一口气占住超过缺省的 5 秒，fetch 先挑中池里那条空闲
  // 连接把请求写出去，服务器的空闲计时器随后才轮到、把它关掉，请求没人读，
  // 对端收到 RST——Windows CI 上 git 慢，就是这样报 ECONNRESET 的。
  listener.keepAliveTimeout = 0;
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});

afterAll(async () => {
  process.env.PATH = savedPath;
  await core.server.close();
  core.close();
  cleanupFixtures();
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
  const response = await fetch(`${base}/api/rpc/${name.replaceAll(".", "/")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  const text = await response.text();
  const body = (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
  if (response.ok) return { status: response.status, body: body.json };
  expect(typeof body.requestId).toBe("string");
  const { requestId: _requestId, ...rest } = body;
  return { status: response.status, body: rest };
}

/** 每次提交、每个任务都会变的字段。 */
const VOLATILE = new Set(["commit", "jobId", "oid"]);

function stable(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = VOLATILE.has(key) ? "<volatile>" : stable(field);
  }
  return out;
}

const text = (answer: Answer) => canonicalJson(stable(answer.body));

/** 三种答法：状态一样（procedure 成功恒为 200），体规范化后逐字节相等。 */
function expectParity([old, rest, rpc]: readonly [
  Answer,
  Answer,
  Answer,
]): void {
  expect(rest.status, "旧路径的状态").toBe(old.status);
  expect(rpc.status, "procedure 的状态").toBe(
    old.status >= 400 ? old.status : 200,
  );
  expect(text(rest), "旧路径的体").toBe(text(old));
  expect(text(rpc), "procedure 的体").toBe(text(old));
}

/** 同一个读问三遍。 */
async function three(
  method: string,
  path: string,
  name: string,
  input: Record<string, unknown>,
  body?: unknown,
): Promise<readonly [Answer, Answer, Answer]> {
  return [
    await table(method, path, body),
    await legacy(method, path, body),
    await procedure(name, input),
  ];
}

/** 会改仓库的写：每问一次之前先把仓库拨回同一个状态。 */
async function threeWrites(
  reset: () => void,
  method: string,
  path: string,
  name: string,
  input: Record<string, unknown>,
  body?: unknown,
): Promise<readonly [Answer, Answer, Answer]> {
  reset();
  const old = await table(method, path, body);
  reset();
  const rest = await legacy(method, path, body);
  reset();
  const rpc = await procedure(name, input);
  return [old, rest, rpc];
}

const ALL: WorkspacePermissions = { read: true, write: true, execute: true };

function workspaceAt(
  root: string,
  permissions: WorkspacePermissions = ALL,
): string {
  return createWorkspace(core.database, {
    name: `ws-${Math.random().toString(36).slice(2)}`,
    rootPath: root,
    permissions,
  }).id;
}

const at = (workspaceId: string) => `/api/workspaces/${workspaceId}/git`;
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

const entries = contractEntries().filter((entry) => entry.path[0] === "git");

describe("git 域：旧路径、procedure 与原 handler 答得一样", () => {
  let repo: Repo;
  let id: string;

  beforeAll(() => {
    repo = repository("parity-git");
    repo.write("a.txt", "one\ntwo\nthree\n");
    repo.write("b.txt", "bee\n");
    repo.commit("base");
    repo.write("a.txt", "one\nTWO\nthree\n");
    repo.write("b.txt", "bee  \n");
    repo.write("new.txt", "fresh\n");
    id = workspaceAt(repo.path);
  });

  it("status：有改动的检出、不是仓库的工作空间", async () => {
    expectParity(
      await three("GET", `${at(id)}/status?path=.`, "git.status", {
        workspaceId: id,
        path: ".",
      }),
    );
    // 逗号拼的路径与数组：两种拼法都只答 a.txt 那一行。
    const narrowed = await three(
      "GET",
      `${at(id)}/status?path=.&paths=a.txt`,
      "git.status",
      { workspaceId: id, path: ".", paths: ["a.txt"] },
    );
    expectParity(narrowed);
    expect(narrowed[2].body).toMatchObject({
      changedCount: 1,
      files: [{ path: "a.txt" }],
    });
    const plain = temporaryDirectory("parity-git-plain");
    const plainId = workspaceAt(plain);
    expectParity(
      await three("GET", `${at(plainId)}/status`, "git.status", {
        workspaceId: plainId,
      }),
    );
  });

  it('diff：两侧、逗号拼的路径与数组、忽略空白（查询串的 "true" 与布尔）', async () => {
    expectParity(
      await three("GET", `${at(id)}/diff?path=.&scope=worktree`, "git.diff", {
        workspaceId: id,
        path: ".",
        scope: "worktree",
      }),
    );
    expectParity(
      await three(
        "GET",
        `${at(id)}/diff?path=.&scope=worktree&paths=a.txt,b.txt&ignoreWhitespace=true`,
        "git.diff",
        {
          workspaceId: id,
          path: ".",
          scope: "worktree",
          paths: ["a.txt", "b.txt"],
          ignoreWhitespace: true,
        },
      ),
    );
    const [old, , rpc] = await three(
      "GET",
      `${at(id)}/diff?paths=a.txt`,
      "git.diff",
      { workspaceId: id, paths: "a.txt" },
    );
    expect(text(rpc)).toBe(text(old));
    expectParity(
      await three("GET", `${at(id)}/diff?scope=staged`, "git.diff", {
        workspaceId: id,
        scope: "staged",
      }),
    );
  });

  it("diff：不认识的 scope 由域拒绝，原话一样", async () => {
    const answers = await three(
      "GET",
      `${at(id)}/diff?scope=both`,
      "git.diff",
      {
        workspaceId: id,
        scope: "both",
      },
    );
    expect(answers[0].status).toBe(400);
    expectParity(answers);
  });

  it("headCommit", async () => {
    expectParity(
      await three("GET", `${at(id)}/head-commit?path=.`, "git.headCommit", {
        workspaceId: id,
        path: ".",
      }),
    );
  });

  it("stage / unstage：同一个仓库同一个状态，三次答案一样", async () => {
    const unstage = () => repo.git("reset", "-q", "--", "a.txt");
    expectParity(
      await threeWrites(
        unstage,
        "POST",
        `${at(id)}/stage`,
        "git.stage",
        { workspaceId: id, path: ".", paths: ["a.txt"] },
        { path: ".", paths: ["a.txt"] },
      ),
    );
    const stage = () => repo.git("add", "--", "a.txt");
    expectParity(
      await threeWrites(
        stage,
        "POST",
        `${at(id)}/unstage`,
        "git.unstage",
        { workspaceId: id, paths: ["a.txt"] },
        { paths: ["a.txt"] },
      ),
    );
    unstage();
  });

  it("resolve：还带冲突标记的文件被拒，原话一样", async () => {
    const conflicted = repository("parity-git-conflict");
    conflicted.write(
      "c.txt",
      "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> b\n",
    );
    const cid = workspaceAt(conflicted.path);
    const answers = await three(
      "POST",
      `${at(cid)}/resolve`,
      "git.resolve",
      { workspaceId: cid, paths: ["c.txt"] },
      { paths: ["c.txt"] },
    );
    expect(answers[0].status).toBeGreaterThanOrEqual(400);
    expectParity(answers);
  });

  it("revert：从索引还原；不认识的来源由域拒绝", async () => {
    const restore = () => repo.write("b.txt", "bee  \n");
    expectParity(
      await threeWrites(
        restore,
        "POST",
        `${at(id)}/revert`,
        "git.revert",
        { workspaceId: id, paths: ["b.txt"], source: "index" },
        { paths: ["b.txt"], source: "index" },
      ),
    );
    restore();
    const refused = await three(
      "POST",
      `${at(id)}/revert`,
      "git.revert",
      { workspaceId: id, paths: ["b.txt"], source: "stash" },
      { paths: ["b.txt"], source: "stash" },
    );
    expect(refused[0].status).toBe(400);
    expectParity(refused);
  });

  it("commit：只提交给的路径；amend 的 HEAD 不对被拒", async () => {
    const own = repository("parity-git-commit");
    const oid = own.head();
    const cid = workspaceAt(own.path);
    // 每次都从种子提交起，写同一份改动：三次提交的内容一样，只有对象 id 不同。
    const answers = await threeWrites(
      () => {
        own.git("reset", "-q", "--hard", oid);
        own.write("c.txt", "c\n");
      },
      "POST",
      `${at(cid)}/commit`,
      "git.commit",
      { workspaceId: cid, message: "add c", paths: ["c.txt"] },
      { message: "add c", paths: ["c.txt"] },
    );
    // 提交摘要里带着那次的短 id：只比去掉它之后的样子。
    const shape = (answer: Answer) => {
      const body = answer.body as { summary: string; commit: string };
      return {
        ...answer,
        body: {
          ...body,
          summary: body.summary.replace(body.commit.slice(0, 7), "<oid>"),
        },
      };
    };
    expectParity([shape(answers[0]), shape(answers[1]), shape(answers[2])]);
    expect(own.git("log", "--format=%s").trim().split("\n")).toEqual([
      "add c",
      "seed",
    ]);
    expectParity(
      await three(
        "POST",
        `${at(cid)}/commit`,
        "git.commit",
        {
          workspaceId: cid,
          message: "amend",
          amend: { expectedHead: oid, allowPublished: false },
        },
        {
          message: "amend",
          amend: { expectedHead: oid, allowPublished: false },
        },
      ),
    );
  });

  it("hunks / applyHunk：读一个块、暂存它；不认识的动作由域拒绝", async () => {
    const read = await three(
      "GET",
      `${at(id)}/hunks?path=.&file=a.txt&scope=worktree`,
      "git.hunks",
      { workspaceId: id, path: ".", file: "a.txt", scope: "worktree" },
    );
    expectParity(read);
    const diff = read[0].body as {
      diffDigest: string;
      hunks: { id: string }[];
    };
    const mutation = {
      path: ".",
      file: "a.txt",
      scope: "worktree",
      diffDigest: diff.diffDigest,
      hunkId: diff.hunks[0]!.id,
      action: "stage",
    };
    expectParity(
      await threeWrites(
        () => repo.git("reset", "-q", "--", "a.txt"),
        "POST",
        `${at(id)}/hunks`,
        "git.applyHunk",
        { workspaceId: id, ...mutation },
        mutation,
      ),
    );
    repo.git("reset", "-q", "--", "a.txt");
    const refused = await three(
      "POST",
      `${at(id)}/hunks`,
      "git.applyHunk",
      { workspaceId: id, ...mutation, action: "squash" },
      { ...mutation, action: "squash" },
    );
    expect(refused[0].status).toBe(400);
    expectParity(refused);
    const noScope = await three(
      "GET",
      `${at(id)}/hunks?file=a.txt`,
      "git.hunks",
      { workspaceId: id, file: "a.txt" },
    );
    expect(noScope[0].status).toBe(400);
    expectParity(noScope);
  });

  it("message：提供方、暂存源；不支持的语言由域拒绝", async () => {
    repo.git("add", "--", "new.txt");
    expectParity(
      await three(
        "GET",
        `${at(id)}/message/providers`,
        "git.message.providers",
        {
          workspaceId: id,
        },
      ),
    );
    const source = await three(
      "GET",
      `${at(id)}/message/source`,
      "git.message.source",
      { workspaceId: id },
    );
    expect(source[0].status).toBe(200);
    expectParity(source);
    const draft = {
      provider: "claude-bare",
      expectedHead: repo.head(),
      indexDigest: (source[0].body as { indexDigest: string }).indexDigest,
      language: "fr",
    };
    const refused = await three(
      "POST",
      `${at(id)}/message/generate`,
      "git.message.generate",
      { workspaceId: id, ...draft },
      draft,
    );
    expect(refused[0].status).toBe(400);
    expectParity(refused);
    repo.git("reset", "-q", "--", "new.txt");
  });

  it("init：只在没有仓库的地方建；已有仓库的被拒", async () => {
    const plain = [0, 1, 2].map(() => temporaryDirectory("parity-git-init"));
    const ids = plain.map((root) => workspaceAt(root));
    const created = [
      await table("POST", `${at(ids[0]!)}/init`),
      await legacy("POST", `${at(ids[1]!)}/init`),
      await procedure("git.init", { workspaceId: ids[2] }),
    ];
    // 各建在自己的目录里：只有 `path` 不同，且就是那个目录。
    created.forEach((answer, index) => {
      expect((answer.body as { path: string }).path).toBe(plain[index]);
    });
    const shape = (answer: Answer): Answer => ({
      ...answer,
      body: { ...(answer.body as object), path: "<directory>" },
    });
    expectParity([shape(created[0]!), shape(created[1]!), shape(created[2]!)]);
    const again = await three("POST", `${at(id)}/init`, "git.init", {
      workspaceId: id,
    });
    expect(again[0].status).toBe(409);
    expectParity(again);
  });

  it("权限：不许读、不许写、没有执行授权、不存在的工作空间", async () => {
    const noRead = workspaceAt(repository("parity-git-noRead").path, {
      read: false,
      write: false,
      execute: false,
    });
    expectParity(
      await three("GET", `${at(noRead)}/status`, "git.status", {
        workspaceId: noRead,
      }),
    );
    const readOnly = workspaceAt(repository("parity-git-readOnly").path, {
      read: true,
      write: false,
      execute: true,
    });
    const denied = await three(
      "POST",
      `${at(readOnly)}/stage`,
      "git.stage",
      { workspaceId: readOnly, paths: ["a.txt"] },
      { paths: ["a.txt"] },
    );
    expect(denied[0].status).toBe(403);
    expectParity(denied);
    const noExec = workspaceAt(repository("parity-git-noExec").path, {
      read: true,
      write: true,
      execute: false,
    });
    for (const [path, name] of [
      ["status", "git.status"],
      ["head-commit", "git.headCommit"],
      ["message/source", "git.message.source"],
    ] as const) {
      const answers = await three("GET", `${at(noExec)}/${path}`, name, {
        workspaceId: noExec,
      });
      expect((answers[0].body as { code: string }).code).toBe(
        "git_execution_required",
      );
      expectParity(answers);
    }
    expectParity(
      await three("GET", `${at(UNKNOWN)}/status`, "git.status", {
        workspaceId: UNKNOWN,
      }),
    );
  });
});

describe("git.clone：任务模型（只起任务、答 jobId，进度轮询）", () => {
  it("不在名单里的地址、祖先工作空间不许写、不认识的任务", async () => {
    const parent = temporaryDirectory("parity-git-clone");
    const local = { url: parent, parent, name: "copy" };
    const refused = await three(
      "POST",
      "/api/git/clone",
      "git.clone.start",
      local,
      local,
    );
    expect(refused[0].status).toBe(400);
    expectParity(refused);

    const guarded = join(parent, "guarded");
    mkdirSync(guarded);
    workspaceAt(guarded, { read: true, write: false, execute: true });
    const inside = {
      url: "https://127.0.0.1:9/none.git",
      parent: guarded,
      name: "copy",
    };
    const ancestor = await three(
      "POST",
      "/api/git/clone",
      "git.clone.start",
      inside,
      inside,
    );
    expect(ancestor[0].status).toBe(403);
    expectParity(ancestor);

    expectParity(
      await three("GET", "/api/git/clone/nope", "git.clone.status", {
        jobId: "nope",
      }),
    );
    expectParity(
      await three("DELETE", "/api/git/clone/nope", "git.clone.cancel", {
        jobId: "nope",
      }),
    );
  });

  it("起任务、三条路读同一个任务的进度、取消", async () => {
    const parent = temporaryDirectory("parity-git-clone-job");
    const start = (name: string) => ({
      url: "https://127.0.0.1:9/none.git",
      parent,
      name,
    });
    const started = [
      await table("POST", "/api/git/clone", start("one")),
      await legacy("POST", "/api/git/clone", start("two")),
      await procedure("git.clone.start", start("three")),
    ] as const;
    expectParity(started);
    const jobs = started.map(
      (answer) => (answer.body as { jobId: string }).jobId,
    );
    expect(new Set(jobs).size).toBe(3);

    // 连不上的地址很快失败；三条路读的是同一个任务。
    const job = jobs[0]!;
    const deadline = Date.now() + 20_000;
    for (;;) {
      const status = await table("GET", `/api/git/clone/${job}`);
      if ((status.body as { state: string }).state !== "running") break;
      if (Date.now() > deadline) throw new Error("克隆任务一直没有结束");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expectParity(
      await three("GET", `/api/git/clone/${job}`, "git.clone.status", {
        jobId: job,
      }),
    );

    // 取消一个已结束的任务不是错误：旧路径答 204，procedure 答 200 无体。
    const cancelled = [
      await table("DELETE", `/api/git/clone/${jobs[0]}`),
      await legacy("DELETE", `/api/git/clone/${jobs[1]}`),
      await procedure("git.clone.cancel", { jobId: jobs[2] }),
    ] as const;
    expect(cancelled.map((answer) => answer.status)).toEqual([204, 204, 200]);
    expect(cancelled.map((answer) => answer.body ?? null)).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe("git 域：入参形状错只比码与状态", () => {
  it("缺字段、类型不对：旧路径与 procedure 由入参校验答 bad_request", async () => {
    const repo = repository("parity-git-shape");
    const id = workspaceAt(repo.path);
    const cases: readonly [string, string, string, Record<string, unknown>][] =
      [
        ["POST", `${at(id)}/stage`, "git.stage", { paths: "a.txt" }],
        ["POST", `${at(id)}/commit`, "git.commit", { paths: ["a.txt"] }],
        ["GET", `${at(id)}/hunks?scope=worktree`, "git.hunks", {}],
        ["POST", "/api/git/clone", "git.clone.start", { parent: "/tmp" }],
      ];
    for (const [method, path, name, body] of cases) {
      const input = path.startsWith("/api/git/")
        ? body
        : { workspaceId: id, ...body };
      const old = await table(
        method,
        path,
        method === "GET" ? undefined : body,
      );
      const rest = await legacy(
        method,
        path,
        method === "GET" ? undefined : body,
      );
      const rpc = await procedure(name, input);
      for (const answer of [old, rest, rpc]) {
        expect(answer.status, `${name} ${answer.status}`).toBe(400);
        expect((answer.body as { code: string }).code).toBe("bad_request");
      }
      expect(
        (rpc.body as { details?: { issues?: unknown[] } }).details?.issues,
      ).toBeDefined();
    }
  });
});

describe("git 域：契约与路由表", () => {
  it("meta.scope 与路由表给旧路径的要求一致；旧路径都在路由表里", () => {
    expect(entries.length).toBe(17);
    for (const entry of entries) {
      const legacyRoute = entry.meta.legacy!;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = core.server.router.match(legacyRoute.path);
      expect(found?.entry.methods, entry.name).toContain(legacyRoute.method);
    }
  });

  it("切分边界：路由表里其余的 Git 路径都是仓库级，恰好是 gitRepository（§40.2）那 23 条", () => {
    const migrated = new Set(
      entries.map(
        (entry) => `${entry.meta.legacy!.method} ${entry.meta.legacy!.path}`,
      ),
    );
    const rest = ROUTES.filter((route) => route.path.includes("/git/")).flatMap(
      (route) =>
        route.methods
          .map((method) => `${method} ${route.path}`)
          .filter((key) => !migrated.has(key)),
    );
    for (const key of rest) {
      expect(key, key).toMatch(
        /\/git\/(repository\/|repositories$|log$|refs$|identity$)/,
      );
    }
    const repository = contractEntries()
      .filter((entry) => entry.path[0] === "gitRepository")
      .map(
        (entry) => `${entry.meta.legacy!.method} ${entry.meta.legacy!.path}`,
      );
    expect(repository).toHaveLength(23);
    expect([...rest].sort()).toEqual([...repository].sort());
    expect(migrated.size + rest.length).toBe(
      ROUTES.filter((route) => route.path.includes("/git/")).reduce(
        (sum, route) => sum + route.methods.length,
        0,
      ),
    );
  });
});
