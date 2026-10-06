/**
 * 托管平台域（契约 §29）：迁移、按远端地址识别、配置与令牌（只进 SecretStore）、
 * `/api/forge/*` 的形状与拒绝码，以及 GitHub 经同一个客户端与凭据装进接口。
 */

import { afterEach, describe, expect, it } from "vitest";

import { Router, emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import type { SecretBackend } from "../secrets/backend";
import {
  configureToken,
  githubFixture,
  type GithubFixture,
} from "../github/fixture";
import { GithubStore } from "../github/store";
import type { GithubService } from "../github/service";
import {
  FAKE_GITEA,
  type FakeGitea,
  startFakeGitea,
} from "./fake-gitea.fixture";
import { FORGE_ROUTES, installRoutes } from "./routes";
import { ForgeService, configKey, forgeRepo } from "./service";
import { ForgeStore } from "./store";

const SHA = "a".repeat(40);

const closing: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

function memoryBackend(): SecretBackend & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    kind: "file",
    values,
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

interface Harness {
  readonly github: GithubFixture;
  readonly gitea: FakeGitea;
  readonly secrets: ReturnType<typeof memoryBackend>;
  readonly service: ForgeService;
  call(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<{ status: number; body: any }>;
}

async function harness(
  options: { github?: () => GithubService | undefined } = {},
): Promise<Harness> {
  const github = await githubFixture();
  closing.push(() => github.close());
  const gitea = await startFakeGitea();
  closing.push(() => gitea.close());
  const secrets = memoryBackend();
  let ids = 0;
  const service = new ForgeService({
    store: new ForgeStore(github.db.database),
    secrets: () => secrets,
    github: options.github ?? (() => github.service),
    now: () => 1_800_000_000_000,
    newId: () => `id${(ids += 1)}`,
  });
  const router = new Router();
  installRoutes({ router } as unknown as CoreServer, service);
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
  ) => {
    const encoded = Buffer.from(
      body === undefined ? "" : JSON.stringify(body),
      "utf8",
    );
    const request = {
      ...emptyRequest(method, path),
      query: new URLSearchParams(query),
      body: encoded,
      json: <T>() => JSON.parse(encoded.toString("utf8")) as T,
    };
    return (await router.dispatch(method, path, request)) as {
      status: number;
      body: any;
    };
  };
  return { github, gitea, secrets, service, call };
}

/** 把假 Gitea 配成 `127.0.0.1` 这台主机的平台。 */
async function configureHost(h: Harness): Promise<any> {
  const answer = await h.call("PUT", "/api/forge/configs/127.0.0.1", {
    forge: "gitea",
    apiBase: h.gitea.root,
    token: FAKE_GITEA.token,
  });
  expect(answer.status).toBe(200);
  return answer.body;
}

const REPO_PATH = `/api/forge/repos/127.0.0.1/${FAKE_GITEA.owner}/${FAKE_GITEA.repo}`;

describe("迁移", () => {
  it("有 forge_config；github_references 多一列 forge，缺省 github", async () => {
    const h = await harness();
    const database = h.github.db.database;
    const columns = database
      .prepare("SELECT name FROM pragma_table_info('forge_config')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual([
      "repo_key",
      "forge",
      "api_base",
      "credential_ref",
      "account_login",
      "revision",
      "created_at_ms",
      "updated_at_ms",
    ]);
    new GithubStore(database).putReference(
      {
        referenceId: "r".repeat(32),
        workspaceId: "ws-1",
        repository: {
          owner: "octo",
          name: "repo",
          apiBase: "https://api.github.com",
          webHost: "github.com",
        },
        kind: 1,
        number: 7,
        targetKind: 1,
        targetId: "session-1",
        title: "t",
        revision: 0,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      0,
    );
    expect(
      database.prepare("SELECT forge FROM github_references").get(),
    ).toEqual({ forge: "github" });
    expect(() =>
      database
        .prepare(
          "INSERT INTO forge_config VALUES ('x', 'svn', 'https://x', '', '', 1, 1, 1)",
        )
        .run(),
    ).toThrow();
  });
});

describe("识别（§29.1）", () => {
  it("github.com 归 GitHub；凭据只在配过时为真", async () => {
    const h = await harness();
    const before = h.service.detect(forgeRepo("GitHub.com", "octo", "repo"));
    expect(before).toMatchObject({
      forge: "github",
      source: "github",
      apiBase: "https://api.github.com",
      webUrl: "https://github.com/octo/repo",
      credential: false,
      accountLogin: null,
    });
    await configureToken(h.github);
    expect(
      h.service.detect(forgeRepo("www.github.com", "octo", "repo")),
    ).toMatchObject({
      forge: "github",
      credential: true,
      accountLogin: "octocat",
    });
  });

  it("GitHub 凭据配的企业版根：那台主机归 GitHub，github.com 没有令牌", async () => {
    const enterprise = {
      store: {
        config: () => ({
          source: "token_ref",
          apiBase: "https://ghe.corp.example/api/v3",
          accountLogin: "corp-bot",
        }),
      },
    } as unknown as GithubService;
    const h = await harness({ github: () => enterprise });
    expect(
      h.service.detect(forgeRepo("ghe.corp.example", "o", "n")),
    ).toMatchObject({
      forge: "github",
      apiBase: "https://ghe.corp.example/api/v3",
      webUrl: "https://ghe.corp.example/o/n",
      credential: true,
    });
    expect(h.service.detect(forgeRepo("github.com", "o", "n")).credential).toBe(
      false,
    );
  });

  it("别的主机按配置；仓库一行优先于主机一行；没配就不认识", async () => {
    const h = await harness();
    expect(h.service.detect(forgeRepo("127.0.0.1", "acme", "app"))).toEqual({
      repository: { host: "127.0.0.1", owner: "acme", name: "app" },
      forge: null,
      source: null,
      configKey: null,
      apiBase: null,
      webUrl: null,
      credential: false,
      accountLogin: null,
    });
    await configureHost(h);
    expect(
      h.service.detect(forgeRepo("127.0.0.1", "acme", "app")),
    ).toMatchObject({
      forge: "gitea",
      source: "config",
      configKey: "127.0.0.1",
      apiBase: `${h.gitea.root}/api/v1`,
      webUrl: `${h.gitea.root}/acme/app`,
      credential: true,
      accountLogin: FAKE_GITEA.login,
    });
    const own = await h.call("PUT", "/api/forge/configs/127.0.0.1/acme/app", {
      forge: "gitea",
      apiBase: "https://mirror.example.test/",
    });
    expect(own.status).toBe(200);
    expect(
      h.service.detect(forgeRepo("127.0.0.1", "acme", "app")),
    ).toMatchObject({
      configKey: "127.0.0.1/acme/app",
      apiBase: "https://mirror.example.test/api/v1",
      credential: false,
    });
    expect(
      h.service.detect(forgeRepo("127.0.0.1", "acme", "other")).configKey,
    ).toBe("127.0.0.1");
  });

  it("resolve 读 git 远端地址（https / ssh / scp），答复里没有地址里的凭据", async () => {
    const h = await harness();
    await configureHost(h);
    for (const remote of [
      "http://user:secret@127.0.0.1:3000/acme/app.git",
      "ssh://git@127.0.0.1:2222/acme/app.git",
      "git@127.0.0.1:acme/app.git",
    ]) {
      const answer = await h.call("POST", FORGE_ROUTES.resolve, {
        remoteUrl: remote,
      });
      expect(answer.status).toBe(200);
      expect(answer.body.forge).toBe("gitea");
      expect(answer.body.repository).toEqual({
        host: "127.0.0.1",
        owner: "acme",
        name: "app",
      });
      expect(JSON.stringify(answer.body)).not.toContain("secret");
    }
    expect(
      (
        await h.call("POST", FORGE_ROUTES.resolve, {
          remoteUrl: "not a remote",
        })
      ).body.code,
    ).toBe("bad_request");
    expect((await h.call("POST", FORGE_ROUTES.resolve, {})).status).toBe(400);
  });

  it("键与仓库名的校验", () => {
    expect(configKey("Git.Example.COM.")).toBe("git.example.com");
    expect(configKey("git.example.com", "a", "b")).toBe("git.example.com/a/b");
    expect(() => configKey("bad host")).toThrow();
    expect(() => forgeRepo("git.example.com", "..", "b")).toThrow();
  });
});

describe("配置与令牌（§29.3）", () => {
  it("先核验令牌再存；令牌只进 SecretStore，答复与库里都没有它", async () => {
    const h = await harness();
    const saved = await configureHost(h);
    expect(saved).toEqual({
      repoKey: "127.0.0.1",
      forge: "gitea",
      apiBase: `${h.gitea.root}/api/v1`,
      credential: true,
      accountLogin: FAKE_GITEA.login,
      revision: 1,
      createdAtMs: 1_800_000_000_000,
      updatedAtMs: 1_800_000_000_000,
    });
    expect([...h.secrets.values]).toEqual([
      ["armadra-forge-id1", FAKE_GITEA.token],
    ]);
    const row = h.github.db.database
      .prepare("SELECT * FROM forge_config")
      .get();
    expect(JSON.stringify(row)).not.toContain(FAKE_GITEA.token);
    expect(JSON.stringify(saved)).not.toContain(FAKE_GITEA.token);
    expect(h.gitea.requests[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/user",
      authorization: `token ${FAKE_GITEA.token}`,
    });
    const listed = await h.call("GET", FORGE_ROUTES.configs);
    expect(listed.body.configs).toEqual([saved]);
  });

  it("远端不认的令牌：502，不存任何东西", async () => {
    const h = await harness();
    const answer = await h.call("PUT", "/api/forge/configs/127.0.0.1", {
      forge: "gitea",
      apiBase: h.gitea.root,
      token: "wrong-token",
    });
    expect(answer).toMatchObject({
      status: 502,
      body: { code: "forge_credential_rejected" },
    });
    expect(h.secrets.values.size).toBe(0);
    expect(h.service.configs()).toEqual([]);
  });

  it("revision CAS；换 API 根而不给新令牌就丢掉旧令牌；空串删令牌；DELETE 连条目一起删", async () => {
    const h = await harness();
    await configureHost(h);
    const stale = await h.call("PUT", "/api/forge/configs/127.0.0.1", {
      forge: "gitea",
      apiBase: h.gitea.root,
    });
    expect(stale).toMatchObject({ status: 409, body: { code: "conflict" } });

    const kept = await h.call("PUT", "/api/forge/configs/127.0.0.1", {
      forge: "gitea",
      apiBase: `${h.gitea.root}/api/v1`,
      expectedRevision: 1,
    });
    expect(kept.body).toMatchObject({ revision: 2, credential: true });
    expect(h.secrets.values.size).toBe(1);

    const moved = await h.call("PUT", "/api/forge/configs/127.0.0.1", {
      forge: "gitea",
      apiBase: "https://elsewhere.example.test",
      expectedRevision: 2,
    });
    expect(moved.body).toMatchObject({
      revision: 3,
      credential: false,
      accountLogin: null,
    });
    expect(h.secrets.values.size).toBe(0);

    await h.call("PUT", "/api/forge/configs/127.0.0.1", {
      forge: "gitea",
      apiBase: h.gitea.root,
      token: FAKE_GITEA.token,
      expectedRevision: 3,
    });
    expect(h.secrets.values.size).toBe(1);
    const cleared = await h.call("PUT", "/api/forge/configs/127.0.0.1", {
      forge: "gitea",
      apiBase: h.gitea.root,
      token: "",
      expectedRevision: 4,
    });
    expect(cleared.body.credential).toBe(false);
    expect(h.secrets.values.size).toBe(0);

    await h.call("PUT", "/api/forge/configs/127.0.0.1", {
      forge: "gitea",
      apiBase: h.gitea.root,
      token: FAKE_GITEA.token,
      expectedRevision: 5,
    });
    expect(
      (
        await h.call("DELETE", "/api/forge/configs/127.0.0.1", undefined, {
          expectedRevision: "5",
        })
      ).status,
    ).toBe(409);
    expect(
      await h.call("DELETE", "/api/forge/configs/127.0.0.1", undefined, {
        expectedRevision: "6",
      }),
    ).toEqual({ status: 200, body: { removed: true } });
    expect(h.secrets.values.size).toBe(0);
    expect(
      (
        await h.call("DELETE", "/api/forge/configs/127.0.0.1", undefined, {
          expectedRevision: "1",
        })
      ).status,
    ).toBe(404);
  });

  it("拒绝：GitHub 的主机、不认识的平台、明文非回环、坏令牌", async () => {
    const h = await harness();
    const put = (key: string, body: unknown) =>
      h.call("PUT", `/api/forge/configs/${key}`, body);
    for (const [key, body] of [
      ["github.com", { forge: "gitea", apiBase: "https://github.com" }],
      [
        "git.example.test",
        { forge: "svn", apiBase: "https://git.example.test" },
      ],
      [
        "git.example.test",
        { forge: "github", apiBase: "https://git.example.test" },
      ],
      [
        "git.example.test",
        { forge: "gitea", apiBase: "http://git.example.test" },
      ],
      [
        "git.example.test",
        {
          forge: "gitea",
          apiBase: "https://git.example.test",
          token: "has space",
        },
      ],
      [
        "git.example.test",
        { forge: "gitea", apiBase: "https://git.example.test", token: 5 },
      ],
      ["git.example.test", { forge: "gitea" }],
      ["bad_host!", { forge: "gitea", apiBase: "https://git.example.test" }],
    ] as const) {
      expect((await put(key, body)).body.code, JSON.stringify(body)).toBe(
        "bad_request",
      );
    }
    expect(h.gitea.requests).toEqual([]);
  });
});

describe("/api/forge/repos/…（§29.4）", () => {
  it("没配的仓库：识别答 forge=null，读答 409 forge_not_configured", async () => {
    const h = await harness();
    expect((await h.call("GET", REPO_PATH)).body.forge).toBeNull();
    expect(await h.call("GET", `${REPO_PATH}/issues`)).toMatchObject({
      status: 409,
      body: { code: "forge_not_configured" },
    });
    expect(h.gitea.requests).toEqual([]);
  });

  it("Gitea：列表不带正文、详情带；状态；PR 建 / 文件 / 检查 / 合并", async () => {
    const h = await harness();
    await configureHost(h);
    h.gitea.issues.push(
      {
        number: 1,
        title: "first",
        body: "full body",
        state: "open",
        labels: [],
      },
      { number: 2, title: "second", body: "", state: "open", labels: [] },
    );
    const list = await h.call("GET", `${REPO_PATH}/issues`, undefined, {
      limit: "1",
    });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].body).toBe("");
    expect(list.body.nextCursor).toBe("2");
    const next = await h.call("GET", `${REPO_PATH}/issues`, undefined, {
      limit: "1",
      cursor: "2",
    });
    expect(next.body.items[0].number).toBe(2);
    expect((await h.call("GET", `${REPO_PATH}/issues/1`)).body.body).toBe(
      "full body",
    );
    expect(
      (await h.call("PATCH", `${REPO_PATH}/issues/1`, { state: "closed" })).body
        .state,
    ).toBe("closed");

    const created = await h.call("POST", `${REPO_PATH}/pulls`, {
      title: "add thing",
      head: "topic",
      base: "main",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      number: 3,
      state: "open",
      headRef: "topic",
    });
    const pull = h.gitea.pulls[0]!;
    pull.sha = SHA;
    pull.files = [
      { filename: "a.txt", status: "added", additions: 1, deletions: 0 },
    ];
    pull.diff =
      "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hi\n";
    expect((await h.call("GET", `${REPO_PATH}/pulls/3/files`)).body).toEqual({
      files: [
        {
          path: "a.txt",
          previousPath: null,
          status: "added",
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+hi",
        },
      ],
    });
    h.gitea.statuses.set(SHA, [
      { context: "ci", status: "success", target_url: "" },
    ]);
    expect((await h.call("GET", `${REPO_PATH}/pulls/3/checks`)).body).toEqual({
      headSha: SHA,
      rollup: "success",
      checks: [{ name: "ci", state: "success", url: null }],
    });
    expect(
      (
        await h.call("POST", `${REPO_PATH}/pulls/3/merge`, {
          headSha: "b".repeat(40),
        })
      ).body.code,
    ).toBe("conflict");
    expect(
      await h.call("POST", `${REPO_PATH}/pulls/3/merge`, {
        method: "rebase",
        headSha: SHA,
      }),
    ).toEqual({
      status: 200,
      body: { merged: true, sha: "d".repeat(40) },
    });
    // Gitea 按仓库的 allow_* 细分合并方式（读一次仓库），有检查通过后合并。
    h.gitea.repository.allow_rebase = false;
    const before = h.gitea.requests.length;
    expect((await h.call("GET", `${REPO_PATH}/merge-options`)).body).toEqual({
      methods: ["merge", "squash"],
      autoMerge: true,
      mergeTrain: false,
    });
    expect(h.gitea.requests.length).toBe(before + 1);
    // 已合并的 PR：排不上也撤不了，409，不发写。
    expect(
      (
        await h.call("POST", `${REPO_PATH}/pulls/3/auto-merge`, {
          method: "merge",
          headSha: SHA,
        })
      ).status,
    ).toBe(409);
    expect(
      (await h.call("DELETE", `${REPO_PATH}/pulls/3/auto-merge`)).status,
    ).toBe(409);
    expect(
      h.gitea.requests
        .slice(before)
        .filter((request) => request.method !== "GET"),
    ).toEqual([]);
    const pulls = await h.call("GET", `${REPO_PATH}/pulls`, undefined, {
      state: "closed",
    });
    expect(
      pulls.body.items.map((item: any) => [item.number, item.state, item.body]),
    ).toEqual([[3, "merged", ""]]);
    // 令牌只发到配置的那个根。
    for (const request of h.gitea.requests) {
      expect(request.authorization).toBe(`token ${FAKE_GITEA.token}`);
    }
  });

  it("Gitea：合并后删源分支只删评审者看到的那个 head；fork 与没合并的不删", async () => {
    const h = await harness();
    await configureHost(h);
    const base = {
      body: "",
      state: "closed" as const,
      merged: true,
      mergeable: true,
      base: "main",
      sha: SHA,
      files: [],
      diff: "",
    };
    h.gitea.pulls.push(
      { ...base, number: 5, title: "merged", head: "feature/x" },
      { ...base, number: 6, title: "fork", head: "feature/y", fork: true },
      {
        ...base,
        number: 7,
        title: "open",
        head: "feature/z",
        state: "open",
        merged: false,
      },
    );
    h.gitea.branches.set("feature/x", {
      sha: "b".repeat(40),
      protected: false,
    });
    const pull = (await h.call("GET", `${REPO_PATH}/pulls/6`)).body;
    expect(pull.fromFork).toBe(true);
    expect((await h.call("GET", `${REPO_PATH}/pulls/5`)).body.fromFork).toBe(
      false,
    );
    const drop = (number: number) =>
      h.call("DELETE", `${REPO_PATH}/pulls/${number}/branch`, undefined, {
        headSha: SHA,
      });
    // 分支走到了别的提交：上面有这次合并没带走的东西。
    expect((await drop(5)).body).toEqual({
      deleted: false,
      reasonCode: "BRANCH_MOVED",
    });
    h.gitea.branches.set("feature/x", { sha: SHA, protected: true });
    expect((await drop(5)).body.reasonCode).toBe("BRANCH_PROTECTED");
    h.gitea.branches.set("feature/x", { sha: SHA, protected: false });
    expect(await drop(5)).toEqual({
      status: 200,
      body: { deleted: true, reasonCode: "" },
    });
    expect(h.gitea.branches.has("feature/x")).toBe(false);
    expect(
      h.gitea.requests.filter((r) => r.method === "DELETE").map((r) => r.path),
    ).toEqual(["/api/v1/repos/acme/app/branches/feature/x"]);
    expect((await drop(5)).body.reasonCode).toBe("ALREADY_DELETED");
    expect((await drop(6)).body.reasonCode).toBe("FORK_BRANCH");
    expect((await drop(7)).body.reasonCode).toBe("NOT_MERGED");
    expect(
      (
        await h.call("DELETE", `${REPO_PATH}/pulls/5/branch`, undefined, {
          headSha: "abc",
        })
      ).status,
    ).toBe(400);
    expect(h.gitea.requests.filter((r) => r.method === "DELETE")).toHaveLength(
      1,
    );
  });

  it("参数不对 400；远端 403 / 401 / 5xx 写各有自己的码", async () => {
    const h = await harness();
    await configureHost(h);
    h.gitea.issues.push({
      number: 1,
      title: "t",
      body: "",
      state: "open",
      labels: [],
    });
    for (const [method, path, body, query] of [
      ["GET", `${REPO_PATH}/issues/0`, undefined, {}],
      ["GET", `${REPO_PATH}/issues/abc`, undefined, {}],
      ["GET", `${REPO_PATH}/issues`, undefined, { state: "merged" }],
      ["GET", `${REPO_PATH}/issues`, undefined, { cursor: "1" }],
      ["GET", `${REPO_PATH}/issues`, undefined, { limit: "500" }],
      ["PATCH", `${REPO_PATH}/issues/1`, { state: "gone" }, {}],
      ["POST", `${REPO_PATH}/pulls`, { title: "", head: "a", base: "b" }, {}],
      [
        "POST",
        `${REPO_PATH}/pulls`,
        { title: "x", head: "a", base: "b", draft: "yes" },
        {},
      ],
      [
        "POST",
        `${REPO_PATH}/pulls/1/merge`,
        { method: "octopus", headSha: SHA },
        {},
      ],
      ["GET", "/api/forge/repos/127.0.0.1/..%2F/app/issues", undefined, {}],
    ] as const) {
      const answer = await h.call(
        method,
        path,
        body,
        query as Record<string, string>,
      );
      expect(
        answer.body.code,
        `${method} ${path} ${JSON.stringify(query)}`,
      ).toBe("bad_request");
    }
    h.gitea.failNext("GET", /\/issues\/1$/, 403);
    expect((await h.call("GET", `${REPO_PATH}/issues/1`)).body.code).toBe(
      "forge_forbidden",
    );
    h.gitea.failNext("GET", /\/issues\/1$/, 401);
    expect(await h.call("GET", `${REPO_PATH}/issues/1`)).toMatchObject({
      status: 502,
      body: { code: "forge_credential_rejected" },
    });
    h.gitea.failNext("PATCH", /\/issues\/1$/, 500);
    expect(
      await h.call("PATCH", `${REPO_PATH}/issues/1`, { state: "closed" }),
    ).toMatchObject({
      status: 504,
      body: { code: "unknown_outcome" },
    });
    h.gitea.failNext("GET", /\/issues\/1$/, 429);
    expect((await h.call("GET", `${REPO_PATH}/issues/1`)).status).toBe(429);
    expect((await h.call("GET", `${REPO_PATH}/issues/9`)).status).toBe(404);
  });

  it("GitHub：同一个客户端与凭据，形状换成 forge 的；401 照旧记到凭据状态上", async () => {
    const h = await harness();
    await configureToken(h.github);
    const path = "/api/forge/repos/github.com/octo/repo";
    h.github.github.route("GET /repos/octo/repo/issues", {
      body: [
        {
          id: 70,
          number: 7,
          title: "an issue",
          body: "text",
          state: "open",
          user: { login: "octocat", id: 1 },
          labels: [{ name: "bug", color: "f00" }],
          comments: 3,
          html_url: "https://github.com/octo/repo/issues/7",
          created_at: "2026-09-01T00:00:00Z",
          updated_at: "2026-09-02T00:00:00Z",
        },
        {
          id: 80,
          number: 8,
          title: "a pull",
          state: "open",
          pull_request: { url: "x" },
        },
      ],
    });
    const issues = await h.call("GET", `${path}/issues`);
    expect(issues.status).toBe(200);
    expect(issues.body).toEqual({
      items: [
        {
          number: 7,
          title: "an issue",
          body: "",
          state: "open",
          author: "octocat",
          labels: ["bug"],
          commentCount: 3,
          url: "https://github.com/octo/repo/issues/7",
          createdAtMs: Date.parse("2026-09-01T00:00:00Z"),
          updatedAtMs: Date.parse("2026-09-02T00:00:00Z"),
          closedAtMs: null,
        },
      ],
      nextCursor: null,
    });
    const listed = h.github.github.requests.find(
      (r) => r.path === "/repos/octo/repo/issues",
    )!;
    expect(listed.headers.authorization).toBe("Bearer ghp_pasted_token_value");

    h.github.github.route("PUT /repos/octo/repo/pulls/9/merge", (request) => {
      expect(JSON.parse(request.body)).toEqual({
        sha: SHA,
        merge_method: "squash",
      });
      return { body: { merged: true, sha: "e".repeat(40) } };
    });
    expect(
      await h.call("POST", `${path}/pulls/9/merge`, {
        method: "squash",
        headSha: SHA,
      }),
    ).toEqual({ status: 200, body: { merged: true, sha: "e".repeat(40) } });

    h.github.github.route("GET /repos/octo/repo/issues/7", {
      status: 401,
      body: {},
    });
    expect((await h.call("GET", `${path}/issues/7`)).body.code).toBe(
      "forge_credential_rejected",
    );
    expect((await h.github.credentials.status()).reasonCode).toBe(
      "TOKEN_REJECTED",
    );
  });

  it("GitHub 没配凭据：409，不发匿名请求", async () => {
    const h = await harness();
    expect(
      (await h.call("GET", "/api/forge/repos/github.com/octo/repo/pulls")).body
        .code,
    ).toBe("forge_not_configured");
    expect(h.github.github.requests).toEqual([]);
  });
});

describe("路由门", () => {
  it("读 github:read、写 github:write；resolve 虽是 POST 也只是读", () => {
    const router = new Router();
    installRoutes({ router } as unknown as CoreServer, {} as ForgeService);
    expect(router.requiredScope("POST", FORGE_ROUTES.resolve)?.permission).toBe(
      "github:read",
    );
    expect(router.requiredScope("GET", REPO_PATH)?.permission).toBe(
      "github:read",
    );
    expect(
      router.requiredScope("POST", `${REPO_PATH}/pulls/1/merge`)?.permission,
    ).toBe("github:write");
    expect(
      router.requiredScope("PUT", "/api/forge/configs/git.example.test")
        ?.permission,
    ).toBe("github:write");
    for (const path of Object.values(FORGE_ROUTES)) {
      const methods = ["GET", "PUT", "DELETE", "PATCH", "POST"].filter(
        (method) => router.claimed(method, path),
      );
      expect(methods.length, path).toBeGreaterThan(0);
    }
  });
});
