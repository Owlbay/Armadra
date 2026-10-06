import { z } from "zod";

/**
 * 页面直接调远程服务（个人中转 `<issuer>/v1/*`，cloud 契约 §2、§4、§5、§6、§10）的
 * 一小块客户端：平台信息、登录、续期、登出、源目录、断言、接受链接、`me.stream`
 * 的票，加上经中继向源 core 的 `POST /api/identity/cloud/login` 与刷新（core
 * 契约 §31、§17.4）。手机（`mobile/`）与中继托管的页面（`sources/hosted.ts`）
 * 共用这一份。
 *
 * 只认这几条要用的形状（宽松解析：未知字段忽略，协议包允许更高的 minor）；
 * 错误一律归成 `{ code, message }`，界面按 `code` 取文案，不展示后端的 message。
 */

export class CloudError extends Error {
  readonly code: string;
  readonly status: number;
  /** 账号被锁时对端给的剩余毫秒数。 */
  readonly retryAfterMs: number;

  constructor(status: number, code: string, message = code, retryAfterMs = 0) {
    super(message);
    this.name = "CloudError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 连不上（DNS、证书、超时）：区别于对端明确的拒绝。 */
export class CloudTransportError extends Error {
  constructor(cause: unknown) {
    super("remote service unreachable", { cause });
    this.name = "CloudTransportError";
  }
}

const sessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  accessExpiresAtMs: z.number(),
  expiresAtMs: z.number().default(0),
  account: z
    .object({ accountId: z.string(), displayName: z.string().default("") })
    .optional(),
});
export type CloudSession = z.infer<typeof sessionSchema>;

const loginAnswer = z.object({ session: sessionSchema }).or(
  z.object({
    mfa: z.object({ challengeId: z.string() }),
  }),
);

export const cloudSourceSchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().default(""),
  online: z.boolean().default(false),
  owner: z.boolean().default(false),
  via: z.string().default("owner"),
});
export type CloudSource = z.infer<typeof cloudSourceSchema>;

const assertionSchema = z.object({
  assertion: z.string().min(1),
  assertionExpiresAtMs: z.number().default(0),
  relayToken: z.string().min(1),
  relayTokenExpiresAtMs: z.number().default(0),
  relayOrigin: z.string().default(""),
  relayBaseUrl: z.string().min(1),
  online: z.boolean().default(true),
});
export type CloudAssertion = z.infer<typeof assertionSchema>;

const acceptSchema = z.object({
  sourceId: z.string().min(1),
  relayOrigin: z.string().default(""),
  relayBaseUrl: z.string().min(1),
  assertion: z.string().min(1),
  relayToken: z.string().min(1),
  relayTokenExpiresAtMs: z.number().default(0),
  guestSession: sessionSchema,
});
export type CloudAccept = z.infer<typeof acceptSchema>;

/** `links.get`（匿名）：落地页显示的那几项（cloud-api §5）。 */
const linkInfoSchema = z.object({
  label: z.string().default(""),
  role: z.string().default(""),
  sourceName: z.string().default(""),
  expiresAtMs: z.number().default(0),
  exhausted: z.boolean().default(false),
});
export type CloudLinkInfo = z.infer<typeof linkInfoSchema>;

/** core 的 `cloud/login` 答案里页面要用的部分（与 `identitySessionSchema` 同形）。 */
const coreSessionSchema = z.object({
  session: z.object({
    hostId: z.string(),
    expiresAtUnixMs: z.number().default(0),
    /** 刷新时要带的 CSRF 密钥（Bearer 模式也校验它，契约 §17.4）。 */
    csrfToken: z.string().optional(),
    native: z.object({
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1),
    }),
  }),
});
export type CoreCloudSession = z.infer<typeof coreSessionSchema>["session"];

const coreRefreshSchema = z.object({
  hostId: z.string().default(""),
  expiresAtUnixMs: z.number().default(0),
  csrfToken: z.string().optional(),
  native: z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
  }),
});

