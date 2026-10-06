import { z } from "zod";

import { jsonValueSchema } from "../contract/json.js";

/**
 * GitHub 面的记录与枚举（契约 §5、§41）。
 *
 * 线上的形状逐字段写在 `docs/contracts/core-json-api.md` §2 与 §5：字段名
 * camelCase、`int64` / `uint64` 是十进制**字符串**、枚举是枚举值名、零值照写。
 *
 * 同一张字段表实例化两次：
 *
 *   * **页面读回的形状**（`githubIssueSchema` 等）：`int64` 回 `bigint`，缺字段
 *     补零值，认不出的枚举名落回 `UNSPECIFIED`。`bigint` 保留不是惯性：Issue 与
 *     PR 的编号、时间戳和 id 都是 64 位，`number` 在 2^53 之上会悄悄改值，而一条
 *     被改了 id 的评论会被贴到别人的行上。
 *   * **线上的形状**（`githubIssueWireSchema` 等）：契约的 procedure 出参。没有任何
 *     变换，`int64` 就是 core 写出的那个字符串，多出来的字段原样放行（更新过的
 *     core 写下的记录要读得回来）。契约出参不许带变换：核对出参时的变换会改写
 *     线上的体。
 */

/**
 * 枚举值就是线上的那个名字。
 *
 * 写成 `as const` 的常量对象 + 同名的联合类型：调用点仍然写
 * `GithubIssueState.OPEN`，而类型是一个字符串联合，不是一个数字。
 */
export const GithubCredentialSource = {
  UNSPECIFIED: "GITHUB_CREDENTIAL_SOURCE_UNSPECIFIED",
  NONE: "GITHUB_CREDENTIAL_SOURCE_NONE",
  GH_CLI: "GITHUB_CREDENTIAL_SOURCE_GH_CLI",
  TOKEN_REF: "GITHUB_CREDENTIAL_SOURCE_TOKEN_REF",
} as const;
export type GithubCredentialSource =
  (typeof GithubCredentialSource)[keyof typeof GithubCredentialSource];

export const GithubSecretStore = {
  UNSPECIFIED: "GITHUB_SECRET_STORE_UNSPECIFIED",
  NONE: "GITHUB_SECRET_STORE_NONE",
  OS_KEYCHAIN: "GITHUB_SECRET_STORE_OS_KEYCHAIN",
  FILE_FALLBACK: "GITHUB_SECRET_STORE_FILE_FALLBACK",
} as const;
export type GithubSecretStore =
  (typeof GithubSecretStore)[keyof typeof GithubSecretStore];

export const GithubIssueState = {
  UNSPECIFIED: "GITHUB_ISSUE_STATE_UNSPECIFIED",
  OPEN: "GITHUB_ISSUE_STATE_OPEN",
  CLOSED: "GITHUB_ISSUE_STATE_CLOSED",
} as const;
export type GithubIssueState =
  (typeof GithubIssueState)[keyof typeof GithubIssueState];

export const GithubIssueStateReason = {
  UNSPECIFIED: "GITHUB_ISSUE_STATE_REASON_UNSPECIFIED",
  COMPLETED: "GITHUB_ISSUE_STATE_REASON_COMPLETED",
  NOT_PLANNED: "GITHUB_ISSUE_STATE_REASON_NOT_PLANNED",
  REOPENED: "GITHUB_ISSUE_STATE_REASON_REOPENED",
  DUPLICATE: "GITHUB_ISSUE_STATE_REASON_DUPLICATE",
} as const;
export type GithubIssueStateReason =
  (typeof GithubIssueStateReason)[keyof typeof GithubIssueStateReason];

export const GithubStatusSource = {
  UNSPECIFIED: "GITHUB_STATUS_SOURCE_UNSPECIFIED",
  NONE: "GITHUB_STATUS_SOURCE_NONE",
  LABEL: "GITHUB_STATUS_SOURCE_LABEL",
  PROJECT_FIELD: "GITHUB_STATUS_SOURCE_PROJECT_FIELD",
} as const;
export type GithubStatusSource =
  (typeof GithubStatusSource)[keyof typeof GithubStatusSource];

