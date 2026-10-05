import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import {
  type AnyProcedure,
  ORPCError,
  Procedure,
  implement,
} from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
  type Contract,
  type ContractDomain,
  type ProcedureInput,
  type ProcedureMeta,
  type ProcedureResult,
  contract,
  contractEntries,
  errorStatus,
} from "@armadra/shared";
import {
  type RequestIdentity,
  requestIdentity,
  routeGuard,
} from "../identity/gate";
import { type CorePlatform, reportError } from "../platform";
import { CoreFailure } from "./errors";
import type { CoreRequest, HandlerResult } from "./router";
import type { CoreServer } from "./server";

/**
 * core 的 RPC 门面（工程规范化 §2.2.2、工程规范化包 §1.3）。
 *
 * `@orpc/*` 在 core 里只许出现在这个文件。业务侧（各域）看到的是：
 *
 *   * {@link registerProcedures}：一个域交出自己那部分实现——普通函数，入参是
 *     契约入参 schema 解析之后的值，拒绝就抛 `CoreFailure`（`fail(code, …)`）；
 *   * {@link installContract}：`main` 在所有域装好之后调一次，把实现挂到
 *     `/api/rpc/{procedure}`，并把带 `meta.legacy` 的那几条挂回旧 REST 路径。
 *
 * 线上：`POST /api/rpc/<域>/<动词>`，体是上游 RPC 编码（`{ json, meta? }`）；
 * 成功同样编码；失败一律 `{ code, message, requestId, details? }`（契约 §34.1），
 * 不是上游的 `{ defined, code, status, message, data }`。旧路径失败仍是
 * `{ code, message }`（加 `details` 当且仅当有），与迁移前逐字节同形。
 *
 * 准入门、来源、体积上限都在 `server.ts`，先于这里；这里补的是**按 procedure
 * 的路由门**：`/api/rpc/` 在路由门里是「自己判」的（`route-scopes.ts` 的
 * `SELF_GUARDED`），判定按每条契约的 `meta.scope` / `workspaceKey` 走同一道
 * `routeGuard()`，带旧路径的拿旧路径去问——服务器壳上成员看到的工作空间列表
 * 照旧只剩他有 `canvas:read` 的那几块。
 */

/** 一次调用里实现能看见的东西。 */
export interface RpcCall {
  readonly requestId: string;
  /** 这次请求是谁；本机壳（没有请求主体）是 `undefined`。 */
  readonly identity: RequestIdentity | undefined;
  readonly signal: AbortSignal | undefined;
  /** 原始请求（头、来源）；体已经被门面解析成入参了，别再读。 */
  readonly request: CoreRequest;
  /** 这台 core 实现了的 procedure（`system.hello` 报的那张表）。 */
  readonly procedures: readonly string[];
}

type ProcedureHandler<P> = (
  input: ProcedureInput<P>,
  call: RpcCall,
) => ProcedureResult<P> | Promise<ProcedureResult<P>>;

/** 一个域的实现：契约里这个域的每条 procedure 一个函数。 */
export type DomainHandlers<D extends ContractDomain> = {
  readonly [K in keyof Contract[D]]: ProcedureHandler<Contract[D][K]>;
};

type AnyHandler = (input: unknown, call: RpcCall) => unknown;

const registries = new WeakMap<CoreServer, Map<string, AnyHandler>>();

/** 一个域装配时交出自己那部分实现。同一条登记两次是装配错误。 */
export function registerProcedures<D extends ContractDomain>(
  server: CoreServer,
  domain: D,
  handlers: DomainHandlers<D>,
): void {
  let registry = registries.get(server);
  if (registry === undefined) {
    registry = new Map();
    registries.set(server, registry);
  }
  for (const [verb, handler] of Object.entries(handlers)) {
    const name = `${domain}.${verb}`;
    if (registry.has(name)) throw new Error(`${name} 登记了两次`);
    registry.set(name, handler as AnyHandler);
  }
}

