import { z } from "zod";
import { isServerShellServed, resolveRuntimeUrl } from "./runtime-url";
import {
  ensureCsrf,
  renewShellBearer,
  replaceRejectedCsrf,
  shellBearer,
} from "./identity";
import { t } from "../app/preferences-store";

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

const PAGE_URL =
  typeof window === "undefined" ? "http://localhost/" : window.location.href;

export const RUNTIME_URL = resolveRuntimeUrl(
  import.meta.env.VITE_RUNTIME_URL,
  PAGE_URL,
);

/** 这份页面是不是由服务器壳托管：那条路上写请求要带会话 CSRF 头。 */
export const RUNTIME_VIA_SERVER_SHELL = isServerShellServed(
  import.meta.env.VITE_RUNTIME_URL,
  PAGE_URL,
);

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
 * 大写那几个是 GitHub 面自己的码（`api/github.ts` 另有一层按用途的分类，
 * 那一层不受影响：它读的是 `code`，不是 `message`）。
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
  UNAUTHENTICATED: "error.unauthenticated",
  PERMISSION_DENIED: "error.permissionDenied",
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
 * 要会话的两面（契约 §3.2）：GitHub 与自动化。桌面壳里它们带票据换来的
 * Bearer——core 不再把回环上没带凭据的调用当成本机主人（安全审查 L9）。其余
 * 路由在桌面壳里不认凭据，照旧不带。
 */
const SESSION_SURFACES = ["/api/github/", "/api/automations/"] as const;

function sessionSurface(path: string): boolean {
  return SESSION_SURFACES.some((prefix) => path.startsWith(prefix));
}

async function send(
  path: string,
  init: RequestInit | undefined,
  csrf: string,
  bearer = "",
) {
  return fetch(`${RUNTIME_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(csrf ? { "X-Armadra-CSRF": csrf } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...init?.headers,
    },
  });
}

/**
 * 这个 403 是不是 Gateway 的 CSRF 拒绝（`code: "forbidden"`，或没有 code）。
 * 带别的码的 403 已经到过处理器——例如托管平台的 `forge_scope`：远端拒了这次
 * 写，换一枚令牌再发一遍就是把写重试了一次。
 */
async function csrfRefusal(response: Response): Promise<boolean> {
  if (typeof response.clone !== "function") return true;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  const code = body && typeof body === "object" ? body.code : undefined;
  return code === undefined || code === "forbidden";
}

export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const guarded = RUNTIME_VIA_SERVER_SHELL && unsafeMethod(init?.method);
  let response: Response;
  try {
    const used = guarded ? await ensureCsrf() : "";
    const bearer = sessionSurface(path) ? await shellBearer() : "";
    response = await send(path, init, used, bearer);
    // 访问密钥 15 分钟就过期：401 说明这次请求没进处理器，换一枚再发一次
    // 不会把任何事做两遍。
    if (bearer && response.status === 401) {
      const renewed = await renewShellBearer(bearer);
      if (renewed) response = await send(path, init, used, renewed);
    }
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
      const renewed = await replaceRejectedCsrf(used);
      if (renewed) response = await send(path, init, renewed);
    }
  } catch (cause) {
    throw new RuntimeConnectionError(RUNTIME_URL, cause);
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
