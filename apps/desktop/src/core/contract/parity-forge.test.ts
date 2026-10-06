import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { EventBus } from "../bus";
import { type RpcHandle, installContract } from "../http/rpc";
import { CoreServer } from "../http/server";
import { emptyRequest } from "../http/router";
import { routeScope } from "../http/route-scopes";
import {
  FAKE_GITEA,
  type FakeGitea,
  startFakeGitea,
} from "../forge/fake-gitea.fixture";
import { installRoutes } from "../forge/routes";
import { ForgeService } from "../forge/service";
import { ForgeStore } from "../forge/store";
import { type GithubFixture, githubFixture } from "../github/fixture";
import { createLog, nodePlatform } from "../platform";
import type { SecretBackend } from "../secrets/backend";
import { type JsonValue, canonicalJson } from "./message";

/**
 * forge 域的对偶测试（契约 §41.2；工程规范化包 §3 ④）。
 *
 * 同一份夹具问三次——路由表里原来那条 handler、旧 REST 路径（经 HTTP，由契约实现
 * 经 `OpenAPIHandler` 答）、新 procedure。成功的答案按 `canonicalJson` 逐字节
 * 相等；失败的码、状态与原话相等（procedure 多一个 `requestId`）。会改远端的写
 * （建 PR、合并、删分支）每个答法各用自己的那一条，比较前把每次都不同的字段换
 * 成占位。
 *
 * 只有一类差别是有意的：入参的**形状**错（类型不对）在 procedure 与旧路径上由
 * 契约的入参校验先答 `bad_request`（带 `details.issues`），路由表原 handler 答
 * 它自己的那句话。这一类只比码与状态，在最后一节单独写出来。令牌不进任何答案。
 */

const SHA = "a".repeat(40);
const HOST = "127.0.0.1";
const REPO = { host: HOST, owner: FAKE_GITEA.owner, name: FAKE_GITEA.repo };
const REPO_PATH = `/api/forge/repos/${HOST}/${FAKE_GITEA.owner}/${FAKE_GITEA.repo}`;

let handle: RpcHandle;
let github: GithubFixture;
let gitea: FakeGitea;
let server: CoreServer;
let base: string;
let dataDir: string;

function memoryBackend(): SecretBackend {
  const values = new Map<string, string>();
  return {
    kind: "file",
    async get(name) {
      return values.get(name);
    },
    async set(name, value) {
      values.set(name, value);
    },
    async delete(name) {
      values.delete(name);
    },
  };
}

beforeAll(async () => {
  github = await githubFixture();
  gitea = await startFakeGitea();
  dataDir = mkdtempSync(join(tmpdir(), "armadra-parity-forge-"));
  const secrets = memoryBackend();
  let ids = 0;
  const service = new ForgeService({
    store: new ForgeStore(github.db.database),
    secrets: () => secrets,
    github: () => github.service,
    now: () => 1_800_000_000_000,
    newId: () => `id${(ids += 1)}`,
  });
  const platform = nodePlatform({
    dataDir,
    appVersion: "0.0.0-test",
    isPackaged: false,
    log: createLog("error"),
  });
  server = new CoreServer({
    platform,
    bus: new EventBus(),
    version: "0.0.0-test",
  });
  installRoutes(server, service);
  handle = installContract(server, { validateOutput: true, platform });
  const listener = server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  await table("PUT", `/api/forge/configs/${HOST}`, {
    forge: "gitea",
    apiBase: gitea.root,
    token: FAKE_GITEA.token,
  });
  gitea.issues.push(
    { number: 1, title: "first", body: "full body", state: "open", labels: [] },
    { number: 2, title: "second", body: "", state: "open", labels: ["bug"] },
  );
  const pull = {
    body: "",
    state: "open" as const,
    merged: false,
    mergeable: true,
    base: "main",
    sha: SHA,
    files: [{ filename: "a.txt", status: "added", additions: 1, deletions: 0 }],
    diff: "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hi\n",
  };
  gitea.pulls.push(
    { ...pull, number: 3, title: "read me", head: "topic" },
    // 三条各给一种答法去合并。
    { ...pull, number: 10, title: "m1", head: "m1" },
    { ...pull, number: 11, title: "m2", head: "m2" },
    { ...pull, number: 12, title: "m3", head: "m3" },
    // 三条已合并、分支还在的，各给一种答法去删分支。
    ...[20, 21, 22].map((number) => ({
      ...pull,
      number,
      title: `merged ${number}`,
      head: `feature/${number}`,
      state: "closed" as const,
      merged: true,
    })),
    {
      ...pull,
      number: 30,
      title: "fork",
      head: "feature/fork",
      fork: true,
      state: "closed" as const,
      merged: true,
    },
  );
  for (const number of [20, 21, 22]) {
    gitea.branches.set(`feature/${number}`, { sha: SHA, protected: false });
  }
  gitea.statuses.set(SHA, [
    { context: "ci", status: "success", target_url: "" },
  ]);
});

