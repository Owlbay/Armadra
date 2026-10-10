import { z } from "zod";
import { localRuntime } from "./local-runtime";
import { t } from "../app/preferences-store";
import { type Source, currentSource } from "./source";

/**
 * Runtime HTTP 客户端 —— docs/contracts/v3-agent-terminal-plan.md §7 / §15。
 *
 * 三条约束：
 *  1. 每个响应都过 zod：Runtime 是本地进程但版本可能比前端旧，
 *     字段缺失要在这里炸，而不是在渲染时炸。
 *  2. 连不上 Runtime 与「Runtime 返回错误」是两类失败：前者抛
 *     `RuntimeConnectionError`（壳里有专门的横幅），后者抛普通 Error。
 *  3. 这里不做任何缓存 / 重试 / 状态；调用方自己决定。
 */

/**
 * 这份页面是不是由服务器壳托管：那条路上写请求要带会话 CSRF 头，界面也按它
 * 收起桌面才有的几页。这是页面本身的事实，不随当前源变；发往哪台 core 由源
 * 决定（`api/source.ts`、`sources/`）。
 */
export const RUNTIME_VIA_SERVER_SHELL = localRuntime().viaServerShell;

/** 204 / 空响应体在进 schema 之前先变成 `undefined`。 */
export const noContentSchema = z.unknown().transform(() => undefined);

export class RuntimeConnectionError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, cause?: unknown) {
    super(t("app.runtimeUnreachable", { endpoint }), { cause });
    this.name = "RuntimeConnectionError";
    this.endpoint = endpoint;
  }
}

/**
 * core 的错误码 → 界面文案（`i18n/errors.ts`）。
 *
 * core 的 `message` 是中文，而它不经过 i18n——英文界面上原样透出去就是一句
 * 中文。所以认得出的码一律取这张表；认不出的才落到 `message`，那是最后一道
 * 兜底而不是常态。
 *
 * 大写那几个是 GitHub 面从前的拼法（契约 §41.1 已换成 snake_case）：再保留一个
 * minor，让还没升级的 core 答的大写码照样认得，且与它对应的 snake_case 取同一句
 * 话（`message-by-code.test.ts` 一一对着看）。`api/github.ts` 另有一层按用途的
 * 分类，它读的是 `code`，不是 `message`。
 */
const MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  not_found: "error.notFound",
  forbidden: "error.forbidden",
  bad_request: "error.badRequest",
  method_not_allowed: "error.methodNotAllowed",
  conflict: "error.conflict",
  payload_too_large: "error.payloadTooLarge",
  unavailable: "error.unavailable",
  not_implemented: "error.notImplemented",
  internal: "error.internal",
  unsupported: "error.unsupported",
  unknown_outcome: "error.unknownOutcome",
  // 这一条有自己的那句话：要用户做的事不是「去装点什么」，是「工作区在别的
  // 机器上」——切换执行主机能解决它。
  unsupported_on_remote: "error.unsupportedOnRemote",
  git_execution_required: "gitRepo.executionRequired",
  // 节点凭据（契约 §20）：起终端与凭据页的拒绝。
  credential_not_found: "credentials.error.credential_not_found",
  credential_mismatch: "credentials.error.credential_mismatch",
  credential_kind_disabled: "credentials.error.credential_kind_disabled",
  credential_unsupported_here: "credentials.error.credential_unsupported_here",
  credential_backend_insecure: "credentials.error.credential_backend_insecure",
  credential_unset: "credentials.error.credential_unset",
  credential_unavailable: "credentials.error.credential_unavailable",
  // 客户端源表与远程服务（契约 §33）。
  credentials_invalid: "error.credentialsInvalid",
  account_locked: "error.accountLocked",
  fingerprint_mismatch: "error.fingerprintMismatch",
  challenge_required: "error.challengeRequired",
  challenge_invalid: "error.challengeInvalid",
  // 改远程服务的口令（契约 §63）：策略码与 core 自己的口令策略同一句话。
  password_too_short: "security.error.password_too_short",
  password_too_long: "security.error.password_too_long",
  password_contains_name: "security.error.password_contains_name",
  password_too_common: "security.error.password_too_common",
  password_breached: "security.error.password_breached",
  address_invalid: "error.addressInvalid",
  address_https_only: "error.addressHttpsOnly",
  address_plaintext_loopback_only: "error.addressPlaintextLoopbackOnly",
  address_has_credentials: "error.addressHasCredentials",
  fingerprint_invalid: "error.fingerprintInvalid",
  source_unreachable: "error.sourceUnreachable",
  source_unauthorized: "error.sourceUnauthorized",
  source_offline: "error.sourceOffline",
  cloud_account_unlinked: "error.cloudAccountUnlinked",
  // 经中继到达的源（客户端包 §5）：页面自己的码与远程服务的拒绝。
  source_mismatch: "remote.error.sourceMismatch",
  account_disabled: "remote.error.accountDisabled",
  // 云登录与登记（契约 §31）。
  cloud_not_registered: "error.cloudNotRegistered",
  cloud_assertion_invalid: "error.cloudAssertionInvalid",
  cloud_assertion_replayed: "error.cloudAssertionInvalid",
  cloud_already_registered: "error.cloudAlreadyRegistered",
  cloud_issuer_mismatch: "error.cloudIssuerMismatch",
  invitation_invalid: "error.invitationInvalid",
  registration_token_invalid: "error.registrationTokenInvalid",
  protocol_unsupported: "error.protocolUnsupported",
  // 页面直接调远程服务（`/v1/*`，cloud-api §1）时它答的账号与源类的码。
  rate_limited: "error.rateLimited",
  unauthenticated: "error.unauthenticated",
  session_expired: "error.remoteSessionExpired",
  session_revoked: "error.remoteSessionExpired",
  source_access_denied: "error.sourceAccessDenied",
  source_revoked: "error.sourceRevoked",
  limit_reached: "error.limitReached",
  // 分享链接（契约 §33.7；手机与托管页面直接调远程服务时同样的码）。
  link_invalid: "error.linkInvalid",
  link_expired: "error.linkExpired",
  link_exhausted: "error.linkExhausted",
  link_secret_invalid: "error.linkSecretInvalid",
  // ACP prompt 的附件（契约 §56）。
  acp_image_unsupported: "acp.attach.imageUnsupported",
  acp_attachment_unsupported: "acp.attach.fileUnsupported",
  acp_attachment_too_large: "acp.attach.failed",
  // ACP 适配器的安装（契约 §39.7）。
  adapter_not_installable: "error.adapterNotInstallable",
  adapter_already_installed: "error.adapterAlreadyInstalled",
  npm_not_found: "error.npmNotFound",
  adapter_install_busy: "error.adapterInstallBusy",
  adapter_rollback_unavailable: "error.adapterRollbackUnavailable",
  UNAUTHENTICATED: "error.unauthenticated",
  PERMISSION_DENIED: "error.forbidden",
  NOT_FOUND: "error.notFound",
  CONFLICT: "error.conflict",
  INVALID_ARGUMENT: "error.badRequest",
  RESOURCE_EXHAUSTED: "error.rateLimited",
  UNSUPPORTED: "error.unsupported",
  UNKNOWN_OUTCOME: "error.unknownOutcome",
};

/** 认得出这个码就是那句话，认不出就是 core 给的原话。 */
export function localizedFailure(code: string | undefined, fallback: string) {
  const key = code === undefined ? undefined : MESSAGE_BY_CODE[code];
  return key === undefined ? fallback : t(key);
}

/**
 * Runtime 回了非 2xx。`message` 按 `code` 取界面文案，认不出的码才用 Runtime
 * 那句；`status` / `code` 留给需要分支的场景——例如保存冲突要提示重新加载，
 * 而不是笼统的"失败"。
 */
export class RuntimeRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  /**
   * core 说的那句原话。
   *
   * `message` 被换成本地化的那句之后，具体度是有损失的：`bad_request` 的原话
   * 常常说得出是哪个字段。原话留在这里而不是丢掉，给要细节的日志与调用点。
   */
  readonly coreMessage: string;
  /**
   * 原样的错误 body。有些拒绝不是一句话能表达的——执行主机改绑的 409 里带着
   * 两边的指纹或者还占着旧主机的东西，调用方要拿这些才说得出人能做什么。
   * 未解析：认得出这个形状的是调用方，不是传输层。
   */
  readonly body?: unknown;

  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(localizedFailure(code, message));
    this.name = "RuntimeRequestError";
    this.status = status;
    this.code = code;
    this.coreMessage = message;
    this.body = body;
  }
}

