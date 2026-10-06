/**
 * GitHub 域的两层错误：传输层的 {@link GithubApiError} 和域层的
 * {@link GithubError}。
 *
 * 移植自合并前实现的错误码与那组错误定义。分成两层不是为了整齐：传输层知道
 * 的是 HTTP 状态和一个稳定的机器原因，域层知道的是**调用方该做什么**——重新登录、
 * 等一会、重新读一遍版本，还是告诉用户。把两者合并会让「403 是没权限」和
 * 「403 是次级限流」变成同一个答案，而它们的修法不一样。
 *
 * 远端散文永远不往外传：Issue 正文、评论、错误消息都是外部服务上受攻击者影响的
 * 文本，只有本文件里写死的那些原因码会到达客户端。
 */

/** 传输层对一次远端拒绝的解读。刻意不是 HTTP 状态。 */
export type GithubCode =
  | "INVALID_ARGUMENT"
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RESOURCE_EXHAUSTED"
  | "UNAVAILABLE"
  /**
   * 请求离开了这个进程而结果没有被读到。**永远不降级成失败**——重试可能会重复
   * 一条评论、一次评审或一次合并。
   */
  | "UNKNOWN_OUTCOME"
  | "UNSUPPORTED";

export class GithubApiError extends Error {
  constructor(
    readonly code: GithubCode,
    readonly status: number,
    readonly reason: string,
  ) {
    super(`github ${code} (status ${status}, ${reason})`);
    this.name = "GithubApiError";
  }
}

export function apiFailure(
  code: GithubCode,
  status: number,
  reason: string,
): GithubApiError {
  return new GithubApiError(code, status, reason);
}

/** 这个错误的传输层解读，不是本包产生的就是 `undefined`。 */
export function codeOf(error: unknown): GithubCode | undefined {
  return error instanceof GithubApiError ? error.code : undefined;
}

/**
 * 域层的意义。
 *
 * `unsupported` 的意思是这台机器**根本没法服务这次请求**——没有凭据服务，或者
 * 没有配置凭据。调用方答 UNSUPPORTED，而不是返回一个读起来像「没有 Issue」的
 * 空列表。
 */
export type GithubErrorKind =
  | "unsupported"
  | "invalid"
  | "permission"
  | "rateLimited"
  | "unknownOutcome"
  | "notFound"
  | "conflict"
  | "corrupt"
  | "unavailable"
  | "internal";

export class GithubError extends Error {
  constructor(readonly kind: GithubErrorKind) {
    super(kind);
    this.name = "GithubError";
  }
}

export function githubError(kind: GithubErrorKind): GithubError {
  return new GithubError(kind);
}

export function isGithubError(
  error: unknown,
  kind: GithubErrorKind,
): error is GithubError {
  return error instanceof GithubError && error.kind === kind;
}

/**
 * JSON 面上的一次拒绝：HTTP 状态 + 码 + 一句固定的英文。
 *
 * 码是注册表里的 snake_case（`packages/shared/src/contract/errors.ts`，契约 §41.1）；
 * 从前的大写拼法（`NOT_FOUND`、`PERMISSION_DENIED` ……）已换掉，页面在一个 minor
 * 里两种拼法都认（`api/request.ts` 的 `MESSAGE_BY_CODE`、`api/github.ts` 的
 * `classifyGithubFailure`）。
 */
export interface GithubFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/**
 * 域错误 → 线上的拒绝。逐条对着合并前实现的
 * `githubFailure`，状态与文案都不动，只有码换成 snake_case——前端
 * `apps/web/src/api/github.ts` 的 `classifyGithubFailure` 按码分档。
 */
export function githubFailure(error: unknown): GithubFailure {
  const kind = error instanceof GithubError ? error.kind : "internal";
  switch (kind) {
    case "unsupported":
      return {
        status: 501,
        code: "unsupported",
        message: "This Host has no usable GitHub credential",
      };
    case "permission":
      return {
        status: 403,
        code: "forbidden",
        message: "GitHub permission or CSRF check failed",
      };
    case "invalid":
      return {
        status: 400,
        code: "bad_request",
        message: "Invalid GitHub request",
      };
    case "rateLimited":
      return {
        status: 429,
        code: "rate_limited",
        message: "GitHub rate limit reached; retry after it resets",
      };
    case "unknownOutcome":
      // 这次写可能已经生效。调用方必须重新读，永远不要重试。
      return {
        status: 504,
        code: "unknown_outcome",
        message: "The GitHub write result was not read; reload before retrying",
      };
    case "conflict":
      return {
        status: 409,
        code: "conflict",
        message: "The remote or the stored revision changed; reload it",
      };
    case "notFound":
      return {
        status: 404,
        code: "not_found",
        message:
          "The repository, Issue, pull request or reference was not found",
      };
    default:
      return {
        status: 500,
        code: "internal",
        message: "GitHub operation failed",
      };
  }
}

/** 身份域的拒绝，兼容面上的拼法和 Host `authFailure` 一致。 */
export const UNAUTHENTICATED: GithubFailure = {
  status: 401,
  code: "unauthenticated",
  message: "Device session is invalid or expired",
};
