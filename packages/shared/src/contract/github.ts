import { z } from "zod";

import {
  deleteGithubBranchResponseWireSchema,
  getGithubIssueResponseWireSchema,
  getGithubPullResponseWireSchema,
  githubCheckSummaryWireSchema,
  githubCommentWireSchema,
  githubCredentialStatusWireSchema,
  githubExternalReferenceWireSchema,
  githubIssueWireSchema,
  githubPullRequestWireSchema,
  githubReviewWireSchema,
  githubStatusMappingWireSchema,
  listGithubIssuesResponseWireSchema,
  listGithubPullsResponseWireSchema,
  listGithubReferencesResponseWireSchema,
  mergeGithubPullResponseWireSchema,
  moveGithubIssueResponseWireSchema,
  rerunGithubChecksResponseWireSchema,
  resolveGithubRepositoryResponseWireSchema,
  unlinkGithubReferenceResponseWireSchema,
} from "../api/github.js";
import { errors } from "./errors.js";
import { jsonObjectSchema } from "./json.js";
import { meta, oc } from "./meta.js";

/**
 * `github.*`（契约 §41.1）：GitHub 面板对 core 的调用——凭据、仓库、Issue、状态
 * 映射、PR、检查、合并与清理、外部连接，24 个动词。
 *
 * 线上的形状逐字段写在契约 §2 与 §5：`int64` / `uint64` 是十进制**字符串**，
 * 枚举是枚举值名，零值照写。出参是 `api/github.ts` 的「线上的形状」那一份（没有
 * 变换），页面再按自己读回的那一份（`bigint`）解析。入参只校到顶层字段的类型：
 * 嵌套的记录（`repository`、`filter`、`patch`、`mapping`、`reference`、评审意见）
 * 与枚举取值由域按字段表解码（`core/github/schema.ts`），解不开的答 `bad_request`，
 * 所以这里不把它们写死——更新过的页面多带的字段不是拒绝的理由。
 *
 * 工作空间在入参的 `workspaceId` 里（授权绑在它上面）。旧的 `POST
 * /api/github/<动词>?workspaceId=` 是整段自己认证的原样路由（来源、CSRF 与会话
 * 在域自己的 HTTP 面上判），不挂在契约的旧路径上，见 §41.1 的说明；procedure 与它
 * 走同一份实现。
 *
 * 远端的散文（Issue 正文、评论、错误消息）是外部服务上受攻击者影响的文本：只有
 * 固定的原因码到达客户端；令牌不进日志、事件与答案。
 *
 * 错误码一律 snake_case。从前的大写拼法（`NOT_FOUND`、`PERMISSION_DENIED` ……）在
 * 页面的 `MESSAGE_BY_CODE` 与 `classifyGithubFailure` 里再保留一个 minor。
 *
 * 权限：读是 `github:read`，写是 `github:write`，都绑在工作空间上。
 */

const base = {
  since: "1.11",
  contract: "§41.1",
  workspaceKey: "workspaceId",
} as const;

const workspace = z.object({ workspaceId: z.string().min(1) });

/** 十进制字符串（`int64`）；容忍数字。 */
const I = z.union([z.string(), z.number()]).optional();
const S = z.string().optional();
const B = z.boolean().optional();
const SS = z.array(z.string()).optional();
const M = jsonObjectSchema.optional();
const MS = z.array(jsonObjectSchema).optional();

const credential = errors.pick(
  "bad_request",
  "unauthenticated",
  "forbidden",
  "conflict",
  "rate_limited",
  "unsupported",
  "unknown_outcome",
);
const read = errors.pick(
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "rate_limited",
  "unsupported",
);
const write = errors.pick(
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "unsupported",
  "unknown_outcome",
);

