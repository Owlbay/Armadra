import { ERROR_CODES, type ErrorCode } from "@armadra/shared";

/**
 * Every failure the core reports, in one shape.
 *
 * `{ code, message }` is contractual (contract §5.1): the front end switches on
 * `code` and shows `message`, and 347 zod schemas in `packages/shared` are
 * written against exactly this. Nothing here may grow a third key.
 */
export interface CoreError {
  readonly code: string;
  readonly message: string;
}

export interface ErrorResponse {
  readonly status: number;
  readonly body: CoreError;
}

export function coreError(
  status: number,
  code: string,
  message: string,
): ErrorResponse {
  return { status, body: { code, message } };
}

export const notFound = (path: string): ErrorResponse =>
  coreError(404, "not_found", `没有这个接口：${path}`);

export const methodNotAllowed = (method: string, path: string): ErrorResponse =>
  coreError(405, "method_not_allowed", `${path} 不接受 ${method}`);

export const badRequest = (message: string): ErrorResponse =>
  coreError(400, "bad_request", message);

export const payloadTooLarge = (message: string): ErrorResponse =>
  coreError(413, "payload_too_large", message);

export const forbidden = (message: string): ErrorResponse =>
  coreError(403, "forbidden", message);

export const internal = (message: string): ErrorResponse =>
  coreError(500, "internal", message);

/**
 * 表里有、这个构建没写的路由答的那一句。
 *
 * 501 而不是 404，是因为 404 读起来是「你要的东西不存在」——和一个拼错的 URL
 * 分不开。501 说的是「这条路在契约里，这个构建还没写」，页面据此降级。
 */
export function notImplemented(path: string): ErrorResponse {
  return coreError(501, "not_implemented", `未实现：${path}`);
}

/**
 * 抛出来的拒绝（工程规范化 §2.3.2）：码、状态与可选的细节。
 *
 * `coreError` 是「答一个值」，给按路径分派的 handler 用；契约 procedure 的实现
 * 是普通函数，拒绝就抛这个，RPC 门面（`http/rpc.ts`）把它改写成
 * `{ code, message, requestId?, details? }`。状态从注册表查，同一个码不会在两处
 * 答出两个状态；还没登记的码（各域对象形拒绝的存量）由调用方给状态。
 */
export class CoreFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CoreFailure";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  response(): ErrorResponse {
    return coreError(this.status, this.code, this.message);
  }
}

/** `throw fail("not_found", "…")`：状态按注册表。 */
export function fail(
  code: ErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): CoreFailure {
  return new CoreFailure(ERROR_CODES[code].status, code, message, details);
}

/**
 * 限流的拒绝：重试的秒数放进 `details.retryAfterSeconds`，HTTP 上 RPC 门面与旧路径
 * 同时给 `Retry-After` 头（`http/rpc.ts` 的 `retryAfter`、{@link failureResult}）。
 */
export function rateLimited(
  message: string,
  retryAfterMs: number,
): CoreFailure {
  return fail("rate_limited", message, {
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  });
}

/**
 * 旧路径 handler 把一个抛出的拒绝答成响应：与 RPC 门面同一个形状——带细节时体里有
 * `details`，限流时多一个 `Retry-After` 头。
 */
export function failureResult(error: CoreFailure): {
  readonly status: number;
  readonly body: CoreError & {
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly headers?: Readonly<Record<string, string>>;
} {
  const seconds = error.details?.retryAfterSeconds;
  return {
    status: error.status,
    body:
      error.details === undefined
        ? { code: error.code, message: error.message }
        : { code: error.code, message: error.message, details: error.details },
    ...(error.status === 429 && typeof seconds === "number"
      ? { headers: { "retry-after": String(seconds) } }
      : {}),
  };
}
