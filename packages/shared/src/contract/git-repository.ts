import { z } from "zod";

import {
  gitCherryPickPreviewSchema,
  gitIntegrationSnapshotSchema,
} from "../git-integration.js";
import {
  gitBranchSnapshotSchema,
  gitCommitDetailSchema,
  gitCommitFileDiffSchema,
  gitHistoryPageSchema,
  gitIdentitySchema,
  gitLogPageSchema,
  gitRebaseTodoPreviewSchema,
  gitReflogPageSchema,
  gitRefsSnapshotSchema,
  gitRemotesSchema,
  gitRepositoryListSchema,
  gitRepositoryOperationSchema,
  gitStashDetailSchema,
  gitStashSnapshotSchema,
  gitStatusBatchSchema,
  gitTagSnapshotSchema,
  gitWorktreeBindingVerdictSchema,
  gitWorktreesSchema,
} from "../git-repository.js";
import { errors } from "./errors.js";
import { jsonValueSchema } from "./json.js";
import { meta, oc } from "./meta.js";

/**
 * `gitRepository.*`（契约 §40.2）：仓库级的读与操作队列——工作空间下发现的
 * 仓库、合并日志、引用树、提交身份，以及一个检出的分支、标签、远端、worktree、
 * 储藏、历史、reflog、提交详情、cherry-pick 与 rebase 的预览、多检出的状态、
 * worktree 绑定的核对、整合（merge / rebase / cherry-pick）状态，和操作队列。
 *
 * 一个检出的工作区与索引是 `git.*`（§40.1，E3-5 第一部分）。
 *
 * 出参复用页面已有的 schema。入参只校形状：路径是否越界、引用与 oid 是否合法、
 * 操作（`action`）是不是认识的那几种、日志的筛选条件对不对，这些判断在域里
 * （`core/git/`），旧路径与 procedure 走同一份实现，拒绝的码与原话一样。所以
 * `action` 只要求是带 `kind` 的对象，其余字段原样交给域。
 *
 * 旧路径的读是查询串：`limit`、`maxDepth`、`mainline` 以数字串到达，`refresh` 以
 * `"true"` 到达，`history` 的 `paths` 以逗号拼成一个字符串到达，所以这几个字段
 * 两种拼法都收；procedure 用数字、布尔与数组。
 *
 * 长操作（fetch、pull、push、rebase、合并、worktree 增删……）保留原来的操作
 * 队列：`operations.start` 只把操作排进队列、答它的快照（带 `id`），进度由页面
 * 按 `operations.get` 轮询，`operations.cancel` 请求取消。操作只对发起它的工作
 * 空间可见。
 *
 * 权限与路由表（`core/http/route-scopes.ts`）给旧路径的一致：`GET` 是 `git:read`，
 * 其余方法是 `git:write`——`log`、`statusBatch`、`worktreeBinding` 虽然只读，旧
 * 路径是 `POST`（筛选条件或路径表是体），同样是 `git:write`。工作空间自己的
 * 读 / 写 / 执行授权是域里的判断（`git_execution_required`）。
 */

const workspaceRef = z.object({ workspaceId: z.string().min(1) });

/** 一个检出：工作空间内的相对目录，缺省是根（`.`）。 */
const checkout = workspaceRef.extend({ path: z.string().optional() });

/** 一个非负整数：procedure 里是数字，旧路径的查询串里是数字串。 */
const count = z.union([z.number(), z.string()]);

/** 一个开关：procedure 里是布尔，旧路径的查询串里是 `"true"`。 */
const flag = z.union([z.boolean(), z.string()]);

/** 一组路径：procedure 里是数组；旧路径的查询串里是逗号拼成的一个字符串。 */
const pathList = z.union([z.array(z.string()), z.string()]);

/** 分页读：从哪个引用读、一页几条、上一页给的游标。 */
const page = checkout.extend({
  reference: z.string().optional(),
  limit: count.optional(),
  cursor: z.string().nullish(),
});

/** 一个操作：`kind` 说是哪一种，其余字段随种类而定，由域校验。 */
const action = z.object({ kind: z.string() }).catchall(jsonValueSchema);

/** 页面看到的仓库状态（CAS）：HEAD 与分支变了就拒绝。 */
const expected = z.object({
  headOid: z.string().nullish(),
  branch: z.string().nullish(),
});

