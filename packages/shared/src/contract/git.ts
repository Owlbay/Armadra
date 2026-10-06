import { z } from "zod";

import {
  gitCloneStartedSchema,
  gitCloneStateSchema,
} from "../api/git-clone.js";
import {
  gitCommitResponseSchema,
  gitDiffSchema,
  gitHeadCommitSchema,
  gitInitResponseSchema,
  gitResolveResponseSchema,
  gitRevertResponseSchema,
  gitStageResponseSchema,
  gitStatusSchema,
  gitUnstageResponseSchema,
} from "../api/git.js";
import { gitHunkDiffSchema, gitHunkResultSchema } from "../git-hunks.js";
import {
  gitMessageDraftSchema,
  gitMessageProvidersSchema,
  gitMessageSourceSchema,
} from "../git-message.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";
import { workspaceWireSchema } from "./workspaces.js";

/**
 * `git.*`（契约 §40.1）：一个检出的工作区与索引——状态、差异、HEAD 提交、初始化、
 * 暂存 / 取消暂存 / 标记解决 / 还原、提交、按块（hunk）读写、AI 提交信息，以及
 * 克隆仓库的任务。
 *
 * 仓库级的读与操作（分支、历史、日志、引用、worktree、储藏、远端、整合、操作
 * 队列）是 `gitRepository.*`，随 E3-5 的第二部分进契约（§40.2）；在那之前仍走
 * 路由表的旧路径。
 *
 * 出参复用页面已有的 schema。入参只校形状：路径是否越界、`scope` / `source` /
 * `action` / `language` 是不是认识的值、提交信息与 hunk 摘要对不对，这些判断在
 * 域里（`core/git/`），旧路径与 procedure 走同一份实现，拒绝的码与原话一样，所以
 * 这些字段在这里是 `string`，取值写在各条的说明与契约正文里。
 *
 * 旧路径的读是查询串：`paths` 以逗号拼成一个字符串到达、`ignoreWhitespace` 以
 * `"true"` 到达，所以这两个字段两种拼法都收。
 *
 * 克隆是长操作，保留原来的任务模型：`clone.start` 只起任务、答 `jobId`；进度由
 * 页面按 `clone.status` 轮询（克隆时还没有工作空间，不走工作空间事件流）。
 *
 * 权限与路由表（`core/http/route-scopes.ts`）给旧路径的一致：`GET` 是 `git:read`，
 * 其余方法是 `git:write`（AI 提交信息的生成虽然只读仓库，旧路径是 `POST`，同样
 * 是 `git:write`）。工作区读写另要工作空间自己的读 / 写 / 执行授权，那是域里的
 * 判断（`git_execution_required`）。
 */

const workspaceRef = z.object({ workspaceId: z.string().min(1) });

/** 一个检出：工作空间内的相对目录，缺省是根（`.`）。 */
const checkout = workspaceRef.extend({ path: z.string().optional() });

/** 一组路径：JSON 体里是数组；旧路径的查询串里是逗号拼成的一个字符串。 */
const pathList = z.union([z.array(z.string()), z.string()]);

/** 写的入参：哪个检出、哪些路径（路径的合法性由域判断）。 */
const pathsWrite = checkout.extend({ paths: z.array(z.string()) });

const WORKSPACE = "/api/workspaces/{workspaceId}/git";
const base = { since: "1.8", contract: "§40.1" } as const;
const inWorkspace = { ...base, workspaceKey: "workspaceId" } as const;

const read = errors.pick(
  "bad_request",
  "forbidden",
  "not_found",
  "git_execution_required",
);
const write = errors.pick(
  "bad_request",
  "forbidden",
  "not_found",
  "conflict",
  "git_execution_required",
);