afterAll(async () => {
  await server.close();
  await github.close();
  await gitea.close();
  rmSync(dataDir, { recursive: true, force: true });
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
  const url = new URL(path, "http://core");
  const encoded = Buffer.from(
    body === undefined ? "" : JSON.stringify(body),
    "utf8",
  );
  const request = {
    ...emptyRequest(method, url.pathname),
    query: url.searchParams,
    body: encoded,
    json: <T>() => JSON.parse(encoded.toString("utf8")) as T,
  };
  const answer = await server.router.dispatch(method, url.pathname, request);
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

/** 每次建、每次合并都不同的字段。 */
const VOLATILE = new Set(["number", "url", "createdAtMs", "updatedAtMs"]);

function stable(value: unknown, volatile: boolean): JsonValue {
  if (Array.isArray(value)) return value.map((item) => stable(item, volatile));
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] =
      volatile && VOLATILE.has(key) ? "<volatile>" : stable(field, volatile);
  }
  return out;
}

const text = (answer: Answer, volatile = false) =>
  canonicalJson(stable(answer.body, volatile));

interface Case {
  readonly method: string;
  /** 旧路径，带查询串。 */
  readonly path: string;
  readonly body?: unknown;
  readonly procedure: string;
  readonly input?: unknown;
}

/** 三种答法问同一个问题：返回三份答案。 */
async function ask(one: Case): Promise<[Answer, Answer, Answer]> {
  return [
    await table(one.method, one.path, one.body),
    await legacy(one.method, one.path, one.body),
    await procedure(one.procedure, one.input),
  ];
}

/** 三份答案相等（成功逐字节；失败码、状态与原话）。 */
async function same(one: Case, volatile = false): Promise<Answer> {
  const answers = await ask(one);
  const expected = answers[0];
  for (const answer of answers.slice(1)) {
    expect(answer.status, `${one.method} ${one.path}`).toBe(expected.status);
    expect(text(answer, volatile), `${one.method} ${one.path}`).toBe(
      text(expected, volatile),
    );
  }
  return expected;
}

