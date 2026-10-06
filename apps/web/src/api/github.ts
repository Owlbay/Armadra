/**
 * GitHub 面板对 core 的调用面 —— `github.*` procedure（契约 §41.1）。
 *
 * ## 线上的形状
 *
 * 形状逐字段写在 `docs/contracts/core-json-api.md` §2 与 §5：
 * 字段名 camelCase、`int64` / `uint64` 是十进制**字符串**、枚举是枚举值名、零值
 * 照写。记录与枚举住在 `packages/shared/src/api/github.ts`（同一张字段表实例化
 * 两次：契约出参读的是线上那份，这里读的是把 `int64` 解回 `bigint` 的那份）。
 *
 * **`bigint` 保留**不是惯性：Issue 与 PR 的编号、时间戳和 id 都是 64 位，
 * `number` 在 2^53 之上会悄悄改值，而一条被改了 id 的评论会被贴到别人的行上。
 * 入参里的 `bigint` 在这里按线上形状换成十进制字符串再发。
 *
 * ## 三条和 `request.ts` 一致的规矩
 *
 * 每个响应过 zod；连不上 core 与 core 报错是两类失败；这里不做缓存与重试。
 * 额外一条：域错误的 `code` 被翻成 {@link GithubApiError} 的 `failure`，因为面板
 * 要按「该怎么修」分支，而不是按 HTTP 状态。
 *
 * 客户端由 `api/client.ts` 交进来（这个模块被它 import，反过来 import 它就是一个
 * 环）：{@link githubApiFor} 给 `openGithub(workspaceId, source?)`，缺省发往当前源。
 */

import {
  type GithubIssuePatch,
  type GithubReviewCommentDraft,
  GithubCheckConclusion,
  GithubCredentialSource,
  GithubIssueState,
  GithubIssueStateReason,
  GithubMergeMethod,
  GithubMergeableState,
  GithubPullState,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubReviewState,
  GithubSecretStore,
  GithubStatusSource,
  GithubWriteState,
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
  type GithubRepositoryRef,
  type GithubUser,
  type GithubLabel,
  type GithubMilestone,
  type GithubRateLimit,
  type GithubCredentialStatus,
  type GithubRepository,
  type ResolveGithubRepositoryResponse,
  type GithubIssue,
  type GithubComment,
  type GithubIssueFilter,
  type GithubStatusGroup,
  type GithubStateCoupling,
  type GithubStatusMapping,
  type GithubWriteOutcome,
  type GithubCheckRun,
  type GithubCheckSummary,
  type GithubReview,
  type GithubReviewComment,
  type GithubPullFile,
  type GithubPullRequest,
  type GithubPullFilter,
  type GithubExternalReference,
  type ListGithubIssuesResponse,
  type GetGithubIssueResponse,
  type MoveGithubIssueResponse,
  type ListGithubPullsResponse,
  type GetGithubPullResponse,
  type MergeGithubPullResponse,
  type RerunGithubChecksResponse,
  type DeleteGithubBranchResponse,
  type ListGithubReferencesResponse,
  type UnlinkGithubReferenceResponse,
} from "@armadra/shared";
import { z } from "zod";

import type { ArmadraClient } from "./client";
import type { Source } from "./source";
import { RuntimeConnectionError, RuntimeRequestError } from "./request";

