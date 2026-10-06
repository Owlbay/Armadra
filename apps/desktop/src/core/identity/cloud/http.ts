/**
 * `/api/identity/cloud*` 的旧路径（契约 §31）。
 *
 * 整段 `/api/identity/` 是身份域的原样路由，自己认会话；这里登记一个更长的前缀
 * （原样路由按最长前缀匹配），同样自己认：`login` 匿名（断言就是凭据），其余按
 * 会话 + 契约里写的那一档权限判（与 RPC 门面按 `meta.scope` 判的是同一张表）。
 * 实现与 procedure 是同一份（`index.ts` 的 `CloudService`）。
 *
 * 会话的发法与配对、口令登录同一条规矩：原生传输（回环明文 + 壳的来源、Gateway
 * 或隧道标过的 Bearer 模式）把密钥放在响应体的 `native` 里，不发 Cookie；浏览器
 * 会话发 `HttpOnly` Cookie，体里只有 CSRF。
 */

import type { ServerResponse } from "node:http";

import {
  cloudBindInputSchema,
  cloudLoginInputSchema,
  cloudRegisterInputSchema,
  cloudRevokeInputSchema,
  cloudTrustedOriginsInputSchema,
} from "@armadra/platform-protocol/core-api";

import { CoreFailure, fail } from "../../http/errors";
import type { CoreRequest } from "../../http/router";
import type { Authorizer } from "../authorize";
import { IdentityError, IdentityRefusal } from "../errors";
import { runAs } from "../gate";
import {
  credential,
  csrfRequired,
  nativeRequest,
  remoteAddress,
  sessionCookies,
  sessionJson,
} from "../http";
import { canonicalOrigin } from "../origin";
import { type Scope, scope } from "../scopes";
import type {
  IdentityService,
  Principal,
  SessionCredentials,
} from "../service";
import type { Throttle } from "../throttle";
import { sessionIdentity, subjectOf } from "../transport";
import type { CloudService } from "./service";

export const CLOUD_PREFIX = "/api/identity/cloud";

export interface CloudHttpOptions {
  readonly service: IdentityService;
  readonly authorizer: Authorizer;
  readonly cloud: CloudService;
  /** 来源地址的令牌桶（只有失败扣）；没装加固时不限。 */
  readonly throttle?: Throttle;
}

function header(request: CoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** 协议包的 zod schema 只用到这一点：`safeParse`。core 不直接依赖 zod。 */
interface Parser<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: {
          issues: readonly {
            path: readonly PropertyKey[];
            message: string;
          }[];
        };
      };
}