export interface RpcInstallOptions {
  /**
   * 出参按契约校验（`ARMADRA_RPC_VALIDATE_OUTPUT`）。开发与测试缺省开：形状
   * 漂移在这里炸，而不是在页面渲染时炸；打包后的生产构建缺省关。
   */
  readonly validateOutput: boolean;
  /** 每条调用都记耗时（`ARMADRA_RPC_TRACE=1`）；只开一条用契约的 `meta.trace`。 */
  readonly trace?: boolean;
  readonly platform: Pick<CorePlatform, "log" | "reportError">;
}

/** 从环境读开关：`1` / `true` 开，`0` / `false` 关，缺省按是否打包。 */
export function rpcOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  platform: Pick<CorePlatform, "log" | "reportError" | "isPackaged">,
): RpcInstallOptions {
  const flag = (value: string | undefined): boolean | undefined =>
    value === undefined || value === ""
      ? undefined
      : value === "1" || value.toLowerCase() === "true";
  return {
    validateOutput:
      flag(env.ARMADRA_RPC_VALIDATE_OUTPUT) ??
      !(platform.isPackaged || env.NODE_ENV === "production"),
    trace: flag(env.ARMADRA_RPC_TRACE) ?? false,
    platform,
  };
}

export interface RpcHandle {
  /** 契约里的全部 procedure。 */
  readonly procedures: readonly string[];
  /** 这次装配真的有实现的那些；其余答 501 `not_implemented`。 */
  readonly implemented: readonly string[];
}

interface RpcContext {
  readonly request: CoreRequest;
  readonly requestId: string;
  /** 经旧路径进来的：`server.ts` 已经按真实路径过了路由门。 */
  readonly legacy: boolean;
}

/** 上游自带的大写码 → 注册表里的码。 */
const UPSTREAM_CODES: Readonly<Record<string, string>> = {
  BAD_REQUEST: "bad_request",
  UNAUTHORIZED: "unauthenticated",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  METHOD_NOT_SUPPORTED: "method_not_allowed",
  NOT_ACCEPTABLE: "bad_request",
  TIMEOUT: "internal",
  CONFLICT: "conflict",
  PRECONDITION_FAILED: "conflict",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  UNSUPPORTED_MEDIA_TYPE: "bad_request",
  UNPROCESSABLE_CONTENT: "bad_request",
  TOO_MANY_REQUESTS: "rate_limited",
  CLIENT_CLOSED_REQUEST: "bad_request",
  INTERNAL_SERVER_ERROR: "internal",
  NOT_IMPLEMENTED: "not_implemented",
  BAD_GATEWAY: "internal",
  SERVICE_UNAVAILABLE: "internal",
  GATEWAY_TIMEOUT: "internal",
};

const INTERNAL_MESSAGE = "核心处理请求时失败";