export const GithubWriteState = {
  UNSPECIFIED: "GITHUB_WRITE_STATE_UNSPECIFIED",
  APPLIED: "GITHUB_WRITE_STATE_APPLIED",
  PENDING: "GITHUB_WRITE_STATE_PENDING",
  FAILED: "GITHUB_WRITE_STATE_FAILED",
  CONFLICTED: "GITHUB_WRITE_STATE_CONFLICTED",
  SKIPPED: "GITHUB_WRITE_STATE_SKIPPED",
} as const;
export type GithubWriteState =
  (typeof GithubWriteState)[keyof typeof GithubWriteState];

export const GithubPullState = {
  UNSPECIFIED: "GITHUB_PULL_STATE_UNSPECIFIED",
  OPEN: "GITHUB_PULL_STATE_OPEN",
  CLOSED: "GITHUB_PULL_STATE_CLOSED",
  MERGED: "GITHUB_PULL_STATE_MERGED",
} as const;
export type GithubPullState =
  (typeof GithubPullState)[keyof typeof GithubPullState];

export const GithubMergeMethod = {
  UNSPECIFIED: "GITHUB_MERGE_METHOD_UNSPECIFIED",
  MERGE: "GITHUB_MERGE_METHOD_MERGE",
  SQUASH: "GITHUB_MERGE_METHOD_SQUASH",
  REBASE: "GITHUB_MERGE_METHOD_REBASE",
} as const;
export type GithubMergeMethod =
  (typeof GithubMergeMethod)[keyof typeof GithubMergeMethod];

export const GithubMergeableState = {
  UNSPECIFIED: "GITHUB_MERGEABLE_STATE_UNSPECIFIED",
  UNKNOWN: "GITHUB_MERGEABLE_STATE_UNKNOWN",
  MERGEABLE: "GITHUB_MERGEABLE_STATE_MERGEABLE",
  CONFLICTING: "GITHUB_MERGEABLE_STATE_CONFLICTING",
  BLOCKED: "GITHUB_MERGEABLE_STATE_BLOCKED",
} as const;
export type GithubMergeableState =
  (typeof GithubMergeableState)[keyof typeof GithubMergeableState];

export const GithubCheckConclusion = {
  UNSPECIFIED: "GITHUB_CHECK_CONCLUSION_UNSPECIFIED",
  PENDING: "GITHUB_CHECK_CONCLUSION_PENDING",
  SUCCESS: "GITHUB_CHECK_CONCLUSION_SUCCESS",
  FAILURE: "GITHUB_CHECK_CONCLUSION_FAILURE",
  NEUTRAL: "GITHUB_CHECK_CONCLUSION_NEUTRAL",
  CANCELLED: "GITHUB_CHECK_CONCLUSION_CANCELLED",
  SKIPPED: "GITHUB_CHECK_CONCLUSION_SKIPPED",
  TIMED_OUT: "GITHUB_CHECK_CONCLUSION_TIMED_OUT",
  ACTION_REQUIRED: "GITHUB_CHECK_CONCLUSION_ACTION_REQUIRED",
  STALE: "GITHUB_CHECK_CONCLUSION_STALE",
} as const;
export type GithubCheckConclusion =
  (typeof GithubCheckConclusion)[keyof typeof GithubCheckConclusion];

export const GithubReviewState = {
  UNSPECIFIED: "GITHUB_REVIEW_STATE_UNSPECIFIED",
  COMMENTED: "GITHUB_REVIEW_STATE_COMMENTED",
  APPROVED: "GITHUB_REVIEW_STATE_APPROVED",
  CHANGES_REQUESTED: "GITHUB_REVIEW_STATE_CHANGES_REQUESTED",
  DISMISSED: "GITHUB_REVIEW_STATE_DISMISSED",
  PENDING: "GITHUB_REVIEW_STATE_PENDING",
} as const;
export type GithubReviewState =
  (typeof GithubReviewState)[keyof typeof GithubReviewState];

