import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeApi } from "./client";
import { RuntimeRequestError } from "./request";
import { setCurrentSourceResolver, type Source, localSource } from "./source";

/**
 * gitRepository 域的页面一侧（契约 §40.2）：都发 `POST /api/rpc/gitRepository/…`，
 * 体是 `{ json: { … } }`，答案过页面自己的 schema，发往当前源。游标、路径表、
 * `mainline` 这些是入参里的字段，不再拼进查询串。
 */

const workspaceId = "workspace/id";
const oid = "a".repeat(40);
const operation = {
  id: "operation/id",
  repositoryId: "repo",
  workspaceRoot: "/repo",
  repositoryPath: "/repo",
  action: { kind: "fetch", remote: "origin", prune: false },
  state: "queued",
  cancellationRequested: false,
  progress: 0,
  createdAt: "now",
  finishedAt: null,
  message: null,
};

type Call = { url: string; init: RequestInit };
let calls: Call[];

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stub(respond: (call: Call) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        url: input instanceof Request ? input.url : String(input),
        init: init ?? {},
      };
      calls.push(call);
      return respond(call);
    }),
  );
}

const ok = (json: unknown) => stub(() => answer(200, { json }));
const sent = (index = 0): unknown =>
  (JSON.parse(String(calls[index]?.init.body ?? "null")) as { json: unknown })
    .json;
const procedure = (index = 0): string | undefined =>
  calls[index]?.url.split("/api/rpc/")[1];

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCurrentSourceResolver(null);
});