/** 线上的错误形状（契约 §5.1、§34.1）。 */
export interface RpcErrorBody {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** 一个错误 → 线上的码、状态与那句话。不认识的一律是 500 `internal`，原话不外泄。 */
export function errorEnvelope(
  error: unknown,
  requestId?: string,
): { status: number; body: RpcErrorBody } {
  const withId = (body: Omit<RpcErrorBody, "requestId">): RpcErrorBody =>
    requestId === undefined ? body : { ...body, requestId };
  if (!(error instanceof ORPCError)) {
    // 上游在解码入参时抛的不是 ORPCError：体不是合法的 JSON。
    return {
      status: 400,
      body: withId({ code: "bad_request", message: "请求体不是合法的 JSON" }),
    };
  }
  const code = UPSTREAM_CODES[error.code] ?? error.code;
  const status = errorStatus(code) ?? error.status;
  const internal =
    status >= 500 && (code === "internal" || code === "internal_error");
  const details = errorDetails(error);
  const base = {
    code,
    message: internal ? INTERNAL_MESSAGE : error.message,
  };
  return {
    status,
    body: withId(details === undefined ? base : { ...base, details }),
  };
}

/** 入参校验失败给字段路径与那句话（不给值）；其余给实现交出的细节。 */
function errorDetails(
  error: ORPCError<string, unknown>,
): Readonly<Record<string, unknown>> | undefined {
  const data = error.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  if (error.code === "BAD_REQUEST" && "issues" in data) {
    const issues = (data as { issues: unknown }).issues;
    if (!Array.isArray(issues)) return undefined;
    return {
      issues: issues.map((issue: unknown) => {
        const { path, message } = issue as {
          path?: readonly unknown[];
          message?: unknown;
        };
        return {
          path: (path ?? []).map((segment) =>
            typeof segment === "object" && segment !== null && "key" in segment
              ? (segment as { key: PropertyKey }).key.toString()
              : String(segment),
          ),
          message: typeof message === "string" ? message : "",
        };
      }),
    };
  }
  if (error.status >= 500) return undefined;
  return data as Record<string, unknown>;
}

/**
 * 域经 `fail(code, …)` 有意答的 5xx（`source_unreachable` 502、`source_offline`
 * 503 这类「对端不在」）：是答案，不是崩溃，不记错误、不报给壳。
 */
const deliberate = new WeakSet<object>();

/** 实现抛出来的 → 上游的错误；不是拒绝的原样往上抛，最后答 500。 */
function toUpstream(error: unknown): unknown {
  if (error instanceof ORPCError) return error;
  if (error instanceof CoreFailure) {
    const upstream = new ORPCError(error.code, {
      status: error.status,
      message: error.message,
      data: error.details,
    });
    if (error.code !== "internal" && error.code !== "internal_error") {
      deliberate.add(upstream);
    }
    return upstream;
  }
  if (error instanceof SyntaxError) {
    return new ORPCError("bad_request", {
      status: 400,
      message: "请求体不是合法的 JSON",
    });
  }
  return error;
}

const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

/** 已经缓冲好的请求 → 一个 fetch `Request`（体在 `server.ts` 里读过了）。 */
function toFetchRequest(core: CoreRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(core.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (Array.isArray(value))
      for (const one of value) headers.append(name, one);
    else headers.set(name, value);
  }
  const bodyless =
    core.method === "GET" ||
    core.method === "HEAD" ||
    core.body.byteLength === 0;
  // 不报类型（或报成纯文本，`fetch` 给字符串体的缺省）的调用方——脚本、探针——
  // 和迁移前一样被当成 JSON：旧路由从不看这个头。
  const declared = headers.get("content-type") ?? "";
  if (!bodyless && (declared === "" || declared.startsWith("text/plain"))) {
    headers.set("content-type", "application/json");
  }
  const search = core.query.toString();
  return new Request(`http://core${core.path}${search ? `?${search}` : ""}`, {
    method: core.method,
    headers,
    body: bodyless ? undefined : new Uint8Array(core.body),
  });
}

/** 路由门要看的那次请求：带旧路径的拿旧路径与旧的体去问，否则是一个不落在任何表规则上的名字。 */
function gateRequest(
  core: CoreRequest,
  name: string,
  meta: Partial<ProcedureMeta>,
  input: unknown,
): CoreRequest {
  const fields =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>) }
      : {};
  let method = "POST";
  let path = `rpc:${name}`;
  if (meta.legacy !== undefined) {
    method = meta.legacy.method;
    path = meta.legacy.path.replace(/\{([^}]+)\}/g, (_whole, key: string) => {
      const value = fields[key];
      delete fields[key];
      return encodeURIComponent(typeof value === "string" ? value : "");
    });
  }
  const body = Buffer.from(JSON.stringify(fields), "utf8");
  return {
    method,
    path,
    query: new URLSearchParams(),
    headers: core.headers,
    body,
    raw: core.raw,
    json: <T>() => JSON.parse(body.toString("utf8")) as T,
  };
}