export const GithubReferenceKind = {
  UNSPECIFIED: "GITHUB_REFERENCE_KIND_UNSPECIFIED",
  ISSUE: "GITHUB_REFERENCE_KIND_ISSUE",
  PULL_REQUEST: "GITHUB_REFERENCE_KIND_PULL_REQUEST",
} as const;
export type GithubReferenceKind =
  (typeof GithubReferenceKind)[keyof typeof GithubReferenceKind];

export const GithubReferenceTargetKind = {
  UNSPECIFIED: "GITHUB_REFERENCE_TARGET_KIND_UNSPECIFIED",
  SESSION: "GITHUB_REFERENCE_TARGET_KIND_SESSION",
  BRANCH: "GITHUB_REFERENCE_TARGET_KIND_BRANCH",
  WORKTREE: "GITHUB_REFERENCE_TARGET_KIND_WORKTREE",
} as const;
export type GithubReferenceTargetKind =
  (typeof GithubReferenceTargetKind)[keyof typeof GithubReferenceTargetKind];

/* -------------------------------------------------------------------------- */
/*                              解析的零件                                      */
/* -------------------------------------------------------------------------- */

/** 一张字段表用到的零件；两种实例化只在这些零件上不同。 */
interface Kit<I> {
  readonly int: z.ZodType<I>;
  readonly text: z.ZodType<string>;
  readonly flag: z.ZodType<boolean>;
  /** `github` | `gitea` | `gitlab`（契约 §29.6）；旧 core 不带，按 `github`。 */
  readonly forge: z.ZodType<string>;
  enumOf<T extends Record<string, string>>(values: T): z.ZodType<T[keyof T]>;
  list<T>(schema: z.ZodType<T>): z.ZodType<T[]>;
  obj<S extends z.ZodRawShape>(shape: S): z.ZodObject<S>;
}

/** 页面读回的零件：`int64` 回 `bigint`，缺什么补什么。 */
const decodeKit: Kit<bigint> = {
  int: z
    .union([z.string(), z.number(), z.bigint()])
    .transform((value) => BigInt(value))
    .catch(0n)
    .default(0n),
  text: z.string().catch("").default(""),
  flag: z.boolean().catch(false).default(false),
  forge: z.string().catch("github").default("github"),
  /**
   * 认不出来的名字落回 `UNSPECIFIED` 而不是让整条记录解析失败：core 比页面新一
   * 版时多出来的那个值，不该让一整页 Issue 消失。
   */
  enumOf<T extends Record<string, string>>(values: T): z.ZodType<T[keyof T]> {
    const known = new Set<string>(Object.values(values));
    const fallback = values.UNSPECIFIED as string;
    // `preprocess` 而不是 `transform`：后者跟着 `z.unknown()` 会让这个键变成可选，
    // 于是一条没带状态的记录解出来是 `undefined`——那正是这里要避免的那种「缺席」。
    return z.preprocess(
      (value) =>
        typeof value === "string" && known.has(value) ? value : fallback,
      z.string(),
    ) as unknown as z.ZodType<T[keyof T]>;
  },
  list: <T>(schema: z.ZodType<T>) =>
    z.array(schema).catch([]).default([]) as unknown as z.ZodType<T[]>,
  obj: (shape) => z.object(shape),
};

/** 线上的零件：不变换，枚举是名字，`int64` 是十进制字符串（容忍数字）。 */
const wireKit: Kit<string | number> = {
  int: z.union([z.string(), z.number()]),
  text: z.string(),
  flag: z.boolean(),
  forge: z.string(),
  enumOf: <T extends Record<string, string>>() =>
    z.string() as unknown as z.ZodType<T[keyof T]>,
  list: <T>(schema: z.ZodType<T>) =>
    z.array(schema) as unknown as z.ZodType<T[]>,
  obj: (shape) =>
    z.object(shape).catchall(jsonValueSchema) as unknown as z.ZodObject<
      typeof shape
    >,
};

