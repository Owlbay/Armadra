import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { EventBus } from "../bus";
import { type CorePlatform, reportError } from "../platform";
import { corsHeaders, websocketOriginAllowed } from "./cors";
import {
  type ErrorResponse,
  badRequest,
  forbidden,
  internal,
  payloadTooLarge,
} from "./errors";
import {
  type RequestIdentity,
  onAccessChanged,
  requestIdentity,
  routeGuard,
  runAs,
} from "../identity/gate";
import type { AuthorizationSubject } from "../identity/authorize";
import { MAX_FRAME_BYTES } from "../identity/protocol";
import { type HookHealth, NO_HOOK_SERVICE, healthDocument } from "./health";
import { type CoreRequest, type HandlerResult, Router } from "./router";
import { CONTROL_PROTOCOL, goingAway } from "./ws-control";
import { applyHttpTimeouts } from "./timeouts";

/**
 * The core's HTTP and WebSocket face.
 *
 * `node:http` plus `ws`, and nothing else. Express or Fastify would buy
 * routing the core already has as a table and middleware the core has three
 * of; what they would cost is a second opinion on the error envelope, which
 * is contractual (`{ code, message }`, camelCase, contract §5.1).
 *
 * The three layers, in the order a request meets them:
 *
 *   1. **Origin.** A browser request must come from a loopback origin, and a
 *      WebSocket upgrade must name one — the browser sends no preflight for an
 *      upgrade, so this check is the only gate on the streams. A request with
 *      no `Origin` is not a browser and passes: that is `curl`, the shell's own
 *      probe and the hook client.
 *   2. **Body limit.** A body is buffered before it is parsed, so the ceiling
 *      has to bite while reading, not after.
 *   3. **Envelope.** Every answer is JSON; every failure is `{ code, message }`.
 */

/**
 * 授权变了、复核不过时关流用的码（与实时同步的 4403 同一个，契约 §16.1）。
 */
export const CLOSE_ACCESS_REVOKED = 4403;

/**
 * 访问令牌到期、会话没有刷新时关流用的码（安全审查 L1）。与 4403 分开：这不是
 * 授权被收回，页面照常重连——重连在升级前过门，凭据刷新之后就进得来。
 */
export const CLOSE_ACCESS_EXPIRED = 4401;

/** `setTimeout` 能等的最长时间；再远的到期分段等。 */
const MAX_TIMER_MS = 2_147_483_647;

/** How long `close()` waits for a listener before giving up on it. */
export const CLOSE_GRACE_MS = 2_000;

/** What a body may weigh before the core stops reading it. */
export const MAX_BODY_BYTES = 12 * 1024 * 1024;

/**
 * 一条流上客户端一帧的缺省上限：`GET /api/identity/hello` 报的 `maxFrameBytes`
 * （`identity/protocol.ts`）。帧本来就大的流在 {@link CoreServer.stream} 里各自
 * 声明（实时协同的首个 step2、终端的大段粘贴）。超过的帧由 `ws` 以 `1009` 关流。
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES;

/**
 * `ws` 层心跳的间隔（工程规范化 §3.3）：每隔这么久给每条流发一个 ping 控制帧，
 * 浏览器自己回 pong。连续 {@link HEARTBEAT_MISSES} 次没有 pong 就 `terminate()`——
 * 半开的连接（睡眠的笔记本、断了的隧道）不再占着终端的附着与队列。ping 同时给
 * 中继与代理保活（很多代理 60 秒空闲就断）。
 */
export const HEARTBEAT_MS = 25_000;
export const HEARTBEAT_MISSES = 2;

export interface CoreServerOptions {
  readonly platform: CorePlatform;
  readonly bus: EventBus;
  readonly version: string;
  /** R3 replaces this; R0 reports a core with no hook service. */
  readonly hookHealth?: () => HookHealth;
  readonly maxBodyBytes?: number;
  /** ws 层心跳间隔；`0` 关掉。缺省 {@link HEARTBEAT_MS}。 */
  readonly heartbeatMs?: number;
}

