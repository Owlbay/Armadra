/**
 * GitLab 实现对回放夹具（`fixtures/gitlab/*.json`，`gitlab-replay.fixture.ts`）：
 * `PRIVATE-TOKEN` 认证、merge request ↔ pull request 的映射、翻页、差异与检查、
 * 合并先核 head，以及拒绝的翻译（`insufficient_granular_scope` / `insufficient_scope`
 * → `scopeMissing`，远端原话不外传）。经路由的那一段在 `forge.test.ts`。
 */

import { describe, expect, it } from "vitest";

import {
  GITLAB_FIXTURE,
  type CassetteName,
  CASSETTES,
  cassette,
  replay,
} from "./gitlab-replay.fixture";
import {
  GitlabForge,
  gitlabApiBase,
  gitlabRefusal,
  gitlabWebRoot,
  lineCounts,
  toPull,
} from "./gitlab";
import { ForgeError } from "./types";

const REPO = GITLAB_FIXTURE.repo;
const LIST = { state: "open" as const, page: 1, limit: 0 };

function forgeOver(names: readonly CassetteName[], pick: string[] = []) {
  const tape = replay(names, pick);
  const forge = new GitlabForge({
    apiBase: GITLAB_FIXTURE.apiBase,
    token: async () => GITLAB_FIXTURE.token,
    fetch: tape.fetch,
  });
  return { forge, requests: tape.requests };
}

async function rejection(work: Promise<unknown>): Promise<ForgeError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeError);
    return error as ForgeError;
  }
  throw new Error("expected a rejection");
}

describe("夹具", () => {
  it("每份录像都对着同一个 API 根，答复都是 JSON", () => {
    for (const name of CASSETTES) {
      const tape = cassette(name);
      expect(tape.apiBase).toBe(GITLAB_FIXTURE.apiBase);
      expect(tape.interactions.length).toBeGreaterThan(0);
      for (const entry of tape.interactions) {
        expect(entry.request.path.startsWith("/")).toBe(true);
        expect(entry.response.status).toBeGreaterThanOrEqual(200);
      }
    }
  });
});

describe("地址", () => {
  it("站点根或 API 根都行，统一成 /api/v4", () => {
    expect(gitlabApiBase("https://gitlab.example.com/")).toBe(
      "https://gitlab.example.com/api/v4",
    );
    expect(gitlabApiBase("https://example.com/gitlab/api/v4")).toBe(
      "https://example.com/gitlab/api/v4",
    );
    expect(gitlabApiBase("http://127.0.0.1:8929")).toBe(
      "http://127.0.0.1:8929/api/v4",
    );
    expect(gitlabApiBase("http://gitlab.example.com")).toBeUndefined();
    expect(gitlabApiBase("https://u:p@gitlab.example.com")).toBeUndefined();
    expect(gitlabWebRoot("https://gitlab.example.com/api/v4")).toBe(
      "https://gitlab.example.com",
    );
  });
});

describe("认证与 issue", () => {
  it("令牌放在 PRIVATE-TOKEN 头里，只发到配置的根；项目按 owner%2Fname 寻址", async () => {
    const { forge, requests } = forgeOver(["user", "issues"]);
    expect(await forge.viewer()).toBe("bot");
    await forge.listIssues(REPO, { ...LIST, limit: 2 });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.token).toBe(GITLAB_FIXTURE.token);
      expect(request.url.startsWith(`${GITLAB_FIXTURE.apiBase}/`)).toBe(true);
    }
    expect(requests[1]?.path).toBe("/projects/acme%2Fapp/issues");
    expect(requests[1]?.query).toMatchObject({
      state: "opened",
      order_by: "updated_at",
      sort: "desc",
    });
  });

  it("issue 的 iid 是编号，opened ↔ open，Link 头给下一页", async () => {
    const { forge, requests } = forgeOver(["issues"]);
    const first = await forge.listIssues(REPO, { ...LIST, limit: 2 });
    expect(first.nextCursor).toBe("2");
    expect(first.items.map((issue) => issue.number)).toEqual([7, 5]);
    expect(first.items[0]).toMatchObject({
      number: 7,
      title: "登录页按钮错位",
      state: "open",
      author: "alice",
      labels: ["bug", "ui"],
      commentCount: 3,
      url: "https://gitlab.example.test/acme/app/-/issues/7",
      closedAtMs: null,
    });
    const second = await forge.listIssues(REPO, { ...LIST, limit: 2, page: 2 });
    expect(second.items.map((issue) => issue.number)).toEqual([2]);
    expect(second.nextCursor).toBeNull();
    expect(requests[1]?.query.page).toBe("2");
  });

  it("关 issue 用 state_event，答复映射回 closed", async () => {
    const { forge, requests } = forgeOver(["issues"]);
    const issue = await forge.setIssueState(REPO, 7, "closed");
    expect(issue.state).toBe("closed");
    expect(issue.closedAtMs).toBe(Date.parse("2026-10-03T12:00:00.000Z"));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "PUT",
      path: "/projects/acme%2Fapp/issues/7",
      body: { state_event: "close" },
    });
    await forge.setIssueState(REPO, 7, "open");
    expect(requests[1]?.body).toEqual({ state_event: "reopen" });
  });

  it("没有的 issue 答 notFound", async () => {
    const { forge } = forgeOver(["issues"]);
    expect((await rejection(forge.getIssue(REPO, 404))).kind).toBe("notFound");
  });
});