describe("gitRepository：仓库级的读经 RPC", () => {
  it("分支、历史与 worktree：游标原样作为字段，不经查询串转义", async () => {
    const answers = [
      {
        repositoryId: "repo",
        repositoryPath: "/repo",
        head: { headOid: oid, branch: "main" },
        branches: [],
        remotes: [],
        observedAt: "now",
      },
      {
        reference: "feature/a",
        anchorOid: oid,
        commits: [],
        nextCursor: null,
        shallow: false,
      },
      [],
    ];
    stub(() => answer(200, { json: answers[calls.length - 1] }));

    await runtimeApi.gitRepositoryBranches(workspaceId);
    await runtimeApi.gitRepositoryHistory(
      workspaceId,
      "feature/a",
      "cursor&next=bad",
    );
    await runtimeApi.gitRepositoryWorktrees(workspaceId);

    expect(procedure(0)).toBe("gitRepository/branches");
    expect(sent(0)).toEqual({ workspaceId, path: "." });
    expect(procedure(1)).toBe("gitRepository/history");
    expect(sent(1)).toEqual({
      workspaceId,
      path: ".",
      reference: "feature/a",
      limit: 50,
      cursor: "cursor&next=bad",
    });
    expect(procedure(2)).toBe("gitRepository/worktrees");
    expect(sent(2)).toEqual({ workspaceId, path: "." });
  });

  it("历史的路径过滤是数组；没有游标与路径时不发这两个字段", async () => {
    ok({
      reference: "HEAD",
      anchorOid: null,
      commits: [],
      nextCursor: null,
      shallow: false,
    });

    await runtimeApi.gitRepositoryHistory(
      workspaceId,
      "HEAD",
      undefined,
      undefined,
      "apps/inner",
      100,
      ["src/a.ts", "b,c.ts"],
    );
    await runtimeApi.gitRepositoryHistory(workspaceId);

    expect(sent(0)).toEqual({
      workspaceId,
      path: "apps/inner",
      reference: "HEAD",
      limit: 100,
      paths: ["src/a.ts", "b,c.ts"],
    });
    expect(sent(1)).toEqual({
      workspaceId,
      path: ".",
      reference: "HEAD",
      limit: 50,
    });
  });

  it("仓库发现：只在要刷新时带 refresh，maxDepth 是数字", async () => {
    ok({
      workspaceRoot: "/repo",
      maxDepth: 3,
      repositories: [],
      truncated: false,
      observedAt: "now",
    });

    await runtimeApi.gitRepositories(workspaceId, {
      refresh: true,
      maxDepth: 3,
    });
    await runtimeApi.gitRepositories(workspaceId);

    expect(procedure(0)).toBe("gitRepository/repositories");
    expect(sent(0)).toEqual({ workspaceId, refresh: true, maxDepth: 3 });
    expect(sent(1)).toEqual({ workspaceId });
  });

  it("合并日志：筛选条件原样与 workspaceId 一起发", async () => {
    ok({ commits: [], nextCursor: null, repositories: [], truncated: false });

    await runtimeApi.gitLog(workspaceId, {
      refs: { kind: "named", names: ["main"] },
      text: { query: "fix", regex: false, matchCase: true },
      cursor: "c1",
      limit: 100,
    });

    expect(procedure()).toBe("gitRepository/log");
    expect(sent()).toEqual({
      workspaceId,
      refs: { kind: "named", names: ["main"] },
      text: { query: "fix", regex: false, matchCase: true },
      cursor: "c1",
      limit: 100,
    });
  });

  it("提交详情与单个文件：base 为 null 时不发；cherry-pick 的 mainline 是数字", async () => {
    // 只看发出去的入参；答案不合各自的 schema，调用方拿到的是拒绝。
    ok({});
    await runtimeApi
      .gitRepositoryCommitDetail(workspaceId, oid, null)
      .catch(() => undefined);
    await runtimeApi
      .gitRepositoryCommitDetail(workspaceId, oid, "HEAD")
      .catch(() => undefined);
    await runtimeApi
      .gitRepositoryCommitFile(workspaceId, oid, null, "src/a.ts")
      .catch(() => undefined);
    await runtimeApi
      .gitRepositoryCherryPickPreview(workspaceId, oid, 1)
      .catch(() => undefined);
    await runtimeApi
      .gitRepositoryCherryPickPreview(workspaceId, oid, null)
      .catch(() => undefined);

    expect(procedure(0)).toBe("gitRepository/commitDetail");
    expect(sent(0)).toEqual({ workspaceId, path: ".", oid });
    expect(sent(1)).toEqual({ workspaceId, path: ".", oid, base: "HEAD" });
    expect(procedure(2)).toBe("gitRepository/commitFile");
    expect(sent(2)).toEqual({ workspaceId, path: ".", oid, file: "src/a.ts" });
    expect(procedure(3)).toBe("gitRepository/cherryPickPreview");
    expect(sent(3)).toEqual({ workspaceId, path: ".", oid, mainline: 1 });
    expect(sent(4)).toEqual({ workspaceId, path: ".", oid });
  });

  it("多检出状态与 worktree 绑定：只读的两条，空的分支与仓库 id 不发", async () => {
    ok({ repositories: [], observedAt: "now" });
    await runtimeApi.gitRepositoryStatusBatch(workspaceId, [".", "apps/x"]);
    expect(procedure()).toBe("gitRepository/statusBatch");
    expect(sent()).toEqual({
      workspaceId,
      paths: [".", "apps/x"],
      pathspecs: [],
    });

    ok({
      valid: true,
      code: "ok",
      worktreePath: "wt",
      absolutePath: "/repo/wt",
      repositoryId: "repo",
      branch: "main",
      headOid: oid,
      isMain: false,
      locked: false,
      prunable: false,
    });
    await runtimeApi.gitRepositoryWorktreeBinding(workspaceId, {
      worktreePath: "wt",
      branch: null,
      repositoryId: "repo",
    });
    expect(procedure(1)).toBe("gitRepository/worktreeBinding");
    expect(sent(1)).toEqual({
      workspaceId,
      worktreePath: "wt",
      repositoryId: "repo",
    });
  });

  it("游标被拒按码抛出（invalid_cursor），页面据此丢掉游标重读", async () => {
    stub(() =>
      answer(409, {
        code: "invalid_cursor",
        message: "The log cursor does not match these filters",
        requestId: "r-1",
      }),
    );
    const error = await runtimeApi
      .gitLog(workspaceId, { cursor: "stale" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RuntimeRequestError);
    expect((error as RuntimeRequestError).code).toBe("invalid_cursor");
    expect((error as RuntimeRequestError).status).toBe(409);
  });

  it("发往当前源：换了源，请求跟着去", async () => {
    const other: Source = {
      ...localSource,
      sourceId: "remote-1",
      httpBase: "https://core.example",
      wsBase: "wss://core.example",
    };
    setCurrentSourceResolver(() => other);
    ok([]);

    await runtimeApi.gitRepositoryOperations(workspaceId);

    expect(calls[0]?.url).toBe(
      "https://core.example/api/rpc/gitRepository/operations/list",
    );
  });
});

describe("gitRepository.operations：长操作只排队、答快照", () => {
  it("显式 CAS 起操作、按 id 轮询、按 id 取消，各一次，不发 force 字段", async () => {
    ok(operation);

    await runtimeApi.gitRepositoryOperate(
      workspaceId,
      { kind: "fetch", remote: "origin", prune: false },
      { headOid: oid, branch: "main" },
    );
    await runtimeApi.gitRepositoryOperation(workspaceId, "operation/id");
    await runtimeApi.gitRepositoryCancel(workspaceId, "operation/id");

    expect(procedure(0)).toBe("gitRepository/operations/start");
    expect(sent(0)).toEqual({
      workspaceId,
      path: ".",
      action: { kind: "fetch", remote: "origin", prune: false },
      expected: { headOid: oid, branch: "main" },
    });
    expect(procedure(1)).toBe("gitRepository/operations/get");
    expect(sent(1)).toEqual({ workspaceId, operationId: "operation/id" });
    expect(procedure(2)).toBe("gitRepository/operations/cancel");
    expect(sent(2)).toEqual({ workspaceId, operationId: "operation/id" });
    expect(calls).toHaveLength(3);
  });

  it("不合法的操作在发请求前就同步抛出", () => {
    ok(operation);

    expect(() =>
      runtimeApi.gitRepositoryOperate(
        workspaceId,
        { kind: "fetch", remote: "", prune: false },
        { headOid: null, branch: null },
      ),
    ).toThrow();
    expect(calls).toHaveLength(0);
  });

  it("成功的答案形状不对就拒绝，而不是报告操作已排上", async () => {
    ok({ ok: true });

    await expect(
      runtimeApi.gitRepositoryOperate(
        workspaceId,
        { kind: "fetch", remote: "origin", prune: false },
        { headOid: null, branch: null },
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