/* -------------------------------------------------------------------------- */
/*                                  记录                                       */
/* -------------------------------------------------------------------------- */

function records<I>(k: Kit<I>) {
  const { int: bigint, text, flag, enumOf, list } = k;

  const githubRepositoryRefSchema = k.obj({
    owner: text,
    name: text,
    apiBase: text,
    host: text,
  });
  const githubUserSchema = k.obj({ login: text, id: bigint });
  const githubLabelSchema = k.obj({ name: text, color: text });
  const githubMilestoneSchema = k.obj({
    number: bigint,
    title: text,
  });
  const githubRateLimitSchema = k.obj({
    limit: bigint,
    remaining: bigint,
    resetsAtUnixMs: bigint,
    throttled: flag,
    retryAfterUnixMs: bigint,
  });
  const githubCredentialStatusSchema = k.obj({
    source: enumOf(GithubCredentialSource),
    store: enumOf(GithubSecretStore),
    available: flag,
    apiBase: text,
    enterprise: flag,
    accountLogin: text,
    tokenScopes: list(z.string()),
    checkedAtUnixMs: bigint,
    reasonCode: text,
    revision: bigint,
  });
  const githubRepositorySchema = k.obj({
    ref: githubRepositoryRefSchema.optional(),
    id: bigint,
    defaultBranch: text,
    private: flag,
    fork: flag,
    hasIssues: flag,
    allowedMergeMethods: list(enumOf(GithubMergeMethod)),
    permission: text,
    observedAtUnixMs: bigint,
  });
  const resolveGithubRepositoryResponseSchema = k.obj({
    repository: githubRepositorySchema.optional(),
    hostMismatch: flag,
    reasonCode: text,
    rateLimit: githubRateLimitSchema.optional(),
  });
  const githubIssueSchema = k.obj({
    repository: githubRepositoryRefSchema.optional(),
    number: bigint,
    id: bigint,
    title: text,
    body: text,
    state: enumOf(GithubIssueState),
    stateReason: enumOf(GithubIssueStateReason),
    author: githubUserSchema.optional(),
    assignees: list(githubUserSchema),
    labels: list(githubLabelSchema),
    milestone: githubMilestoneSchema.optional(),
    commentCount: bigint,
    createdAtUnixMs: bigint,
    updatedAtUnixMs: bigint,
    closedAtUnixMs: bigint,
    htmlUrl: text,
    statusGroupId: text,
    statusConflict: flag,
    observedAtUnixMs: bigint,
  });
  const githubCommentSchema = k.obj({
    id: bigint,
    author: githubUserSchema.optional(),
    body: text,
    createdAtUnixMs: bigint,
    updatedAtUnixMs: bigint,
    htmlUrl: text,
  });
  const githubIssueFilterSchema = k.obj({
    state: enumOf(GithubIssueState),
    labels: list(z.string()),
    assignee: text,
    author: text,
    milestoneNumber: bigint,
    query: text,
  });

  const githubStatusGroupSchema = k.obj({
    id: text,
    title: text,
    label: text,
    projectOptionId: text,
    couplesIssueState: enumOf(GithubIssueState),
  });
  const githubStateCouplingSchema = k.obj({
    state: enumOf(GithubIssueState),
    groupId: text,
  });
  const githubStatusMappingSchema = k.obj({
    repository: githubRepositoryRefSchema.optional(),
    source: enumOf(GithubStatusSource),
    projectId: text,
    projectFieldId: text,
    groups: list(githubStatusGroupSchema),
    stateGroups: list(githubStateCouplingSchema),
    revision: bigint,
    updatedAtUnixMs: bigint,
  });
  const githubWriteOutcomeSchema = k.obj({
    actionId: text,
    target: text,
    state: enumOf(GithubWriteState),
    reasonCode: text,
    previousValue: text,
    requestedValue: text,
  });
  const githubCheckRunSchema = k.obj({
    name: text,
    app: text,
    conclusion: enumOf(GithubCheckConclusion),
    detailsUrl: text,
    startedAtUnixMs: bigint,
    completedAtUnixMs: bigint,
    rerunnable: flag,
    workflowRunId: bigint,
  });
  const githubCheckSummarySchema = k.obj({
    headSha: text,
    runs: list(githubCheckRunSchema),
    rollup: enumOf(GithubCheckConclusion),
    observedAtUnixMs: bigint,
  });
  const githubReviewSchema = k.obj({
    id: bigint,
    author: githubUserSchema.optional(),
    state: enumOf(GithubReviewState),
    body: text,
    commitSha: text,
    submittedAtUnixMs: bigint,
  });
  const githubReviewCommentSchema = k.obj({
    id: bigint,
    author: githubUserSchema.optional(),
    body: text,
    path: text,
    commitSha: text,
    line: bigint,
    side: text,
    outdated: flag,
    createdAtUnixMs: bigint,
  });

  const githubPullFileSchema = k.obj({
    path: text,
    previousPath: text,
    status: text,
    additions: bigint,
    deletions: bigint,
    binary: flag,
    patch: text,
  });
  const githubPullRequestSchema = k.obj({
    repository: githubRepositoryRefSchema.optional(),
    number: bigint,
    id: bigint,
    title: text,
    body: text,
    state: enumOf(GithubPullState),
    draft: flag,
    author: githubUserSchema.optional(),
    baseRef: text,
    headRef: text,
    headSha: text,
    headRepoFullName: text,
    fromFork: flag,
    mergeable: enumOf(GithubMergeableState),
    allowedMergeMethods: list(enumOf(GithubMergeMethod)),
    additions: bigint,
    deletions: bigint,
    changedFiles: bigint,
    commits: bigint,
    requestedReviewers: list(githubUserSchema),
    labels: list(githubLabelSchema),
    createdAtUnixMs: bigint,
    updatedAtUnixMs: bigint,
    mergedAtUnixMs: bigint,
    closedAtUnixMs: bigint,
    htmlUrl: text,
    observedAtUnixMs: bigint,
  });
  const githubPullFilterSchema = k.obj({
    state: enumOf(GithubPullState),
    author: text,
    baseRef: text,
    reviewRequested: text,
    draftOnly: flag,
  });
  const githubExternalReferenceSchema = k.obj({
    referenceId: text,
    workspaceId: text,
    /** `github` | `gitea` | `gitlab`（契约 §29.6）；旧 core 不带，按 `github`。 */
    forge: k.forge,
    repository: githubRepositoryRefSchema.optional(),
    kind: enumOf(GithubReferenceKind),
    number: bigint,
    targetKind: enumOf(GithubReferenceTargetKind),
    targetId: text,
    title: text,
    revision: bigint,
    createdAtUnixMs: bigint,
    updatedAtUnixMs: bigint,
  });
  const listGithubIssuesResponseSchema = k.obj({
    issues: list(githubIssueSchema),
    nextCursor: text,
    hasMore: flag,
    rateLimit: githubRateLimitSchema.optional(),
    fromCache: flag,
    observedAtUnixMs: bigint,
    pollIntervalMs: bigint,
    statusGroupsPartial: flag,
  });
  const getGithubIssueResponseSchema = k.obj({
    issue: githubIssueSchema.optional(),
    comments: list(githubCommentSchema),
    references: list(githubExternalReferenceSchema),
    rateLimit: githubRateLimitSchema.optional(),
    pollIntervalMs: bigint,
  });
  const moveGithubIssueResponseSchema = k.obj({
    issue: githubIssueSchema.optional(),
    outcomes: list(githubWriteOutcomeSchema),
    rateLimit: githubRateLimitSchema.optional(),
  });
  const listGithubPullsResponseSchema = k.obj({
    pulls: list(githubPullRequestSchema),
    nextCursor: text,
    hasMore: flag,
    rateLimit: githubRateLimitSchema.optional(),
    fromCache: flag,
    observedAtUnixMs: bigint,
    pollIntervalMs: bigint,
  });
  const getGithubPullResponseSchema = k.obj({
    pull: githubPullRequestSchema.optional(),
    files: list(githubPullFileSchema),
    reviews: list(githubReviewSchema),
    reviewComments: list(githubReviewCommentSchema),
    comments: list(githubCommentSchema),
    checks: githubCheckSummarySchema.optional(),
    references: list(githubExternalReferenceSchema),
    rateLimit: githubRateLimitSchema.optional(),
    pollIntervalMs: bigint,
  });
  const mergeGithubPullResponseSchema = k.obj({
    merged: flag,
    mergeSha: text,
    reasonCode: text,
    pull: githubPullRequestSchema.optional(),
    checks: githubCheckSummarySchema.optional(),
  });
  const rerunGithubChecksResponseSchema = k.obj({
    outcomes: list(githubWriteOutcomeSchema),
    reasonCode: text,
    checks: githubCheckSummarySchema.optional(),
    rateLimit: githubRateLimitSchema.optional(),
  });
  const deleteGithubBranchResponseSchema = k.obj({
    deleted: flag,
    reasonCode: text,
  });
  const listGithubReferencesResponseSchema = k.obj({
    references: list(githubExternalReferenceSchema),
    nextId: text,
    hasMore: flag,
  });
  const unlinkGithubReferenceResponseSchema = k.obj({
    referenceId: text,
    unlinked: flag,
  });

  return {
    githubRepositoryRefSchema,
    githubUserSchema,
    githubLabelSchema,
    githubMilestoneSchema,
    githubRateLimitSchema,
    githubCredentialStatusSchema,
    githubRepositorySchema,
    resolveGithubRepositoryResponseSchema,
    githubIssueSchema,
    githubCommentSchema,
    githubIssueFilterSchema,
    githubStatusGroupSchema,
    githubStateCouplingSchema,
    githubStatusMappingSchema,
    githubWriteOutcomeSchema,
    githubCheckRunSchema,
    githubCheckSummarySchema,
    githubReviewSchema,
    githubReviewCommentSchema,
    githubPullFileSchema,
    githubPullRequestSchema,
    githubPullFilterSchema,
    githubExternalReferenceSchema,
    listGithubIssuesResponseSchema,
    getGithubIssueResponseSchema,
    moveGithubIssueResponseSchema,
    listGithubPullsResponseSchema,
    getGithubPullResponseSchema,
    mergeGithubPullResponseSchema,
    rerunGithubChecksResponseSchema,
    deleteGithubBranchResponseSchema,
    listGithubReferencesResponseSchema,
    unlinkGithubReferenceResponseSchema,
  };
}

