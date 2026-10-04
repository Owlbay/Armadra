/**
 * GitLab 经 `/api/forge/*`（契约 §29.6）：配置时用 `PRIVATE-TOKEN` 核验、API 根
 * 统一成 `/api/v4`、识别答复的网页地址、读写走 GitLab 实现、`forge_scope` 拒绝码；
 * 以及外部连接带 `forge`（Gitea / GitLab 的仓库由这一域核对，API 根不取自请求）。
 */

import { afterEach, describe, expect, it } from "vitest";

import { Router, emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import type { SecretBackend } from "../secrets/backend";
import { create } from "../contract/message";
import {
  configureToken,
  githubFixture,
  type GithubFixture,
} from "../github/fixture";
import {
  linkReference,
  listReferences,
  referencesFor,
} from "../github/references";
import {
  GithubExternalReferenceSchema,
  GithubRepositoryRefSchema,
  LinkGithubReferenceRequestSchema,
  ListGithubReferencesRequestSchema,
} from "../github/schema";
import {
  GithubReferenceKind,
  GithubReferenceTargetKind,
} from "../github/types";
import { GITLAB_FIXTURE, type Replay, replay } from "./gitlab-replay.fixture";
import { installRoutes } from "./routes";
import { ForgeService } from "./service";
import { ForgeStore } from "./store";

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
  readonly tape: Replay;
  readonly secrets: ReturnType<typeof memoryBackend>;
  readonly service: ForgeService;
  call(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<{ status: number; body: any }>;
}

async function harness(pick: string[] = []): Promise<Harness> {
  const github = await githubFixture();
  closing.push(() => github.close());
  const tape = replay(
    [
      "user",
      "issues",
      "merge-requests",
      "diffs",
      "statuses",
      "merge",
      "refusals",
      "subgroups",
      "merge-methods",
      "auto-merge",
      "cleanup",
    ],
    pick,
  );
  const secrets = memoryBackend();
  const service = new ForgeService({
    store: new ForgeStore(github.db.database),
    secrets: () => secrets,
    github: () => github.service,
    fetch: tape.fetch,
    now: () => 1_800_000_000_000,
    newId: () => "0123456789abcdef",
  });
  github.service.externalRepository = (forge, ref) =>
    service.referenceRepository(forge, ref);
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
  return { github, tape, secrets, service, call };
}

const HOST = GITLAB_FIXTURE.repo.host;
const REPO_PATH = `/api/forge/repos/${HOST}/acme/app`;

async function configure(h: Harness) {
  const answer = await h.call("PUT", `/api/forge/configs/${HOST}`, {
    forge: "gitlab",
    apiBase: "https://gitlab.example.test",
    token: GITLAB_FIXTURE.token,
  });
  expect(answer.status).toBe(200);
  return answer.body;
}

describe("配置与识别", () => {
  it("核验走 PRIVATE-TOKEN 的 GET /user；根存成 /api/v4；令牌只进 SecretStore", async () => {
    const h = await harness();
    const saved = await configure(h);
    expect(saved).toMatchObject({
      repoKey: HOST,
      forge: "gitlab",
      apiBase: GITLAB_FIXTURE.apiBase,
      credential: true,
      accountLogin: "bot",
    });
    expect(JSON.stringify(saved)).not.toContain(GITLAB_FIXTURE.token);
    expect(h.tape.requests).toHaveLength(1);
    expect(h.tape.requests[0]).toMatchObject({
      method: "GET",
      path: "/user",
      token: GITLAB_FIXTURE.token,
    });
    expect([...h.secrets.values.entries()]).toEqual([
      ["armadra-forge-0123456789abcdef", GITLAB_FIXTURE.token],
    ]);

    const detection = (await h.call("GET", REPO_PATH)).body;
    expect(detection).toMatchObject({
      forge: "gitlab",
      source: "config",
      apiBase: GITLAB_FIXTURE.apiBase,
      webUrl: "https://gitlab.example.test/acme/app",
      credential: true,
      accountLogin: "bot",
    });
    const resolved = await h.call("POST", "/api/forge/resolve", {
      remoteUrl: "git@gitlab.example.test:acme/app.git",
    });
    expect(resolved.body.forge).toBe("gitlab");
  });

  it("从 Gitea 改成 GitLab 而不给新令牌：根变了，旧令牌丢掉", async () => {
    const h = await harness();
    const saved = await configure(h);
    const changed = await h.call("PUT", `/api/forge/configs/${HOST}`, {
      forge: "gitea",
      apiBase: "https://gitlab.example.test",
      expectedRevision: saved.revision,
    });
    expect(changed.body).toMatchObject({
      forge: "gitea",
      apiBase: "https://gitlab.example.test/api/v1",
      credential: false,
    });
    expect(h.secrets.values.size).toBe(0);
  });

  it("远端不认令牌：502，不存", async () => {
    const h = await harness(["unauthorized"]);
    const answer = await h.call("PUT", `/api/forge/configs/${HOST}`, {
      forge: "gitlab",
      apiBase: "https://gitlab.example.test",
      token: "glpat-wrong",
    });
    expect(answer).toMatchObject({
      status: 502,
      body: { code: "forge_credential_rejected" },
    });
    expect(h.secrets.values.size).toBe(0);
    expect((await h.call("GET", "/api/forge/configs")).body.configs).toEqual(
      [],
    );
  });
});

describe("多级子组", () => {
  const NESTED = "git@gitlab.example.test:platform/web/app.git";

  it("主机配成 GitLab：远端整条路径除最后一段都是 owner，项目整条编码，网页地址带子组", async () => {
    const h = await harness();
    await configure(h);
    for (const remoteUrl of [
      NESTED,
      "https://gitlab.example.test/platform/web/app.git",
      "ssh://git@gitlab.example.test:2222/platform/web/app",
    ]) {
      const resolved = await h.call("POST", "/api/forge/resolve", {
        remoteUrl,
      });
      expect(resolved.body).toMatchObject({
        repository: { host: HOST, owner: "platform/web", name: "app" },
        forge: "gitlab",
        webUrl: "https://gitlab.example.test/platform/web/app",
        credential: true,
      });
    }
    const base = `/api/forge/repos/${HOST}/${encodeURIComponent("platform/web")}/app`;
    expect((await h.call("GET", base)).body.repository.owner).toBe(
      "platform/web",
    );
    const pulls = await h.call("GET", `${base}/pulls`);
    expect(pulls.status).toBe(200);
    expect(pulls.body.items.map((pull: any) => pull.number)).toEqual([31]);
    expect(h.tape.requests.at(-1)?.path).toBe(
      "/projects/platform%2Fweb%2Fapp/merge_requests",
    );
    const pull = await h.call("GET", `${base}/pulls/31`);
    expect(pull.body.url).toBe(
      "https://gitlab.example.test/platform/web/app/-/merge_requests/31",
    );
  });

  it("GitLab 装在子路径下：http(s) 远端先去掉站点前缀；仓库一行按最长的 owner 先认", async () => {
    const h = await harness();
    // 不给令牌就不核验：这里只看识别。
    const saved = await h.call("PUT", `/api/forge/configs/${HOST}`, {
      forge: "gitlab",
      apiBase: "https://gitlab.example.test/code",
    });
    expect(saved.status).toBe(200);
    const viaWeb = await h.call("POST", "/api/forge/resolve", {
      remoteUrl: "https://gitlab.example.test/code/platform/web/app.git",
    });
    expect(viaWeb.body).toMatchObject({
      repository: { owner: "platform/web", name: "app" },
      webUrl: "https://gitlab.example.test/code/platform/web/app",
    });
    // ssh 远端没有站点前缀。
    const viaSsh = await h.call("POST", "/api/forge/resolve", {
      remoteUrl: NESTED,
    });
    expect(viaSsh.body.repository.owner).toBe("platform/web");

    const repoKey = `${HOST}/${encodeURIComponent("platform/web")}/app`;
    const row = await h.call("PUT", `/api/forge/configs/${repoKey}`, {
      forge: "gitlab",
      apiBase: "https://gitlab.example.test",
    });
    expect(row.body.repoKey).toBe(`${HOST}/platform/web/app`);
    const deep = await h.call("POST", "/api/forge/resolve", {
      remoteUrl: "git@gitlab.example.test:platform/web/app.git",
    });
    expect(deep.body).toMatchObject({
      configKey: `${HOST}/platform/web/app`,
      repository: { owner: "platform/web", name: "app" },
      webUrl: "https://gitlab.example.test/platform/web/app",
    });
  });

  it("Gitea 与 GitHub 不认多级 owner：配置拒绝、识别按最后两段、直接寻址认不出", async () => {
    const h = await harness();
    const refused = await h.call(
      "PUT",
      `/api/forge/configs/${HOST}/${encodeURIComponent("platform/web")}/app`,
      { forge: "gitea", apiBase: "https://gitlab.example.test" },
    );
    expect(refused).toMatchObject({
      status: 400,
      body: { code: "bad_request" },
    });
    await h.call("PUT", `/api/forge/configs/${HOST}`, {
      forge: "gitea",
      apiBase: "https://gitlab.example.test",
    });
    const flat = await h.call("POST", "/api/forge/resolve", {
      remoteUrl: NESTED,
    });
    expect(flat.body).toMatchObject({
      repository: { owner: "web", name: "app" },
      forge: "gitea",
    });
    const nested = await h.call(
      "GET",
      `/api/forge/repos/${HOST}/${encodeURIComponent("platform/web")}/app`,
    );
    expect(nested.body).toMatchObject({ forge: null, credential: false });
    const github = await h.call(
      "GET",
      `/api/forge/repos/github.com/${encodeURIComponent("a/b")}/c`,
    );
    expect(github.body.forge).toBeNull();
    const deep = await h.call(
      "GET",
      `/api/forge/repos/${HOST}/${encodeURIComponent("a/../b")}/c`,
    );
    expect(deep.status).toBe(400);
  });
});

describe("读写", () => {
  it("issue / MR 列表与详情、文件、检查、合并都走 GitLab 的形状", async () => {
    const h = await harness();
    await configure(h);
    const issues = await h.call("GET", `${REPO_PATH}/issues`, undefined, {
      limit: "2",
    });
    expect(h.tape.requests.at(-1)).toMatchObject({
      path: "/projects/acme%2Fapp/issues",
      query: { state: "opened", per_page: "2" },
      token: GITLAB_FIXTURE.token,
    });
    expect(issues.body.nextCursor).toBe("2");
    expect(issues.body.items[0]).toMatchObject({ number: 7, body: "" });
    const next = await h.call("GET", `${REPO_PATH}/issues`, undefined, {
      limit: "2",
      cursor: "2",
    });
    expect(next.body.items.map((issue: any) => issue.number)).toEqual([2]);
    const closed = await h.call("PATCH", `${REPO_PATH}/issues/7`, {
      state: "closed",
    });
    expect(closed.body.state).toBe("closed");

    const pulls = await h.call("GET", `${REPO_PATH}/pulls`);
    expect(pulls.status).toBe(200);
    expect(pulls.body.items.map((pull: any) => pull.number)).toEqual([12, 11]);
    expect(pulls.body.items[0].body).toBe("");

    const pull = await h.call("GET", `${REPO_PATH}/pulls/12`);
    expect(pull.body).toMatchObject({
      number: 12,
      body: "把登录页拆成两步",
      headSha: GITLAB_FIXTURE.sha,
    });
    const files = await h.call("GET", `${REPO_PATH}/pulls/12/files`);
    expect(files.body.files).toHaveLength(5);
    const checks = await h.call("GET", `${REPO_PATH}/pulls/12/checks`);
    expect(checks.body.rollup).toBe("pending");
    const merged = await h.call("POST", `${REPO_PATH}/pulls/12/merge`, {
      method: "merge",
      headSha: GITLAB_FIXTURE.sha,
    });
    expect(merged.body).toEqual({
      merged: true,
      sha: GITLAB_FIXTURE.mergedSha,
    });
    const rebase = await h.call("POST", `${REPO_PATH}/pulls/12/merge`, {
      method: "rebase",
      headSha: GITLAB_FIXTURE.sha,
    });
    expect(rebase).toMatchObject({
      status: 400,
      body: { code: "bad_request" },
    });
  });

  it("merge-options 按项目设置；变基先发出时答 409 rebase_started", async () => {
    const plain = await harness();
    await configure(plain);
    expect(
      (await plain.call("GET", `${REPO_PATH}/merge-options`)).body,
    ).toEqual({
      methods: ["merge", "squash"],
      autoMerge: true,
      mergeTrain: false,
    });

    const h = await harness(["project-rebase-merge", "need-rebase"]);
    await configure(h);
    expect((await h.call("GET", `${REPO_PATH}/merge-options`)).body).toEqual({
      methods: ["merge", "rebase", "squash"],
      autoMerge: true,
      mergeTrain: false,
    });
    const started = await h.call("POST", `${REPO_PATH}/pulls/12/merge`, {
      method: "rebase",
      headSha: GITLAB_FIXTURE.sha,
    });
    expect(started).toMatchObject({
      status: 409,
      body: { code: "rebase_started" },
    });
    expect(
      h.tape.requests.filter((r) => r.method === "PUT").map((r) => r.path),
    ).toEqual(["/projects/acme%2Fapp/merge_requests/12/rebase"]);
  });

  it("流水线通过后合并：POST 排上、DELETE 撤销", async () => {
    const h = await harness(["merge-scheduled"]);
    await configure(h);
    const queued = await h.call("POST", `${REPO_PATH}/pulls/12/auto-merge`, {
      method: "merge",
      headSha: GITLAB_FIXTURE.sha,
    });
    expect(queued).toEqual({
      status: 200,
      body: { merged: false, sha: null, train: false },
    });
    const bad = await h.call("POST", `${REPO_PATH}/pulls/12/auto-merge`, {
      method: "fast-forward",
      headSha: GITLAB_FIXTURE.sha,
    });
    expect(bad.status).toBe(400);

    const set = await harness(["auto-merge-set"]);
    await configure(set);
    expect(
      await set.call("DELETE", `${REPO_PATH}/pulls/12/auto-merge`),
    ).toEqual({ status: 200, body: { cancelled: true } });
    const idle = await h.call("DELETE", `${REPO_PATH}/pulls/12/auto-merge`);
    expect(idle).toMatchObject({ status: 409, body: { code: "conflict" } });
  });

  it("合并后删源分支：DELETE pulls/{n}/branch?headSha=", async () => {
    const h = await harness(["merged-mr"]);
    await configure(h);
    expect(
      await h.call("DELETE", `${REPO_PATH}/pulls/12/branch`, undefined, {
        headSha: GITLAB_FIXTURE.sha,
      }),
    ).toEqual({ status: 200, body: { deleted: true, reasonCode: "" } });
    expect(
      (await h.call("DELETE", `${REPO_PATH}/pulls/12/branch`)).status,
    ).toBe(400);
  });

  it("细粒度令牌缺范围：403 forge_scope，远端原话不外传", async () => {
    const h = await harness(["granular"]);
    await configure(h);
    const answer = await h.call("GET", `${REPO_PATH}/issues`, undefined, {
      limit: "2",
    });
    expect(answer).toMatchObject({
      status: 403,
      body: { code: "forge_scope" },
    });
    expect(JSON.stringify(answer.body)).not.toContain("read_issue");
  });

  it("别的 403 仍是 forge_forbidden", async () => {
    const h = await harness(["forbidden"]);
    await configure(h);
    const answer = await h.call("GET", `${REPO_PATH}/pulls`);
    expect(answer.body.code).toBe("forge_forbidden");
  });
});

describe("外部连接带 forge", () => {
  const link = (h: Harness, forge: string, apiBase = "") =>
    linkReference(
      h.github.service,
      h.github.caller,
      create(LinkGithubReferenceRequestSchema, {
        reference: create(GithubExternalReferenceSchema, {
          forge,
          repository: create(GithubRepositoryRefSchema, {
            owner: "acme",
            name: "app",
            host: HOST,
            apiBase,
          }),
          kind: GithubReferenceKind.PULL_REQUEST,
          number: 12n,
          targetKind: GithubReferenceTargetKind.BRANCH,
          targetId: "feature/login",
          title: "登录改版",
        }),
      }),
    );

  it("GitLab 的 MR：API 根取自配置，列表里带 forge，GitHub 详情不收它", async () => {
    const h = await harness();
    await configure(h);
    const linked = link(h, "gitlab");
    expect(linked.forge).toBe("gitlab");
    expect(linked.repository).toMatchObject({
      apiBase: GITLAB_FIXTURE.apiBase,
      host: HOST,
    });
    const listed = listReferences(
      h.github.service,
      h.github.caller,
      create(ListGithubReferencesRequestSchema, {}),
    );
    expect(listed.references.map((reference) => reference.forge)).toEqual([
      "gitlab",
    ]);
    expect(
      h.github.db.database.prepare("SELECT forge FROM github_references").get(),
    ).toEqual({ forge: "gitlab" });
    expect(
      referencesFor(
        h.github.service,
        "ws-1",
        linked.repository!,
        GithubReferenceKind.PULL_REQUEST,
        12n,
      ),
    ).toEqual([]);
  });

  it("平台对不上、指名别的 API 根、没配的主机、未知平台：一律拒绝", async () => {
    const h = await harness();
    expect(() => link(h, "gitlab")).toThrow();
    await configure(h);
    expect(() => link(h, "gitea")).toThrow();
    expect(() =>
      link(h, "gitlab", "https://evil.example.test/api/v4"),
    ).toThrow();
    expect(() => link(h, "svn")).toThrow();
  });

  it("GitHub 的连接照旧：forge 空串按 github，答复里是 github", async () => {
    const h = await harness();
    await configureToken(h.github);
    const linked = linkReference(
      h.github.service,
      h.github.caller,
      create(LinkGithubReferenceRequestSchema, {
        reference: create(GithubExternalReferenceSchema, {
          repository: create(GithubRepositoryRefSchema, {
            owner: "octo",
            name: "repo",
          }),
          kind: GithubReferenceKind.ISSUE,
          number: 7n,
          targetKind: GithubReferenceTargetKind.SESSION,
          targetId: "session-1",
          title: "t",
        }),
      }),
    );
    expect(linked.forge).toBe("github");
  });
});