export class CoreServer {
  readonly router = new Router();
  /** 按单帧上限分的 `ws` 服务器：`maxPayload` 是服务器级的选项。 */
  private readonly websockets = new Map<number, WebSocketServer>();
  /** 每条连接连续几次 ping 没等到 pong。 */
  private readonly missedPongs = new WeakMap<WebSocket, number>();
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly servers: Server[] = [];
  private readonly streams = new Map<string, StreamRegistration>();
  private readonly rawRoutes: { prefix: string; handler: RawHandler }[] = [];
  private readonly bodyLimits = new Map<string, number>();
  private readonly options: CoreServerOptions;
  private readonly capabilityProbes = new Map<string, () => boolean>();
  private admissionGate: RequestAdmission | undefined;
  private contractLegacy: ContractLegacy | undefined;

  constructor(options: CoreServerOptions) {
    this.options = options;
    const health = () => ({
      status: 200,
      body: healthDocument({
        version: options.version,
        hookHealth: options.hookHealth ?? (() => NO_HOOK_SERVICE),
        capabilities: () => this.capabilities(),
      }),
    });
    this.router.handle("GET", "/health", health);
    this.router.handle("GET", "/api/health", health);
  }

  /**
   * 一个域登记一项页面要知道的能力，`/health` 每次现问。
   *
   * 由域自己登记而不是在 main 里汇总：能力有没有，只有装配它的域说得清，
   * 比如浏览器域知道自己选的是哪个后端、找没找到 Chromium。
   */
  capability(name: string, probe: () => boolean): void {
    this.capabilityProbes.set(name, probe);
  }

