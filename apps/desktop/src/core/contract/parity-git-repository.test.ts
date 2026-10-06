import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { installContract } from "../http/rpc";
import { routeScope } from "../http/route-scopes";
import { ROUTES } from "../http/routes";
import { invalidateAll } from "../git/discovery";
import { type Repo, cleanupFixtures, repository } from "../git/fixture";
import { install as installGit } from "../git/index";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import {
  type WorkspacePermissions,
  createWorkspace,
} from "../workspaces/table";
import { type JsonValue, canonicalJson } from "./message";

/**
 * gitRepository 域的对偶测试（契约 §40.2；工程规范化包 §3 ④）。
 *
 * 与 `parity-git.test.ts` 同一个做法：同一份夹具问三次——路由表里原来那条
 * handler、旧 REST 路径（经 HTTP，由契约实现经 `OpenAPIHandler` 答）、新
 * procedure。成功的答案按 `canonicalJson` 逐字节相等；失败的码、状态与原话相等
 * （procedure 多一个 `requestId`）。
 *
 * 旧路径的读是查询串，所以每条读都用数字串、`"true"` 与逗号拼的路径问旧路径，
 * 用数字、布尔与数组问 procedure。操作队列是长操作：每种答法各起一个操作（id
 * 与时刻不同，比较前换成占位），各自轮询到结束；读同一个操作的三种答法逐字节
 * 相等。rebase 在每次之间把分支拨回同一个提交，三次的过程与结果一样。
 *
 * 只有一类差别是有意的：入参的**形状**错在 procedure 与旧路径上由契约的入参校验
 * 先答 `bad_request`（带 `details.issues`），只比码与状态，在最后一节单独写出来。
 */

let core: Fixture;
let base: string;