export interface CloudDevice {
  readonly platform: "ios" | "android" | "browser";
  readonly name: string;
}

/** 这台手机在远程服务里的登记（原生 App 只有 iOS 与 Android 两种）。 */
export function thisDevice(
  userAgent: string = globalThis.navigator?.userAgent ?? "",
): CloudDevice {
  return /android/i.test(userAgent)
    ? { platform: "android", name: "Armadra Android" }
    : { platform: "ios", name: "Armadra iOS" };
}

/** 浏览器里打开的页面（中继托管）在远程服务里的登记。 */
export function browserDevice(
  userAgent: string = globalThis.navigator?.userAgent ?? "",
): CloudDevice {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "";
  return {
    platform: "browser",
    name: browser === "" ? "Armadra Web" : `Armadra Web (${browser})`,
  };
}

export interface CloudOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function trimmed(base: string): string {
  return base.replace(/\/+$/, "");
}

async function send<T>(
  url: string,
  schema: z.ZodType<T>,
  init: {
    readonly method?: string;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  },
  options: CloudOptions,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        Accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch (cause) {
    throw new CloudTransportError(cause);
  } finally {
    clearTimeout(timer);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = (payload ?? {}) as {
      code?: unknown;
      message?: unknown;
      details?: { retryAfterMs?: unknown };
    };
    const retry = body.details?.retryAfterMs;
    throw new CloudError(
      response.status,
      typeof body.code === "string" ? body.code : "unknown",
      typeof body.message === "string" ? body.message : "",
      typeof retry === "number" ? retry : 0,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new CloudError(502, "bad_response");
  return parsed.data;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** `POST /v1/auth/login`；个人中转没有第二因素，答了 `mfa` 就当不支持。 */
export async function cloudLogin(
  issuer: string,
  account: string,
  password: string,
  device: CloudDevice,
  options: CloudOptions = {},
): Promise<CloudSession> {
  const answer = await send(
    `${trimmed(issuer)}/v1/auth/login`,
    loginAnswer,
    { body: { account, password, device } },
    options,
  );
  if (!("session" in answer)) throw new CloudError(501, "mfa_unsupported");
  return answer.session;
}

/** `POST /v1/auth/refresh`：刷新令牌每次旋转，调用方必须存下答案里的新令牌。 */
export async function cloudRefresh(
  issuer: string,
  refreshToken: string,
  options: CloudOptions = {},
): Promise<CloudSession> {
  const answer = await send(
    `${trimmed(issuer)}/v1/auth/refresh`,
    z.object({ session: sessionSchema }),
    { body: { refreshToken } },
    options,
  );
  return answer.session;
}

/** `POST /v1/auth/logout`：尽力而为，失败不抛。 */
export async function cloudLogout(
  issuer: string,
  accessToken: string,
  options: CloudOptions = {},
): Promise<void> {
  await send(
    `${trimmed(issuer)}/v1/auth/logout`,
    z.unknown(),
    { method: "POST", headers: bearer(accessToken), body: {} },
    options,
  ).catch(() => undefined);
}

const platformInfoSchema = z.object({
  mode: z.string(),
  issuer: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  webApp: z.string().nullable().default(null),
});
export type CloudPlatformInfo = z.infer<typeof platformInfoSchema>;

/** `GET /.well-known/armadra-platform`（匿名）。 */
export function cloudPlatformInfo(
  origin: string,
  options: CloudOptions = {},
): Promise<CloudPlatformInfo> {
  return send(
    `${trimmed(origin)}/.well-known/armadra-platform`,
    platformInfoSchema,
    {},
    options,
  );
}

/** `POST /v1/me/stream/ticket`：30 秒一次性，升级 `GET /v1/me/stream` 时用。 */
export async function cloudStreamTicket(
  issuer: string,
  accessToken: string,
  options: CloudOptions = {},
): Promise<string> {
  const answer = await send(
    `${trimmed(issuer)}/v1/me/stream/ticket`,
    z.object({ ticket: z.string().min(1) }),
    { method: "POST", headers: bearer(accessToken), body: {} },
    options,
  );
  return answer.ticket;
}

/** `GET /v1/me/sources`。 */
export async function cloudSources(
  issuer: string,
  accessToken: string,
  options: CloudOptions = {},
): Promise<CloudSource[]> {
  const answer = await send(
    `${trimmed(issuer)}/v1/me/sources`,
    z.object({ sources: z.array(cloudSourceSchema) }),
    { headers: bearer(accessToken) },
    options,
  );
  return answer.sources;
}

/** `POST /v1/sources/{id}/assertion`：断言 + 中继令牌 + 中继地址。 */
export function cloudAssertion(
  issuer: string,
  accessToken: string,
  sourceId: string,
  device: CloudDevice,
  options: CloudOptions = {},
): Promise<CloudAssertion> {
  return send(
    `${trimmed(issuer)}/v1/sources/${encodeURIComponent(sourceId)}/assertion`,
    assertionSchema,
    { headers: bearer(accessToken), body: { device } },
    options,
  );
}

/** `GET /v1/links/{id}`（匿名）：链接指向谁、什么权限、何时过期。 */
export function cloudLinkInfo(
  issuer: string,
  linkId: string,
  options: CloudOptions = {},
): Promise<CloudLinkInfo> {
  return send(
    `${trimmed(issuer)}/v1/links/${encodeURIComponent(linkId)}`,
    linkInfoSchema,
    {},
    options,
  );
}

/** `POST /v1/links/{id}/accept`（匿名）：分享链接换访客会话与断言。 */
export function cloudAcceptLink(
  issuer: string,
  linkId: string,
  secret: string,
  device: CloudDevice,
  options: CloudOptions = {},
): Promise<CloudAccept> {
  return send(
    `${trimmed(issuer)}/v1/links/${encodeURIComponent(linkId)}/accept`,
    acceptSchema,
    { body: { secret, device } },
    options,
  );
}

/** 经中继发往源 core 的请求要带的头。 */
export function relayHeaders(relayToken: string): Record<string, string> {
  return { "Armadra-Relay-Token": relayToken };
}

/**
 * `POST <relayBaseUrl>/api/identity/cloud/login`：用源访问断言换 core 自己的会话
 * （core 契约 §31）。邀请令牌只在接受分享链接时带。
 */
export async function coreCloudLogin(
  relayBaseUrl: string,
  relayToken: string,
  assertion: string,
  invitationToken: string | undefined,
  options: CloudOptions = {},
): Promise<CoreCloudSession> {
  const answer = await send(
    `${trimmed(relayBaseUrl)}/api/identity/cloud/login`,
    coreSessionSchema,
    {
      headers: relayHeaders(relayToken),
      body: {
        assertion,
        ...(invitationToken === undefined ? {} : { invitationToken }),
      },
    },
    options,
  );
  return answer.session;
}

/**
 * `POST <基址>/api/identity/session/refresh`（刷新令牌当 Bearer，轮换）：直连与
 * 经中继同一条；经中继时带 `relayToken`。core 在 Bearer 模式下同样校验会话的
 * CSRF 密钥（契约 §17.4），有就带上；没有时对端会拒，调用方退回重新登录。
 */
export function coreRefresh(
  base: string,
  refreshToken: string,
  relayToken: string | undefined,
  options: CloudOptions = {},
  csrfToken?: string,
): Promise<z.infer<typeof coreRefreshSchema>> {
  return send(
    `${trimmed(base)}/api/identity/session/refresh`,
    coreRefreshSchema,
    {
      method: "POST",
      headers: {
        ...bearer(refreshToken),
        ...(relayToken === undefined ? {} : relayHeaders(relayToken)),
        ...(csrfToken === undefined || csrfToken === ""
          ? {}
          : { "X-Armadra-CSRF": csrfToken }),
      },
    },
    options,
  );
}