describe("merge request ↔ pull request", () => {
  it("开着的列表：草稿、冲突、head / base 与 SHA", async () => {
    const { forge, requests } = forgeOver(["merge-requests"]);
    const page = await forge.listPulls(REPO, LIST);
    expect(requests[0]?.path).toBe("/projects/acme%2Fapp/merge_requests");
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      number: 12,
      state: "open",
      draft: true,
      headRef: "feature/login",
      baseRef: "main",
      headSha: GITLAB_FIXTURE.sha,
      mergeable: "unknown",
      url: "https://gitlab.example.test/acme/app/-/merge_requests/12",
    });
    expect(page.items[1]).toMatchObject({
      number: 11,
      mergeable: "conflicting",
    });
  });

  it("closed 含已合并：按 all 取、滤掉开着的", async () => {
    const { forge, requests } = forgeOver(["merge-requests"]);
    const page = await forge.listPulls(REPO, { ...LIST, state: "closed" });
    expect(requests[0]?.query.state).toBe("all");
    expect(page.items.map((pull) => [pull.number, pull.state])).toEqual([
      [9, "merged"],
      [8, "closed"],
    ]);
    expect(page.items[0]?.mergedAtMs).toBe(
      Date.parse("2026-09-30T07:00:00.000Z"),
    );
    expect(page.items[0]?.mergeable).toBe("unknown");
  });

  it("详情与状态映射", async () => {
    const { forge } = forgeOver(["merge-requests"]);
    const pull = await forge.getPull(REPO, 12);
    expect(pull).toMatchObject({
      number: 12,
      body: "把登录页拆成两步",
      draft: false,
      mergeable: "mergeable",
    });
    expect(
      toPull({ iid: 1, state: "locked", merge_status: "can_be_merged" }),
    ).toMatchObject({ state: "open", mergeable: "mergeable" });
    expect(
      toPull({ iid: 1, state: "opened", detailed_merge_status: "ci_must_pass" })
        .mergeable,
    ).toBe("unknown");
    expect(toPull({ iid: 1, sha: "abc" }).headSha).toBe("");
    expect(toPull({ iid: 1, web_url: "javascript:alert(1)" }).url).toBe("");
  });

  it("建 MR：head / base 映射成 source / target，草稿加 Draft: 前缀", async () => {
    const { forge, requests } = forgeOver(["merge-requests"]);
    const pull = await forge.createPull(REPO, {
      title: "New flow",
      body: "正文",
      head: "feature/flow",
      base: "main",
      draft: true,
    });
    expect(pull).toMatchObject({ number: 13, draft: true, state: "open" });
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/projects/acme%2Fapp/merge_requests",
      body: {
        source_branch: "feature/flow",
        target_branch: "main",
        title: "Draft: New flow",
        description: "正文",
      },
    });
    expect(
      (
        await rejection(
          forge.createPull(REPO, {
            title: "x",
            body: "",
            head: "../evil",
            base: "main",
            draft: false,
          }),
        )
      ).reason,
    ).toBe("REF_INVALID");
  });
});