export const git = {
  /**
   * 一个检出的状态（`git status --porcelain`）。不是仓库答 `repository: false`，
   * 不是错误。`paths` 收下但不过滤（计数与行都是整个检出）。
   */
  status: oc
    .input(checkout.extend({ paths: pathList.optional() }))
    .output(gitStatusSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: { method: "GET", path: `${WORKSPACE}/status` },
      }),
    ),
  /**
   * 差异：`scope` 是 `worktree`（缺省）或 `staged`；给 `paths` 时只 diff 这些
   * 文件。`ignoreWhitespace` 只影响补丁与行数，不影响文件列表。
   */
  diff: oc
    .input(
      checkout.extend({
        scope: z.string().optional(),
        paths: pathList.optional(),
        ignoreWhitespace: z.union([z.boolean(), z.string()]).optional(),
      }),
    )
    .output(gitDiffSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: { method: "GET", path: `${WORKSPACE}/diff` },
      }),
    ),
  /** 修订（amend）会改写的那个提交；未出生的分支答 `null`。 */
  headCommit: oc
    .input(checkout)
    .output(gitHeadCommitSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: { method: "GET", path: `${WORKSPACE}/head-commit` },
      }),
    ),
  /** `git init`：只在状态答「不是仓库」时提供；已经在某个仓库里的拒绝。 */
  init: oc
    .input(workspaceRef)
    .output(gitInitResponseSchema)
    .errors(write)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:write",
        legacy: { method: "POST", path: `${WORKSPACE}/init` },
      }),
    ),
  stage: oc
    .input(pathsWrite)
    .output(gitStageResponseSchema)
    .errors(write)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:write",
        legacy: { method: "POST", path: `${WORKSPACE}/stage` },
      }),
    ),
  /** `git restore --staged`：只动索引，工作区改动一律保留。 */
  unstage: oc
    .input(pathsWrite)
    .output(gitUnstageResponseSchema)
    .errors(write)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:write",
        legacy: { method: "POST", path: `${WORKSPACE}/unstage` },
      }),
    ),
  /** 暂存一个冲突路径；文件里还有冲突标记时拒绝并带上行号。 */
  resolve: oc
    .input(pathsWrite)
    .output(gitResolveResponseSchema)
    .errors(write)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:write",
        legacy: { method: "POST", path: `${WORKSPACE}/resolve` },
      }),
    ),
  /**
   * 还原：`source` 是 `index`（缺省，只丢未暂存的改动）或 `head`（连暂存的一起
   * 丢并取消暂存）。
   */
  revert: oc
    .input(pathsWrite.extend({ source: z.string().optional() }))
    .output(gitRevertResponseSchema)
    .errors(write)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:write",
        legacy: { method: "POST", path: `${WORKSPACE}/revert` },
      }),
    ),
  /**
   * 提交。给 `paths` 时只提交这些（先暂存）；`amend` 改写当前提交，必须带上页面
   * 看到的 HEAD，已推送的还要 `allowPublished`。一次只提交一个检出。
   */
  commit: oc
    .input(
      checkout.extend({
        message: z.string(),
        paths: z.array(z.string()).nullish(),
        amend: z
          .object({
            expectedHead: z.string(),
            allowPublished: z.boolean().optional(),
          })
          .nullish(),
      }),
    )
    .output(gitCommitResponseSchema)
    .errors(write)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:write",
        legacy: { method: "POST", path: `${WORKSPACE}/commit` },
      }),
    ),
  /**
   * 按块读：一个文件在 `scope`（`worktree` / `staged`）一侧的块，带整份差异的
   * 摘要（写回时要带）。
   */
  hunks: oc
    .input(checkout.extend({ file: z.string(), scope: z.string().optional() }))
    .output(gitHunkDiffSchema)
    .errors(read)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:read",
        legacy: { method: "GET", path: `${WORKSPACE}/hunks` },
      }),
    ),
  /**
   * 按块写：`action` 是 `stage` / `unstage` / `revert`。差异摘要或块 id 与磁盘上
   * 的不一致时拒绝（页面重读再来）。
   */
  applyHunk: oc
    .input(
      checkout.extend({
        file: z.string(),
        scope: z.string().optional(),
        diffDigest: z.string(),
        hunkId: z.string(),
        action: z.string(),
      }),
    )
    .output(gitHunkResultSchema)
    .errors(write)
    .meta(
      meta({
        ...inWorkspace,
        scope: "git:write",
        legacy: { method: "POST", path: `${WORKSPACE}/hunks` },
      }),
    ),
  /** AI 提交信息（暂存区 → 草稿）。提供方的凭据在 core 这边，源在仓库那边。 */
  message: {
    /** 能用的提供方；不在工作空间里跑任何东西，有读权限即可。 */
    providers: oc
      .input(workspaceRef)
      .output(gitMessageProvidersSchema)
      .errors(errors.pick("forbidden", "not_found"))
      .meta(
        meta({
          ...inWorkspace,
          scope: "git:read",
          legacy: { method: "GET", path: `${WORKSPACE}/message/providers` },
        }),
      ),
    /** 会交给提供方的暂存源：文件清单、摘要、是否截断与脱敏（不含正文）。 */
    source: oc
      .input(workspaceRef)
      .output(gitMessageSourceSchema)
      .errors(read)
      .meta(
        meta({
          ...inWorkspace,
          scope: "git:read",
          legacy: { method: "GET", path: `${WORKSPACE}/message/source` },
        }),
      ),
    /**
     * 生成草稿。`expectedHead` 与 `indexDigest` 是页面看到的那一份：仓库在这期间
     * 变了就拒绝。`language` 是 `en`（缺省）或 `zh`。
     */
    generate: oc
      .input(
        workspaceRef.extend({
          provider: z.string(),
          expectedHead: z.string().nullish(),
          indexDigest: z.string(),
          language: z.string().optional(),
          conventional: z.boolean().optional(),
        }),
      )
      .output(gitMessageDraftSchema)
      .errors(write)
      .meta(
        meta({
          ...inWorkspace,
          scope: "git:write",
          legacy: { method: "POST", path: `${WORKSPACE}/message/generate` },
        }),
      ),
  },
  /**
   * 克隆仓库（长操作，任务模型）：`start` 起任务、答 `jobId`；`status` 轮询，
   * 完成时 core 已把目标目录登记成工作空间并带在答案里；`cancel` 取消。
   */
  clone: {
    /**
     * `parent` 在已有工作空间里时，每个祖先工作空间都要允许读、写与执行。只认
     * `https://`、`ssh://` 与 `user@host:path`。
     */
    start: oc
      .input(
        z.object({
          url: z.string(),
          parent: z.string(),
          name: z.string().nullish(),
        }),
      )
      .output(gitCloneStartedSchema)
      .errors(
        errors.pick(
          "bad_request",
          "forbidden",
          "not_found",
          "git_execution_required",
        ),
      )
      .meta(
        meta({
          ...base,
          scope: "git:write",
          legacy: { method: "POST", path: "/api/git/clone" },
        }),
      ),
    /** `lines` 是 `git clone --progress` 的最后至多 20 行。 */
    status: oc
      .input(z.object({ jobId: z.string() }))
      .output(
        z.object({
          state: gitCloneStateSchema,
          lines: z.array(z.string()),
          error: z.string().optional(),
          workspace: workspaceWireSchema.optional(),
        }),
      )
      .errors(errors.pick("bad_request", "forbidden", "not_found"))
      .meta(
        meta({
          ...base,
          scope: "git:read",
          legacy: { method: "GET", path: "/api/git/clone/{jobId}" },
        }),
      ),
    /** 取消；旧路径答 `204`。 */
    cancel: oc
      .input(z.object({ jobId: z.string() }))
      .output(z.void())
      .errors(errors.pick("forbidden", "not_found"))
      .meta(
        meta({
          ...base,
          scope: "git:write",
          legacy: {
            method: "DELETE",
            path: "/api/git/clone/{jobId}",
            successStatus: 204,
          },
        }),
      ),
  },
};
