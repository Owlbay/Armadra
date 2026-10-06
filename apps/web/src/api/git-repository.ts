import { z } from "zod";
import {
  gitBranchSnapshotSchema,
  gitCherryPickPreviewSchema,
  gitCommitDetailSchema,
  gitCommitFileDiffSchema,
  gitExpectedStateSchema,
  gitHistoryPageSchema,
  gitIntegrationSnapshotSchema,
  gitIdentitySchema,
  gitLogPageSchema,
  gitRefsSnapshotSchema,
  gitRebaseTodoPreviewSchema,
  gitRemotesSchema,
  gitReflogPageSchema,
  gitRepositoryActionSchema,
  gitRepositoryListSchema,
  gitRepositoryOperationSchema,
  gitStatusBatchSchema,
  gitStashDetailSchema,
  gitStashSnapshotSchema,
  gitTagSnapshotSchema,
  gitWorktreeBindingVerdictSchema,
  gitWorktreesSchema,
  type GitExpectedState,
  type GitLogRequest,
  type GitRepositoryAction,
} from "@armadra/shared";
import type { ArmadraClient } from "./client";

/**
 * 仓库级的读与操作队列（契约 §40.2，`gitRepository.*`）：经客户端发 procedure，
 * 答案过页面自己的 schema。一个检出的工作区与索引在 `api/git.ts`（§40.1）。
 *
 * 客户端由 `api/client.ts` 交进来（这个模块被它 import，反过来 import 它就是一个
 * 环）；交进来的是「当前源的客户端」，所以换了源，后面的调用就发往新的源。
 *
 * 长操作（fetch、pull、push、rebase……）保留操作队列：`gitRepositoryOperate` 只
 * 排进队列、答快照，进度按 `gitRepositoryOperation` 轮询。操作与 CAS 先过页面的
 * schema 再发，不合法的在发请求前就同步抛出，所以那个函数不是 `async` 的。
 */
const withSignal = (signal: AbortSignal | undefined) =>
  signal ? { signal } : undefined;

const operationListSchema = z.array(gitRepositoryOperationSchema);

