import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeApi } from "./client";
import { RuntimeRequestError } from "./request";
import { setCurrentSourceResolver, type Source, localSource } from "./source";

/**
 * git 域的页面一侧（契约 §40.1）：都发 `POST /api/rpc/git/<动词>`，体是
 * `{ json: { … } }`，答案过页面自己的 schema，发往当前源。仓库级的读与操作
 * （`api/git-repository.ts`）还走旧路径，不在这里。
 */

const timestamp = "2026-08-13T00:00:00.000Z";
const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const digest = "a".repeat(64);
const oid = "b".repeat(40);

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

describe("git：工作区与索引经 RPC", () => {
  it("暂存时提交路径列表，缺省点名工作空间根", async () => {
    ok({ staged: ["src/App.tsx"] });

    const result = await runtimeApi.gitStage(workspaceId, ["src/App.tsx"]);

    expect(result.staged).toEqual(["src/App.tsx"]);
    expect(procedure()).toBe("git/stage");
    // 每个写请求都点名作用于哪个仓库；缺省是工作空间根（roadmap §4.1）。
    expect(sent()).toEqual({ workspaceId, paths: ["src/App.tsx"], path: "." });
  });

  it("暂存可以指向工作空间下的另一个仓库", async () => {
    ok({ staged: ["main.rs"] });

    await runtimeApi.gitStage(workspaceId, ["main.rs"], "apps/inner");

    expect(sent()).toEqual({
      workspaceId,
      paths: ["main.rs"],
      path: "apps/inner",
    });
  });

  it("空路径的回滚、空提交信息在发请求前就被拦下", () => {
    ok({});

    expect(() => runtimeApi.gitRevert(workspaceId, [])).toThrow();
    expect(() => runtimeApi.gitCommit(workspaceId, "   ")).toThrow();
    expect(() => runtimeApi.gitStage(workspaceId, [])).toThrow();
    expect(calls).toHaveLength(0);
  });

  it("回滚带上来源；取消暂存、标记解决各走自己的 procedure", async () => {
    ok({ reverted: ["a.ts"] });
    await runtimeApi.gitRevert(workspaceId, ["a.ts"], "head");
    expect(procedure()).toBe("git/revert");
    expect(sent()).toEqual({
      workspaceId,
      paths: ["a.ts"],
      source: "head",
      path: ".",
    });

    ok({ unstaged: ["a.ts"] });
    expect(
      (await runtimeApi.gitUnstage(workspaceId, ["a.ts"])).unstaged,
    ).toEqual(["a.ts"]);
    expect(procedure(1)).toBe("git/unstage");

    ok({ resolved: ["a.ts"] });
    await runtimeApi.gitMarkResolved(workspaceId, ["a.ts"], "apps/inner");
    expect(procedure(2)).toBe("git/resolve");
    expect(sent(2)).toEqual({
      workspaceId,
      paths: ["a.ts"],
      path: "apps/inner",
    });
  });

  it("提交在没有指定路径时不发 paths；amend 原样带上", async () => {
    ok({ commit: "abc1234", committed: [], summary: "1 file changed" });

    await runtimeApi.gitCommit(workspaceId, "feat: 画布");
    expect(procedure()).toBe("git/commit");
    expect(sent()).toEqual({ workspaceId, message: "feat: 画布", path: "." });

    await runtimeApi.gitCommit(workspaceId, "fix", ["a.ts"], {
      expectedHead: oid,
      allowPublished: false,
    });
    expect(sent(1)).toEqual({
      workspaceId,
      message: "fix",
      paths: ["a.ts"],
      amend: { expectedHead: oid, allowPublished: false },
      path: ".",
    });
  });

  it("diff 缺省取工作区；scope / paths / 忽略空白进入参，paths 是数组", async () => {
    ok({ repository: true, clean: true, files: [] });

    await runtimeApi.gitDiff(workspaceId);
    expect(procedure()).toBe("git/diff");
    expect(sent()).toEqual({ workspaceId, path: ".", scope: "worktree" });

    await runtimeApi.gitDiff(workspaceId, {
      scope: "staged",
      paths: ["src/a.ts", "src/b.ts"],
      ignoreWhitespace: true,
    });
    expect(sent(1)).toEqual({
      workspaceId,
      path: ".",
      scope: "staged",
      paths: ["src/a.ts", "src/b.ts"],
      ignoreWhitespace: true,
    });
  });

  it("未知 scope 在发请求前就被拦下", () => {
    ok({ repository: true, clean: true, files: [] });

    expect(() =>
      runtimeApi.gitDiff(workspaceId, {
        scope: "index" as unknown as "staged",
      }),
    ).toThrow();
    expect(calls).toHaveLength(0);
  });

  it("status 带回逐文件的暂存 / 未暂存两列，并把 signal 交给请求", async () => {
    ok({
      repository: true,
      branch: "main",
      changedCount: 1,
      files: [{ path: "a.ts", status: "M", staged: true, unstaged: true }],
    });
    const controller = new AbortController();

    const status = await runtimeApi.gitStatus(
      workspaceId,
      "apps/inner",
      ["a.ts"],
      controller.signal,
    );
    expect(procedure()).toBe("git/status");
    expect(sent()).toEqual({
      workspaceId,
      path: "apps/inner",
      paths: ["a.ts"],
    });
    expect(calls[0]?.init.signal).toBeDefined();
    expect(status.files[0]).toEqual({
      path: "a.ts",
      status: "M",
      staged: true,
      unstaged: true,
      // A Runtime that predates the rename origin omits the key; the row is
      // still a row, it just has no arrow to draw.
      originPath: null,
    });
  });

  it("HEAD 提交、初始化", async () => {
    ok(null);
    expect(await runtimeApi.gitHeadCommit(workspaceId)).toBeNull();
    expect(procedure()).toBe("git/headCommit");
    expect(sent()).toEqual({ workspaceId, path: "." });

    ok({ repository: true, branch: "main", path: "/tmp/one" });
    await runtimeApi.gitInit(workspaceId);
    expect(procedure(1)).toBe("git/init");
    expect(sent(1)).toEqual({ workspaceId });
  });

  it("按块读写：读点名检出、文件与一侧；写带摘要与块 id", async () => {
    ok({
      file: "a.ts",
      scope: "worktree",
      diffDigest: digest,
      supported: true,
      unsupportedReason: null,
      hunks: [],
    });
    await runtimeApi.gitHunks(workspaceId, "a.ts", "worktree");
    expect(procedure()).toBe("git/hunks");
    expect(sent()).toEqual({
      workspaceId,
      path: ".",
      file: "a.ts",
      scope: "worktree",
    });

    ok({
      applied: true,
      file: "a.ts",
      scope: "worktree",
      action: "stage",
      hunkId: digest,
    });
    await runtimeApi.gitApplyHunk(workspaceId, {
      path: ".",
      file: "a.ts",
      scope: "worktree",
      diffDigest: digest,
      hunkId: digest,
      action: "stage",
    });
    expect(procedure(1)).toBe("git/applyHunk");
    expect(sent(1)).toEqual({
      workspaceId,
      path: ".",
      file: "a.ts",
      scope: "worktree",
      diffDigest: digest,
      hunkId: digest,
      action: "stage",
    });
  });

  it("AI 提交信息：提供方、暂存源、生成走 git.message.*", async () => {
    ok([{ id: "claude-bare", label: "Claude", available: true, reason: null }]);
    await runtimeApi.gitMessageProviders(workspaceId);
    expect(procedure()).toBe("git/message/providers");

    const source = {
      expectedHead: oid,
      indexDigest: digest,
      sourceDigest: digest,
      includedFiles: ["a.ts"],
      excludedFiles: [],
      truncated: false,
      redacted: false,
    };
    ok(source);
    await runtimeApi.gitMessageSource(workspaceId);
    expect(procedure(1)).toBe("git/message/source");

    ok({
      ...source,
      message: "feat: one",
      provider: "claude-bare",
      language: "zh",
      conventional: true,
    });
    await runtimeApi.gitMessageGenerate(workspaceId, {
      provider: "claude-bare",
      expectedHead: oid,
      indexDigest: digest,
      language: "zh",
      conventional: true,
    });
    expect(procedure(2)).toBe("git/message/generate");
    expect(sent(2)).toEqual({
      workspaceId,
      provider: "claude-bare",
      expectedHead: oid,
      indexDigest: digest,
      language: "zh",
      conventional: true,
    });
  });

  it("域的拒绝按码抛出，原话留在 coreMessage 上", async () => {
    stub(() =>
      answer(403, {
        code: "git_execution_required",
        message: "Git worktree status requires workspace execution permission",
        requestId: "r-1",
      }),
    );
    const error = await runtimeApi
      .gitStatus(workspaceId)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RuntimeRequestError);
    expect((error as RuntimeRequestError).code).toBe("git_execution_required");
    expect((error as RuntimeRequestError).status).toBe(403);
  });

  it("发往当前源：换了源，请求跟着去", async () => {
    const other: Source = {
      ...localSource,
      sourceId: "remote-1",
      httpBase: "https://core.example",
      wsBase: "wss://core.example",
    };
    setCurrentSourceResolver(() => other);
    ok({ staged: ["a.ts"] });

    await runtimeApi.gitStage(workspaceId, ["a.ts"]);

    expect(calls[0]?.url).toBe("https://core.example/api/rpc/git/stage");
  });
});