const operationRef = workspaceRef.extend({ operationId: z.string().min(1) });

const WORKSPACE = "/api/workspaces/{workspaceId}/git";
const REPOSITORY = `${WORKSPACE}/repository`;
const inWorkspace = {
  since: "1.10",
  contract: "§40.2",
  workspaceKey: "workspaceId",
} as const;

const read = errors.pick(
  "bad_request",
  "forbidden",
  "not_found",
  "git_execution_required",
);
/** 分页读：游标不属于这个引用或这组筛选条件时答 `invalid_cursor`。 */
const paged = errors.pick(
  "bad_request",
  "forbidden",
  "not_found",
  "conflict",
  "invalid_cursor",
  "git_execution_required",
);
const write = errors.pick(
  "bad_request",
  "forbidden",
  "not_found",
  "conflict",
  "git_execution_required",
);

const getAt = (path: string) => ({ method: "GET" as const, path });
const postAt = (path: string) => ({ method: "POST" as const, path });

export const gitRepository = {
  /**
   * 工作空间下发现的仓库（含嵌套仓库与 worktree）。`refresh` 丢掉发现缓存
   * 重扫；`maxDepth` 限制往下找几层。
   */
  repositories: oc
    .input(
      workspaceRef.extend({
        refresh: flag.optional(),
        maxDepth: count.optional(),
      }),
    )
    .output(gitRepositoryListSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${WORKSPACE}/repositories`),
      }),
    ),
  /**
   * 合并日志的一页：引用选择、作者、日期范围、路径、全文搜索与游标。游标属于
   * 取它时的那组筛选条件，条件变了还送回来答 `invalid_cursor`（页面丢掉游标
   * 重读第一页）。只读，旧路径是 `POST`（筛选条件是体）。
   */
  log: oc
    .input(
      workspaceRef.extend({
        repositories: z.array(z.string()).nullish(),
        refs: z
          .object({
            kind: z.string().optional(),
            names: z.array(z.string()).optional(),
          })
          .nullish(),
        authors: z.array(z.string()).optional(),
        since: z.string().nullish(),
        until: z.string().nullish(),
        paths: z.array(z.string()).optional(),
        text: z
          .object({
            query: z.string(),
            regex: z.boolean().optional(),
            matchCase: z.boolean().optional(),
          })
          .nullish(),
        cursor: z.string().nullish(),
        limit: z.number().optional(),
      }),
    )
    .output(gitLogPageSchema)
    .errors(paged)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:write",
        legacy: postAt(`${WORKSPACE}/log`),
      }),
    ),
  /** 每个发现的仓库的引用树（分支、远端、标签、worktree、储藏），一次答全。 */
  refs: oc
    .input(workspaceRef)
    .output(gitRefsSnapshotSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${WORKSPACE}/refs`),
      }),
    ),
  /** 这个检出的提交会署谁的名：`git config` 自己的答案，没配时两项都是 `null`。 */
  identity: oc
    .input(checkout)
    .output(gitIdentitySchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${WORKSPACE}/identity`),
      }),
    ),
  branches: oc
    .input(checkout)
    .output(gitBranchSnapshotSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/branches`),
      }),
    ),
  tags: oc
    .input(checkout)
    .output(gitTagSnapshotSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/tags`),
      }),
    ),
  /** 远端；URL 里嵌的凭据已换掉。 */
  remotes: oc
    .input(checkout)
    .output(gitRemotesSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/remotes`),
      }),
    ),
  worktrees: oc
    .input(checkout)
    .output(gitWorktreesSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/worktrees`),
      }),
    ),
  stashes: oc
    .input(checkout)
    .output(gitStashSnapshotSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/stashes`),
      }),
    ),
  /** 一个储藏改了哪些文件。 */
  stashDetail: oc
    .input(checkout.extend({ oid: z.string() }))
    .output(gitStashDetailSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/stash-detail`),
      }),
    ),
  /** 一个引用（缺省 `HEAD`）的历史，按游标分页；`paths` 只看动过这些路径的提交。 */
  history: oc
    .input(page.extend({ paths: pathList.optional() }))
    .output(gitHistoryPageSchema)
    .errors(paged)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/history`),
      }),
    ),
  /** 一个引用（缺省 `HEAD`）的 reflog，按偏移分页（reflog 只在前面长）。 */
  reflog: oc
    .input(page)
    .output(gitReflogPageSchema)
    .errors(paged)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/reflog`),
      }),
    ),
  /** 一个提交改了哪些文件；`base` 缺省对第一父提交比较。 */
  commitDetail: oc
    .input(checkout.extend({ oid: z.string(), base: z.string().optional() }))
    .output(gitCommitDetailSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/commit`),
      }),
    ),
  /** 一个提交里一个文件的差异；`base` 同上。 */
  commitFile: oc
    .input(
      checkout.extend({
        oid: z.string(),
        base: z.string().optional(),
        file: z.string(),
      }),
    )
    .output(gitCommitFileDiffSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/commit-file`),
      }),
    ),
  /** cherry-pick 一个提交前的预览；合并提交要给 `mainline`。 */
  cherryPickPreview: oc
    .input(checkout.extend({ oid: z.string(), mainline: count.optional() }))
    .output(gitCherryPickPreviewSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/cherry-pick-preview`),
      }),
    ),
  /** 交互式 rebase 到 `onto` 会重放的提交，按顺序。 */
  rebaseTodo: oc
    .input(checkout.extend({ onto: z.string() }))
    .output(gitRebaseTodoPreviewSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/rebase-todo`),
      }),
    ),
  /**
   * 几个检出的状态一次答：每个仓库各带自己的失败，一个坏的不连累其余。只读，
   * 旧路径是 `POST`（路径表是体）。
   */
  statusBatch: oc
    .input(
      workspaceRef.extend({
        paths: z.array(z.string()),
        pathspecs: z.array(z.string()).optional(),
      }),
    )
    .output(gitStatusBatchSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:write",
        legacy: postAt(`${REPOSITORY}/status-batch`),
      }),
    ),
  /**
   * 一个 Frame 的 worktree 绑定是否仍指向它声称的那个仓库的检出：答一个带原因
   * 的结论，不是布尔。只读，旧路径是 `POST`。
   */
  worktreeBinding: oc
    .input(
      workspaceRef.extend({
        worktreePath: z.string(),
        branch: z.string().nullish(),
        repositoryId: z.string().nullish(),
      }),
    )
    .output(gitWorktreeBindingVerdictSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:write",
        legacy: postAt(`${REPOSITORY}/worktree-binding`),
      }),
    ),
  /**
   * 整合（merge / rebase / cherry-pick / revert）状态与冲突。不是这个工作空间
   * 发起的会话，会话 id 与能否继续一律抹掉。
   */
  integration: oc
    .input(checkout)
    .output(gitIntegrationSnapshotSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: getAt(`${REPOSITORY}/integration`),
      }),
    ),
  /**
   * 操作队列（长操作）：`start` 只排进队列、答快照（带 `id`）；进度按 `get`
   * 轮询；`cancel` 请求取消。只看得到这个工作空间发起的操作。
   */
  operations: {
    list: oc
      .input(checkout)
      .output(z.array(gitRepositoryOperationSchema))
      .errors(read)
      .meta(
        meta({
          ...inWorkspace,
          scope: "git:read",
          legacy: getAt(`${REPOSITORY}/operations`),
        }),
      ),
    /**
     * 排一个操作。`expected` 是页面看到的 HEAD 与分支，开跑时对不上就失败；
     * 继续 / 中止 / 跳过整合时 `action.sessionId` 必须是这个工作空间的会话。
     */
    start: oc
      .input(checkout.extend({ action, expected }))
      .output(gitRepositoryOperationSchema)
      .errors(write)
      .meta(
        meta({
          ...inWorkspace,
          scope: "git:write",
          legacy: postAt(`${REPOSITORY}/operations`),
        }),
      ),
    get: oc
      .input(operationRef)
      .output(gitRepositoryOperationSchema)
      .errors(errors.pick("bad_request", "forbidden", "not_found"))
      .meta(
        meta({
          ...inWorkspace,
          scope: "git:read",
          legacy: getAt(`${REPOSITORY}/operations/{operationId}`),
        }),
      ),
    /** 请求取消；已结束的操作原样答它的快照。 */
    cancel: oc
      .input(operationRef)
      .output(gitRepositoryOperationSchema)
      .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
      .meta(
        meta({
          ...inWorkspace,
          scope: "git:write",
          legacy: postAt(`${REPOSITORY}/operations/{operationId}/cancel`),
        }),
      ),
  },
};