  private capabilities(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [name, probe] of this.capabilityProbes) {
      try {
        out[name] = probe();
      } catch {
        out[name] = false;
      }
    }
    return out;
  }

  /**
   * 回环监听上的准入（契约 §3.2，安全审查 L9）：身份域装配时放进来，判每一个
   * 直接打到这台 core 自己监听上的请求与升级要不要凭据、是谁。没装时一律放行——
   * 那是裸 core 显式打开回环匿名（`ARMADRA_LOOPBACK_OWNER=1`）或没有身份域的
   * 单元测试。
   *
   * 经 Gateway 交接进来的请求不过这道门（{@link createListener} 的 `admitted`）：
   * Gateway 在 TLS 那一侧已经认过人，并把身份放进了这次请求（`runAs`）。
   */
  admission(gate: RequestAdmission | undefined): void {
    this.admissionGate = gate;
  }

  /**
   * A server per listener. One address per `http.Server` is a Node fact, so
   * the router and the upgrade handler are shared and the servers are not.
   */
  createListener(
    options: {
      readonly admitted?: boolean;
      /**
       * 只与 `admitted` 一起用：交接点自己的门（中继隧道，契约 §32）。给了它，
       * 回环那一套来源与 CORS 判定就不再适用——来源、凭据、CORS 头都由它定，
       * 它放行时带出的身份就是这次请求的身份。
       */
      readonly gate?: ListenerGate;
    } = {},
  ): Server {
    const admitted = options.admitted === true;
    const gate = admitted ? options.gate : undefined;
    const server = createServer((request, response) => {
      if (gate !== undefined) {
        void this.serveGated(request, response, gate);
        return;
      }
      void this.serve(request, response, admitted);
    });
    applyHttpTimeouts(server);
    server.on("upgrade", (request, socket, head) => {
      if (gate !== undefined) {
        this.upgradeGated(request, socket, head, gate);
        return;
      }
      this.upgrade(request, socket, head, admitted);
    });
    this.servers.push(server);
    return server;
  }

  /** 交接点自己的门判过之后再进来（{@link createListener} 的 `gate`）。 */
  private async serveGated(
    request: IncomingMessage,
    response: ServerResponse,
    gate: ListenerGate,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://core");
    const verdict = gate(coreRequest(request, url, EMPTY_BODY), false);
    if ("refusal" in verdict) {
      return this.send(
        response,
        verdict.refusal.status,
        verdict.refusal.body,
        verdict.refusal.cors,
      );
    }
    if ("reply" in verdict) {
      return this.send(
        response,
        verdict.reply.status,
        verdict.reply.body,
        verdict.reply.cors,
      );
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, verdict.cors);
      response.end();
      return;
    }
    if (verdict.identity === undefined) {
      return this.serveAdmitted(request, response, verdict.cors, url);
    }
    return runAs(verdict.identity, () =>
      this.serveAdmitted(request, response, verdict.cors, url),
    );
  }

  private upgradeGated(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    gate: ListenerGate,
  ): void {
    const url = new URL(request.url ?? "/", "http://core");
    const found = this.router.match(url.pathname);
    const registration =
      found === undefined ? undefined : this.streams.get(found.entry.path);
    const verdict = gate(coreRequest(request, url, EMPTY_BODY), true);
    if ("refusal" in verdict || "reply" in verdict) {
      const answer = "refusal" in verdict ? verdict.refusal : verdict.reply;
      const code =
        typeof answer.body === "object" &&
        answer.body !== null &&
        "code" in answer.body
          ? String((answer.body as { code: unknown }).code)
          : "";
      socket.write(
        `HTTP/1.1 ${answer.status} ${code}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    if (found === undefined || registration === undefined) {
      socket.write("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const core = coreRequest(request, url, EMPTY_BODY);
    const proceed = () =>
      this.upgradeAdmitted(request, socket, head, core, found, registration);
    if (verdict.identity === undefined) proceed();
    else runAs(verdict.identity, proceed);
  }

  private async serve(
    request: IncomingMessage,
    response: ServerResponse,
    admitted = false,
  ): Promise<void> {
    const origin = request.headers.origin;
    const headers = corsHeaders(Array.isArray(origin) ? origin[0] : origin);
    if (headers === undefined) {
      return this.send(response, 403, {
        code: "forbidden",
        message: "来源不被允许",
      });
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://core");
    const gate = admitted ? undefined : this.admissionGate;
    if (gate !== undefined) {
      // 在读请求体之前判：一个没带凭据的请求不该让 core 先缓冲它的 12 MB。
      const verdict = gate(coreRequest(request, url, EMPTY_BODY), false);
      if ("refusal" in verdict) {
        return this.send(
          response,
          verdict.refusal.status,
          verdict.refusal.body,
          headers,
        );
      }
      if (verdict.identity !== undefined) {
        const identity = verdict.identity;
        return runAs(identity, () =>
          this.serveAdmitted(request, response, headers, url),
        );
      }
    }
    return this.serveAdmitted(request, response, headers, url);
  }

  private async serveAdmitted(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
    url: URL,
  ): Promise<void> {
    const path = url.pathname;
    let answer: HandlerResult | ErrorResponse;
    try {
      const body = await readBody(request, this.bodyLimitFor(path));
      if (!body.ok) {
        answer = body.tooLarge
          ? payloadTooLarge(body.reason)
          : badRequest(body.reason);
      } else {
        const core = coreRequest(request, url, body.body);
        // 共享权限的路由门（设计 S3）：路由表声明要什么，门按这次请求的主体
        // 判。本机壳没有请求主体，门恒放行；服务器壳上成员在这里被拦下。
        const verdict = routeGuard()(
          core,
          this.router.requiredScope(core.method, path),
        );
        if (!verdict.allowed) {
          answer = forbidden("没有这项权限");
        } else {
          // Raw routes come before the table: they own their own request and
          // response handling, so the JSON envelope must not touch them.
          // Origin and the body ceiling still apply — they ran above.
          const raw = this.rawRoutes.find((route) =>
            path.startsWith(route.prefix),
          );
          if (raw !== undefined) {
            await raw.handler(core, response, headers);
            return;
          }
          // 迁到契约上的旧路径先问 RPC 门面（`http/rpc.ts`），它不认的照旧
          // 走路由表——迁移期两边并存，表里那条 handler 仍是回落。
          answer =
            (await this.contractLegacy?.(core)) ??
            (await this.router.dispatch(request.method ?? "GET", path, core));
          if (
            verdict.filter !== undefined &&
            answer.status >= 200 &&
            answer.status < 300 &&
            !("raw" in answer && answer.raw !== undefined)
          ) {
            answer = { ...answer, body: verdict.filter(answer.body) };
          }
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        // 一份坏的 JSON 是调用方的错，不是 core 的。它的消息里引着请求体的
        // 开头（可能正是一个凭据值），所以不进日志、不进崩溃上报。
        answer = badRequest("请求体不是合法的 JSON");
      } else {
        this.options.platform.log.error("request failed", {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        // 没人接住的错误才走到这里；按 §11.2 报给壳（没开上报就只是这行日志）。
        reportError(this.options.platform, error, { source: "http" });
        answer = internal("核心处理请求时失败");
      }
    }
    this.send(
      response,
      answer.status,
      answer.body,
      {
        ...headers,
        ...("headers" in answer ? answer.headers : undefined),
      },
      "raw" in answer ? answer.raw : undefined,
    );
  }

  private send(
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
    raw?: Buffer,
  ): void {
    // 204 carries no body, and no `Content-Type` for a body that is not
    // there. `null\n` under `application/json` is what a client sees as a
    // document, and it is not the answer the Rust Runtime gives to a DELETE.
    const empty = status === 204 || status === 304;
    const payload = empty
      ? Buffer.alloc(0)
      : (raw ?? Buffer.from(JSON.stringify(body ?? null), "utf8"));
    response.writeHead(status, {
      ...(empty
        ? {}
        : {
            "content-type": raw
              ? "application/octet-stream"
              : "application/json",
          }),
      ...headers,
      ...(empty ? {} : { "content-length": String(payload.byteLength) }),
    });
    response.end(payload);
  }

  /**
   * Raises the body ceiling for one table route — the multipart imports,
   * which the Rust Runtime let through at a batch plus a manifest. Keyed by
   * the route's pattern, so a limit set before the route is claimed still
   * applies once it is.
   */
  bodyLimit(path: string, bytes: number): void {
    this.bodyLimits.set(path, bytes);
  }

  private bodyLimitFor(path: string): number {
    const found = this.router.match(path);
    return (
      (found === undefined
        ? undefined
        : this.bodyLimits.get(found.entry.path)) ??
      this.options.maxBodyBytes ??
      MAX_BODY_BYTES
    );
  }

  /**
   * A route matched by prefix, before the table, that writes its own response.
   * For domains whose verbs do not fit the generic JSON envelope (identity,
   * GitHub, automations) and want to encode and dispatch by hand. Origin and
   * the body ceiling are still enforced before the handler runs.
   */
  raw(prefix: string, handler: RawHandler): void {
    this.rawRoutes.push({ prefix, handler });
    this.rawRoutes.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /**
   * 迁到契约上的旧 REST 路径（工程规范化 §2.4）：RPC 门面在这里接住方法与模式
   * 都对得上的请求，答 `undefined` 的照旧交给路由表。来源、准入、体积上限与
   * 路由门都在它之前判过了，成功答案照样过路由门的 `filter`。
   */
  contractRoutes(handler: ContractLegacy | undefined): void {
    this.contractLegacy = handler;
  }

  /** 这条路径落在某个整段接管的前缀里（三张 JSON 面就是这么装的）。 */
  /** 整段接管的前缀，按登记顺序（长的在前）。路由 scope 的覆盖率用例逐个问。 */
  rawPrefixes(): readonly string[] {
    return this.rawRoutes.map((route) => route.prefix);
  }

  rawHandled(path: string): boolean {
    return this.rawRoutes.some((route) => path.startsWith(route.prefix));
  }

  /**
   * The upgrade path. R0 accepts no stream yet — every WebSocket route in the
   * table belongs to R1 and later — so an upgrade is refused with the same
   * reason the HTTP side would give, rather than left hanging.
   */
  private upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    admitted = false,
  ): void {
    const origin = request.headers.origin;
    if (!websocketOriginAllowed(Array.isArray(origin) ? origin[0] : origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://core");
    const path = url.pathname;
    const found = this.router.match(path);
    const registration =
      found === undefined ? undefined : this.streams.get(found.entry.path);
    if (found === undefined || registration === undefined) {
      socket.write("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const core = coreRequest(request, url, EMPTY_BODY);
    const gate = admitted ? undefined : this.admissionGate;
    if (gate !== undefined) {
      // 浏览器的升级带不了 `Authorization`：凭据是 `Sec-WebSocket-Protocol` 里
      // 那张一次性票（契约 §3.2），由门兑换、认证。
      const verdict = gate(core, true);
      if ("refusal" in verdict) {
        socket.write(
          `HTTP/1.1 ${verdict.refusal.status} ${verdict.refusal.body.code}\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      if (verdict.identity !== undefined) {
        const identity = verdict.identity;
        runAs(identity, () =>
          this.upgradeAdmitted(
            request,
            socket,
            head,
            core,
            found,
            registration,
          ),
        );
        return;
      }
    }
    this.upgradeAdmitted(request, socket, head, core, found, registration);
  }

  private upgradeAdmitted(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    core: CoreRequest,
    found: NonNullable<ReturnType<Router["match"]>>,
    registration: StreamRegistration,
  ): void {
    const path = core.path;
    // 升级前和 HTTP 同一道路由门：终端的 socket 能写，事件流能读，都得先过它。
    if (!routeGuard()(core, this.router.requiredScope("GET", path)).allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    void (async () => {
      // The guard answers BEFORE the upgrade, as the Rust runtime does: a
      // missing workspace is an HTTP 404, not a socket that opens and closes.
      const refusal = registration.guard
        ? await registration.guard(found.params, core)
        : undefined;
      if (refusal !== undefined) {
        socket.write(
          `HTTP/1.1 ${refusal.status} ${refusal.reason ?? ""}\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      // 升级时的那个人。长连接不会再经过任何请求级的门，所以授权一变（撤销
      // 设备或会话、登出、停用账号、收回共享）就按同一道路由门复核一次，不过就
      // 以 4403 关流——终端、语言服务、浏览器画面这些流自己不复核，靠的就是这里。
      const identity = requestIdentity();
      const websockets = this.websocketsFor(registration.maxPayload);
      websockets.handleUpgrade(request, socket, head, (connection) => {
        this.track(connection);
        registration.open(connection, found.params, core);
        if (identity === undefined) return;
        const permitted = (subject: AuthorizationSubject) =>
          runAs({ ...identity, subject }, () =>
            routeGuard()(core, this.router.requiredScope("GET", path)),
          ).allowed;
        const stop = onAccessChanged(() => {
          if (connection.readyState !== connection.OPEN) return;
          const subject =
            identity.revalidate === undefined
              ? identity.subject
              : identity.revalidate();
          if (subject === undefined || !permitted(subject)) {
            connection.close(CLOSE_ACCESS_REVOKED, "forbidden");
          }
        });
        // 访问令牌到期时再认一次（安全审查 L1）：授权没变的流原来能一直活下去，
        // 比签给它的令牌活得久。刷新过就续到新的到期时刻，没刷新以 4401 关，
        // 刷新过但门不放行（授权变了）以 4403 关。
        let timer: NodeJS.Timeout | undefined;
        const expire = (atMs: number) => {
          timer = setTimeout(
            () => {
              timer = undefined;
              if (connection.readyState !== connection.OPEN) return;
              if (Date.now() < atMs) {
                expire(atMs);
                return;
              }
              const renewed = identity.renew?.();
              if (
                renewed === undefined ||
                renewed.accessExpiresAtMs <= Date.now()
              ) {
                connection.close(CLOSE_ACCESS_EXPIRED, "expired");
              } else if (!permitted(renewed.subject)) {
                connection.close(CLOSE_ACCESS_REVOKED, "forbidden");
              } else {
                expire(renewed.accessExpiresAtMs);
              }
            },
            Math.min(Math.max(atMs - Date.now(), 0), MAX_TIMER_MS),
          );
          timer.unref();
        };
        if (
          identity.accessExpiresAtMs !== undefined &&
          identity.renew !== undefined
        ) {
          expire(identity.accessExpiresAtMs);
        }
        connection.once("close", () => {
          stop();
          if (timer !== undefined) clearTimeout(timer);
        });
      });
    })();
  }

  /**
   * R1 and later attach their streams here; the table still gates the path.
   * `guard` may refuse the upgrade with an HTTP status before any socket
   * exists — the only way to answer 404/401/409 the way an HTTP route would.
   */
  stream(
    path: string,
    handler: StreamHandler,
    guard?: StreamGuard,
    options: StreamOptions = {},
  ): void {
    this.streams.set(path, {
      open: handler,
      guard,
      maxPayload: options.maxPayload ?? DEFAULT_MAX_PAYLOAD_BYTES,
    });
  }

  private websocketsFor(maxPayload: number): WebSocketServer {
    let websockets = this.websockets.get(maxPayload);
    if (websockets === undefined) {
      websockets = new WebSocketServer({
        noServer: true,
        maxPayload,
        // Terminal frames are the reason: compression on a stream of escape
        // sequences costs CPU per frame for a ratio the transport does not need.
        perMessageDeflate: false,
        // 子协议：报了控制面的（`armadra-rpc.v1`，契约 §35.1）回选它，其余照旧
        // 回选第一个（那张一次性票）。
        handleProtocols: (protocols) =>
          protocols.has(CONTROL_PROTOCOL)
            ? CONTROL_PROTOCOL
            : (protocols.values().next().value ?? false),
      });
      this.websockets.set(maxPayload, websockets);
    }
    return websockets;
  }

  /**
   * 把一条刚升级的连接挂上心跳。一个定时器管全部连接：每一跳先看上一跳的
   * ping 有没有回音，连续 {@link HEARTBEAT_MISSES} 跳没有就 `terminate()`（不走
   * 关闭握手——对端已经不说话了），否则再 ping 一次。
   */
  private track(connection: WebSocket): void {
    // 一帧超限、坏帧这类协议错误由 `ws` 以 `error` 事件报出，紧接着自己关流。
    // 没有监听者的 `error` 是进程级的未捕获异常——一个客户端发一帧大的就能把
    // core 打掉——所以在这里统一接住；各流照旧在 `close` 里收尾。
    connection.on("error", () => {});
    const interval = this.options.heartbeatMs ?? HEARTBEAT_MS;
    if (interval <= 0) return;
    this.missedPongs.set(connection, 0);
    connection.on("pong", () => this.missedPongs.set(connection, 0));
    if (this.heartbeat !== undefined) return;
    this.heartbeat = setInterval(() => this.beat(), interval);
    this.heartbeat.unref();
  }

  private beat(): void {
    let open = 0;
    for (const websockets of this.websockets.values()) {
      for (const client of websockets.clients) {
        if (client.readyState !== client.OPEN) continue;
        const missed = this.missedPongs.get(client) ?? 0;
        if (missed >= HEARTBEAT_MISSES) {
          client.terminate();
          continue;
        }
        open += 1;
        this.missedPongs.set(client, missed + 1);
        try {
          client.ping();
        } catch {
          // 正在关的 socket；下一跳就不在 `clients` 里了。
        }
      }
    }
    if (open === 0 && this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /** 这条路径有一个真的流在等升级。路由表的对账用例问的就是它。 */
  streamed(path: string): boolean {
    return this.streams.has(path);
  }

  /**
   * Stops listening and drops every connection, upgraded ones included.
   *
   * `http.Server#close` waits for its connections to end, and
   * `closeAllConnections` ends the HTTP ones — but a socket that was upgraded
   * to a WebSocket is no longer on that list, so with one terminal or event
   * stream open the callback never came and the core never exited: the shell
   * waited its twelve seconds, sent SIGKILL and then refused to quit at all.
   * So the WebSocket clients are terminated first, and the wait is bounded —
   * a listener that still has not closed after {@link CLOSE_GRACE_MS} is not
   * worth keeping the process alive for.
   */
  async close(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    // 控制面先以 1001 说「这是停机」（契约 §35.2），让关闭帧先写出去一拍，再断。
    goingAway(this);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const websockets of this.websockets.values()) {
      for (const client of websockets.clients) client.terminate();
      websockets.close();
    }
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            const deadline = setTimeout(resolve, CLOSE_GRACE_MS);
            deadline.unref();
            server.close(() => {
              clearTimeout(deadline);
              resolve();
            });
            server.closeAllConnections();
          }),
      ),
    );
  }
}

export type StreamHandler = (
  connection: WebSocket,
  params: Readonly<Record<string, string>>,
  request: CoreRequest,
) => void;

/** Answer a status to refuse the upgrade, or `undefined` to let it through. */
export type StreamGuard = (
  params: Readonly<Record<string, string>>,
  request: CoreRequest,
) => Promise<StreamRefusal | undefined> | StreamRefusal | undefined;

export interface StreamRefusal {
  readonly status: number;
  readonly reason?: string;
}

/**
 * 回环监听上的一次准入裁决（{@link CoreServer.admission}）。拒绝时是一个可以
 * 直接写出去的 `{ code, message }`；放行时可以带上这次请求是谁——之后的路由门、
 * 事件订阅与长连接的复核都按它判。放行而不带身份的是不要会话的路径。
 */
export type AdmissionVerdict =
  | {
      readonly refusal: {
        readonly status: number;
        readonly body: { readonly code: string; readonly message: string };
      };
    }
  | { readonly identity?: RequestIdentity };

/**
 * 交接点自己的门（{@link CoreServer.createListener} 的 `gate`）的裁决：拒绝、
 * 由门自己答（WebSocket 票这类只属于这个交接点的面），或者放行——放行时 CORS
 * 头由门给，身份可选（不给就是不要会话的路径，门自己决定以谁的身份跑）。
 */
export type ListenerVerdict =
  | {
      readonly refusal: {
        readonly status: number;
        readonly body: { readonly code: string; readonly message: string };
        readonly cors?: Record<string, string>;
      };
    }
  | {
      readonly reply: {
        readonly status: number;
        readonly body: unknown;
        readonly cors?: Record<string, string>;
      };
    }
  | {
      readonly identity?: RequestIdentity;
      readonly cors: Record<string, string>;
    };

export type ListenerGate = (
  request: CoreRequest,
  upgrade: boolean,
) => ListenerVerdict;

/** 旧路径交给契约实现；不认的答 `undefined`。 */
export type ContractLegacy = (
  request: CoreRequest,
) => Promise<HandlerResult | undefined>;

export type RequestAdmission = (
  request: CoreRequest,
  upgrade: boolean,
) => AdmissionVerdict;

const EMPTY_BODY = Buffer.alloc(0);

interface StreamRegistration {
  readonly open: StreamHandler;
  readonly guard?: StreamGuard;
  readonly maxPayload: number;
}

export interface StreamOptions {
  /**
   * 客户端一帧的上限，缺省 {@link DEFAULT_MAX_PAYLOAD_BYTES}。超过的帧由 `ws`
   * 以 `1009` 关流。
   */
  readonly maxPayload?: number;
}

/** Writes its own status, headers and body; `cors` are the headers to include. */
export type RawHandler = (
  request: CoreRequest,
  response: ServerResponse,
  cors: Record<string, string>,
) => Promise<void> | void;

function coreRequest(
  request: IncomingMessage,
  url: URL,
  body: Buffer,
): CoreRequest {
  return {
    method: (request.method ?? "GET").toUpperCase(),
    path: url.pathname,
    query: url.searchParams,
    headers: request.headers,
    body,
    raw: request,
    json: <T>() => JSON.parse(body.toString("utf8") || "null") as T,
  };
}

type BodyResult =
  | { readonly ok: true; readonly body: Buffer }
  | {
      readonly ok: false;
      readonly tooLarge?: boolean;
      readonly reason: string;
    };

/**
 * Reads the body, refusing anything over the ceiling *while* it reads. A check
 * on `content-length` alone is a check a chunked request walks around.
 */
/**
 * How much of an over-limit body is drained before the socket is dropped.
 *
 * Destroying the request the moment the ceiling is crossed left the client
 * with a reset connection and no answer — the page saw a network error, not
 * "too large". Draining the rest (bounded, so a hostile stream cannot keep a
 * handler busy forever) lets the 413 actually reach it.
 */
export const DRAIN_LIMIT_BYTES = 8 * 1024 * 1024;

export function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let drained = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      if (over) {
        drained += chunk.byteLength;
        if (drained > DRAIN_LIMIT_BYTES) request.destroy();
        return;
      }
      size += chunk.byteLength;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () =>
      resolve(
        over
          ? {
              ok: false,
              tooLarge: true,
              reason: `请求体超过 ${limit} 字节上限`,
            }
          : { ok: true, body: Buffer.concat(chunks) },
      ),
    );
    request.on("error", (error) =>
      resolve({ ok: false, reason: error.message }),
    );
    request.on("close", () => {
      // A drain that hit its own ceiling: answer anyway; the socket is gone.
      if (over)
        resolve({
          ok: false,
          tooLarge: true,
          reason: `请求体超过 ${limit} 字节上限`,
        });
    });
  });
}