export const github = {
  /** 凭据的状态：配了哪一种来源、现在能不能用。从不带令牌。 */
  getCredential: oc
    .input(workspace)
    .output(githubCredentialStatusWireSchema)
    .errors(credential)
    .meta(meta({ ...base, scope: "github:read" })),
  /** 配凭据。`token` 是这一面上唯一会外发的值，而且只对 `TOKEN_REF`；答的是一份状态，不是一次回声。 */
  configureCredential: oc
    .input(
      workspace.extend({
        source: S,
        token: S,
        apiBase: S,
        expectedRevision: I,
      }),
    )
    .output(githubCredentialStatusWireSchema)
    .errors(credential)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 撤销凭据（删掉存的令牌）。 */
  revokeCredential: oc
    .input(workspace.extend({ expectedRevision: I }))
    .output(githubCredentialStatusWireSchema)
    .errors(credential)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 一个远端地址 → 它对应的 GitHub 仓库与这次的限流读数。 */
  resolveRepository: oc
    .input(workspace.extend({ remoteUrl: S }))
    .output(resolveGithubRepositoryResponseWireSchema)
    .errors(read)
    .meta(meta({ ...base, scope: "github:read" })),
  /** Issue 列表；列表里不带正文，详情把整份拿回来。 */
  listIssues: oc
    .input(
      workspace.extend({ repository: M, filter: M, afterCursor: S, limit: I }),
    )
    .output(listGithubIssuesResponseWireSchema)
    .errors(read)
    .meta(meta({ ...base, scope: "github:read" })),
  /** 一条 Issue 连同评论与外部连接。 */
  getIssue: oc
    .input(workspace.extend({ repository: M, number: I }))
    .output(getGithubIssueResponseWireSchema)
    .errors(read)
    .meta(meta({ ...base, scope: "github:read" })),
  /** 新建 Issue。 */
  createIssue: oc
    .input(
      workspace.extend({
        repository: M,
        title: S,
        body: S,
        labels: SS,
        assignees: SS,
        milestoneNumber: I,
      }),
    )
    .output(githubIssueWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 改标题、正文、标签与指派人。`expectedUpdatedAtUnixMs` 是调用方显示过的更新时刻：GitHub 没有原子版本锁，写之前再读一次，变了答 `conflict`。 */
  updateIssue: oc
    .input(
      workspace.extend({
        repository: M,
        number: I,
        patch: M,
        expectedUpdatedAtUnixMs: I,
      }),
    )
    .output(githubIssueWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 关闭与重开。移动到 Done 组是另一个调用。 */
  setIssueState: oc
    .input(
      workspace.extend({
        repository: M,
        number: I,
        state: S,
        reason: S,
        expectedUpdatedAtUnixMs: I,
      }),
    )
    .output(githubIssueWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 评论。 */
  commentIssue: oc
    .input(workspace.extend({ repository: M, number: I, body: S }))
    .output(githubCommentWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 这个仓库的状态映射（标签或 Project 字段）。 */
  getStatusMapping: oc
    .input(workspace.extend({ repository: M }))
    .output(githubStatusMappingWireSchema)
    .errors(read)
    .meta(meta({ ...base, scope: "github:read" })),
  /** 写状态映射，`expectedRevision` 不符答 `conflict`。 */
  putStatusMapping: oc
    .input(workspace.extend({ mapping: M, expectedRevision: I }))
    .output(githubStatusMappingWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 在配置好的组之间移动一条 Issue，其余标签一个不动。 */
  moveIssue: oc
    .input(
      workspace.extend({
        repository: M,
        number: I,
        toGroupId: S,
        fromGroupId: S,
        expectedUpdatedAtUnixMs: I,
        expectedMappingRevision: I,
      }),
    )
    .output(moveGithubIssueResponseWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** PR 列表；列表里不带正文。 */
  listPulls: oc
    .input(
      workspace.extend({ repository: M, filter: M, afterCursor: S, limit: I }),
    )
    .output(listGithubPullsResponseWireSchema)
    .errors(read)
    .meta(meta({ ...base, scope: "github:read" })),
  /** 一条 PR 连同文件、评审、评论、检查与外部连接。 */
  getPull: oc
    .input(workspace.extend({ repository: M, number: I }))
    .output(getGithubPullResponseWireSchema)
    .errors(read)
    .meta(meta({ ...base, scope: "github:read" })),
  /** 新建 PR；`expectedHeadSha` 不符答 `conflict`。 */
  createPull: oc
    .input(
      workspace.extend({
        repository: M,
        baseRef: S,
        headRef: S,
        title: S,
        body: S,
        draft: B,
        linkedIssueNumber: I,
        expectedHeadSha: S,
      }),
    )
    .output(githubPullRequestWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 提交评审，按面板显示过的提交。 */
  submitReview: oc
    .input(
      workspace.extend({
        repository: M,
        number: I,
        commitSha: S,
        state: S,
        body: S,
        comments: MS,
      }),
    )
    .output(githubReviewWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 一个 head 上的检查汇总。 */
  getChecks: oc
    .input(workspace.extend({ repository: M, number: I }))
    .output(githubCheckSummaryWireSchema)
    .errors(read)
    .meta(meta({ ...base, scope: "github:read" })),
  /** 重跑面板显示过的那个 head 上可重跑的检查。 */
  rerunChecks: oc
    .input(
      workspace.extend({
        repository: M,
        number: I,
        expectedHeadSha: S,
        checkName: S,
        failedOnly: B,
      }),
    )
    .output(rerunGithubChecksResponseWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 按面板显示过的 head 合并；检查汇总变了、head 动了答 `conflict`。 */
  mergePull: oc
    .input(
      workspace.extend({
        repository: M,
        number: I,
        expectedHeadSha: S,
        method: S,
        commitTitle: S,
        commitMessage: S,
        expectedCheckRollup: S,
      }),
    )
    .output(mergeGithubPullResponseWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 删一条远端分支。和合并分开：清理是读者的决定，而且它不碰本地任何东西。 */
  deleteBranch: oc
    .input(workspace.extend({ repository: M, branch: S, expectedSha: S }))
    .output(deleteGithubBranchResponseWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 把一个会话、分支或 worktree 连到一条 Issue 或 PR。 */
  linkReference: oc
    .input(workspace.extend({ reference: M, expectedRevision: I }))
    .output(githubExternalReferenceWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 解除连接。 */
  unlinkReference: oc
    .input(workspace.extend({ referenceId: S, expectedRevision: I }))
    .output(unlinkGithubReferenceResponseWireSchema)
    .errors(write)
    .meta(meta({ ...base, scope: "github:write" })),
  /** 外部连接列表。 */
  listReferences: oc
    .input(workspace.extend({ targetId: S, afterId: S, limit: I }))
    .output(listGithubReferencesResponseWireSchema)
    .errors(read)
    .meta(meta({ ...base, scope: "github:read" })),
};