describe("forge：读", () => {
  it("配置列表、识别与 resolve", async () => {
    const listed = await same({
      method: "GET",
      path: "/api/forge/configs",
      procedure: "forge.configs",
      input: {},
    });
    expect(listed.body).toMatchObject({
      configs: [{ repoKey: HOST, forge: "gitea", credential: true }],
    });
    expect(JSON.stringify(listed.body)).not.toContain(FAKE_GITEA.token);
    const detected = await same({
      method: "GET",
      path: REPO_PATH,
      procedure: "forge.detect",
      input: REPO,
    });
    expect(detected.body).toMatchObject({ forge: "gitea", credential: true });
    const resolved = await same({
      method: "POST",
      path: "/api/forge/resolve",
      body: { remoteUrl: `https://${HOST}/acme/app.git` },
      procedure: "forge.resolve",
      input: { remoteUrl: `https://${HOST}/acme/app.git` },
    });
    expect(resolved.status).toBe(200);
    // 地址里的凭据不回显。
    const withCredentials = await same({
      method: "POST",
      path: "/api/forge/resolve",
      body: { remoteUrl: `https://user:s3cret@${HOST}/acme/app.git` },
      procedure: "forge.resolve",
      input: { remoteUrl: `https://user:s3cret@${HOST}/acme/app.git` },
    });
    expect(JSON.stringify(withCredentials.body)).not.toContain("s3cret");
  });

  it("issue 与 PR 的列表、详情、文件、检查与合并选项", async () => {
    const list = await same({
      method: "GET",
      path: `${REPO_PATH}/issues?limit=1`,
      procedure: "forge.issues",
      input: { ...REPO, limit: 1 },
    });
    expect(list.body).toMatchObject({ nextCursor: "2" });
    // 列表不带正文，详情带。
    expect((list.body as { items: { body: string }[] }).items[0]?.body).toBe(
      "",
    );
    await same({
      method: "GET",
      path: `${REPO_PATH}/issues?limit=1&cursor=2&state=all`,
      procedure: "forge.issues",
      input: { ...REPO, limit: "1", cursor: "2", state: "all" },
    });
    const issue = await same({
      method: "GET",
      path: `${REPO_PATH}/issues/1`,
      procedure: "forge.issue",
      input: { ...REPO, number: 1 },
    });
    expect(issue.body).toMatchObject({ body: "full body" });
    await same({
      method: "GET",
      path: `${REPO_PATH}/pulls?state=all`,
      procedure: "forge.pulls",
      input: { ...REPO, state: "all" },
    });
    await same({
      method: "GET",
      path: `${REPO_PATH}/pulls/3`,
      procedure: "forge.pull",
      input: { ...REPO, number: 3 },
    });
    const files = await same({
      method: "GET",
      path: `${REPO_PATH}/pulls/3/files`,
      procedure: "forge.pullFiles",
      input: { ...REPO, number: 3 },
    });
    expect(files.body).toMatchObject({ files: [{ path: "a.txt" }] });
    await same({
      method: "GET",
      path: `${REPO_PATH}/pulls/3/checks`,
      procedure: "forge.pullChecks",
      input: { ...REPO, number: 3 },
    });
    await same({
      method: "GET",
      path: `${REPO_PATH}/merge-options`,
      procedure: "forge.mergeOptions",
      input: REPO,
    });
  });

  it("没配的仓库：识别答 forge=null，读答 409 forge_not_configured", async () => {
    const other = { host: "git.example.test", owner: "x", name: "y" };
    const path = "/api/forge/repos/git.example.test/x/y";
    const detected = await same({
      method: "GET",
      path,
      procedure: "forge.detect",
      input: other,
    });
    expect((detected.body as { forge: unknown }).forge).toBeNull();
    const refused = await same({
      method: "GET",
      path: `${path}/issues`,
      procedure: "forge.issues",
      input: other,
    });
    expect(refused).toMatchObject({
      status: 409,
      body: { code: "forge_not_configured" },
    });
  });

  it("GitLab 多级子组的 owner 整条编码成一段", async () => {
    const nested = { host: "gitlab.example.test", owner: "g/sub", name: "app" };
    const path = `/api/forge/repos/gitlab.example.test/${encodeURIComponent("g/sub")}/app`;
    const answer = await same({
      method: "GET",
      path,
      procedure: "forge.detect",
      input: nested,
    });
    expect(answer.body).toMatchObject({
      repository: { host: "gitlab.example.test", owner: "g/sub", name: "app" },
    });
  });
});

