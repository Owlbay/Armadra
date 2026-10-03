/**
 * 身份域只有五种失败，每种对着一个 HTTP 状态。
 *
 * 分得这么细是因为页面的行为不同：`unauthenticated` 触发一次轮转重试，
 * `permission` 不重试，`conflict` 要求重读当前状态。把它们合并成一个
 * 「认证失败」，页面就只能在 401 上无限重试。
 */
export type IdentityErrorKind =
  | "invalid"
  | "unauthenticated"
  | "permission"
  | "conflict"
  | "notFound";

export class IdentityError extends Error {
  readonly name = "IdentityError";
  constructor(readonly kind: IdentityErrorKind) {
    super(`identity: ${kind}`);
  }
}

export function isIdentityError(value: unknown): value is IdentityError {
  return value instanceof IdentityError;
}

/**
 * 加固那几条（契约 §18.1–§18.4）的具名拒绝：口令策略、锁定与限流、passkey 不可
 * 用、MFA。它们的 `code` 是 snake_case 的具体原因，页面按它选文案；HTTP 状态
 * 跟着原因走，而不是落回那五种之一。`retryAfterMs` 只给锁定与限流，HTTP 层把它
 * 写进 `Retry-After`，不进响应体——错误体仍然只有 `{ code, message }`。
 */
export class IdentityRefusal extends IdentityError {
  constructor(
    kind: IdentityErrorKind,
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(kind);
    this.message = message;
  }
}

/** HTTP 状态与 `{ code, message }` 里的 code，照 Host 的 `authFailure`。 */
export function identityFailure(error: unknown): {
  status: number;
  code: string;
  message: string;
  retryAfterMs?: number;
} {
  if (error instanceof IdentityRefusal) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.retryAfterMs > 0 ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  const kind = isIdentityError(error) ? error.kind : "internal";
  switch (kind) {
    case "unauthenticated":
      return {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Device session is invalid or expired",
      };
    case "permission":
      return {
        status: 403,
        code: "PERMISSION_DENIED",
        message: "Device permission or CSRF check failed",
      };
    case "invalid":
      return {
        status: 400,
        code: "INVALID_ARGUMENT",
        message: "Invalid identity request",
      };
    case "conflict":
      return {
        status: 409,
        code: "CONFLICT",
        message: "Identity changed; reload its current state",
      };
    case "notFound":
      return {
        status: 404,
        code: "NOT_FOUND",
        message: "Device was not found",
      };
    default:
      return {
        status: 500,
        code: "INTERNAL",
        message: "Identity operation failed",
      };
  }
}