describe("差异与检查", () => {
  it("差异跨两页，状态、改名、二进制与增删行数", async () => {
    const { forge, requests } = forgeOver(["diffs"]);
    const files = await forge.pullFiles(REPO, 12);
    expect(requests.map((request) => request.query.page ?? "1")).toEqual([
      "1",
      "2",
    ]);
    expect(files.map((file) => [file.path, file.status])).toEqual([
      ["src/login.ts", "modified"],
      ["src/two-step.ts", "added"],
      ["src/legacy.ts", "removed"],
      ["docs/login.md", "renamed"],
      ["assets/logo.png", "modified"],
    ]);
    expect(files[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(files[0]?.patch?.startsWith("@@ -1,3 +1,4 @@")).toBe(true);
    expect(files[2]).toMatchObject({ additions: 0, deletions: 1 });
    expect(files[3]).toMatchObject({
      previousPath: "docs/old.md",
      patch: null,
    });
    expect(files[4]?.patch).toBeNull();
    expect(lineCounts("@@ x\n+a\n-b\n c\n+++ d")).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("检查用 commit statuses：同名取 id 最大，允许失败记 neutral，链接只收 http(s)", async () => {
    const { forge, requests } = forgeOver(["merge-requests", "statuses"]);
    const checks = await forge.checks(REPO, 12);
    expect(requests[1]?.path).toBe(
      `/projects/acme%2Fapp/repository/commits/${GITLAB_FIXTURE.sha}/statuses`,
    );
    expect(checks.headSha).toBe(GITLAB_FIXTURE.sha);
    expect(checks.checks).toEqual([
      {
        name: "build",
        state: "success",
        url: "https://gitlab.example.test/acme/app/-/jobs/503",
      },
      {
        name: "lint",
        state: "neutral",
        url: "https://gitlab.example.test/acme/app/-/jobs/502",
      },
      {
        name: "test",
        state: "pending",
        url: "https://gitlab.example.test/acme/app/-/jobs/504",
      },
      { name: "deploy", state: "neutral", url: null },
    ]);
    expect(checks.rollup).toBe("pending");
  });
});

describe("合并", () => {
  it("先核 head，再带 sha 合并；答复里的合并提交交回", async () => {
    const { forge, requests } = forgeOver(["merge-requests", "merge"]);
    const merged = await forge.merge(REPO, 12, {
      method: "squash",
      headSha: GITLAB_FIXTURE.sha,
    });
    expect(merged).toEqual({ merged: true, sha: GITLAB_FIXTURE.mergedSha });
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
    expect(requests[1]?.body).toEqual({
      sha: GITLAB_FIXTURE.sha,
      squash: true,
    });
  });

  it("head 变了不发合并；rebase 不接；远端 409 / 405 译成冲突", async () => {
    const stale = forgeOver(["merge-requests", "merge"]);
    expect(
      (
        await rejection(
          stale.forge.merge(REPO, 12, {
            method: "merge",
            headSha: GITLAB_FIXTURE.oldSha,
          }),
        )
      ).reason,
    ).toBe("HEAD_CHANGED");
    expect(stale.requests.map((request) => request.method)).toEqual(["GET"]);

    expect(
      (
        await rejection(
          stale.forge.merge(REPO, 12, {
            method: "rebase",
            headSha: GITLAB_FIXTURE.sha,
          }),
        )
      ).reason,
    ).toBe("MERGE_METHOD_UNSUPPORTED");

    const raced = forgeOver(["merge-requests", "refusals"], ["head-changed"]);
    const error = await rejection(
      raced.forge.merge(REPO, 12, {
        method: "merge",
        headSha: GITLAB_FIXTURE.sha,
      }),
    );
    expect([error.kind, error.reason]).toEqual(["conflict", "HEAD_CHANGED"]);
    // 写永远不重试。
    expect(raced.requests.filter((r) => r.method === "PUT")).toHaveLength(1);

    const blocked = forgeOver(
      ["merge-requests", "refusals"],
      ["not-mergeable"],
    );
    expect(
      (
        await rejection(
          blocked.forge.merge(REPO, 12, {
            method: "merge",
            headSha: GITLAB_FIXTURE.sha,
          }),
        )
      ).reason,
    ).toBe("NOT_MERGEABLE");
  });
});

describe("拒绝", () => {
  it("细粒度令牌的 insufficient_granular_scope → scopeMissing，远端原话不外传", async () => {
    const { forge } = forgeOver(["refusals"], ["granular"]);
    const error = await rejection(forge.listIssues(REPO, LIST));
    expect(error.kind).toBe("scopeMissing");
    expect(error.reason).toBe("INSUFFICIENT_GRANULAR_SCOPE");
    expect(error.message).not.toContain("Access denied");
    expect(error.message).not.toContain("read_issue");
  });

  it("经典令牌的 insufficient_scope 同样 → scopeMissing", async () => {
    const { forge } = forgeOver(["refusals"], ["scope"]);
    const error = await rejection(forge.setIssueState(REPO, 7, "closed"));
    expect([error.kind, error.reason]).toEqual([
      "scopeMissing",
      "INSUFFICIENT_SCOPE",
    ]);
  });

  it("别的 403 仍是 remoteForbidden，401 是 credentialRejected", async () => {
    const { forge } = forgeOver(["refusals"], ["forbidden", "unauthorized"]);
    const forbidden = await rejection(forge.listPulls(REPO, LIST));
    expect(forbidden.kind).toBe("remoteForbidden");
    expect(forbidden.message).not.toContain("script");
    expect((await rejection(forge.viewer())).kind).toBe("credentialRejected");
  });

  it("只看 403 的 JSON 里的 error 机器码", () => {
    const body = (value: unknown) => Buffer.from(JSON.stringify(value));
    expect(
      gitlabRefusal(403, body({ error: "insufficient_granular_scope" }))?.kind,
    ).toBe("scopeMissing");
    expect(
      gitlabRefusal(401, body({ error: "insufficient_scope" })),
    ).toBeUndefined();
    expect(gitlabRefusal(403, body({ error: "other" }))).toBeUndefined();
    expect(gitlabRefusal(403, Buffer.from("<html>"))).toBeUndefined();
  });

  it("没有令牌不发请求", async () => {
    const tape = replay(["issues"]);
    const forge = new GitlabForge({
      apiBase: GITLAB_FIXTURE.apiBase,
      token: async () => "",
      fetch: tape.fetch,
    });
    expect((await rejection(forge.listIssues(REPO, LIST))).kind).toBe(
      "notConfigured",
    );
    expect(tape.requests).toHaveLength(0);
  });
});