function parse<T>(schema: Parser<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw fail("bad_request", "Input validation failed", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function body(request: CoreRequest): Record<string, unknown> {
  if (request.body.byteLength === 0) return {};
  let value: unknown;
  try {
    value = request.json();
  } catch {
    throw fail("bad_request", "请求体不是合法的 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail("bad_request", "请求体应为一个 JSON 对象");
  }
  return value as Record<string, unknown>;
}

/** 失败 → `{ code, message, details? }` 与状态；不认识的一律 500，原话不外泄。 */
function failureOf(error: unknown): {
  status: number;
  body: Record<string, unknown>;
  retryAfterMs?: number;
} {
  if (error instanceof CoreFailure) {
    const retry = (error.details as { retryAfterMs?: unknown } | undefined)
      ?.retryAfterMs;
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      ...(typeof retry === "number" ? { retryAfterMs: retry } : {}),
    };
  }
  if (error instanceof IdentityRefusal) {
    return {
      status: error.status,
      body: { code: error.code, message: error.message },
      ...(error.retryAfterMs > 0 ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  if (error instanceof IdentityError) {
    const failure =
      error.kind === "permission"
        ? fail("forbidden", "没有这项权限，或 CSRF 校验未通过")
        : fail("unauthenticated", "需要一个有效的会话");
    return failureOf(failure);
  }
  return {
    status: 500,
    body: { code: "internal", message: "核心处理请求时失败" },
  };
}

export class CloudHttp {
  constructor(private readonly options: CloudHttpOptions) {}

  async handle(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    try {
      const declared = header(request, "origin");
      const origin =
        declared === undefined ? undefined : canonicalOrigin(declared);
      if (origin === undefined) {
        throw fail("forbidden", "请求没有带来源");
      }
      const rest = request.path.slice(CLOUD_PREFIX.length);
      const route = `${request.method} ${rest}`;
      if (route === "POST /login") {
        await this.login(request, response, cors, origin);
        return;
      }
      const answer = await this.authenticated(request, origin, route);
      if (answer === undefined) {
        throw fail("not_found", `没有这个接口：${request.path}`);
      }
      this.json(response, cors, 200, answer);
    } catch (error) {
      if (!(error instanceof CoreFailure || error instanceof IdentityError)) {
        // 没人接住的错误交给 server.ts：记一行、答 500，原话不外泄；请求体
        // （断言、令牌）不进日志。
        throw error;
      }
      const failure = failureOf(error);
      if (failure.retryAfterMs !== undefined) {
        response.setHeader(
          "retry-after",
          String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000))),
        );
      }
      this.json(response, cors, failure.status, failure.body);
    }
  }

  private async login(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
    origin: string,
  ): Promise<void> {
    const { throttle, cloud } = this.options;
    const remoteIp = remoteAddress(request);
    throttle?.checkIp(remoteIp);
    let result: Awaited<ReturnType<CloudService["login"]>>;
    try {
      const input = parse(cloudLoginInputSchema, body(request));
      result = await cloud.login({
        assertion: input.assertion,
        invitationToken: input.invitationToken,
        origin,
        remoteIp,
        userAgent: (header(request, "user-agent") ?? "").slice(0, 256),
      });
    } catch (error) {
      throttle?.chargeIp(remoteIp);
      throw error;
    }
    const hostId = this.options.service.hostId();
    sessionCookies(request, response, hostId, result.credentials);
    response.setHeader("cache-control", "no-store");
    this.json(response, cors, 200, {
      session: this.sessionBody(request, result.credentials),
      principal: result.principal,
      created: result.created,
    });
  }

  private sessionBody(
    request: CoreRequest,
    credentials: SessionCredentials,
  ): Record<string, unknown> {
    const session = sessionJson(
      credentials.principal,
      credentials.accessExpiresAtMs,
    );
    session.csrfToken = credentials.csrfToken;
    if (nativeRequest(request)) {
      session.native = {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
      };
    }
    return session;
  }

  /** 要会话的那几条：认人、判权限，以这个人的身份跑。 */
  private async authenticated(
    request: CoreRequest,
    origin: string,
    route: string,
  ): Promise<unknown> {
    const trusted = /^PUT \/([^/]+)\/trusted-origins$/.exec(route);
    const required: Scope | undefined =
      route === "GET " || route === "GET /"
        ? scope("settings:read")
        : route === "POST /register" ||
            route === "DELETE /register" ||
            trusted !== null
          ? scope("settings:write")
          : route === "POST /bind"
            ? scope("identity:read")
            : undefined;
    if (required === undefined) return undefined;
    const { service, authorizer, cloud } = this.options;
    const hostId = service.hostId();
    const write = request.method !== "GET";
    const principal: Principal = service.authenticate({
      accessToken: credential(request, hostId, "access"),
      hostId,
      origin,
      requireCsrf: write && csrfRequired(request),
      csrfToken: header(request, "x-armadra-csrf") ?? "",
    });
    if (!authorizer.permits(subjectOf(principal), [required])) {
      throw fail("forbidden", "没有这项权限");
    }
    const identity = sessionIdentity(service, hostId, principal, origin);
    return runAs(identity, async () => {
      if (route === "GET " || route === "GET /") return cloud.status();
      if (route === "POST /register") {
        return cloud.register(
          parse(cloudRegisterInputSchema, body(request)),
          principal.principalId,
        );
      }
      if (route === "DELETE /register") {
        const fields = body(request);
        const issuer = request.query.get("issuer");
        return cloud.revoke(
          parse(
            cloudRevokeInputSchema,
            issuer === null ? fields : { ...fields, issuer },
          ),
          principal.principalId,
        );
      }
      if (route === "POST /bind") {
        return cloud.bind(
          principal.principalId,
          parse(cloudBindInputSchema, body(request)).assertion,
        );
      }
      let issuer = "";
      try {
        issuer = decodeURIComponent(trusted?.[1] ?? "");
      } catch {
        throw fail("bad_request", "地址里的 issuer 不是合法的编码");
      }
      return cloud.trustedOrigins(
        parse(cloudTrustedOriginsInputSchema, { ...body(request), issuer }),
      );
    });
  }

  private json(
    response: ServerResponse,
    cors: Record<string, string>,
    status: number,
    payload: unknown,
  ): void {
    const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
    response.writeHead(status, {
      ...cors,
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
    });
    response.end(bytes);
  }
}
