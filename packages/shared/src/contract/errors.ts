import type { z } from "zod";

/**
 * 错误码注册表（工程规范化 §2.3.2 的雏形）。
 *
 * 线上形状仍是 `{ code, message }`（契约 §5.1）；这张表回答「一个码对应哪个
 * HTTP 状态」。码一律 snake_case，同一类失败只留一个拼法。
 *
 * 现阶段只登记 core 里 `coreError(status, "<code>", …)` 字面量直接给出的码——
 * 状态码一条条对得上，`apps/web/src/api/error-codes.test.ts` 会扫 core
 * 源码核对：写了没登记的码、或同一个码换了状态，测试都会红。身份域与 GitHub 面
 * 的大写码（`NOT_FOUND`…）、各域自己的对象形拒绝码在对应域迁移时再并进来，
 * 在那之前由测试里的存量名单只减不增地盯着。
 */
export interface ErrorSpec {
  /** 这个码对应的 HTTP 状态。 */
  readonly status: number;
  /** 界面文案的 i18n 键；还没有专属文案的码暂缺，页面回落到 core 给的原话。 */
  readonly i18n?: string;
  /** 带细节的拒绝（如 409 的指纹、修订号）的 `details` 形状。 */
  readonly data?: z.ZodType;
}

export const ERROR_CODES = {
  bad_request: { status: 400, i18n: "error.badRequest" },
  unauthenticated: { status: 401, i18n: "error.unauthenticated" },
  forbidden: { status: 403, i18n: "error.forbidden" },
  not_found: { status: 404, i18n: "error.notFound" },
  method_not_allowed: { status: 405, i18n: "error.methodNotAllowed" },
  conflict: { status: 409, i18n: "error.conflict" },
  payload_too_large: { status: 413, i18n: "error.payloadTooLarge" },
  rate_limited: { status: 429, i18n: "error.rateLimited" },
  internal: { status: 500, i18n: "error.internal" },
  /** 与 `internal` 是同一类失败的第二个拼法，迁移时并入 `internal`。 */
  internal_error: { status: 500 },
  not_implemented: { status: 501, i18n: "error.notImplemented" },
  unsupported: { status: 501, i18n: "error.unsupported" },
  settings_unavailable: { status: 503 },
  unknown_outcome: { status: 504, i18n: "error.unknownOutcome" },
  forge_credential_rejected: { status: 502 },
  forge_unavailable: { status: 502 },
  mail_send_failed: { status: 502 },
  forge_forbidden: { status: 403 },
  forge_scope: { status: 403 },
  pairing_code_disabled: { status: 403 },
  pairing_code_invalid: { status: 404 },
  device_required: { status: 409 },
  forge_not_configured: { status: 409 },
  gateway_managed_by_shell: { status: 409 },
  gateway_not_running: { status: 409 },
  link_invalid: { status: 409 },
  mail_not_configured: { status: 409 },
  origin_mismatch: { status: 409 },
  rebase_started: { status: 409 },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isRegisteredErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CODES, code);
}