function stringField(input: unknown, key: string): string {
  if (typeof input !== "object" || input === null) return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/** 一个 fetch `Response` 原样写到 Node 的响应上，叠上 CORS。 */
async function writeResponse(
  response: ServerResponse,
  answer: Response,
  cors: Record<string, string>,
): Promise<void> {
  const payload = Buffer.from(await answer.arrayBuffer());
  const headers: Record<string, string> = { ...cors };
  answer.headers.forEach((value, name) => {
    headers[name] = value;
  });
  if (payload.byteLength > 0)
    headers["content-length"] = String(payload.byteLength);
  response.writeHead(answer.status, headers);
  response.end(payload);
}

function writeEnvelope(
  response: ServerResponse,
  status: number,
  body: RpcErrorBody,
  cors: Record<string, string>,
): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    ...cors,
    "content-type": "application/json",
    "content-length": String(payload.byteLength),
  });
  response.end(payload);
}

type Implementer = Record<
  string,
  Record<string, { handler(fn: (options: never) => unknown): AnyProcedure }>
>;

/**
 * 把登记过的实现挂起来。在所有域 `install` 之后、任何监听开始之前调。
 */
export function installContract(
  server: CoreServer,
  options: RpcInstallOptions,
): RpcHandle {
  const registry = registries.get(server) ?? new Map<string, AnyHandler>();
  const entries = contractEntries();
  const names = entries.map((entry) => entry.name);
  for (const name of registry.keys()) {
    if (!names.includes(name)) throw new Error(`${name} 不在契约里`);
  }
  const implemented = names.filter((name) => registry.has(name));
  const { log } = options.platform;

  const base = implement(contract)
    .$context<RpcContext>()
    .use(async ({ context, procedure, path, next }, input) => {
      const meta = (procedure["~orpc"].meta ?? {}) as Partial<ProcedureMeta>;
      if (context.legacy || meta.scope === null || meta.scope === undefined) {
        return next();
      }
      const name = path.join(".");
      const verdict = routeGuard()(
        gateRequest(context.request, name, meta, input),
        {
          permission: meta.scope,
          workspaceId:
            meta.workspaceKey === undefined
              ? ""
              : stringField(input, meta.workspaceKey),
        },
      );
      if (!verdict.allowed) {
        throw new ORPCError("forbidden", {
          status: 403,
          message: "没有这项权限",
        });
      }
      const result = await next();
      return verdict.filter === undefined
        ? result
        : { ...result, output: verdict.filter(result.output) };
    }) as unknown as Implementer;

  const rpcTree: Record<string, Record<string, AnyProcedure>> = {};
  const legacyTree: typeof rpcTree = {};
  for (const entry of entries) {
    const [domain, verb] = entry.path as [string, string];
    const handler = registry.get(entry.name);
    const built = (base[domain] as Implementer[string])[verb]!.handler((async ({
      input,
      context,
      signal,
    }: {
      input: unknown;
      context: RpcContext;
      signal?: AbortSignal;
    }) => {
      if (handler === undefined) {
        throw new ORPCError("not_implemented", {
          status: 501,
          message: `未实现：${entry.name}`,
        });
      }
      try {
        return await handler(input, {
          requestId: context.requestId,
          identity: requestIdentity(),
          signal,
          request: context.request,
          procedures: implemented,
        });
      } catch (error) {
        throw toUpstream(error);
      }
    }) as never);
    const def = built["~orpc"];
    const procedure = options.validateOutput
      ? built
      : new Procedure({ ...def, outputSchema: undefined });
    (rpcTree[domain] ??= {})[verb] = procedure;
    const legacy = entry.meta.legacy;
    if (legacy !== undefined) {
      (legacyTree[domain] ??= {})[verb] = new Procedure({
        ...procedure["~orpc"],
        route: {
          method: legacy.method,
          path: legacy.path as `/${string}`,
          successStatus: legacy.successStatus ?? 200,
          inputStructure: "compact",
          outputStructure: "compact",
        },
      });
    }
  }

  const trace = (name: string, meta: Partial<ProcedureMeta>) =>
    options.trace === true || meta.trace === true ? name : undefined;
  const clientInterceptors = [
    async ({
      next,
      path,
      procedure,
    }: {
      next: () => Promise<unknown>;
      path: readonly string[];
      procedure: { "~orpc": { meta?: unknown } };
    }) => {
      const name = path.join(".");
      const traced = trace(
        name,
        (procedure["~orpc"].meta ?? {}) as Partial<ProcedureMeta>,
      );
      const started = performance.now();
      try {
        return await next();
      } catch (error) {
        const upstream = error instanceof ORPCError;
        if (
          !upstream ||
          (error.status >= 500 &&
            error.code !== "not_implemented" &&
            !deliberate.has(error))
        ) {
          // 没人接住的错误，或出参没过校验：记一行（只有名字与消息，不带入参
          // 与出参），按 §11.2 报给壳。
          log.error("rpc call failed", {
            procedure: name,
            error:
              upstream && error.cause instanceof Error
                ? error.cause.message
                : error instanceof Error
                  ? error.message
                  : String(error),
          });
          reportError(
            options.platform,
            upstream && error.cause ? error.cause : error,
            {
              source: "http",
            },
          );
        }
        // 到这里还不是上游错误的，是实现里没人接住的异常：一律 500。出了这层
        // 还不是上游错误的，只剩解码请求体失败（`errorEnvelope` 答 400）。
        throw upstream
          ? error
          : new ORPCError("INTERNAL_SERVER_ERROR", { cause: error });
      } finally {
        if (traced !== undefined) {
          log.info("rpc call", {
            procedure: traced,
            ms: Math.round(performance.now() - started),
          });
        }
      }
    },
  ];
  const envelope =
    (withRequestId: boolean) =>
    async ({
      next,
      context,
    }: {
      next: () => Promise<unknown>;
      context: RpcContext;
    }) => {
      try {
        return await next();
      } catch (error) {
        const { status, body } = errorEnvelope(
          error,
          withRequestId ? context.requestId : undefined,
        );
        return {
          matched: true,
          response: { status, headers: {}, body },
        };
      }
    };

  // 每个处理器各给一份数组：上游的插件会往 `clientInterceptors` 里追加自己的
  // 拦截器（RPC 的严格 GET），共用一份就会串到另一个处理器上。
  const rpc = new RPCHandler(rpcTree as never, {
    interceptors: [envelope(true) as never],
    clientInterceptors: [...clientInterceptors] as never,
  });
  const openapi = new OpenAPIHandler(legacyTree as never, {
    interceptors: [envelope(false) as never],
    clientInterceptors: [...clientInterceptors] as never,
  });

  server.raw("/api/rpc/", async (core, response, cors) => {
    const requestId = randomUUID();
    // 只收 POST：一个能被 GET 触发的写，在 Cookie 会话上就绕开了 CSRF。
    if (core.method !== "POST") {
      writeEnvelope(
        response,
        405,
        {
          code: "method_not_allowed",
          message: `${core.path} 不接受 ${core.method}`,
          requestId,
        },
        { ...cors, allow: "POST" },
      );
      return;
    }
    const result = await rpc.handle(toFetchRequest(core), {
      prefix: "/api/rpc",
      context: { request: core, requestId, legacy: false },
    });
    if (!result.matched) {
      writeEnvelope(
        response,
        404,
        {
          code: "not_found",
          message: `没有这个 procedure：${core.path}`,
          requestId,
        },
        cors,
      );
      return;
    }
    await writeResponse(response, result.response, cors);
  });

  // 旧路径：只有方法与模式都对得上的才交给上游路由，其余照旧走路由表。
  const legacyRoutes = new Set(
    entries.flatMap((entry) =>
      entry.meta.legacy === undefined
        ? []
        : [`${entry.meta.legacy.method} ${entry.meta.legacy.path}`],
    ),
  );
  server.contractRoutes(async (core): Promise<HandlerResult | undefined> => {
    const pattern = server.router.match(core.path)?.entry.path;
    if (
      pattern === undefined ||
      !legacyRoutes.has(`${core.method} ${pattern}`)
    ) {
      return undefined;
    }
    const result = await openapi.handle(toFetchRequest(core), {
      context: { request: core, requestId: randomUUID(), legacy: true },
    });
    if (!result.matched) return undefined;
    const text = await result.response.text();
    return {
      status: result.response.status,
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
  });

  return { procedures: names, implemented };
}