describe("forge：写", () => {
  it("改 issue 状态", async () => {
    const closed = await same({
      method: "PATCH",
      path: `${REPO_PATH}/issues/1`,
      body: { state: "closed" },
      procedure: "forge.setIssueState",
      input: { ...REPO, number: 1, state: "closed" },
    });
    expect(closed.body).toMatchObject({ number: 1, state: "closed" });
    const reopened = await same({
      method: "PATCH",
      path: `${REPO_PATH}/issues/1`,
      body: { state: "open" },
      procedure: "forge.setIssueState",
      input: { ...REPO, number: 1, state: "open" },
    });
    expect(reopened.body).toMatchObject({ state: "open" });
  });

  it("建 PR：旧路径答 201，三种答法各建一条", async () => {
    const draft = { title: "add thing", head: "topic", base: "main" };
    const [fromTable, fromLegacy, fromProcedure] = await ask({
      method: "POST",
      path: `${REPO_PATH}/pulls`,
      body: draft,
      procedure: "forge.createPull",
      input: { ...REPO, ...draft },
    });
    expect(fromTable?.status).toBe(201);
    expect(fromLegacy?.status).toBe(201);
    // procedure 答 200（状态属于旧路径的约定），体相同。
    expect(fromProcedure?.status).toBe(200);
    expect(text(fromLegacy!, true)).toBe(text(fromTable!, true));
    expect(text(fromProcedure!, true)).toBe(text(fromTable!, true));
    const numbers = [fromTable, fromLegacy, fromProcedure].map(
      (answer) => (answer?.body as { number: number }).number,
    );
    expect(new Set(numbers).size).toBe(3);
  });

  it("合并：旧 head 答 conflict；三种答法各合并自己的那条", async () => {
    await same({
      method: "POST",
      path: `${REPO_PATH}/pulls/10/merge`,
      body: { headSha: "b".repeat(40) },
      procedure: "forge.merge",
      input: { ...REPO, number: 10, headSha: "b".repeat(40) },
    }).then((answer) =>
      expect(answer.body).toMatchObject({ code: "conflict" }),
    );
    const merged = [
      await table("POST", `${REPO_PATH}/pulls/10/merge`, {
        method: "rebase",
        headSha: SHA,
      }),
      await legacy("POST", `${REPO_PATH}/pulls/11/merge`, {
        method: "rebase",
        headSha: SHA,
      }),
      await procedure("forge.merge", {
        ...REPO,
        number: 12,
        method: "rebase",
        headSha: SHA,
      }),
    ];
    for (const answer of merged) {
      expect(answer.status).toBe(200);
      expect(text(answer)).toBe(text(merged[0]!));
    }
  });

  it("没有流水线通过后合并的平台答 bad_request", async () => {
    await same({
      method: "POST",
      path: `${REPO_PATH}/pulls/3/auto-merge`,
      body: { headSha: SHA },
      procedure: "forge.autoMerge",
      input: { ...REPO, number: 3, headSha: SHA },
    }).then((answer) => expect(answer.status).toBe(400));
    await same({
      method: "DELETE",
      path: `${REPO_PATH}/pulls/3/auto-merge`,
      procedure: "forge.cancelAutoMerge",
      input: { ...REPO, number: 3 },
    }).then((answer) => expect(answer.status).toBe(400));
  });

  it("合并后删源分支：三种答法各删自己的；分支动过、fork 与没合并的不删", async () => {
    const dropped = [
      await table("DELETE", `${REPO_PATH}/pulls/20/branch?headSha=${SHA}`),
      await legacy("DELETE", `${REPO_PATH}/pulls/21/branch?headSha=${SHA}`),
      await procedure("forge.deleteBranch", {
        ...REPO,
        number: 22,
        headSha: SHA,
      }),
    ];
    for (const answer of dropped) {
      expect(answer).toMatchObject({
        status: 200,
        body: { deleted: true, reasonCode: "" },
      });
    }
    // 已经删了；fork；缺 headSha。
    const gone = await same({
      method: "DELETE",
      path: `${REPO_PATH}/pulls/20/branch?headSha=${SHA}`,
      procedure: "forge.deleteBranch",
      input: { ...REPO, number: 20, headSha: SHA },
    });
    expect(gone.body).toMatchObject({ reasonCode: "ALREADY_DELETED" });
    const fork = await same({
      method: "DELETE",
      path: `${REPO_PATH}/pulls/30/branch?headSha=${SHA}`,
      procedure: "forge.deleteBranch",
      input: { ...REPO, number: 30, headSha: SHA },
    });
    expect(fork.body).toMatchObject({ reasonCode: "FORK_BRANCH" });
    await same({
      method: "DELETE",
      path: `${REPO_PATH}/pulls/20/branch`,
      procedure: "forge.deleteBranch",
      input: { ...REPO, number: 20 },
    }).then((answer) => expect(answer.status).toBe(400));
  });
});