const decoded = records(decodeKit);
const wire = records(wireKit);

/* 页面读回的形状 */
export const githubRepositoryRefSchema = decoded.githubRepositoryRefSchema;
export const githubUserSchema = decoded.githubUserSchema;
export const githubLabelSchema = decoded.githubLabelSchema;
export const githubMilestoneSchema = decoded.githubMilestoneSchema;
export const githubRateLimitSchema = decoded.githubRateLimitSchema;
export const githubCredentialStatusSchema =
  decoded.githubCredentialStatusSchema;
export const githubRepositorySchema = decoded.githubRepositorySchema;
export const resolveGithubRepositoryResponseSchema =
  decoded.resolveGithubRepositoryResponseSchema;
export const githubIssueSchema = decoded.githubIssueSchema;
export const githubCommentSchema = decoded.githubCommentSchema;
export const githubIssueFilterSchema = decoded.githubIssueFilterSchema;
export const githubStatusGroupSchema = decoded.githubStatusGroupSchema;
export const githubStateCouplingSchema = decoded.githubStateCouplingSchema;
export const githubStatusMappingSchema = decoded.githubStatusMappingSchema;
export const githubWriteOutcomeSchema = decoded.githubWriteOutcomeSchema;
export const githubCheckRunSchema = decoded.githubCheckRunSchema;
export const githubCheckSummarySchema = decoded.githubCheckSummarySchema;
export const githubReviewSchema = decoded.githubReviewSchema;
export const githubReviewCommentSchema = decoded.githubReviewCommentSchema;
export const githubPullFileSchema = decoded.githubPullFileSchema;
export const githubPullRequestSchema = decoded.githubPullRequestSchema;
export const githubPullFilterSchema = decoded.githubPullFilterSchema;
export const githubExternalReferenceSchema =
  decoded.githubExternalReferenceSchema;