beforeAll(async () => {
  invalidateAll();
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

/** 每次读、每个操作都会变的字段。 */
const VOLATILE = new Set(["id", "createdAt", "finishedAt", "observedAt"]);

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

/** 同一个读问三遍：旧路径用查询串或体，procedure 用入参。 */
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
const repo = (workspaceId: string) => `${at(workspaceId)}/repository`;
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

const entries = contractEntries().filter(
  (entry) => entry.path[0] === "gitRepository",
);

interface Operation {
  readonly id: string;
  readonly state: string;
}

/** 轮询一个操作直到结束（经路由表读，读法本身另有用例比）。 */
async function settled(workspaceId: string, id: string): Promise<Operation> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await table("GET", `${repo(workspaceId)}/operations/${id}`);
    expect(answer.status).toBe(200);
    const snapshot = answer.body as Operation;
    if (snapshot.state !== "queued" && snapshot.state !== "running") {
      return snapshot;
    }
    if (Date.now() > deadline) throw new Error(`操作 ${id} 一直没有结束`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("gitRepository 域：仓库级的读，旧路径、procedure 与原 handler 答得一样", () => {
  let main: Repo;
  let id: string;
  let first: string;
  let second: string;
  let stash: string;

  beforeAll(() => {
    main = repository("parity-repo");
    main.git("config", "user.name", "Parity");
    main.git("config", "user.email", "parity@example.com");
    first = main.head();
    main.write("a.txt", "one\n");
    main.write("dir/b.txt", "bee\n");
    second = main.commit("add a and b");
    main.write("a.txt", "two\n");
    main.commit("change a");
    main.git("tag", "v1", second);
    main.git("tag", "-a", "v2", "-m", "second release");
    main.git("branch", "feature", first);
    main.git(
      "remote",
      "add",
      "origin",
      "https://user:secret@example.invalid/parity.git",
    );
    // 工作空间里的第二个检出：忽略掉，不然它是主检出里一个未跟踪的目录。
    main.write(".git/info/exclude", ".wt-side/\n");
    main.git("worktree", "add", "-q", join(main.path, ".wt-side"), "feature");
    main.write("a.txt", "dirty\n");
    main.git("stash", "push", "-q", "-m", "parked");
    stash = main.git("rev-parse", "stash@{0}").trim();
    main.write("dir/b.txt", "changed\n");
    id = workspaceAt(main.path);
  });

  it('repositories：refresh 的 "true" 与布尔、maxDepth 的数字串与数字', async () => {
    expectParity(
      await three(
        "GET",
        `${at(id)}/repositories?refresh=true&maxDepth=2`,
        "gitRepository.repositories",
        { workspaceId: id, refresh: true, maxDepth: 2 },
      ),
    );
    expectParity(
      await three(
        "GET",
        `${at(id)}/repositories`,
        "gitRepository.repositories",
        {
          workspaceId: id,
        },
      ),
    );
    const refused = await three(
      "GET",
      `${at(id)}/repositories?maxDepth=-1`,
      "gitRepository.repositories",
      { workspaceId: id, maxDepth: -1 },
    );
    expect(refused[0].status).toBe(400);
    expectParity(refused);
  });

  it("log：筛选条件是体；游标属于取它时的筛选条件", async () => {
    const filters = { refs: { kind: "all" }, limit: 2 };
    const page = await three(
      "POST",
      `${at(id)}/log`,
      "gitRepository.log",
      { workspaceId: id, ...filters },
      filters,
    );
    expectParity(page);
    const cursor = (page[0].body as { nextCursor: string | null }).nextCursor;
    expect(cursor).not.toBeNull();
    const next = { ...filters, cursor };
    expectParity(
      await three(
        "POST",
        `${at(id)}/log`,
        "gitRepository.log",
        { workspaceId: id, ...next },
        next,
      ),
    );
    const searched = {
      text: { query: "change", matchCase: true },
      paths: ["a.txt"],
      authors: ["Test"],
    };
    expectParity(
      await three(
        "POST",
        `${at(id)}/log`,
        "gitRepository.log",
        { workspaceId: id, ...searched },
        searched,
      ),
    );
    // 换了筛选条件还送回旧游标：409 invalid_cursor。
    const stale = { refs: { kind: "head" }, limit: 2, cursor };
    const refused = await three(
      "POST",
      `${at(id)}/log`,
      "gitRepository.log",
      { workspaceId: id, ...stale },
      stale,
    );
    expect(refused[0].status).toBe(409);
    expect((refused[0].body as { code: string }).code).toBe("invalid_cursor");
    expectParity(refused);
    const kind = { refs: { kind: "some" } };
    const unknownKind = await three(
      "POST",
      `${at(id)}/log`,
      "gitRepository.log",
      { workspaceId: id, ...kind },
      kind,
    );
    expect(unknownKind[0].status).toBe(400);
    expectParity(unknownKind);
  });

  it("refs、identity、branches、tags、remotes、worktrees、stashes", async () => {
    expectParity(
      await three("GET", `${at(id)}/refs`, "gitRepository.refs", {
        workspaceId: id,
      }),
    );
    for (const [path, name] of [
      [`${at(id)}/identity`, "identity"],
      [`${repo(id)}/branches`, "branches"],
      [`${repo(id)}/tags`, "tags"],
      [`${repo(id)}/remotes`, "remotes"],
      [`${repo(id)}/worktrees`, "worktrees"],
      [`${repo(id)}/stashes`, "stashes"],
    ] as const) {
      const answers = await three(
        "GET",
        `${path}?path=.`,
        `gitRepository.${name}`,
        { workspaceId: id, path: "." },
      );
      expect(
        answers[0].status,
        `${name} ${JSON.stringify(answers[0].body)}`,
      ).toBe(200);
      expectParity(answers);
    }
    // 远端 URL 里嵌的凭据三条路都换掉了。
    const remotes = await procedure("gitRepository.remotes", {
      workspaceId: id,
    });
    expect(JSON.stringify(remotes.body)).not.toContain("secret");
  });

  it("stashDetail、commitDetail（对第一父与对 HEAD）、commitFile", async () => {
    expectParity(
      await three(
        "GET",
        `${repo(id)}/stash-detail?path=.&oid=${stash}`,
        "gitRepository.stashDetail",
        { workspaceId: id, path: ".", oid: stash },
      ),
    );
    expectParity(
      await three(
        "GET",
        `${repo(id)}/commit?oid=${second}`,
        "gitRepository.commitDetail",
        { workspaceId: id, oid: second },
      ),
    );
    expectParity(
      await three(
        "GET",
        `${repo(id)}/commit?oid=${second}&base=HEAD`,
        "gitRepository.commitDetail",
        { workspaceId: id, oid: second, base: "HEAD" },
      ),
    );
    expectParity(
      await three(
        "GET",
        `${repo(id)}/commit-file?oid=${second}&file=dir/b.txt`,
        "gitRepository.commitFile",
        { workspaceId: id, oid: second, file: "dir/b.txt" },
      ),
    );
    const missing = await three(
      "GET",
      `${repo(id)}/commit?oid=${"0".repeat(40)}`,
      "gitRepository.commitDetail",
      { workspaceId: id, oid: "0".repeat(40) },
    );
    expect(missing[0].status).toBeGreaterThanOrEqual(400);
    expectParity(missing);
  });

  it("history：数字串的 limit、逗号拼的路径与数组、下一页的游标、不属于它的游标", async () => {
    const page = await three(
      "GET",
      `${repo(id)}/history?path=.&reference=HEAD&limit=1`,
      "gitRepository.history",
      { workspaceId: id, path: ".", reference: "HEAD", limit: 1 },
    );
    expectParity(page);
    const cursor = (page[0].body as { nextCursor: string }).nextCursor;
    expect(cursor).toBeTruthy();
    expectParity(
      await three(
        "GET",
        `${repo(id)}/history?limit=1&cursor=${encodeURIComponent(cursor)}`,
        "gitRepository.history",
        { workspaceId: id, limit: 1, cursor },
      ),
    );
    expectParity(
      await three(
        "GET",
        `${repo(id)}/history?paths=a.txt,dir/b.txt`,
        "gitRepository.history",
        { workspaceId: id, paths: ["a.txt", "dir/b.txt"] },
      ),
    );
    const refused = await three(
      "GET",
      `${repo(id)}/history?reference=feature&cursor=${encodeURIComponent(cursor)}`,
      "gitRepository.history",
      { workspaceId: id, reference: "feature", cursor },
    );
    expect(refused[0].status).toBe(409);
    expectParity(refused);
    const badLimit = await three(
      "GET",
      `${repo(id)}/history?limit=many`,
      "gitRepository.history",
      { workspaceId: id, limit: "many" },
    );
    expect(badLimit[0].status).toBe(400);
    expectParity(badLimit);
  });

  it("reflog：第一页与下一页", async () => {
    const page = await three(
      "GET",
      `${repo(id)}/reflog?reference=HEAD&limit=2`,
      "gitRepository.reflog",
      { workspaceId: id, reference: "HEAD", limit: 2 },
    );
    expectParity(page);
    const cursor = (page[0].body as { nextCursor: string | null }).nextCursor;
    if (cursor !== null) {
      expectParity(
        await three(
          "GET",
          `${repo(id)}/reflog?limit=2&cursor=${encodeURIComponent(cursor)}`,
          "gitRepository.reflog",
          { workspaceId: id, limit: 2, cursor },
        ),
      );
    }
  });

  it("cherryPickPreview（数字串的 mainline 与数字）、rebaseTodo", async () => {
    expectParity(
      await three(
        "GET",
        `${repo(id)}/cherry-pick-preview?oid=${second}`,
        "gitRepository.cherryPickPreview",
        { workspaceId: id, oid: second },
      ),
    );
    // 不是合并提交却给了 mainline：由域拒绝，原话一样。
    const mainline = await three(
      "GET",
      `${repo(id)}/cherry-pick-preview?oid=${second}&mainline=1`,
      "gitRepository.cherryPickPreview",
      { workspaceId: id, oid: second, mainline: 1 },
    );
    expectParity(mainline);
    expectParity(
      await three(
        "GET",
        `${repo(id)}/rebase-todo?onto=${first}`,
        "gitRepository.rebaseTodo",
        { workspaceId: id, onto: first },
      ),
    );
  });

  it("statusBatch、worktreeBinding（只读的 POST）", async () => {
    const batch = { paths: [".", ".wt-side", "missing"], pathspecs: ["dir"] };
    expectParity(
      await three(
        "POST",
        `${repo(id)}/status-batch`,
        "gitRepository.statusBatch",
        { workspaceId: id, ...batch },
        batch,
      ),
    );
    for (const binding of [
      { worktreePath: ".wt-side", branch: "feature" },
      { worktreePath: ".wt-side", branch: "main" },
      { worktreePath: "gone" },
    ]) {
      expectParity(
        await three(
          "POST",
          `${repo(id)}/worktree-binding`,
          "gitRepository.worktreeBinding",
          { workspaceId: id, ...binding },
          binding,
        ),
      );
    }
  });

  it("integration：不是这个工作空间的会话被抹掉", async () => {
    expectParity(
      await three(
        "GET",
        `${repo(id)}/integration?path=.`,
        "gitRepository.integration",
        { workspaceId: id, path: "." },
      ),
    );
  });

  it("读、写、执行授权与不存在的工作空间", async () => {
    const own = repository("parity-repo-grants");
    const unreadable = workspaceAt(own.path, {
      read: false,
      write: true,
      execute: true,
    });
    // 同一个根只登记得出一块工作空间：没有执行授权的另用一个仓库。
    const noExecute = workspaceAt(repository("parity-repo-no-execute").path, {
      read: true,
      write: true,
      execute: false,
    });
    for (const workspaceId of [unreadable, UNKNOWN]) {
      const answers = await three(
        "GET",
        `${repo(workspaceId)}/branches`,
        "gitRepository.branches",
        { workspaceId },
      );
      expect(answers[0].status).toBeGreaterThanOrEqual(403);
      expectParity(answers);
    }
    const batch = { paths: ["."] };
    const execute = await three(
      "POST",
      `${repo(noExecute)}/status-batch`,
      "gitRepository.statusBatch",
      { workspaceId: noExecute, ...batch },
      batch,
    );
    expect((execute[0].body as { code: string }).code).toBe(
      "git_execution_required",
    );
    expectParity(execute);
    // 没有执行授权的读照样答，执行授权交给执行的那一侧判。
    expectParity(
      await three(
        "GET",
        `${repo(noExecute)}/branches`,
        "gitRepository.branches",
        { workspaceId: noExecute },
      ),
    );
  });
});

describe("gitRepository 域：操作队列（长操作只起任务、答快照）", () => {
  it("起操作、轮询、列表；别的工作空间看不到；取消已结束的操作", async () => {
    const own = repository("parity-repo-ops");
    const id = workspaceAt(own.path);
    const other = workspaceAt(repository("parity-repo-ops-other").path);
    const head = own.head();
    const start = (name: string) => ({
      path: ".",
      action: { kind: "createBranch", name, startPoint: null, switch: false },
      expected: { headOid: head, branch: "main" },
    });

    const started = [
      await table("POST", `${repo(id)}/operations`, start("one")),
      await legacy("POST", `${repo(id)}/operations`, start("two")),
      await procedure("gitRepository.operations.start", {
        workspaceId: id,
        ...start("three"),
      }),
    ] as const;
    // 三个操作只差分支名：换成同一个再比。
    const named = (answer: Answer): Answer => {
      const body = answer.body as { action: { name: string } };
      return {
        ...answer,
        body: { ...body, action: { ...body.action, name: "<name>" } },
      };
    };
    expectParity([named(started[0]), named(started[1]), named(started[2])]);
    const ids = started.map((answer) => (answer.body as Operation).id);
    expect(new Set(ids).size).toBe(3);
    for (const operation of ids) {
      expect((await settled(id, operation)).state).toBe("succeeded");
    }
    expect(own.git("branch", "--list", "one", "two", "three")).toContain(
      "three",
    );

    const operation = ids[0]!;
    const read = await three(
      "GET",
      `${repo(id)}/operations/${operation}`,
      "gitRepository.operations.get",
      { workspaceId: id, operationId: operation },
    );
    // 读同一个操作：连 id 与时刻都一样。
    expect(canonicalJson(read[2].body as JsonValue)).toBe(
      canonicalJson(read[0].body as JsonValue),
    );
    expectParity(read);
    expectParity(
      await three(
        "GET",
        `${repo(id)}/operations?path=.`,
        "gitRepository.operations.list",
        { workspaceId: id, path: "." },
      ),
    );
    const foreign = await three(
      "GET",
      `${repo(other)}/operations/${operation}`,
      "gitRepository.operations.get",
      { workspaceId: other, operationId: operation },
    );
    expect(foreign[0].status).toBe(404);
    expectParity(foreign);
    expectParity(
      await three(
        "POST",
        `${repo(other)}/operations/${operation}/cancel`,
        "gitRepository.operations.cancel",
        { workspaceId: other, operationId: operation },
      ),
    );
    expectParity(
      await three(
        "POST",
        `${repo(id)}/operations/${operation}/cancel`,
        "gitRepository.operations.cancel",
        { workspaceId: id, operationId: operation },
      ),
    );
  });

  it("rebase：三次都从同一个分支起，过程与结果一样", async () => {
    const own = repository("parity-repo-rebase");
    const base = own.head();
    own.write("main.txt", "main\n");
    const onto = own.commit("main moves");
    own.git("switch", "-q", "-c", "feature", base);
    own.write("feature.txt", "feature\n");
    const tip = own.commit("feature work");
    const id = workspaceAt(own.path);
    const reset = () => {
      own.git("switch", "-q", "feature");
      own.git("reset", "-q", "--hard", tip);
    };
    const token = async () =>
      (
        (await table("GET", `${repo(id)}/integration`)).body as {
          stateToken: string;
        }
      ).stateToken;
    const body = async () => ({
      action: {
        kind: "startRebase",
        onto,
        expectedStateToken: await token(),
      },
      expected: { headOid: tip, branch: "feature" },
    });

    const runs: Answer[] = [];
    const finals: Operation[] = [];
    for (const ask of [
      async () => table("POST", `${repo(id)}/operations`, await body()),
      async () => legacy("POST", `${repo(id)}/operations`, await body()),
      async () =>
        procedure("gitRepository.operations.start", {
          workspaceId: id,
          ...(await body()),
        }),
    ]) {
      reset();
      const answer = await ask();
      expect(answer.status).toBe(200);
      runs.push(answer);
      finals.push(await settled(id, (answer.body as Operation).id));
      expect(own.git("rev-list", "--count", `${onto}..HEAD`).trim()).toBe("1");
    }
    expectParity([runs[0]!, runs[1]!, runs[2]!]);
    expect(finals.map((operation) => operation.state)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(text({ status: 200, body: finals[1] })).toBe(
      text({ status: 200, body: finals[0] }),
    );
    expect(text({ status: 200, body: finals[2] })).toBe(
      text({ status: 200, body: finals[0] }),
    );
  });

  it("拒绝：不许写、不认识的操作、HEAD 对不上、会话不是这个工作空间的", async () => {
    const own = repository("parity-repo-refuse");
    const readOnly = workspaceAt(own.path, {
      read: true,
      write: false,
      execute: true,
    });
    const id = workspaceAt(own.path);
    const expected = { headOid: own.head(), branch: "main" };
    const fetch = {
      action: { kind: "fetch", remote: "origin", prune: false },
      expected,
    };
    const denied = await three(
      "POST",
      `${repo(readOnly)}/operations`,
      "gitRepository.operations.start",
      { workspaceId: readOnly, ...fetch },
      fetch,
    );
    expect(denied[0].status).toBe(403);
    expectParity(denied);
    for (const action of [
      { kind: "teleport" },
      { kind: "createBranch", name: "" },
      {
        kind: "continueIntegration",
        sessionId: "11111111-1111-4111-8111-111111111111",
        expectedStateToken: "0".repeat(64),
      },
    ]) {
      const request = { action, expected };
      const answers = await three(
        "POST",
        `${repo(id)}/operations`,
        "gitRepository.operations.start",
        { workspaceId: id, ...request },
        request,
      );
      expect(answers[0].status, action.kind).toBeGreaterThanOrEqual(400);
      expectParity(answers);
    }
    const unknownOperation = await three(
      "POST",
      `${repo(readOnly)}/operations/nope/cancel`,
      "gitRepository.operations.cancel",
      { workspaceId: readOnly, operationId: "nope" },
    );
    expect(unknownOperation[0].status).toBe(403);
    expectParity(unknownOperation);
  });
});

describe("gitRepository 域：入参形状错只比码与状态", () => {
  it("缺字段、类型不对：旧路径与 procedure 由入参校验答 bad_request", async () => {
    const own = repository("parity-repo-shape");
    const id = workspaceAt(own.path);
    const cases: readonly [string, string, string, Record<string, unknown>][] =
      [
        ["GET", `${repo(id)}/stash-detail`, "gitRepository.stashDetail", {}],
        ["GET", `${repo(id)}/rebase-todo`, "gitRepository.rebaseTodo", {}],
        [
          "POST",
          `${repo(id)}/status-batch`,
          "gitRepository.statusBatch",
          { paths: "." },
        ],
        [
          "POST",
          `${repo(id)}/operations`,
          "gitRepository.operations.start",
          { expected: { headOid: null, branch: null } },
        ],
        [
          "POST",
          `${repo(id)}/worktree-binding`,
          "gitRepository.worktreeBinding",
          {},
        ],
      ];
    for (const [method, path, name, body] of cases) {
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
      const rpc = await procedure(name, { workspaceId: id, ...body });
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

describe("gitRepository 域：契约与路由表", () => {
  it("meta.scope 与路由表给旧路径的要求一致；旧路径都在路由表里", () => {
    expect(entries.length).toBe(23);
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

  it("git 面迁完：路由表里每条 Git 路径都恰好属于 git（§40.1）或 gitRepository（§40.2）", () => {
    const owner = new Map<string, string>();
    for (const entry of contractEntries()) {
      const domain = entry.path[0]!;
      if (domain !== "git" && domain !== "gitRepository") continue;
      const key = `${entry.meta.legacy!.method} ${entry.meta.legacy!.path}`;
      expect(owner.has(key), key).toBe(false);
      owner.set(key, domain);
    }
    const routes = ROUTES.filter((route) =>
      route.path.includes("/git/"),
    ).flatMap((route) =>
      route.methods.map((method) => `${method} ${route.path}`),
    );
    for (const key of routes) {
      expect(owner.get(key), key).toBeDefined();
      if (
        /\/git\/(repository\/|repositories$|log$|refs$|identity$)/.test(key)
      ) {
        expect(owner.get(key), key).toBe("gitRepository");
      } else {
        expect(owner.get(key), key).toBe("git");
      }
    }
    expect(owner.size).toBe(routes.length);
  });
});
