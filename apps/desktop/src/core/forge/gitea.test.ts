/**
 * Gitea / Forgejo 实现对进程内假 Gitea（`fake-gitea.fixture.ts`）：认证头、列表与
 * 翻页、issue 状态、PR 建 / 读 / 差异 / 检查 / 合并，以及传输层的规矩（只发到配置
 * 的根、写不重试、远端原话不外传）。真 Gitea 那条在 `gitea.devstack.integration.test.ts`。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FAKE_GITEA,
  type FakeGitea,
  startFakeGitea,
} from "./fake-gitea.fixture";
import { GiteaForge, giteaApiBase, giteaWebRoot, splitDiff } from "./gitea";
import { ForgeTransport, nextPage, normalizeBase } from "./transport";
import { ForgeError } from "./types";

const REPO = {
  host: "127.0.0.1",
  owner: FAKE_GITEA.owner,
  name: FAKE_GITEA.repo,
};
const SHA = "a".repeat(40);

let fake: FakeGitea;
let forge: GiteaForge;

beforeEach(async () => {
  fake = await startFakeGitea();
  forge = new GiteaForge({
    apiBase: fake.apiBase,
    token: async () => FAKE_GITEA.token,
  });
});
afterEach(async () => {
  await fake.close();
});

async function rejection(work: Promise<unknown>): Promise<ForgeError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeError);
    return error as ForgeError;
  }
  throw new Error("expected a rejection");
}

describe("地址", () => {
  it("站点根或 API 根都行，统一成 /api/v1；明文 HTTP 只收回环", () => {
    expect(giteaApiBase("https://git.example.com/")).toBe(
      "https://git.example.com/api/v1",
    );
    expect(giteaApiBase("https://git.example.com/sub/api/v1")).toBe(
      "https://git.example.com/sub/api/v1",
    );
    expect(giteaApiBase("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000/api/v1",
    );
    expect(giteaApiBase("http://localhost:3000/")).toBe(
      "http://localhost:3000/api/v1",
    );
    expect(giteaApiBase("http://git.example.com")).toBeUndefined();
    expect(giteaApiBase("https://user:pw@git.example.com")).toBeUndefined();
    expect(giteaApiBase("https://git.example.com/?x=1")).toBeUndefined();
    expect(giteaApiBase("ftp://git.example.com")).toBeUndefined();
    expect(giteaApiBase("")).toBeUndefined();
    expect(giteaWebRoot("https://git.example.com/api/v1")).toBe(
      "https://git.example.com",
    );
    expect(normalizeBase("https://GIT.example.com:8443/x/")).toBe(
      "https://git.example.com:8443/x",
    );
  });

  it("Link 头只取页码", () => {
    expect(
      nextPage(
        '<https://x.test/a?page=3&limit=2>; rel="next", <https://x.test/a?page=9>; rel="last"',
      ),
    ).toBe(3);
    expect(nextPage('<https://x.test/a?page=1>; rel="prev"')).toBe(0);
    expect(nextPage("")).toBe(0);
  });
});

describe("issues", () => {
  beforeEach(() => {
    fake.issues.push(
      { number: 1, title: "first", body: "b1", state: "open", labels: ["bug"] },
      { number: 2, title: "second", body: "b2", state: "closed", labels: [] },
      {
        number: 3,
        title: "a pull",
        body: "",
        state: "open",
        labels: [],
        pull: true,
      },
      { number: 4, title: "fourth", body: "b4", state: "open", labels: [] },
    );
  });

  it("列表带 token 认证头、只要 issue、按 Link 翻页", async () => {
    const first = await forge.listIssues(REPO, {
      state: "open",
      page: 1,
      limit: 1,
    });
    expect(first.items.map((issue) => issue.number)).toEqual([1]);
    expect(first.nextCursor).toBe("2");
    expect(first.items[0]).toMatchObject({
      title: "first",
      state: "open",
      author: "alice",
      labels: ["bug"],
      commentCount: 2,
      closedAtMs: null,
      url: `${fake.root}/acme/app/issues/1`,
    });
    const second = await forge.listIssues(REPO, {
      state: "open",
      page: 2,
      limit: 1,
    });
    expect(second.items.map((issue) => issue.number)).toEqual([4]);
    expect(second.nextCursor).toBeNull();
    const request = fake.requests[0]!;
    expect(request.authorization).toBe(`token ${FAKE_GITEA.token}`);
    expect(request.path).toContain("type=issues");
    expect(request.path.startsWith("/api/v1/repos/acme/app/issues")).toBe(true);
  });

  it("详情；PR 的编号不当 issue；关掉再打开", async () => {
    expect((await forge.getIssue(REPO, 2)).state).toBe("closed");
    expect((await forge.getIssue(REPO, 2)).closedAtMs).toBeGreaterThan(0);
    expect((await rejection(forge.getIssue(REPO, 3))).kind).toBe("notFound");
    expect((await rejection(forge.setIssueState(REPO, 3, "closed"))).kind).toBe(
      "notFound",
    );
    const closed = await forge.setIssueState(REPO, 1, "closed");
    expect(closed.state).toBe("closed");
    expect(fake.issues[0]!.state).toBe("closed");
    const patch = fake.requests.find((request) => request.method === "PATCH")!;
    expect(patch.body).toEqual({ state: "closed" });
    expect((await forge.setIssueState(REPO, 1, "open")).state).toBe("open");
  });

  it("远端拒绝按种类翻译，原话不外传", async () => {
    fake.failNext("GET", /\/issues\/1$/, 403);
    const forbidden = await rejection(forge.getIssue(REPO, 1));
    expect(forbidden.kind).toBe("remoteForbidden");
    expect(forbidden.message).not.toContain("script");
    expect((await rejection(forge.getIssue(REPO, 99))).kind).toBe("notFound");
    const wrong = new GiteaForge({
      apiBase: fake.apiBase,
      token: async () => "nope",
    });
    expect((await rejection(wrong.getIssue(REPO, 1))).kind).toBe(
      "credentialRejected",
    );
    const empty = new GiteaForge({
      apiBase: fake.apiBase,
      token: async () => "",
    });
    expect((await rejection(empty.getIssue(REPO, 1))).kind).toBe(
      "notConfigured",
    );
    expect((await rejection(forge.getIssue(REPO, 0))).kind).toBe("invalid");
    expect(
      (await rejection(forge.getIssue({ ...REPO, owner: "../etc" }, 1))).kind,
    ).toBe("invalid");
  });

  it("读在 5xx 上重试一次；写不重试、报结果未知", async () => {
    fake.failNext("GET", /\/issues\/1$/, 502);
    expect((await forge.getIssue(REPO, 1)).number).toBe(1);
    const before = fake.requests.length;
    fake.failNext("PATCH", /\/issues\/1$/, 502);
    expect((await rejection(forge.setIssueState(REPO, 1, "closed"))).kind).toBe(
      "unknownOutcome",
    );
    expect(
      fake.requests.filter((r, i) => i >= before && r.method === "PATCH"),
    ).toHaveLength(1);
  });
});

describe("pull requests", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " same",
    "diff --git a/img.png b/img.png",
    "new file mode 100644",
    "Binary files /dev/null and b/img.png differ",
    "diff --git a/old name.txt b/new name.txt",
    "similarity index 90%",
    "rename from old name.txt",
    "rename to new name.txt",
    "--- a/old name.txt",
    "+++ b/new name.txt",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "",
  ].join("\n");

  beforeEach(() => {
    fake.pulls.push({
      number: 5,
      title: "feature",
      body: "please",
      state: "open",
      merged: false,
      mergeable: true,
      head: "feature",
      base: "main",
      sha: SHA,
      files: [
        { filename: "src/a.ts", status: "changed", additions: 1, deletions: 1 },
        { filename: "img.png", status: "added", additions: 0, deletions: 0 },
        {
          filename: "new name.txt",
          previous: "old name.txt",
          status: "renamed",
          additions: 1,
          deletions: 1,
        },
      ],
      diff,
    });
  });

  it("列表与详情：分支、head、合并性", async () => {
    const page = await forge.listPulls(REPO, {
      state: "all",
      page: 1,
      limit: 50,
    });
    expect(page.items).toHaveLength(1);
    expect(await forge.getPull(REPO, 5)).toMatchObject({
      number: 5,
      state: "open",
      draft: false,
      author: "bob",
      baseRef: "main",
      headRef: "feature",
      headSha: SHA,
      mergeable: "mergeable",
      mergedAtMs: null,
    });
  });

  it("建 PR：草稿加 WIP 前缀；分支名不合格本地就拒；远端没有分支是 404", async () => {
    const created = await forge.createPull(REPO, {
      title: "next",
      body: "",
      head: "topic",
      base: "main",
      draft: true,
    });
    expect(created.title).toBe("WIP: next");
    expect(created.draft).toBe(true);
    expect(
      (
        await rejection(
          forge.createPull(REPO, {
            title: "x",
            body: "",
            head: "../x",
            base: "main",
            draft: false,
          }),
        )
      ).kind,
    ).toBe("invalid");
    expect(
      (
        await rejection(
          forge.createPull(REPO, {
            title: "x",
            body: "",
            head: "missing",
            base: "main",
            draft: false,
          }),
        )
      ).kind,
    ).toBe("notFound");
  });

  it("文件差异：补丁从 .diff 按文件切出来，二进制没有补丁", async () => {
    const files = await forge.pullFiles(REPO, 5);
    expect(files).toEqual([
      {
        path: "src/a.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,2 +1,2 @@\n-old\n+new\n same",
      },
      {
        path: "img.png",
        previousPath: null,
        status: "added",
        additions: 0,
        deletions: 0,
        patch: null,
      },
      {
        path: "new name.txt",
        previousPath: "old name.txt",
        status: "renamed",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-x\n+y",
      },
    ]);
    expect(splitDiff("").size).toBe(0);
  });

  it("检查用 commit statuses：同一个 context 只留最新的，汇总按最坏", async () => {
    expect(await forge.checks(REPO, 5)).toEqual({
      headSha: SHA,
      rollup: "none",
      checks: [],
    });
    fake.statuses.set(SHA, [
      {
        context: "ci/build",
        status: "failure",
        target_url: "https://ci.example.test/1",
      },
      {
        context: "ci/build",
        status: "success",
        target_url: "https://ci.example.test/0",
      },
      {
        context: "ci/lint",
        status: "pending",
        target_url: "javascript:alert(1)",
      },
      { context: "ci/docs", status: "warning", target_url: "" },
    ]);
    expect(await forge.checks(REPO, 5)).toEqual({
      headSha: SHA,
      rollup: "failure",
      checks: [
        {
          name: "ci/build",
          state: "failure",
          url: "https://ci.example.test/1",
        },
        { name: "ci/lint", state: "pending", url: null },
        { name: "ci/docs", state: "neutral", url: null },
      ],
    });
  });

  it("合并：先核 head；不可合是冲突；成功后读回合并提交", async () => {
    expect(
      (
        await rejection(
          forge.merge(REPO, 5, { method: "merge", headSha: "b".repeat(40) }),
        )
      ).reason,
    ).toBe("HEAD_CHANGED");
    expect(
      (
        await rejection(
          forge.merge(REPO, 5, { method: "merge", headSha: "abc" }),
        )
      ).kind,
    ).toBe("invalid");
    fake.pulls[0]!.mergeable = false;
    expect(
      (
        await rejection(
          forge.merge(REPO, 5, { method: "squash", headSha: SHA }),
        )
      ).kind,
    ).toBe("conflict");
    fake.pulls[0]!.mergeable = true;
    const merged = await forge.merge(REPO, 5, {
      method: "squash",
      headSha: SHA,
    });
    expect(merged).toEqual({ merged: true, sha: "d".repeat(40) });
    const post = fake.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/merge"),
    );
    expect(post.at(-1)!.body).toEqual({ Do: "squash", head_commit_id: SHA });
    expect((await forge.getPull(REPO, 5)).state).toBe("merged");
    expect(
      (await rejection(forge.merge(REPO, 5, { method: "merge", headSha: SHA })))
        .reason,
    ).toBe("ALREADY_MERGED");
  });
});

describe("传输", () => {
  it("路径不能改写 authority；重定向当错误", async () => {
    const transport = new ForgeTransport({
      base: fake.apiBase,
      token: async () => FAKE_GITEA.token,
      authorize: (token) => ({ authorization: `token ${token}` }),
    });
    for (const path of ["//evil.test/x", "/a?b", "relative", "/a\\b", "/a b"]) {
      await expect(transport.get(path)).rejects.toMatchObject({
        kind: "invalid",
      });
    }
    const redirecting = new ForgeTransport({
      base: "https://forge.example.test/api/v1",
      token: async () => "t",
      authorize: (token) => ({ authorization: `token ${token}` }),
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/" },
        }),
    });
    await expect(redirecting.get("/user")).rejects.toMatchObject({
      kind: "unavailable",
      reason: "REDIRECT_REFUSED",
    });
    expect(
      () =>
        new ForgeTransport({
          base: "http://forge.example.test",
          token: async () => "t",
          authorize: () => ({}),
        }),
    ).toThrow(ForgeError);
  });

  it("viewer 读出令牌属于谁", async () => {
    expect(await forge.viewer()).toBe(FAKE_GITEA.login);
  });
});