export const listGithubIssuesResponseSchema =
  decoded.listGithubIssuesResponseSchema;
export const getGithubIssueResponseSchema =
  decoded.getGithubIssueResponseSchema;
export const moveGithubIssueResponseSchema =
  decoded.moveGithubIssueResponseSchema;
export const listGithubPullsResponseSchema =
  decoded.listGithubPullsResponseSchema;
export const getGithubPullResponseSchema = decoded.getGithubPullResponseSchema;
export const mergeGithubPullResponseSchema =
  decoded.mergeGithubPullResponseSchema;
export const rerunGithubChecksResponseSchema =
  decoded.rerunGithubChecksResponseSchema;
export const deleteGithubBranchResponseSchema =
  decoded.deleteGithubBranchResponseSchema;
export const listGithubReferencesResponseSchema =
  decoded.listGithubReferencesResponseSchema;
export const unlinkGithubReferenceResponseSchema =
  decoded.unlinkGithubReferenceResponseSchema;

/* 线上的形状（契约出参） */
export const githubRepositoryRefWireSchema = wire.githubRepositoryRefSchema;
export const githubUserWireSchema = wire.githubUserSchema;
export const githubLabelWireSchema = wire.githubLabelSchema;
export const githubMilestoneWireSchema = wire.githubMilestoneSchema;
export const githubRateLimitWireSchema = wire.githubRateLimitSchema;
export const githubCredentialStatusWireSchema =
  wire.githubCredentialStatusSchema;
