import {
  gitCloneRequestSchema,
  gitCloneStartedSchema,
  gitCloneStatusSchema,
  gitCommitRequestSchema,
  gitCommitResponseSchema,
  gitDiffRequestSchema,
  gitDiffSchema,
  gitHeadCommitSchema,
  gitHunkDiffSchema,
  gitHunkMutationSchema,
  gitHunkResultSchema,
  gitInitResponseSchema,
  gitMessageDraftSchema,
  gitMessageProvidersSchema,
  gitMessageRequestSchema,
  gitMessageSourceSchema,
  gitPathsRequestSchema,
  gitResolveResponseSchema,
  gitRevertRequestSchema,
  gitRevertResponseSchema,
  gitStageResponseSchema,
  gitStatusSchema,
  gitUnstageResponseSchema,
  type DiffScope,
  type GitCloneRequest,
  type GitHunkMutation,
  type GitHunkScope,
  type GitMessageRequest,
  type GitRestoreSource,
} from "@armadra/shared";
import type { ArmadraClient } from "./client";

/**
 * 一个检出的工作区与索引（契约 §40.1，`git.*`）：经客户端发 procedure，答案过
 * 页面自己的 schema。仓库级的读与操作在 `api/git-repository.ts`（§40.2）。
 *
 * 客户端由 `api/client.ts` 交进来（这个模块被它 import，反过来 import 它就是一个
 * 环）；交进来的是「当前源的客户端」，所以换了源，后面的调用就发往新的源。
 *
 * 入参先过页面的 schema 再发：空路径、空提交信息、不认识的 `scope` 在发请求前就
 * 同步抛出，所以这些函数不是 `async` 的。
 */
const withSignal = (signal: AbortSignal | undefined) =>
  signal ? { signal } : undefined;