describe("git.clone：只起任务，进度轮询", () => {
  it("起任务只发 url / parent / name，答 jobId", async () => {
    ok({ jobId: "job-1" });

    await expect(
      runtimeApi.cloneRepository({
        url: "https://example.test/demo.git",
        parent: "/tmp",
      }),
    ).resolves.toEqual({ jobId: "job-1" });

    expect(procedure()).toBe("git/clone/start");
    expect(sent()).toEqual({
      url: "https://example.test/demo.git",
      parent: "/tmp",
    });
  });

  it("轮询带回完成后的工作空间", async () => {
    ok({
      state: "done",
      lines: ["Receiving objects: 100% (20/20)"],
      workspace: {
        id: workspaceId,
        name: "demo",
        rootPath: "/tmp/demo",
        color: "#5B5BD6",
        permissions: { read: true, write: true, execute: true },
        lastOpenedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });

    const status = await runtimeApi.gitCloneStatus("job-1");
    expect(procedure()).toBe("git/clone/status");
    expect(sent()).toEqual({ jobId: "job-1" });
    expect(status.state).toBe("done");
    expect(status.workspace?.rootPath).toBe("/tmp/demo");
  });

  it("取消发 git.clone.cancel", async () => {
    stub(() => answer(200, {}));

    await expect(runtimeApi.cancelClone("job-1")).resolves.toBeUndefined();

    expect(procedure()).toBe("git/clone/cancel");
    expect(sent()).toEqual({ jobId: "job-1" });
  });
});