export const githubRepositoryWireSchema = wire.githubRepositorySchema;
export const resolveGithubRepositoryResponseWireSchema =
  wire.resolveGithubRepositoryResponseSchema;
export const githubIssueWireSchema = wire.githubIssueSchema;
export const githubCommentWireSchema = wire.githubCommentSchema;
export const githubIssueFilterWireSchema = wire.githubIssueFilterSchema;
export const githubStatusGroupWireSchema = wire.githubStatusGroupSchema;
export const githubStateCouplingWireSchema = wire.githubStateCouplingSchema;
export const githubStatusMappingWireSchema = wire.githubStatusMappingSchema;
export const githubWriteOutcomeWireSchema = wire.githubWriteOutcomeSchema;
export const githubCheckRunWireSchema = wire.githubCheckRunSchema;
export const githubCheckSummaryWireSchema = wire.githubCheckSummarySchema;
export const githubReviewWireSchema = wire.githubReviewSchema;
export const githubReviewCommentWireSchema = wire.githubReviewCommentSchema;
export const githubPullFileWireSchema = wire.githubPullFileSchema;
export const githubPullRequestWireSchema = wire.githubPullRequestSchema;
export const githubPullFilterWireSchema = wire.githubPullFilterSchema;
export const githubExternalReferenceWireSchema =
  wire.githubExternalReferenceSchema;
export const listGithubIssuesResponseWireSchema =
  wire.listGithubIssuesResponseSchema;
export const getGithubIssueResponseWireSchema =
  wire.getGithubIssueResponseSchema;
export const moveGithubIssueResponseWireSchema =
  wire.moveGithubIssueResponseSchema;
export const listGithubPullsResponseWireSchema =
  wire.listGithubPullsResponseSchema;
export const getGithubPullResponseWireSchema = wire.getGithubPullResponseSchema;
export const mergeGithubPullResponseWireSchema =
  wire.mergeGithubPullResponseSchema;