export const gitApiFor = (rpc: () => ArmadraClient) => ({
  /* ------------------------------------ git ----------------------------- */
  gitMessageProviders: async (workspaceId: string, signal?: AbortSignal) =>
    gitMessageProvidersSchema.parse(
      await rpc().git.message.providers({ workspaceId }, withSignal(signal)),
    ),
  gitMessageSource: async (workspaceId: string, signal?: AbortSignal) =>
    gitMessageSourceSchema.parse(
      await rpc().git.message.source({ workspaceId }, withSignal(signal)),
    ),
  gitMessageGenerate: (workspaceId: string, value: GitMessageRequest) => {
    const draft = gitMessageRequestSchema.parse(value);
    return rpc()
      .git.message.generate({ workspaceId, ...draft })
      .then((answer) => gitMessageDraftSchema.parse(answer));
  },
  /**
   * `path` is the checkout the file belongs to. Without it a nested
   * repository's `src/a.ts` was read against the workspace root's index — a
   * different repository, and, for the apply below, a different file.
   */
  gitHunks: async (
    workspaceId: string,
    file: string,
    scope: GitHunkScope,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitHunkDiffSchema.parse(
      await rpc().git.hunks(
        { workspaceId, path, file, scope },
        withSignal(signal),
      ),
    ),
  gitApplyHunk: (workspaceId: string, mutation: GitHunkMutation) => {
    const parsed = gitHunkMutationSchema.parse(mutation);
    return rpc()
      .git.applyHunk({ workspaceId, ...parsed })
      .then((answer) => gitHunkResultSchema.parse(answer));
  },
  /**
   * `paths` is a server-side pathspec filter: Git applies it to both the count
   * and the rows, so the two describe one set. Filtering in the browser after
   * reading the whole checkout is what made a panel say "12 changes" above
   * three of them.
   */
  gitStatus: async (
    workspaceId: string,
    path = ".",
    paths?: string[],
    signal?: AbortSignal,
  ) =>
    gitStatusSchema.parse(
      await rpc().git.status(
        {
          workspaceId,
          path,
          ...(paths && paths.length > 0 ? { paths } : {}),
        },
        withSignal(signal),
      ),
    ),
  /** `git init`; only offered when a status read reported no repository. */
  gitInit: async (workspaceId: string) =>
    gitInitResponseSchema.parse(await rpc().git.init({ workspaceId })),
  gitDiff: (
    workspaceId: string,
    options: {
      path?: string;
      scope?: DiffScope;
      paths?: string[];
      ignoreWhitespace?: boolean;
    } = {},
  ) => {
    const parsed = gitDiffRequestSchema.parse(options);
    return rpc()
      .git.diff({
        workspaceId,
        path: parsed.path ?? ".",
        scope: parsed.scope,
        ...(parsed.paths && parsed.paths.length > 0
          ? { paths: parsed.paths }
          : {}),
        ...(parsed.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
      })
      .then((answer) => gitDiffSchema.parse(answer));
  },
  gitStage: (workspaceId: string, paths: string[], path = ".") => {
    const parsed = gitPathsRequestSchema.parse({ paths });
    return rpc()
      .git.stage({ workspaceId, ...parsed, path })
      .then((answer) => gitStageResponseSchema.parse(answer));
  },
  /** `git restore --staged`：只动索引，工作区改动一律保留。 */
  gitUnstage: (workspaceId: string, paths: string[], path = ".") => {
    const parsed = gitPathsRequestSchema.parse({ paths });
    return rpc()
      .git.unstage({ workspaceId, ...parsed, path })
      .then((answer) => gitUnstageResponseSchema.parse(answer));
  },
  /**
   * Stage a conflicted path. Refused — with the offending line numbers — while
   * the file on disk still contains Git conflict markers.
   */
  gitMarkResolved: (workspaceId: string, paths: string[], path = ".") => {
    const parsed = gitPathsRequestSchema.parse({ paths });
    return rpc()
      .git.resolve({ workspaceId, ...parsed, path })
      .then((answer) => gitResolveResponseSchema.parse(answer));
  },
  /**
   * `index` restores the working tree from what is staged; `head` restores
   * from the commit and unstages as well. They lose different work, so the
   * caller always says which one it means.
   */
  gitRevert: (
    workspaceId: string,
    paths: string[],
    source: GitRestoreSource = "index",
    path = ".",
  ) => {
    const parsed = gitRevertRequestSchema.parse({ paths, source });
    return rpc()
      .git.revert({ workspaceId, ...parsed, path })
      .then((answer) => gitRevertResponseSchema.parse(answer));
  },
  /** The commit an amend would rewrite; null on an unborn branch. */
  gitHeadCommit: async (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitHeadCommitSchema.parse(
      await rpc().git.headCommit({ workspaceId, path }, withSignal(signal)),
    ),
  gitCommit: (
    workspaceId: string,
    message: string,
    paths?: string[],
    amend?: { expectedHead: string; allowPublished: boolean },
    path = ".",
  ) => {
    const parsed = gitCommitRequestSchema.parse({
      message,
      ...(paths && paths.length > 0 ? { paths } : {}),
      ...(amend ? { amend } : {}),
    });
    // One request, one repository: there is deliberately no cross-repository
    // commit (roadmap §4.1).
    return rpc()
      .git.commit({ workspaceId, ...parsed, path })
      .then((answer) => gitCommitResponseSchema.parse(answer));
  },

  /* --------------------------------- 克隆仓库 --------------------------- */
  /**
   * 克隆是长操作：这里只起任务、拿到 `jobId`。克隆还没有工作空间，所以不走
   * 工作空间事件流，对话框自己按 500ms 轮询 `gitCloneStatus`。
   */
  cloneRepository: (input: GitCloneRequest) => {
    const parsed = gitCloneRequestSchema.parse(input);
    return rpc()
      .git.clone.start(parsed)
      .then((answer) => gitCloneStartedSchema.parse(answer));
  },
  /** 完成时带上 core 已经建好的工作空间，直接打开它。 */
  gitCloneStatus: async (jobId: string) =>
    gitCloneStatusSchema.parse(await rpc().git.clone.status({ jobId })),
  cancelClone: async (jobId: string): Promise<void> => {
    await rpc().git.clone.cancel({ jobId });
  },
});
