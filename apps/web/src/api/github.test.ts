/**
 * GitHub 的调用面（契约 §41.1，`github.*` procedure）。
 *
 * 测三件事：**线上那份 JSON 解回页面用的值**（`int64` → `bigint`，枚举 → 那个
 * 名字）、**请求发出去的形状**（`POST /api/rpc/github/<动词>`，`bigint` 变十进制
 * 字符串、工作空间在入参里），以及**错误按该怎么修分档**（码是 snake_case，从前的
 * 大写拼法再认一个 minor）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { runtimeApi } from "./client";
import {
  GithubApiError,
  GithubCheckConclusion,
  GithubIssueState,
  GithubMergeMethod,
  githubIssueFilter,
  githubIssueSchema,
  githubRepositoryRef,
  listGithubIssuesResponseSchema,
} from "./github";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

/** 一次假的 core 应答，记下它收到的请求；成功的答案按 RPC 编码包进 `json`。 */
function serve(status: number, payload: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        init,
      });
      return new Response(
        JSON.stringify(status < 400 ? { json: payload } : payload),
        { status, headers: { "content-type": "application/json" } },
      );
    },
  ) as unknown as typeof fetch;
  return calls;
}

/** 请求体里的入参（`{ json: … }` 那一格）。 */
const sentJson = (call: { init: RequestInit | undefined } | undefined) =>
  (JSON.parse(String(call?.init?.body ?? "null")) as { json: unknown }).json;

const open = (workspaceId = "ws-1") => runtimeApi.openGithub(workspaceId);

const repository = githubRepositoryRef({ owner: "octo", name: "repo" });

describe("GithubApi 的解析", () => {
  it("int64 是字符串，解回 bigint；枚举解回那个名字", () => {
    const issue = githubIssueSchema.parse({
      number: "9007199254740993",
      id: "12",
      title: "一条 Issue",
      body: "正文",
      state: "GITHUB_ISSUE_STATE_OPEN",
      updatedAtUnixMs: "1788000000000",
      labels: [{ name: "bug", color: "ff0000" }],
    });
    // 2^53 + 1：`number` 在这里会悄悄改值。
    expect(issue.number).toBe(9_007_199_254_740_993n);
    expect(issue.state).toBe(GithubIssueState.OPEN);
    expect(issue.updatedAtUnixMs).toBe(1_788_000_000_000n);
    expect(issue.labels[0]?.name).toBe("bug");
    // 没给的字段是零值，不是 undefined：读的地方不必每处都判空。
    expect(issue.commentCount).toBe(0n);
    expect(issue.statusConflict).toBe(false);
    expect(issue.author).toBeUndefined();
  });

  it("认不出来的枚举名落回 UNSPECIFIED，而不是让整页消失", () => {
    const parsed = listGithubIssuesResponseSchema.parse({
      issues: [{ state: "GITHUB_ISSUE_STATE_ARCHIVED_SOMEDAY" }],
    });
    expect(parsed.issues[0]?.state).toBe(GithubIssueState.UNSPECIFIED);
    expect(parsed.hasMore).toBe(false);
  });

  it("工作空间不合法的客户端建不出来", () => {
    expect(() => open("")).toThrow(GithubApiError);
    expect(() => open("有空格 的")).toThrow(GithubApiError);
  });
});

describe("GithubApi 的请求", () => {
  it("工作空间在入参里，bigint 发成十进制字符串", async () => {
    const calls = serve(200, { issue: { number: "7" }, comments: [] });
    const api = open();
    await api.getIssue({ repository, number: 7n });

    expect(calls[0]?.url).toContain("/api/rpc/github/getIssue");
    expect(calls[0]?.init?.method).toBe("POST");
    const sent = sentJson(calls[0]) as {
      workspaceId: string;
      number: unknown;
      repository: { owner: string };
    };
    expect(sent.workspaceId).toBe("ws-1");
    expect(sent.number).toBe("7");
    expect(sent.repository.owner).toBe("octo");
  });

  it("过滤器与分页上限一起发出去", async () => {
    const calls = serve(200, { issues: [] });
    const api = open();
    await api.listIssues({
      repository,
      filter: githubIssueFilter({ state: GithubIssueState.OPEN }),
      limit: 5_000,
    });
    const sent = sentJson(calls[0]) as {
      filter: { state: string; milestoneNumber: string };
      limit: number;
    };
    expect(sent.filter.state).toBe("GITHUB_ISSUE_STATE_OPEN");
    expect(sent.filter.milestoneNumber).toBe("0");
    expect(sent.limit).toBe(100);
  });

  it("合并把看到的 head 与检查汇总一起带上", async () => {
    const calls = serve(200, { merged: true, mergeSha: "abc" });
    const api = open();
    const answer = await api.mergePull({
      repository,
      number: 3n,
      expectedHeadSha: "deadbeef",
      method: GithubMergeMethod.SQUASH,
      expectedCheckRollup: GithubCheckConclusion.SUCCESS,
    });
    expect(answer.merged).toBe(true);
    const sent = sentJson(calls[0]) as {
      method: string;
      expectedCheckRollup: string;
      commitTitle: string;
    };
    expect(sent.method).toBe("GITHUB_MERGE_METHOD_SQUASH");
    expect(sent.expectedCheckRollup).toBe("GITHUB_CHECK_CONCLUSION_SUCCESS");
    expect(sent.commitTitle).toBe("");
  });
});

describe("GithubApi 的错误分档", () => {
  // 每档两种拼法：snake_case 是现在的码，大写是从前的拼法（再认一个 minor）。
  const cases: [string, number, string][] = [
    ["unauthenticated", 401, "unauthenticated"],
    ["unauthenticated", 401, "UNAUTHENTICATED"],
    ["permission", 403, "forbidden"],
    ["permission", 403, "PERMISSION_DENIED"],
    ["unsupported", 501, "unsupported"],
    ["unsupported", 501, "UNSUPPORTED"],
    // 没装配 GitHub 域的 core：procedure 没实现。
    ["unsupported", 501, "not_implemented"],
    ["notFound", 404, "not_found"],
    ["notFound", 404, "NOT_FOUND"],
    ["conflict", 409, "conflict"],
    ["conflict", 409, "CONFLICT"],
    ["rateLimited", 429, "rate_limited"],
    ["rateLimited", 429, "RESOURCE_EXHAUSTED"],
    ["invalid", 400, "bad_request"],
    ["invalid", 400, "INVALID_ARGUMENT"],
  ];

  for (const [failure, status, code] of cases) {
    it(`${code} → ${failure}`, async () => {
      serve(status, { code, message: "nope" });
      const api = open();
      await expect(api.getCredential()).rejects.toMatchObject({
        name: "GithubApiError",
        failure,
      });
    });
  }

  for (const code of ["unknown_outcome", "UNKNOWN_OUTCOME"]) {
    it(`结果没被读到的写（${code}）留在 network，并且带着 outcomeUnknown`, async () => {
      serve(504, { code, message: "nope" });
      const api = open();
      await expect(
        api.commentIssue({ repository, number: 1n, body: "hi" }),
      ).rejects.toMatchObject({ failure: "network", outcomeUnknown: true });
    });
  }

  it("连不上 core 也是 network，而不是一次空列表", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("failed to fetch");
    }) as unknown as typeof fetch;
    const api = open();
    await expect(api.getCredential()).rejects.toMatchObject({
      failure: "network",
    });
  });
});