describe("forge：配置", () => {
  const repoKey = `${HOST}/acme/other`;
  const config = { forge: "gitea", apiBase: "", token: FAKE_GITEA.token };

  it("存与删，令牌不进答案；版本不符答 conflict，没有的答 not_found", async () => {
    const put = {
      ...config,
      apiBase: gitea.root,
    };
    const saved = [
      await table("PUT", `/api/forge/configs/${repoKey}`, put),
      await legacy("PUT", `/api/forge/configs/${repoKey}`, put),
    ];
    // 同一条配置存两次：第二次没带版本，答 conflict；不改状态。
    expect(saved[0]?.status).toBe(200);
    expect(saved[1]?.status).toBe(409);
    expect(JSON.stringify(saved)).not.toContain(FAKE_GITEA.token);
    const removal = [
      await table("DELETE", `/api/forge/configs/${repoKey}?expectedRevision=1`),
    ];
    expect(removal[0]).toEqual({ status: 200, body: { removed: true } });
    // 三种答法各存各删，答案逐字节相等。
    const triple = [
      await table("PUT", `/api/forge/configs/${repoKey}`, put),
      undefined,
    ];
    expect(triple[0]?.body).toMatchObject({ repoKey, credential: true });
    await table("DELETE", `/api/forge/configs/${repoKey}?expectedRevision=1`);
    const viaLegacy = await legacy("PUT", `/api/forge/configs/${repoKey}`, put);
    expect(text(viaLegacy)).toBe(text(triple[0]!));
    await legacy("DELETE", `/api/forge/configs/${repoKey}?expectedRevision=1`);
    const viaProcedure = await procedure("forge.putRepoConfig", {
      host: HOST,
      owner: "acme",
      name: "other",
      ...put,
    });
    expect(text(viaProcedure)).toBe(text(triple[0]!));
    expect(JSON.stringify(viaProcedure)).not.toContain(FAKE_GITEA.token);
    // 删：版本不符 409，没有这条 404，坏版本 400。
    await same({
      method: "DELETE",
      path: `/api/forge/configs/${repoKey}?expectedRevision=5`,
      procedure: "forge.removeRepoConfig",
      input: { host: HOST, owner: "acme", name: "other", expectedRevision: 5 },
    }).then((answer) =>
      expect(answer).toMatchObject({ status: 409, body: { code: "conflict" } }),
    );
    await same({
      method: "DELETE",
      path: `/api/forge/configs/${repoKey}?expectedRevision=0`,
      procedure: "forge.removeRepoConfig",
      input: { host: HOST, owner: "acme", name: "other", expectedRevision: 0 },
    }).then((answer) => expect(answer.status).toBe(400));
    expect(
      await procedure("forge.removeRepoConfig", {
        host: HOST,
        owner: "acme",
        name: "other",
        expectedRevision: 1,
      }),
    ).toEqual({ status: 200, body: { removed: true } });
    await same({
      method: "DELETE",
      path: `/api/forge/configs/${repoKey}?expectedRevision=1`,
      procedure: "forge.removeRepoConfig",
      input: { host: HOST, owner: "acme", name: "other", expectedRevision: 1 },
    }).then((answer) => expect(answer.status).toBe(404));
  });

  it("主机级配置：拒绝的码与原话相等，令牌不回显", async () => {
    for (const [forgeKind, apiBase] of [
      ["svn", "https://git.example.test"],
      ["gitea", "http://git.example.test"],
    ] as const) {
      const answer = await same({
        method: "PUT",
        path: "/api/forge/configs/git.example.test",
        body: { forge: forgeKind, apiBase, token: "s3cret-token" },
        procedure: "forge.putHostConfig",
        input: {
          host: "git.example.test",
          forge: forgeKind,
          apiBase,
          token: "s3cret-token",
        },
      });
      expect(answer.status).toBe(400);
      expect(JSON.stringify(answer)).not.toContain("s3cret-token");
    }
    await same({
      method: "DELETE",
      path: "/api/forge/configs/git.example.test?expectedRevision=1",
      procedure: "forge.removeHostConfig",
      input: { host: "git.example.test", expectedRevision: 1 },
    }).then((answer) => expect(answer.status).toBe(404));
  });
});

