import type { z } from "zod";

/**
 * 错误码注册表（工程规范化 §2.3.2）。
 *
 * 线上形状是 `{ code, message, requestId?, details? }`（契约 §5.1、§34.1）；这张表
 * 回答「一个码对应哪个 HTTP 状态」。码一律 snake_case，同一类失败只留一个拼法。
 *
 * 登记的是 core 里 `coreError(status, "<code>", …)` 与 `fail("<code>", …)` 字面量
 * 给出的码——状态码一条条对得上，`apps/web/src/api/error-codes.test.ts` 会扫 core
 * 源码核对：写了没登记的码、或同一个码换了状态，测试都会红。身份域与 GitHub 面
 * 的大写码（`NOT_FOUND`…）、各域自己的对象形拒绝码在对应域迁移时再并进来，
 * 在那之前由测试里的存量名单只减不增地盯着。
 *
 * 契约（`contract/<域>.ts`）用 {@link errors.pick} 声明一条 procedure 会答哪些码；
 * `contract.test.ts` 断言声明的码都在这里。
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
  /** 一条控制面连接上同时活着的订阅到了上限（契约 §35.2，随后以 4429 关）。 */
  limit_reached: { status: 429 },
  internal: { status: 500, i18n: "error.internal" },
  /** 与 `internal` 是同一类失败的第二个拼法，迁移时并入 `internal`。 */
  internal_error: { status: 500 },
  not_implemented: { status: 501, i18n: "error.notImplemented" },
  unsupported: { status: 501, i18n: "error.unsupported" },
  settings_unavailable: { status: 503 },
  /** 订阅跟不上、队列满了（`resubscribe` 策略）：带 `lastEventId` 重订（契约 §35.5）。 */
  overflow: { status: 503 },
  unknown_outcome: { status: 504, i18n: "error.unknownOutcome" },
  /** 别人持有这块画布的编辑租约（契约 §9.3、§36）。 */
  canvas_lease_held: { status: 423 },
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
  /**
   * 邮件的一次性链接与分享链接（§33.7，远程服务答的「链接不存在或已撤销」）共用；
   * 状态沿用邮件域的 409（协议包注册表里是 404，页面只按码取文案）。
   */
  link_invalid: { status: 409, i18n: "error.linkInvalid" },
  /** 这块板已切到实时协同，表不能直接写（契约 §16.2、§36.2）。 */
  realtime_active: { status: 409 },
  /** 续订的位置已掉出 outbox 的保留下限：先整份重读，再从现在订（契约 §35.4）。 */
  snapshot_required: { status: 409 },
  /** 续订的位置这台 core 从没发过（换了库）：同上（契约 §35.4）。 */
  cursor_ahead: { status: 409 },
  mail_not_configured: { status: 409 },
  origin_mismatch: { status: 409 },
  rebase_started: { status: 409 },
  // 客户端源表与远程服务（契约 §33）：拼法与状态同协议包 `errors` 注册表。
  credentials_invalid: { status: 401, i18n: "error.credentialsInvalid" },
  source_unauthorized: { status: 401, i18n: "error.sourceUnauthorized" },
  cloud_account_unlinked: {
    status: 401,
    i18n: "error.cloudAccountUnlinked",
  },
  fingerprint_mismatch: { status: 400, i18n: "error.fingerprintMismatch" },
  account_locked: { status: 429, i18n: "error.accountLocked" },
  source_unreachable: { status: 502, i18n: "error.sourceUnreachable" },
  source_offline: { status: 503, i18n: "error.sourceOffline" },
  // 云登录与登记（契约 §31）：拼法与状态同协议包 `errors` 注册表。
  cloud_not_registered: { status: 401, i18n: "error.cloudNotRegistered" },
  cloud_assertion_invalid: {
    status: 401,
    i18n: "error.cloudAssertionInvalid",
  },
  cloud_assertion_replayed: {
    status: 401,
    i18n: "error.cloudAssertionInvalid",
  },
  cloud_already_registered: {
    status: 409,
    i18n: "error.cloudAlreadyRegistered",
  },
  cloud_issuer_mismatch: { status: 400, i18n: "error.cloudIssuerMismatch" },
  invitation_invalid: { status: 401, i18n: "error.invitationInvalid" },
  registration_token_invalid: {
    status: 401,
    i18n: "error.registrationTokenInvalid",
  },
  protocol_unsupported: { status: 426, i18n: "error.protocolUnsupported" },
  // 按分享链接挂载（契约 §33.7）：远程服务 `links.accept` 的拒绝，拼法与状态同协议包。
  link_expired: { status: 410, i18n: "error.linkExpired" },
  link_exhausted: { status: 410, i18n: "error.linkExhausted" },
  link_secret_invalid: { status: 403, i18n: "error.linkSecretInvalid" },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isRegisteredErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CODES, code);
}

/** 门面用的名字（工程规范化 §2.3.2）：这个码在注册表里。 */
export const isDefinedCode = isRegisteredErrorCode;

/** 这个码登记的 HTTP 状态；没登记的答 `undefined`。 */
export function errorStatus(code: string): number | undefined {
  return isRegisteredErrorCode(code) ? ERROR_CODES[code].status : undefined;
}

/** 一条 procedure 声明自己会答的码时用的那一项（上游 `ErrorMap` 的一格）。 */
export interface DeclaredError {
  readonly status: number;
  readonly data?: z.ZodType;
}

export const errors = {
  /**
   * 从注册表挑出几个码，交给契约的 `.errors(...)`。状态从注册表来，契约里不再
   * 写第二遍。
   */
  pick<const K extends ErrorCode>(
    ...codes: readonly K[]
  ): { readonly [P in K]: DeclaredError } {
    const picked: Record<string, DeclaredError> = {};
    for (const code of codes) {
      const spec: ErrorSpec = ERROR_CODES[code];
      picked[code] =
        spec.data === undefined
          ? { status: spec.status }
          : { status: spec.status, data: spec.data };
    }
    return picked as { readonly [P in K]: DeclaredError };
  },
};