/** 写文件的 CAS 失败（HTTP 409）。 */
export function isConflict(error: unknown): boolean {
  return error instanceof RuntimeRequestError && error.status === 409;
}

/** core 按这个人的授权拒绝了（服务器壳上的共享成员）。 */
export function isForbidden(error: unknown): boolean {
  return error instanceof RuntimeRequestError && error.status === 403;
}

/**
 * 这个动作只能在 Armadra 自己所在的机器上跑，而当前工作区在另一台
 * （远端补全设计 §3.1）。
 *
 * 和普通的 `unsupported` 分开，是因为要用户做的事不一样：一个是「去装点
 * 什么」，这个是「工作区在别的机器上」——后者可以由切换执行主机解决，界面
 * 得说得出这句话。
 */
export function isUnsupportedOnRemote(error: unknown): boolean {
  return (
    error instanceof RuntimeRequestError &&
    error.code === "unsupported_on_remote"
  );
}

/** 只有会改状态的方法需要 CSRF；GET / HEAD 靠 SameSite Cookie 与精确 Origin。 */
function unsafeMethod(method: string | undefined): boolean {
  const value = (method ?? "GET").toUpperCase();
  return value !== "GET" && value !== "HEAD";
}

/**
 * Bearer 不在这里加：由源自己的 `fetch` 补上（本机源在桌面壳与原生 App 里由
 * `installLocalTransport` 装凭据，契约 §3.2；远程源见 `sources/connection.ts`）；
 * Cookie 会话的源这里只补双提交的 CSRF。
 */
async function send(
  source: Source,
  path: string,
  init: RequestInit | undefined,
  csrf: string,
) {
  return source.fetch(`${source.httpBase}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(csrf ? { "X-Armadra-CSRF": csrf } : {}),
      ...init?.headers,
    },
  });
}

/**
 * 这个 403 是不是 Gateway 的 CSRF 拒绝（`code: "forbidden"`，或没有 code）。
 * 带别的码的 403 已经到过处理器——例如托管平台的 `forge_scope`：远端拒了这次
 * 写，换一枚令牌再发一遍就是把写重试了一次。
 */
export async function csrfRefusal(response: Response): Promise<boolean> {
  if (typeof response.clone !== "function") return true;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  const code = body && typeof body === "object" ? body.code : undefined;
  return code === undefined || code === "forbidden";
}

/**
 * 发一次 REST 请求。`source` 省略是当前源（`api/source.ts` 的
 * {@link currentSource}，没挂远程源时就是本机）。
 */
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
  source: Source = currentSource(),
): Promise<T> {
  const credentials = source.credentials;
  const guarded = credentials.mode === "cookie" && unsafeMethod(init?.method);
  let response: Response;
  try {
    const used = guarded ? ((await credentials.csrf()) ?? "") : "";
    response = await send(source, path, init, used);
    // A rotated token is the one failure worth retrying: the request never
    // reached a handler, so nothing was executed twice. Any other 403 is the
    // core refusing this device, and repeating it would not change that.
    // Another window of this browser may have rotated it already and said so;
    // then that one is used rather than rotating it away again.
    if (
      guarded &&
      response.status === 403 &&
      !(init?.body instanceof FormData) &&
      (await csrfRefusal(response))
    ) {
      const renewed = await credentials.renewCsrf(used);
      if (renewed) response = await send(source, path, init, renewed);
    }
  } catch (cause) {
    throw new RuntimeConnectionError(source.httpBase, cause);
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const body =
      payload && typeof payload === "object"
        ? (payload as { message?: unknown; code?: unknown })
        : null;
    throw new RuntimeRequestError(
      response.status,
      body?.message !== undefined
        ? String(body.message)
        : t("app.runtimeFailed", { status: response.status }),
      body?.code !== undefined ? String(body.code) : undefined,
      payload,
    );
  }
  return schema.parse(payload);
}

export const query = (value: string) => encodeURIComponent(value);

export function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body) };
}