describe("forge：拒绝", () => {
  it("参数不对：码、状态与原话相等", async () => {
    for (const [method, path, body, name, input] of [
      [
        "GET",
        `${REPO_PATH}/issues/0`,
        undefined,
        "forge.issue",
        { ...REPO, number: 0 },
      ],
      [
        "GET",
        `${REPO_PATH}/issues/abc`,
        undefined,
        "forge.issue",
        { ...REPO, number: "abc" },
      ],
      [
        "GET",
        `${REPO_PATH}/issues?state=merged`,
        undefined,
        "forge.issues",
        { ...REPO, state: "merged" },
      ],
      [
        "GET",
        `${REPO_PATH}/issues?cursor=1`,
        undefined,
        "forge.issues",
        { ...REPO, cursor: "1" },
      ],
      [
        "GET",
        `${REPO_PATH}/issues?limit=500`,
        undefined,
        "forge.issues",
        { ...REPO, limit: "500" },
      ],
      [
        "PATCH",
        `${REPO_PATH}/issues/1`,
        { state: "gone" },
        "forge.setIssueState",
        { ...REPO, number: 1, state: "gone" },
      ],
      [
        "POST",
        `${REPO_PATH}/pulls`,
        { title: "", head: "a", base: "b" },
        "forge.createPull",
        { ...REPO, title: "", head: "a", base: "b" },
      ],
      [
        "POST",
        `${REPO_PATH}/pulls/1/merge`,
        { method: "octopus", headSha: SHA },
        "forge.merge",
        { ...REPO, number: 1, method: "octopus", headSha: SHA },
      ],
    ] as const) {
      const answer = await same({
        method,
        path,
        body,
        procedure: name,
        input,
      });
      expect(answer.body, `${method} ${path}`).toMatchObject({
        code: "bad_request",
      });
    }
  });

  it("远端 403、401、限流各有自己的码；原话不外传", async () => {
    for (const [status, code] of [
      [403, "forge_forbidden"],
      [401, "forge_credential_rejected"],
      [429, "rate_limited"],
    ] as const) {
      const answers = [];
      for (const way of ["table", "legacy", "procedure"] as const) {
        gitea.failNext("GET", /\/issues\/1$/, status);
        answers.push(
          way === "table"
            ? await table("GET", `${REPO_PATH}/issues/1`)
            : way === "legacy"
              ? await legacy("GET", `${REPO_PATH}/issues/1`)
              : await procedure("forge.issue", { ...REPO, number: 1 }),
        );
      }
      for (const answer of answers) {
        expect(answer.body).toMatchObject({ code });
        expect(JSON.stringify(answer.body)).not.toContain("<script>");
        expect(text(answer)).toBe(text(answers[0]!));
      }
    }
  });

  it("形状错（类型不对）：procedure 与旧路径由入参校验先答 bad_request，只比码与状态", async () => {
    const wrong = [
      await table("POST", `${REPO_PATH}/pulls`, {
        title: "x",
        head: "a",
        base: "b",
        draft: "yes",
      }),
      await legacy("POST", `${REPO_PATH}/pulls`, {
        title: "x",
        head: "a",
        base: "b",
        draft: "yes",
      }),
      await procedure("forge.createPull", {
        ...REPO,
        title: "x",
        head: "a",
        base: "b",
        draft: "yes",
      }),
    ];
    for (const answer of wrong) {
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ code: "bad_request" });
    }
    // 令牌类型不对：入参校验的细节只有字段路径与那句话，不带值。
    const badToken = await procedure("forge.putHostConfig", {
      host: "git.example.test",
      forge: "gitea",
      apiBase: "https://git.example.test",
      token: 5,
    });
    expect(badToken.status).toBe(400);
  });
});

describe("契约与路由表", () => {
  it("forge.* 的 meta.scope 与路由表给旧路径的要求一致，旧路径都在路由表里", () => {
    const entries = contractEntries().filter(
      (entry) => entry.path[0] === "forge",
    );
    expect(entries).toHaveLength(20);
    for (const entry of entries) {
      const legacyRoute = entry.meta.legacy!;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = server.router.match(legacyRoute.path);
      expect(found?.entry.path, entry.name).toBe(legacyRoute.path);
      expect(found?.entry.methods, entry.name).toContain(legacyRoute.method);
    }
  });

  it("每条 forge procedure 都有实现；resolve 虽是 POST 只要读权限", () => {
    const names = contractEntries()
      .filter((entry) => entry.path[0] === "forge")
      .map((entry) => entry.name);
    for (const name of names) expect(handle.implemented, name).toContain(name);
    expect(
      server.router.requiredScope("POST", "/api/forge/resolve")?.permission,
    ).toBe("github:read");
  });
});