export const gitRepositoryApiFor = (rpc: () => ArmadraClient) => ({
  /**
   * Every repository read and write names the checkout it means. `path` is
   * workspace-relative and defaults to the workspace root, so a single-repo
   * workspace behaves exactly as before (roadmap §4.1).
   */
  gitRepositories: async (
    workspaceId: string,
    options: { refresh?: boolean; maxDepth?: number } = {},
    signal?: AbortSignal,
  ) =>
    gitRepositoryListSchema.parse(
      await rpc().gitRepository.repositories(
        {
          workspaceId,
          ...(options.refresh ? { refresh: true } : {}),
          ...(options.maxDepth === undefined
            ? {}
            : { maxDepth: options.maxDepth }),
        },
        withSignal(signal),
      ),
    ),
  gitRepositoryBranches: async (
    workspaceId: string,
    path = ".",
    signal?: AbortSignal,
  ) =>
    gitBranchSnapshotSchema.parse(
      await rpc().gitRepository.branches(
        { workspaceId, path },
        withSignal(signal),
      ),
    ),
  gitRepositoryOperations: async (
    workspaceId: string,
    path = ".",
    signal?: AbortSignal,
  ) =>
    operationListSchema.parse(
      await rpc().gitRepository.operations.list(
        { workspaceId, path },
        withSignal(signal),
      ),
    ),
  /**
   * `limit` is capped by the service; the commit graph asks for 100 a page and
   * stops at 500 rows, so a long history stays a scroll rather than a stall.
   */
  gitRepositoryHistory: async (
    workspaceId: string,
    reference = "HEAD",
    cursor?: string,
    signal?: AbortSignal,
    path = ".",
    limit = 50,
    paths?: string[],
  ) =>
    gitHistoryPageSchema.parse(
      await rpc().gitRepository.history(
        {
          workspaceId,
          path,
          reference,
          limit,
          ...(cursor ? { cursor } : {}),
          ...(paths && paths.length > 0 ? { paths } : {}),
        },
        withSignal(signal),
      ),
    ),
  /**
   * One page of the workspace's merged commit log (Git 工具窗口设计 §3.1).
   *
   * The filters are a record — a ref selection, an author list, a date range,
   * pathspecs, a search with two switches and a page cursor — sent as they are.
   *
   * The cursor belongs to the filters it was taken under. Changing any of them
   * and sending the cursor back is refused with `invalid_cursor`; the repair is
   * to drop the cursor and read the first page again.
   */
  gitLog: async (
    workspaceId: string,
    filters: GitLogRequest = {},
    signal?: AbortSignal,
  ) =>
    gitLogPageSchema.parse(
      await rpc().gitRepository.log(
        { ...filters, workspaceId },
        withSignal(signal),
      ),
    ),
  /**
   * Every discovered repository's branch tree in one answer, so the Git
   * window's left column is one request rather than five per repository.
   */
  gitRefs: async (workspaceId: string, signal?: AbortSignal) =>
    gitRefsSnapshotSchema.parse(
      await rpc().gitRepository.refs({ workspaceId }, withSignal(signal)),
    ),
  /**
   * Who a commit from this checkout would be attributed to — `git config`'s
   * own answer, not one inferred from the reflog. Both fields are null when
   * nothing is configured.
   */
  gitIdentity: async (workspaceId: string, signal?: AbortSignal, path = ".") =>
    gitIdentitySchema.parse(
      await rpc().gitRepository.identity(
        { workspaceId, path },
        withSignal(signal),
      ),
    ),
  gitRepositoryWorktrees: async (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitWorktreesSchema.parse(
      await rpc().gitRepository.worktrees(
        { workspaceId, path },
        withSignal(signal),
      ),
    ),
  /** The commits an interactive rebase onto `onto` would replay, in order. */
  gitRepositoryRebaseTodo: async (
    workspaceId: string,
    onto: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitRebaseTodoPreviewSchema.parse(
      await rpc().gitRepository.rebaseTodo(
        { workspaceId, path, onto },
        withSignal(signal),
      ),
    ),
  /**
   * One page of a ref's reference log (Git 设计 §3 "Reflog").
   *
   * Paged by offset rather than by an anchor: the reflog is prepended to and
   * has no immutable anchor to hold a window still, and every entry carries its
   * own `loggedAt` so a reader can see that the window slid.
   */
  gitRepositoryReflog: async (
    workspaceId: string,
    reference = "HEAD",
    cursor?: string,
    signal?: AbortSignal,
    path = ".",
    limit = 50,
  ) =>
    gitReflogPageSchema.parse(
      await rpc().gitRepository.reflog(
        {
          workspaceId,
          path,
          reference,
          limit,
          ...(cursor ? { cursor } : {}),
        },
        withSignal(signal),
      ),
    ),
  /**
   * Several checkouts' status in one request (Git 设计 §4.1 全部仓库聚合).
   * Nothing about it writes.
   */
  gitRepositoryStatusBatch: async (
    workspaceId: string,
    paths: string[],
    options: { pathspecs?: string[] } = {},
    signal?: AbortSignal,
  ) =>
    gitStatusBatchSchema.parse(
      await rpc().gitRepository.statusBatch(
        { workspaceId, paths, pathspecs: options.pathspecs ?? [] },
        withSignal(signal),
      ),
    ),
  /**
   * Whether a Frame's worktree binding still names a checkout of the repository
   * it claims (Git 设计 §5.1). A verdict with a reason, never a boolean.
   */
  gitRepositoryWorktreeBinding: async (
    workspaceId: string,
    binding: {
      worktreePath: string;
      branch?: string | null;
      repositoryId?: string | null;
    },
    signal?: AbortSignal,
  ) =>
    gitWorktreeBindingVerdictSchema.parse(
      await rpc().gitRepository.worktreeBinding(
        {
          workspaceId,
          worktreePath: binding.worktreePath,
          ...(binding.branch ? { branch: binding.branch } : {}),
          ...(binding.repositoryId
            ? { repositoryId: binding.repositoryId }
            : {}),
        },
        withSignal(signal),
      ),
    ),
  gitRepositoryTags: async (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitTagSnapshotSchema.parse(
      await rpc().gitRepository.tags({ workspaceId, path }, withSignal(signal)),
    ),
  /** URLs come back with any embedded credentials already replaced. */
  gitRepositoryRemotes: async (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitRemotesSchema.parse(
      await rpc().gitRepository.remotes(
        { workspaceId, path },
        withSignal(signal),
      ),
    ),
  gitRepositoryStashes: async (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitStashSnapshotSchema.parse(
      await rpc().gitRepository.stashes(
        { workspaceId, path },
        withSignal(signal),
      ),
    ),
  gitRepositoryIntegration: async (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitIntegrationSnapshotSchema.parse(
      await rpc().gitRepository.integration(
        { workspaceId, path },
        withSignal(signal),
      ),
    ),
  /**
   * 一个提交改了哪些文件。`base` 传 `null` 表示对第一父提交比较（也就是
   * 「这个提交本身改了什么」），传 `"HEAD"` 就是「比较到当前」。
   */
  gitRepositoryCommitDetail: async (
    workspaceId: string,
    oid: string,
    base: string | null,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitCommitDetailSchema.parse(
      await rpc().gitRepository.commitDetail(
        { workspaceId, path, oid, ...(base === null ? {} : { base }) },
        withSignal(signal),
      ),
    ),
  gitRepositoryCommitFile: async (
    workspaceId: string,
    oid: string,
    base: string | null,
    file: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitCommitFileDiffSchema.parse(
      await rpc().gitRepository.commitFile(
        { workspaceId, path, oid, file, ...(base === null ? {} : { base }) },
        withSignal(signal),
      ),
    ),
  gitRepositoryCherryPickPreview: async (
    workspaceId: string,
    oid: string,
    mainline: number | null,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitCherryPickPreviewSchema.parse(
      await rpc().gitRepository.cherryPickPreview(
        {
          workspaceId,
          path,
          oid,
          ...(mainline === null ? {} : { mainline }),
        },
        withSignal(signal),
      ),
    ),
  gitRepositoryStashDetail: async (
    workspaceId: string,
    oid: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    gitStashDetailSchema.parse(
      await rpc().gitRepository.stashDetail(
        { workspaceId, path, oid },
        withSignal(signal),
      ),
    ),
  gitRepositoryOperate: (
    workspaceId: string,
    action: GitRepositoryAction,
    expected: GitExpectedState,
    path = ".",
  ) => {
    const parsedAction = gitRepositoryActionSchema.parse(action);
    const parsedExpected = gitExpectedStateSchema.parse(expected);
    return rpc()
      .gitRepository.operations.start({
        workspaceId,
        path,
        action: parsedAction,
        expected: parsedExpected,
      })
      .then((answer) => gitRepositoryOperationSchema.parse(answer));
  },
  gitRepositoryOperation: async (
    workspaceId: string,
    operationId: string,
    signal?: AbortSignal,
  ) =>
    gitRepositoryOperationSchema.parse(
      await rpc().gitRepository.operations.get(
        { workspaceId, operationId },
        withSignal(signal),
      ),
    ),
  gitRepositoryCancel: async (workspaceId: string, operationId: string) =>
    gitRepositoryOperationSchema.parse(
      await rpc().gitRepository.operations.cancel({ workspaceId, operationId }),
    ),
});