export const rerunGithubChecksResponseWireSchema =
  wire.rerunGithubChecksResponseSchema;
export const deleteGithubBranchResponseWireSchema =
  wire.deleteGithubBranchResponseSchema;
export const listGithubReferencesResponseWireSchema =
  wire.listGithubReferencesResponseSchema;
export const unlinkGithubReferenceResponseWireSchema =
  wire.unlinkGithubReferenceResponseSchema;

export type GithubRepositoryRef = z.infer<typeof githubRepositoryRefSchema>;
export type GithubUser = z.infer<typeof githubUserSchema>;
export type GithubLabel = z.infer<typeof githubLabelSchema>;
export type GithubMilestone = z.infer<typeof githubMilestoneSchema>;
export type GithubRateLimit = z.infer<typeof githubRateLimitSchema>;
export type GithubCredentialStatus = z.infer<
  typeof githubCredentialStatusSchema
>;
export type GithubRepository = z.infer<typeof githubRepositorySchema>;
export type ResolveGithubRepositoryResponse = z.infer<
  typeof resolveGithubRepositoryResponseSchema
>;
export type GithubIssue = z.infer<typeof githubIssueSchema>;
export type GithubComment = z.infer<typeof githubCommentSchema>;
export type GithubIssueFilter = z.infer<typeof githubIssueFilterSchema>;
export type GithubStatusGroup = z.infer<typeof githubStatusGroupSchema>;
export type GithubStateCoupling = z.infer<typeof githubStateCouplingSchema>;
export type GithubStatusMapping = z.infer<typeof githubStatusMappingSchema>;
export type GithubWriteOutcome = z.infer<typeof githubWriteOutcomeSchema>;
export type GithubCheckRun = z.infer<typeof githubCheckRunSchema>;
export type GithubCheckSummary = z.infer<typeof githubCheckSummarySchema>;
export type GithubReview = z.infer<typeof githubReviewSchema>;
export type GithubReviewComment = z.infer<typeof githubReviewCommentSchema>;
export type GithubPullFile = z.infer<typeof githubPullFileSchema>;
export type GithubPullRequest = z.infer<typeof githubPullRequestSchema>;
export type GithubPullFilter = z.infer<typeof githubPullFilterSchema>;
export type GithubExternalReference = z.infer<
  typeof githubExternalReferenceSchema
>;
export type ListGithubIssuesResponse = z.infer<
  typeof listGithubIssuesResponseSchema
>;
export type GetGithubIssueResponse = z.infer<
  typeof getGithubIssueResponseSchema
>;
export type MoveGithubIssueResponse = z.infer<
  typeof moveGithubIssueResponseSchema
>;
export type ListGithubPullsResponse = z.infer<
  typeof listGithubPullsResponseSchema
>;
export type GetGithubPullResponse = z.infer<typeof getGithubPullResponseSchema>;
export type MergeGithubPullResponse = z.infer<
  typeof mergeGithubPullResponseSchema
>;
export type RerunGithubChecksResponse = z.infer<
  typeof rerunGithubChecksResponseSchema
>;
export type DeleteGithubBranchResponse = z.infer<
  typeof deleteGithubBranchResponseSchema
>;
export type ListGithubReferencesResponse = z.infer<
  typeof listGithubReferencesResponseSchema
>;
export type UnlinkGithubReferenceResponse = z.infer<
  typeof unlinkGithubReferenceResponseSchema
>;

/** 只写出现的字段。标签与指派人整组替换时才带 `replace*`。 */
export interface GithubIssuePatch {
  title?: string;
  body?: string;
  replaceLabels: boolean;
  labels: string[];
  replaceAssignees: boolean;
  assignees: string[];
  milestoneNumber?: bigint;
}

/** 一条还没提交的行内评审意见。 */
export interface GithubReviewCommentDraft {
  path: string;
  line: bigint;
  side: string;
  body: string;
}
