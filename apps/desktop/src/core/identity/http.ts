import type { ServerResponse } from "node:http";
import { MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./protocol";
import type { CoreRequest } from "../http/router";
import type { AccountsService } from "./accounts";
import { type IdentitySecurity, handleAccounts } from "./accounts-http";
import { IdentityError, identityFailure } from "./errors";
import { nativeOrigin } from "./origin";
import type { WsTickets } from "./transport";
import type {
  AccessRequest,
  IdentityService,
  Principal,
  SessionCredentials,
} from "./service";

/**
 * 身份域的那一面：`/api/identity/*`，JSON，`{ code, message }` 的错误信封。
 *
 * `/rpc/armadra.v1.{HostService,IdentityService}/*` 的 protobuf 兼容面在 R7 删掉
 * 了，能力表只在 `GET /api/identity/hello` 上（`docs/contracts/core-json-api.md`
 * §3）。
 *
 * **Cookie 的规矩照 Host**：只有 HTTPS 的那个权威来源才发 Cookie。回环 HTTP
 * 来源拿不到 Cookie 会话——Cookie 按 host 不按 port 隔离，`127.0.0.1:A` 的
 * Cookie 会发往同一个浏览器 profile 下的任何 `127.0.0.1:B`。桌面壳走的是票据
 * 换 Bearer 的原生传输，凭据只在页面内存里。core 今天只在回环明文 HTTP 上服务，
 * 所以实际上永远走原生传输；Cookie 那一支留着给 R6 的服务器壳。
 */

export const API_PREFIX = "/api/identity/";

/** Hello 里报的两个会话能力名，`apps/web/src/host/native-session.ts` 认这两个。 */
export const NATIVE_SESSION_CAPABILITY = "identity.native-session.v1";
export const BROWSER_SESSION_CAPABILITY = "identity.browser-session.v1";

export interface IdentityHttpOptions {
  readonly service: IdentityService;
  readonly instanceId: string;
  /**
   * 账号 / 组 / 共享（R6b）。没有它时那几条路径按 404 回答，和这个 core 没有
   * 应用 0019 的事实一致。
   */
  readonly accounts?: AccountsService;
  /** 额外的能力名，各域装配时追加。 */
  readonly capabilities?: () => readonly string[];
  /**
   * 加固（契约 §18.1–§18.4）：口令策略、锁定、passkey、MFA、会话列表。没有它时
   * 登录照旧、那几条路径 404。
   */
  readonly security?: IdentitySecurity;
  /**
   * 回环监听上的 WebSocket 票（契约 §3.2，安全审查 L9）。给了才答
   * `POST ws-ticket`：桌面壳的页面拿访问密钥换一张，升级时由回环的门兑换
   * （`identity/loopback.ts`）。经 Gateway 来的那一张由 Gateway 自己签。
   */
  readonly wsTickets?: WsTickets;
}

/**
 * 请求的来源地址：socket 的对端，IPv4 映射地址去掉前缀。不读
 * `X-Forwarded-For`——它谁都能写；反向代理后面看到的是代理，限流按代理算，
 * 宁紧勿松。
 */
export function remoteAddress(request: CoreRequest): string {
  const raw = request.raw.socket?.remoteAddress ?? "";
  return (raw.startsWith("::ffff:") ? raw.slice(7) : raw).slice(0, 64);
}

/* ------------------------------ 凭据的读取 -------------------------------- */

/**
 * Gateway 认定为原生 App（Bearer 模式，架构 §7）的那些请求：TLS 上来、来源是
 * App 的固定来源，凭据和桌面壳的原生传输一样走 `Authorization` 与响应体，不发
 * Cookie。由 `core/gateway/listener.ts` 在转交之前标上；按请求对象记，请求
 * 结束就随它回收。
 */
const bearerTransports = new WeakSet<object>();

export function markBearerTransport(raw: object): void {
  bearerTransports.add(raw);
}

/**
 * 这个请求走不走原生传输：明文连接 + 壳能呈现的回环 HTTP 来源，或者 Gateway
 * 标过的 Bearer 模式请求。
 */
export function nativeRequest(request: CoreRequest): boolean {
  if (bearerTransports.has(request.raw)) return true;
  const origin = header(request, "origin");
  return !isSecure(request) && origin !== undefined && nativeOrigin(origin);
}

/**
 * 这次写请求要不要 `X-Armadra-CSRF`（契约 §3.2、§17.4）：凭据是 Cookie（浏览器
 * 会话）时要——Cookie 是环境凭据，跨站页面发起的请求会自动带上它，双提交的那枚
 * 密钥是唯一分得清「是不是这张页面」的东西；凭据是 `Authorization: Bearer`
 * （桌面壳的原生传输、Gateway 的原生 App）时不要——跨站页面拿不到也带不上那个
 * 头，页面在这两种传输上本来就不发 CSRF 头。
 */
export function csrfRequired(request: CoreRequest): boolean {
  return !nativeRequest(request);
}

/**
 * 明文回环上没带凭据的一次调用，要不要按本机主人处理（契约 §3.2，安全审查 L9）。
 *
 * 缺省**不**：自 0.2.0 起桌面壳的页面经票据换来的 Bearer 打这两面（GitHub、
 * 自动化），本机另一个回环端口上的网页再也冒充不了主人。只有探针与开发命令
 * 起的裸 core（页面不在壳里、拿不到票）经 `ARMADRA_LOOPBACK_OWNER=1` 显式打开；
 * 桌面壳与服务器壳都不开（`core/main.ts` 的 `loopbackAnonymousOwner`）。
 */
let loopbackOwner = false;

export function setLoopbackAnonymousOwner(enabled: boolean): void {
  loopbackOwner = enabled;
}

export function loopbackAnonymousOwner(): boolean {
  return loopbackOwner;
}

/**
 * 这次调用走不走「按本机主人」那条路：选项打开、明文回环来源、一个凭据都没带。
 * Gateway 标过的 Bearer 模式请求永远不算——那是经网络来的原生 App。
 */
export function anonymousLoopbackOwner(
  request: CoreRequest,
  token: string,
): boolean {
  return (
    loopbackOwner &&
    token === "" &&
    !bearerTransports.has(request.raw) &&
    nativeRequest(request)
  );
}

export function isSecure(request: CoreRequest): boolean {
  return (request.raw.socket as { encrypted?: boolean }).encrypted === true;
}

export function cookieName(
  hostId: string,
  secure: boolean,
  purpose: string,
): string {
  return `${secure ? "__Host-armadra_" : "armadra_"}${hostId}_${purpose}`;
}

/** 单独一个 Bearer，重复或不是 Bearer 一律当没有。 */
export function bearerCredential(request: CoreRequest): string {
  const raw = request.headers.authorization;
  if (typeof raw !== "string") return "";
  const separator = raw.indexOf(" ");
  if (separator < 0) return "";
  if (raw.slice(0, separator).toLowerCase() !== "bearer") return "";
  const token = raw.slice(separator + 1).trim();
  if (token === "" || /[\s,]/.test(token)) return "";
  return token;
}

function cookieCredential(
  request: CoreRequest,
  hostId: string,
  purpose: string,
): string {
  const raw = request.headers.cookie;
  if (typeof raw !== "string") return "";
  const name = cookieName(hostId, isSecure(request), purpose);
  const found = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  // 两条同名 Cookie 是一次注入尝试，不是一次可以挑一条的选择。
  return found.length === 1 ? (found[0] as string).slice(name.length + 1) : "";
}

export function credential(
  request: CoreRequest,
  hostId: string,
  purpose: "access" | "refresh",
): string {
  return nativeRequest(request)
    ? bearerCredential(request)
    : cookieCredential(request, hostId, purpose);
}

export function sessionCookies(
  request: CoreRequest,
  response: ServerResponse,
  hostId: string,
  credentials: SessionCredentials,
): void {
  // 原生会话的密钥在响应体里；再发一份 Cookie 只会多留一份页面没要的副本。
  if (nativeRequest(request)) return;
  const secure = isSecure(request);
  response.setHeader(
    "set-cookie",
    (
      [
        ["access", credentials.accessToken, credentials.accessExpiresAtMs],
        ["refresh", credentials.refreshToken, credentials.expiresAtMs],
      ] as const
    ).map(
      ([purpose, value, expiry]) =>
        `${cookieName(hostId, secure, purpose)}=${value}; Path=/; Expires=${new Date(expiry).toUTCString()}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
    ),
  );
}

function clearSessionCookies(
  request: CoreRequest,
  response: ServerResponse,
  hostId: string,
): void {
  if (nativeRequest(request)) return;
  const secure = isSecure(request);
  response.setHeader(
    "set-cookie",
    ["access", "refresh"].map(
      (purpose) =>
        `${cookieName(hostId, secure, purpose)}=; Path=/; Max-Age=0; Expires=${new Date(1000).toUTCString()}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
    ),
  );
}

/* ------------------------------- 响应的形状 ------------------------------- */

function grants(principal: Principal) {
  return principal.scopes.map((value) => ({
    permission: value.Permission,
    workspaceId: value.WorkspaceID,
    executionHostId: value.ExecutionHostID,
  }));
}

/** 新面上的会话，JSON，camelCase。密钥不在里面——它们在 `native` 里单独给。 */
export function sessionJson(
  principal: Principal,
  expiresAtUnixMs: number,
): Record<string, unknown> {
  return {
    hostId: principal.hostId,
    device: {
      deviceId: principal.deviceId,
      principalId: principal.principalId,
      displayName: principal.deviceName,
      role: principal.role,
      createdAtUnixMs: principal.deviceCreatedAtMs,
      revision: principal.deviceEpoch,
    },
    scopes: grants(principal),
    expiresAtUnixMs,
  };
}

/* --------------------------------- 分发 ---------------------------------- */

export class IdentityHttp {
  constructor(private readonly options: IdentityHttpOptions) {}

  private get service(): IdentityService {
    return this.options.service;
  }

  capabilities(): string[] {
    return [
      NATIVE_SESSION_CAPABILITY,
      BROWSER_SESSION_CAPABILITY,
      ...(this.options.capabilities?.() ?? []),
    ];
  }

  async handle(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    const action = request.path.slice(API_PREFIX.length);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const origin = header(request, "origin");
    if (origin === undefined || countHeader(request, "origin") !== 1) {
      this.json(response, cors, 403, {
        code: "PERMISSION_DENIED",
        message: "Device permission or CSRF check failed",
      });
      return;
    }
    const hostId = this.service.hostId();
    const csrfToken = header(request, "x-armadra-csrf") ?? "";
    const actor: AccessRequest = {
      accessToken: credential(request, hostId, "access"),
      hostId,
      origin,
      csrfToken,
    };
    const csrf = csrfRequired(request);
    const remoteIp = remoteAddress(request);
    const userAgent = (header(request, "user-agent") ?? "").slice(0, 256);
    try {
      switch (`${request.method} ${action}`) {
        case "POST pair": {
          const body = request.json<{ ticket?: unknown }>();
          if (typeof body?.ticket !== "string")
            throw new IdentityError("invalid");
          const ticket = body.ticket;
          const credentials = this.throttled(remoteIp, () =>
            this.service.consumeBootstrap({
              ticket,
              hostId,
              instanceId: this.options.instanceId,
              origin,
              remoteIp,
              userAgent,
            }),
          );
          sessionCookies(request, response, hostId, credentials);
          this.json(
            response,
            cors,
            200,
            this.credentialJson(request, credentials),
          );
          return;
        }
        case "GET hello": {
          // 能力表只在这一条上。页面靠 `automation.plans.v1` 与 `github.*` 这类
          // 名字决定开不开一块面板，改一个名字等于让所有已装机器的那块面板一起
          // 熄灭。
          //
          // 不要求凭据：它回答的是「这台 core 是谁、支持什么」，而那正是一次配对
          // **之前**就要知道的事。
          this.json(response, cors, 200, this.helloJson());
          return;
        }
        case "GET session": {
          const principal = this.service.authenticate(actor);
          // 成员的快照只有底线，共享得来的授权每次现编；页面据此决定显示什么，
          // 所以这里报的是「快照 ∪ 现编」，和判定用的是同一份。
          const effective =
            principal.role === "member" && this.options.accounts !== undefined
              ? {
                  ...principal,
                  scopes: [
                    ...principal.scopes,
                    ...this.options.accounts.effectiveGrantScopes(
                      principal.principalId,
                    ),
                  ],
                }
              : principal;
          this.json(
            response,
            cors,
            200,
            sessionJson(effective, principal.accessExpiresAtMs),
          );
          return;
        }
        case "POST session/refresh": {
          const credentials = this.throttled(remoteIp, () =>
            this.service.refresh({
              refreshToken: credential(request, hostId, "refresh"),
              csrfToken,
              hostId,
              origin,
            }),
          );
          sessionCookies(request, response, hostId, credentials);
          this.json(
            response,
            cors,
            200,
            this.credentialJson(request, credentials),
          );
          return;
        }
        case "POST session/csrf": {
          const renewed = this.throttled(remoteIp, () =>
            this.service.renewCsrf({
              refreshToken: credential(request, hostId, "refresh"),
              hostId,
              origin,
            }),
          );
          this.json(response, cors, 200, { csrfToken: renewed });
          return;
        }
        case "POST session/logout": {
          this.throttled(remoteIp, () =>
            this.service.logoutRefresh({
              refreshToken: credential(request, hostId, "refresh"),
              csrfToken,
              hostId,
              origin,
            }),
          );
          clearSessionCookies(request, response, hostId);
          this.json(response, cors, 200, { closed: true });
          return;
        }
        case "POST ws-ticket": {
          const tickets = this.options.wsTickets;
          // 只给原生传输：浏览器会话（Cookie）的流经 Gateway 的门认 Cookie，用
          // 不着票。
          if (tickets === undefined || !nativeRequest(request)) {
            this.json(response, cors, 400, {
              code: "bearer_required",
              message: "WebSocket 票只发给原生传输",
            });
            return;
          }
          this.service.authenticate(actor);
          const issued = tickets.issue({
            accessToken: actor.accessToken,
            origin: actor.origin,
          });
          response.setHeader("cache-control", "no-store");
          this.json(response, cors, 200, {
            ticket: issued.ticket,
            expiresAt: new Date(issued.expiresAtMs).toISOString(),
          });
          return;
        }
        case "GET devices": {
          const page = this.service.listDevices(
            actor,
            request.query.get("afterId") ?? "",
            Number(request.query.get("limit") ?? 50),
          );
          this.json(response, cors, 200, page);
          return;
        }
        case "POST devices/revoke": {
          const body = request.json<{
            deviceId?: unknown;
            expectedRevision?: unknown;
          }>();
          if (
            typeof body?.deviceId !== "string" ||
            typeof body.expectedRevision !== "number"
          ) {
            throw new IdentityError("invalid");
          }
          this.service.revokeDevice(
            { ...actor, requireCsrf: csrf },
            body.deviceId,
            body.expectedRevision,
          );
          this.json(response, cors, 200, {
            deviceId: body.deviceId,
            revoked: true,
          });
          return;
        }
        default: {
          // 账号 / 组 / 共享这一面（R6b）。认证在它内部按需发生：`login` 与
          // 邀请接受之前调用方可能还没有会话，而其余动作都要求一个。
          const accounts = this.options.accounts;
          // 和配对同一条规矩：原生传输的密钥在响应体里，浏览器会话才发
          // Cookie（而且只在 HTTPS 的权威来源上带 Secure）。
          const issue = (credentials: SessionCredentials) => {
            sessionCookies(request, response, hostId, credentials);
            return this.credentialJson(request, credentials);
          };
          const security = this.options.security;
          const answered =
            accounts === undefined
              ? undefined
              : await handleAccounts(action, request, {
                  accounts,
                  // 写操作在 Cookie 会话上要 CSRF（契约 §10 与 §18 同一套）。
                  authenticate: (write = false) =>
                    this.service.authenticate({
                      ...actor,
                      requireCsrf: write && csrf,
                    }),
                  login: (input) =>
                    issue(
                      this.service.loginWithPassword({
                        ...input,
                        hostId,
                        origin,
                        remoteIp,
                        userAgent,
                      }),
                    ),
                  ...(security === undefined
                    ? {}
                    : {
                        security: {
                          security,
                          service: this.service,
                          actor,
                          csrf,
                          hostId,
                          origin,
                          remoteIp,
                          userAgent,
                          issue,
                        },
                      }),
                });
          if (answered?.text !== undefined) {
            // 审计导出（契约 §18.6）是这一面唯一不是 JSON 的答案。
            const payload = Buffer.from(answered.text.body, "utf8");
            response.writeHead(answered.status, {
              ...cors,
              "content-type": answered.text.contentType,
              "content-length": String(payload.byteLength),
              "content-disposition": `attachment; filename="${answered.text.filename}"`,
              "cache-control": "no-store",
            });
            response.end(payload);
            return;
          }
          if (answered !== undefined) {
            this.json(response, cors, answered.status, answered.body);
            return;
          }
          this.json(response, cors, 404, {
            code: "NOT_FOUND",
            message: `没有这个接口：${request.path}`,
          });
          return;
        }
      }
    } catch (error) {
      const failure = identityFailure(
        error instanceof SyntaxError ? new IdentityError("invalid") : error,
      );
      if (failure.retryAfterMs !== undefined) {
        response.setHeader(
          "retry-after",
          String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000))),
        );
      }
      this.json(response, cors, failure.status, {
        code: failure.code,
        message: failure.message,
      });
    }
  }

  /**
   * 凭据换会话的那几条（配对、刷新、换 CSRF、登出）的限流：桶空了答 429，
   * 只有失败才扣（`Throttle.checkIp` / `chargeIp`）。没装加固时不限。
   */
  private throttled<T>(remoteIp: string, action: () => T): T {
    const throttle = this.options.security?.throttle;
    throttle?.checkIp(remoteIp);
    try {
      return action();
    } catch (error) {
      if (error instanceof IdentityError) throttle?.chargeIp(remoteIp);
      throw error;
    }
  }

  private credentialJson(
    request: CoreRequest,
    credentials: SessionCredentials,
  ): Record<string, unknown> {
    const body = sessionJson(
      credentials.principal,
      credentials.accessExpiresAtMs,
    );
    body.csrfToken = credentials.csrfToken;
    if (nativeRequest(request)) {
      body.native = {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
      };
    }
    return body;
  }

  /**
   * Hello 的形状，写在 `docs/contracts/core-json-api.md` §3。
   *
   * 不要求凭据：它回答的是「这台 core 是谁、支持什么」，而那正是一次配对**之前**
   * 就要知道的事。
   */
  helloJson(): {
    readonly protocol: { readonly major: number; readonly minor: number };
    readonly hostInstanceId: string;
    readonly hostId: string;
    readonly capabilities: readonly string[];
    readonly maxFrameBytes: number;
  } {
    return {
      protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
      hostInstanceId: this.options.instanceId,
      hostId: this.service.hostId(),
      capabilities: this.capabilities(),
      maxFrameBytes: MAX_FRAME_BYTES,
    };
  }

  private json(
    response: ServerResponse,
    cors: Record<string, string>,
    status: number,
    body: unknown,
  ): void {
    const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    response.writeHead(status, {
      ...cors,
      "content-type": "application/json",
      "content-length": String(payload.byteLength),
    });
    response.end(payload);
  }
}

function header(request: CoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function countHeader(request: CoreRequest, name: string): number {
  const value = request.headers[name];
  if (value === undefined) return 0;
  return Array.isArray(value) ? value.length : 1;
}

function headerList(request: CoreRequest, name: string): string[] {
  const value = request.headers[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