/** 记录、枚举与解析零件住在 shared；这里原样再导出，调用点的 import 不变。 */
export {
  GithubCheckConclusion,
  GithubCredentialSource,
  GithubIssueState,
  GithubIssueStateReason,
  GithubMergeMethod,
  GithubMergeableState,
  GithubPullState,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubReviewState,
  GithubSecretStore,
  GithubStatusSource,
  GithubWriteState,
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
export type {
  GithubIssuePatch,
  GithubReviewCommentDraft,
  GithubRepositoryRef,
  GithubUser,
  GithubLabel,
  GithubMilestone,
  GithubRateLimit,
  GithubCredentialStatus,
  GithubRepository,
  ResolveGithubRepositoryResponse,
  GithubIssue,
  GithubComment,
  GithubIssueFilter,
  GithubStatusGroup,
  GithubStateCoupling,
  GithubStatusMapping,
  GithubWriteOutcome,
  GithubCheckRun,
  GithubCheckSummary,
  GithubReview,
  GithubReviewComment,
  GithubPullFile,
  GithubPullRequest,
  GithubPullFilter,
  GithubExternalReference,
  ListGithubIssuesResponse,
  GetGithubIssueResponse,
  MoveGithubIssueResponse,
  ListGithubPullsResponse,
  GetGithubPullResponse,
  MergeGithubPullResponse,
  RerunGithubChecksResponse,
  DeleteGithubBranchResponse,
  ListGithubReferencesResponse,
  UnlinkGithubReferenceResponse,
};

/* -------------------------------------------------------------------------- */
/*                              空记录的工厂                                    */
/* -------------------------------------------------------------------------- */

/**
 * 一份全零的记录，可选地盖上几个字段。
 *
 * 取代从前的 `create(XSchema, { … })`：protobuf-es 的 `create` 做的就是这件事
 * ——把没给的标量字段填成零值。所以这里是同一个语义，只是不需要一份 schema 描述符。
 */
const zero =
  <T>(base: T) =>
  (init: Partial<T> = {}): T => ({ ...base, ...init });

export const githubRepositoryRef = zero<GithubRepositoryRef>({
  owner: "",
  name: "",
  apiBase: "",
  host: "",
});

export const githubIssueFilter = zero<GithubIssueFilter>({
  state: GithubIssueState.UNSPECIFIED,
  labels: [],
  assignee: "",
  author: "",
  milestoneNumber: 0n,
  query: "",
});

export const githubPullFilter = zero<GithubPullFilter>({
  state: GithubPullState.UNSPECIFIED,
  author: "",
  baseRef: "",
  reviewRequested: "",
  draftOnly: false,
});

export const githubIssuePatch = zero<GithubIssuePatch>({
  replaceLabels: false,
  labels: [],
  replaceAssignees: false,
  assignees: [],
});

export const githubStatusGroup = zero<GithubStatusGroup>({
  id: "",
  title: "",
  label: "",
  projectOptionId: "",
  couplesIssueState: GithubIssueState.UNSPECIFIED,
});

export const githubStateCoupling = zero<GithubStateCoupling>({
  state: GithubIssueState.UNSPECIFIED,
  groupId: "",
});

export const githubStatusMapping = zero<GithubStatusMapping>({
  source: GithubStatusSource.UNSPECIFIED,
  projectId: "",
  projectFieldId: "",
  groups: [],
  stateGroups: [],
  revision: 0n,
  updatedAtUnixMs: 0n,
});

export const githubExternalReference = zero<GithubExternalReference>({
  referenceId: "",
  workspaceId: "",
  forge: "github",
  kind: GithubReferenceKind.UNSPECIFIED,
  number: 0n,
  targetKind: GithubReferenceTargetKind.UNSPECIFIED,
  targetId: "",
  title: "",
  revision: 0n,
  createdAtUnixMs: 0n,
  updatedAtUnixMs: 0n,
});

export const githubIssue = zero<GithubIssue>({
  number: 0n,
  id: 0n,
  title: "",
  body: "",
  state: GithubIssueState.UNSPECIFIED,
  stateReason: GithubIssueStateReason.UNSPECIFIED,
  assignees: [],
  labels: [],
  commentCount: 0n,
  createdAtUnixMs: 0n,
  updatedAtUnixMs: 0n,
  closedAtUnixMs: 0n,
  htmlUrl: "",
  statusGroupId: "",
  statusConflict: false,
  observedAtUnixMs: 0n,
});

export const githubPullRequest = zero<GithubPullRequest>({
  number: 0n,
  id: 0n,
  title: "",
  body: "",
  state: GithubPullState.UNSPECIFIED,
  draft: false,
  baseRef: "",
  headRef: "",
  headSha: "",
  headRepoFullName: "",
  fromFork: false,
  mergeable: GithubMergeableState.UNSPECIFIED,
  allowedMergeMethods: [],
  additions: 0n,
  deletions: 0n,
  changedFiles: 0n,
  commits: 0n,
  requestedReviewers: [],
  labels: [],
  createdAtUnixMs: 0n,
  updatedAtUnixMs: 0n,
  mergedAtUnixMs: 0n,
  closedAtUnixMs: 0n,
  htmlUrl: "",
  observedAtUnixMs: 0n,
});

export const resolveGithubRepositoryResponse =
  zero<ResolveGithubRepositoryResponse>({
    hostMismatch: false,
    reasonCode: "",
  });

export const githubRepository = zero<GithubRepository>({
  id: 0n,
  defaultBranch: "",
  private: false,
  fork: false,
  hasIssues: false,
  allowedMergeMethods: [],
  permission: "",
  observedAtUnixMs: 0n,
});

export const githubCredentialStatus = zero<GithubCredentialStatus>({
  source: GithubCredentialSource.UNSPECIFIED,
  store: GithubSecretStore.UNSPECIFIED,
  available: false,
  apiBase: "",
  enterprise: false,
  accountLogin: "",
  tokenScopes: [],
  checkedAtUnixMs: 0n,
  reasonCode: "",
  revision: 0n,
});

export const githubCheckRun = zero<GithubCheckRun>({
  name: "",
  app: "",
  conclusion: GithubCheckConclusion.UNSPECIFIED,
  detailsUrl: "",
  startedAtUnixMs: 0n,
  completedAtUnixMs: 0n,
  rerunnable: false,
  workflowRunId: 0n,
});

export const githubCheckSummary = zero<GithubCheckSummary>({
  headSha: "",
  runs: [],
  rollup: GithubCheckConclusion.UNSPECIFIED,
  observedAtUnixMs: 0n,
});

export const githubReviewComment = zero<GithubReviewComment>({
  id: 0n,
  body: "",
  path: "",
  commitSha: "",
  line: 0n,
  side: "",
  outdated: false,
  createdAtUnixMs: 0n,
});

/* -------------------------------------------------------------------------- */
/*                                  错误                                       */
/* -------------------------------------------------------------------------- */

/**
 * 出了什么事，按**面板能做什么**分档。
 *
 * `rateLimited` 和 `network` 分开，因为前者的修法是等；`unsupported` 和
 * `permission` 分开，因为一个是「这台 core 没有 GitHub 凭据」，另一个是「这台
 * 设备不能用它」。档位与从前的 `HostGithubError.failure` 逐个对齐。
 */
export type GithubApiFailure =
  | "invalid"
  | "unauthenticated"
  | "permission"
  | "unsupported"
  | "notFound"
  | "conflict"
  | "rateLimited"
  | "response"
  | "cancelled"
  | "network";

export class GithubApiError extends Error {
  readonly name = "GithubApiError";
  constructor(
    readonly failure: GithubApiFailure,
    /** 一次到达了 core 而结果没有被读到的写。永远不降级成「失败」。 */
    readonly outcomeUnknown = false,
    readonly httpStatus?: number,
    readonly hostCode?: string,
  ) {
    super(`GitHub request failed (${failure}).`);
  }
}

/**
 * 传输层的拒绝 → 一次修复。
 *
 * 认不出来的 `code` 留在 `network`，不软化成 `invalid`：一次结果没被读到的写必须
 * 让调用方重新读，而不是重试。
 */
export function classifyGithubFailure(error: unknown): GithubApiError {
  if (error instanceof GithubApiError) return error;
  if (error instanceof RuntimeConnectionError)
    return new GithubApiError("network");
  if (!(error instanceof RuntimeRequestError))
    return new GithubApiError("network");
  const code = error.code ?? "";
  const fail = (failure: GithubApiFailure, outcomeUnknown = false) =>
    new GithubApiError(failure, outcomeUnknown, error.status, code);
  // 码是 snake_case（契约 §41.1）；从前的大写拼法再认一个 minor。
  switch (code) {
    case "unauthenticated":
    case "UNAUTHENTICATED":
      return fail("unauthenticated");
    case "forbidden":
    case "PERMISSION_DENIED":
      return fail("permission");
    case "unsupported":
    case "UNSUPPORTED":
    // 没装配 GitHub 域的 core：procedure 没实现。
    case "not_implemented":
      return fail("unsupported");
    case "not_found":
    case "NOT_FOUND":
      return fail("notFound");
    case "conflict":
    case "CONFLICT":
      return fail("conflict");
    case "rate_limited":
    case "RESOURCE_EXHAUSTED":
      return fail("rateLimited");
    case "bad_request":
    case "INVALID_ARGUMENT":
      return fail("invalid");
    case "unknown_outcome":
    case "UNKNOWN_OUTCOME":
      return fail("network", true);
    default:
      return fail("network");
  }
}

/* -------------------------------------------------------------------------- */
/*                                  客户端                                     */
/* -------------------------------------------------------------------------- */

/** `bigint` 在 JSON 里是十进制字符串——`JSON.stringify` 自己不认它。 */
function body(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

/** 一页最多一百条：再多的正文装不进一次合理的响应。 */
export const MAX_PAGE = 100;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export interface GithubApiOptions {
  readonly workspaceId: string;
  /** 这一面发往哪个源的客户端；每次调用时才取，所以换了源后面的调用跟着换。 */
  readonly rpc: () => ArmadraClient;
}

/**
 * core 的 GitHub 面，带类型。
 *
 * 没有任何方法见得到令牌：凭据在 core 手里，这里只说要操作哪个仓库。响应在到达
 * 界面之前过一遍 zod——一份半解开的 PR 画在合并按钮旁边，等于替 core 说了它没说
 * 过的话。
 */
export class GithubApi {
  readonly #workspaceId: string;
  readonly #rpc: () => ArmadraClient;

  constructor(options: GithubApiOptions) {
    if (!idPattern.test(options?.workspaceId ?? "")) {
      throw new GithubApiError("invalid");
    }
    this.#workspaceId = options.workspaceId;
    this.#rpc = options.rpc;
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  async #call<T>(
    procedure: keyof ArmadraClient["github"],
    input: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      const call = this.#rpc().github[procedure] as (
        input: unknown,
      ) => Promise<unknown>;
      // 线上的 `int64` 是十进制字符串：`bigint` 先换掉，门面再按 JSON 编码。
      const wire = JSON.parse(body(input ?? {})) as Record<string, unknown>;
      return schema.parse(
        await call({ ...wire, workspaceId: this.#workspaceId }),
      );
    } catch (error) {
      if (error instanceof z.ZodError) throw new GithubApiError("response");
      throw classifyGithubFailure(error);
    }
  }

  /* ------------------------------------------------------------ 凭据 */

  /** 从不返回令牌；只说配了哪一种来源，以及它现在能不能用。 */
  getCredential(): Promise<GithubCredentialStatus> {
    return this.#call("getCredential", {}, githubCredentialStatusSchema);
  }

  /**
   * `token` 是这一面上唯一会外发的值，而且只对 TOKEN_REF。它不在这里留存，
   * core 答的是一份状态，不是一次回声。
   */
  configureCredential(input: {
    source: GithubCredentialSource;
    token?: string;
    apiBase?: string;
    expectedRevision: bigint;
  }): Promise<GithubCredentialStatus> {
    return this.#call(
      "configureCredential",
      {
        source: input.source,
        token: input.token ?? "",
        apiBase: input.apiBase ?? "",
        expectedRevision: input.expectedRevision,
      },
      githubCredentialStatusSchema,
    );
  }

  revokeCredential(input: {
    expectedRevision: bigint;
  }): Promise<GithubCredentialStatus> {
    return this.#call(
      "revokeCredential",
      { expectedRevision: input.expectedRevision },
      githubCredentialStatusSchema,
    );
  }

  /* ------------------------------------------------------------ 仓库 */

  resolveRepository(
    remoteUrl: string,
  ): Promise<ResolveGithubRepositoryResponse> {
    return this.#call(
      "resolveRepository",
      { remoteUrl },
      resolveGithubRepositoryResponseSchema,
    );
  }

  /* ------------------------------------------------------------ Issue */

  listIssues(input: {
    repository: GithubRepositoryRef;
    filter?: GithubIssueFilter;
    afterCursor?: string;
    limit?: number;
  }): Promise<ListGithubIssuesResponse> {
    return this.#call(
      "listIssues",
      {
        repository: input.repository,
        filter: input.filter,
        afterCursor: input.afterCursor ?? "",
        limit: Math.min(input.limit ?? MAX_PAGE, MAX_PAGE),
      },
      listGithubIssuesResponseSchema,
    );
  }

  getIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GetGithubIssueResponse> {
    return this.#call("getIssue", input, getGithubIssueResponseSchema);
  }

  createIssue(input: {
    repository: GithubRepositoryRef;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    milestoneNumber?: bigint;
  }): Promise<GithubIssue> {
    return this.#call(
      "createIssue",
      {
        repository: input.repository,
        title: input.title,
        body: input.body ?? "",
        labels: input.labels ?? [],
        assignees: input.assignees ?? [],
        milestoneNumber: input.milestoneNumber ?? 0n,
      },
      githubIssueSchema,
    );
  }

  /**
   * GitHub 没有原子版本锁，所以调用方把它显示过的 `updatedAt` 带上，core 写之前
   * 再读一次。
   */
  updateIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    patch: GithubIssuePatch;
    expectedUpdatedAtUnixMs: bigint;
  }): Promise<GithubIssue> {
    return this.#call("updateIssue", input, githubIssueSchema);
  }

  /** 关闭与重开。移动到 Done 组是另一个调用，这是刻意的。 */
  setIssueState(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    state: GithubIssueState;
    reason?: GithubIssueStateReason;
    expectedUpdatedAtUnixMs: bigint;
  }): Promise<GithubIssue> {
    return this.#call(
      "setIssueState",
      { ...input, reason: input.reason ?? GithubIssueStateReason.UNSPECIFIED },
      githubIssueSchema,
    );
  }

  commentIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    body: string;
  }): Promise<GithubComment> {
    return this.#call("commentIssue", input, githubCommentSchema);
  }

  /* ------------------------------------------------------------ 状态映射 */

  getStatusMapping(
    repository: GithubRepositoryRef,
  ): Promise<GithubStatusMapping> {
    return this.#call(
      "getStatusMapping",
      { repository },
      githubStatusMappingSchema,
    );
  }

  putStatusMapping(input: {
    mapping: GithubStatusMapping;
    expectedRevision: bigint;
  }): Promise<GithubStatusMapping> {
    return this.#call("putStatusMapping", input, githubStatusMappingSchema);
  }

  /** 在配置好的组之间移动一条 Issue；其余标签一个不动。 */
  moveIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    toGroupId: string;
    fromGroupId?: string;
    expectedUpdatedAtUnixMs: bigint;
    expectedMappingRevision: bigint;
  }): Promise<MoveGithubIssueResponse> {
    return this.#call(
      "moveIssue",
      { ...input, fromGroupId: input.fromGroupId ?? "" },
      moveGithubIssueResponseSchema,
    );
  }

  /* ------------------------------------------------------------ PR */

  listPulls(input: {
    repository: GithubRepositoryRef;
    filter?: GithubPullFilter;
    afterCursor?: string;
    limit?: number;
  }): Promise<ListGithubPullsResponse> {
    return this.#call(
      "listPulls",
      {
        repository: input.repository,
        filter: input.filter,
        afterCursor: input.afterCursor ?? "",
        limit: Math.min(input.limit ?? MAX_PAGE, MAX_PAGE),
      },
      listGithubPullsResponseSchema,
    );
  }

  getPull(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GetGithubPullResponse> {
    return this.#call("getPull", input, getGithubPullResponseSchema);
  }

  createPull(input: {
    repository: GithubRepositoryRef;
    baseRef: string;
    headRef: string;
    title: string;
    body?: string;
    draft?: boolean;
    linkedIssueNumber?: bigint;
    expectedHeadSha?: string;
  }): Promise<GithubPullRequest> {
    return this.#call(
      "createPull",
      {
        ...input,
        body: input.body ?? "",
        draft: input.draft ?? false,
        linkedIssueNumber: input.linkedIssueNumber ?? 0n,
        expectedHeadSha: input.expectedHeadSha ?? "",
      },
      githubPullRequestSchema,
    );
  }

  submitReview(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    commitSha: string;
    state: GithubReviewState;
    body?: string;
    comments?: GithubReviewCommentDraft[];
  }): Promise<GithubReview> {
    return this.#call(
      "submitReview",
      { ...input, body: input.body ?? "", comments: input.comments ?? [] },
      githubReviewSchema,
    );
  }

  getChecks(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GithubCheckSummary> {
    return this.#call("getChecks", input, githubCheckSummarySchema);
  }

  /**
   * 按面板显示过的那个 head 合并。把读者看到的检查汇总一起带上，core 才能在检查
   * 变了的时候拒绝——本地一屏绿色不是远端仍然会接受这次合并的承诺。
   */
  mergePull(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    expectedHeadSha: string;
    method: GithubMergeMethod;
    commitTitle?: string;
    commitMessage?: string;
    expectedCheckRollup?: GithubCheckConclusion;
  }): Promise<MergeGithubPullResponse> {
    return this.#call(
      "mergePull",
      {
        ...input,
        commitTitle: input.commitTitle ?? "",
        commitMessage: input.commitMessage ?? "",
        expectedCheckRollup:
          input.expectedCheckRollup ?? GithubCheckConclusion.UNSPECIFIED,
      },
      mergeGithubPullResponseSchema,
    );
  }

  /** 重跑面板显示过的那个 head 上可重跑的检查。 */
  rerunChecks(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    expectedHeadSha: string;
    checkName?: string;
    failedOnly?: boolean;
  }): Promise<RerunGithubChecksResponse> {
    return this.#call(
      "rerunChecks",
      {
        ...input,
        checkName: input.checkName ?? "",
        failedOnly: input.failedOnly ?? false,
      },
      rerunGithubChecksResponseSchema,
    );
  }

  /** 删一条远端分支。和合并分开：清理是读者的决定，而且它不碰本地任何东西。 */
  deleteBranch(input: {
    repository: GithubRepositoryRef;
    branch: string;
    expectedSha: string;
  }): Promise<DeleteGithubBranchResponse> {
    return this.#call("deleteBranch", input, deleteGithubBranchResponseSchema);
  }

  /* ------------------------------------------------------------ 连接 */

  linkReference(input: {
    reference: GithubExternalReference;
    expectedRevision: bigint;
  }): Promise<GithubExternalReference> {
    return this.#call("linkReference", input, githubExternalReferenceSchema);
  }

  async unlinkReference(input: {
    referenceId: string;
    expectedRevision: bigint;
  }): Promise<void> {
    await this.#call(
      "unlinkReference",
      input,
      unlinkGithubReferenceResponseSchema,
    );
  }

  listReferences(
    input: { targetId?: string; afterId?: string; limit?: number } = {},
  ): Promise<ListGithubReferencesResponse> {
    return this.#call(
      "listReferences",
      {
        targetId: input.targetId ?? "",
        afterId: input.afterId ?? "",
        limit: Math.min(input.limit ?? MAX_PAGE, MAX_PAGE),
      },
      listGithubReferencesResponseSchema,
    );
  }
}

/**
 * 一块工作空间上的 GitHub 面。工作空间不合法就在这里被拒；`source` 缺省是当前源。
 * 客户端由 `api/client.ts` 交进来。
 */
export const githubApiFor = (rpc: (source?: Source) => ArmadraClient) => ({
  openGithub: (workspaceId: string, source?: Source) =>
    new GithubApi({ workspaceId, rpc: () => rpc(source) }),
});
