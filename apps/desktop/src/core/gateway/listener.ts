import type { AddressInfo, Socket } from "node:net";
import { createServer as createHttpsServer, type Server } from "node:https";
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { allowOrigins } from "../http/cors";
import type { CoreContext } from "../main";
import { identityInstanceId } from "../identity";
import type { AuthorizationSubject } from "../identity/authorize";
import { type RequestIdentity, runAs } from "../identity/gate";
import { markBearerTransport } from "../identity/http";
import { IdentityService, type Principal } from "../identity/service";
import { IdentityStore } from "../identity/store";
import { allScopes } from "../identity/scopes";
import type { CoreLog } from "../platform";
import {
  type Admission,
  type GateContext,
  type Refusal,
  WS_TICKET_PATH,
  WsTickets,
  admit,
  impliedOrigin,
} from "./admission";
import {
  type ListenAddress,
  type ListenMode,
  acceptsConnection,
  certificateHosts,
  originsFor,
} from "./network";
import { type PairingTicket, pairingLinks } from "./pairing";
import { GATEWAY_API_HEADERS, GATEWAY_RESPONSE_HEADERS } from "./csp";
import { type TlsMaterial, resolveTls } from "./tls";
import { type WebRoot, resolveFile, sendFile, staticHeaders } from "./web-root";

/**
 * `openGateway`：在**同一个进程**里，给已经装配好的 core 前面放一层 TLS。
 *
 * 没有代理。core 的 `CoreServer` 已经是一台完整的 HTTP 服务，只是它自己创建的
 * 监听都在回环上；这里向它要一个**不绑定任何地址**的 `http.Server` 当作交接点，
 * 然后把 TLS 那一侧收到的 `request` / `upgrade` 原样转给它。走的是同一个事件
 * 循环里的一次函数调用，没有第二个套接字、没有一次多余的序列化。
 *
 * core 仍然自己在回环上监听：hook 客户端、`endpoints.json` 的发现提示、以及
 * 同机的诊断都打那里，对外这一侧只认 TLS 上的那个地址。
 *
 * 两种壳都用它：服务器壳的 `serve` 是「解析参数 → `openGateway`」；桌面壳由
 * Gateway 域按设置 `gateway.*` 开关（`./index.ts`）。
 */

export interface GatewayOptions {
  /** 绑定的地址；端口 0 由内核分配。 */
  readonly listen: ListenAddress;
  /**
   * 按连接的本地地址筛（`private` 档）；缺省不筛——服务器壳绑的地址本身就是
   * 答案。
   */
  readonly mode?: ListenMode;
  readonly publicOrigins: readonly string[];
  /**
   * 「自己」的那几个主机：证书的 SAN 与来源白名单都由它们加端口拼出来。每次
   * {@link Gateway.refresh} 现问——私网地址会变。
   */
  readonly hosts: () => readonly string[];
  /** 当前的私网地址，`private` 档筛连接用。 */
  readonly privateAddresses?: () => readonly string[];
  readonly tls: {
    readonly certFile?: string | undefined;
    readonly keyFile?: string | undefined;
    readonly generated: "selfSigned" | "localCa" | "acme";
  };
  readonly webRoot?: WebRoot | undefined;
  /** 配对出来的设备的缺省名字。 */
  readonly deviceName: string;
  readonly now?: () => Date;
}

export interface Gateway {
  readonly address: ListenAddress;
  readonly hostId: string;
  readonly service: IdentityService;
  readonly webRoot: WebRoot | undefined;
  /** 当前的首选来源（公网来源优先，否则第一个自己的地址）。 */
  origin(): string;
  origins(): readonly string[];
  tls(): TlsMaterial;
  /** 铸一张配对票（两分钟、一次性），连同网页链接与原生深链。 */
  pair(input?: { origin?: string; deviceName?: string }): PairingTicket;
  /**
   * 重新问一遍主机与地址：变了就更新来源白名单，本地 CA 来源时重签叶证书并
   * 热换给监听（已有连接不断）。返回有没有变化。
   */
  refresh(): boolean;
  /** 停止监听并断开经它进来的每一条连接（升级过的流也在内）。幂等。 */
  close(): Promise<void>;
}

export async function openGateway(
  core: CoreContext,
  options: GatewayOptions,
): Promise<Gateway> {
  if (!core.db.unified) {
    throw new GatewayError(
      "identity_unavailable",
      "这个数据目录还没过统一库迁移，没有身份表可用",
    );
  }
  const store = new IdentityStore(core.db.database);
  const service = new IdentityService(store, identityInstanceId());
  const hostId = service.hostId();
  const log = core.platform.log;
  const now = options.now ?? (() => new Date());
  const resolve = (hosts: readonly string[]): TlsMaterial =>
    resolveTls({
      certFile: options.tls.certFile,
      keyFile: options.tls.keyFile,
      dataDir: core.dataDir,
      hosts: certificateHosts(hosts, options.publicOrigins),
      generated: options.tls.generated,
      now,
    });

  let hosts = [...options.hosts()];
  let tls = resolve(hosts);
  const delegate = core.server.createListener();
  const https = createHttpsServer({ cert: tls.cert, key: tls.key });
  const sockets = new Set<Socket>();
  const mode = options.mode ?? "all";
  https.on("connection", (socket: Socket) => {
    if (
      !acceptsConnection(
        mode,
        socket.localAddress,
        options.privateAddresses?.() ?? [],
      )
    ) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const bound = await listen(https, options.listen);
  let origins = originsFor(hosts, bound.port, options.publicOrigins);
  const wsTickets = new WsTickets();
  let context: GateContext = {
    origins: new Set(origins),
    service,
    hostId,
    wsTickets,
  };
  // core 的 CORS 默认只放行回环来源。Gateway 的页面不在回环上，所以这里把这次
  // 运行的来源注入进去——注入点在 `core/http/cors.ts`，判定仍然只有一处。
  allowOrigins(origins);

  const state = {
    get context() {
      return context;
    },
    delegate,
    webRoot: options.webRoot,
    log,
    tls: () => tls,
  };
  https.on("request", (request, response) => {
    void handle(request, response, state);
  });
  https.on("upgrade", (request, socket, head) => {
    const admission = admit(
      {
        method: request.method ?? "GET",
        path: pathOf(request),
        headers: request.headers,
        upgrade: true,
      },
      context,
    );
    const refusal = admission.refusal;
    if (refusal !== undefined) {
      socket.write(
        `HTTP/1.1 ${refusal.status} ${refusal.body.code}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    if (admission.bearer !== undefined && admission.origin !== undefined) {
      // core 的流门按 Origin 判；原生 App 的来源对它没有意义，换成会话来源。
      request.headers.origin = admission.origin;
    }
    // 升级在这个人的身份下进行：事件流的订阅判定与之后的复核都认它。
    runAs(requestIdentityOf(admission, context), () =>
      delegate.emit("upgrade", request, socket as Duplex, head),
    );
  });

  let closed = false;
  const gateway: Gateway = {
    address: bound,
    hostId,
    service,
    webRoot: options.webRoot,
    origin: () => origins[0] as string,
    origins: () => origins,
    tls: () => tls,
    pair: (input = {}) => {
      const origin = input.origin ?? (origins[0] as string);
      if (!origins.includes(origin)) {
        throw new GatewayError("invalid_origin", "这个来源不是本 Gateway 的");
      }
      const issued = service.issueBootstrap({
        hostId,
        instanceId: identityInstanceId(),
        origin,
        deviceName: input.deviceName ?? options.deviceName,
        // 配对是 owner 在本机发起的：配出来的设备拿全套授权。成员走邀请。
        scopes: allScopes(),
      });
      return {
        ...issued,
        origin,
        fingerprint: tls.fingerprint,
        ...pairingLinks(origin, issued.ticket, tls.fingerprint),
      };
    },
    refresh: () => {
      if (closed) return false;
      const next = [...options.hosts()];
      const nextOrigins = originsFor(next, bound.port, options.publicOrigins);
      const sameHosts = next.join("\n") === hosts.join("\n");
      const material = resolve(next);
      const sameCert = material.cert === tls.cert;
      if (sameHosts && sameCert) return false;
      hosts = next;
      if (!sameCert) {
        tls = material;
        https.setSecureContext({ cert: tls.cert, key: tls.key });
        log.info("Gateway 叶证书已重签", { names: tls.names });
      }
      origins = nextOrigins;
      context = { ...context, origins: new Set(origins) };
      allowOrigins(origins);
      return true;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      allowOrigins([]);
      await new Promise<void>((done) => {
        https.close(() => done());
        https.closeAllConnections();
        // 升级过的连接不在 `closeAllConnections` 的名单上：逐条断掉，关掉
        // Gateway 的那一刻经它进来的流就停。
        for (const socket of sockets) socket.destroy();
      });
    },
  };
  return gateway;
}

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface HandleState {
  readonly context: GateContext;
  readonly delegate: import("node:http").Server;
  readonly webRoot: WebRoot | undefined;
  readonly log: CoreLog;
  readonly tls: () => TlsMaterial;
}

function pathOf(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "https://gateway").pathname;
}

/** `GET /ca.crt`：匿名，发出信任锚，让手机装一次 CA（架构 §7）。 */
export const CA_PATH = "/ca.crt";

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  state: HandleState,
): Promise<void> {
  const path = pathOf(request);
  const method = (request.method ?? "GET").toUpperCase();
  // 每一个经 Gateway 的答案都带 HSTS 与 nosniff；接口与健康检查再加沙箱 CSP
  // 与缺省不缓存（`csp.ts`）。core 的 `writeHead` 只覆盖它自己写的那几个名字，
  // 所以答案自己给了缓存策略时以它为准。静态产物在 `sendFile` 里另写一份。
  const api = path === "/health" || path === "/api" || path.startsWith("/api/");
  for (const [name, value] of Object.entries(
    api ? GATEWAY_API_HEADERS : GATEWAY_RESPONSE_HEADERS,
  )) {
    response.setHeader(name, value);
  }
  if (path === CA_PATH && (method === "GET" || method === "HEAD")) {
    sendAnchor(response, state.tls(), method);
    return;
  }
  // 补在请求头上而不是只给门看：core 的身份域（`GET /api/identity/session`）
  // 与 CORS 也各自读 Origin，三处必须看到同一个来源。
  const implied = impliedOrigin(method, request.headers, state.context.origins);
  if (implied !== undefined) request.headers.origin = implied;
  const admission = admit(
    { method, path, headers: request.headers },
    state.context,
  );
  if (admission.bearer !== undefined) {
    nativeCors(response, admission.bearer.appOrigin);
    if (method === "OPTIONS" && admission.refusal === undefined) {
      response.writeHead(204).end();
      return;
    }
  }
  if (admission.refusal !== undefined) {
    refuse(response, admission.refusal);
    return;
  }
  if (api) {
    if (admission.bearer !== undefined && admission.origin !== undefined) {
      if (path === WS_TICKET_PATH) {
        answerWsTicket(response, method, admission, state.context);
        return;
      }
      // 身份域按会话来源认票与会话，按 Bearer 模式回密钥；CORS 已在上面换成
      // App 的来源。
      request.headers.origin = admission.origin;
      markBearerTransport(request);
    } else if (path === WS_TICKET_PATH) {
      refuse(response, {
        status: 400,
        body: {
          code: "bearer_required",
          message: "WebSocket 票只发给原生 App",
        },
      });
      return;
    }
    // core 里的路由门与各域的判定按这个身份判（`core/identity/gate.ts`）。
    runAs(requestIdentityOf(admission, state.context), () =>
      state.delegate.emit("request", request, response),
    );
    return;
  }
  if (state.webRoot === undefined) {
    response.writeHead(404, staticHeaders()).end();
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { ...staticHeaders(), allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const file = await resolveFile(state.webRoot, request.url ?? "/");
    if (file === undefined) {
      response.writeHead(404, staticHeaders()).end();
      return;
    }
    sendFile(response, file, method);
  } catch (error) {
    state.log.error("静态产物读取失败", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    response.writeHead(500, staticHeaders()).end();
  }
}

function sendAnchor(
  response: ServerResponse,
  tls: TlsMaterial,
  method: string,
): void {
  if (tls.anchor === undefined) {
    refuse(response, {
      status: 404,
      body: {
        code: "ca_unavailable",
        message: "这张证书没有可以安装的根",
      },
    });
    return;
  }
  const payload = Buffer.from(tls.anchor, "utf8");
  response.writeHead(200, {
    "content-type": "application/x-x509-ca-cert",
    "content-disposition": 'attachment; filename="armadra-ca.crt"',
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(method === "HEAD" ? undefined : payload);
}

/**
 * 原生 App 的 CORS：只回 App 自己的来源，覆盖 core 按会话来源算出来的那一份。
 * core 的响应走 `writeHead(status, headers)`，那里的值会盖掉 `setHeader`，所以
 * 在这一次响应上包一层，把 `access-control-*` 换掉。
 */
function nativeCors(response: ServerResponse, appOrigin: string): void {
  const own: OutgoingHttpHeaders = {
    "access-control-allow-origin": appOrigin,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, x-armadra-csrf",
    "access-control-max-age": "600",
    vary: "origin",
  };
  for (const [name, value] of Object.entries(own)) {
    response.setHeader(name, value as string);
  }
  const original = response.writeHead.bind(response) as (
    ...args: unknown[]
  ) => ServerResponse;
  response.writeHead = ((...args: unknown[]) => {
    const index = args.findIndex(
      (arg, position) =>
        position > 0 &&
        typeof arg === "object" &&
        arg !== null &&
        !Array.isArray(arg),
    );
    if (index > 0) {
      const headers = { ...(args[index] as OutgoingHttpHeaders) };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase().startsWith("access-control-")) {
          delete headers[name];
        }
      }
      args[index] = { ...headers, ...own };
    }
    return original(...args);
  }) as ServerResponse["writeHead"];
}

function answerWsTicket(
  response: ServerResponse,
  method: string,
  admission: Admission,
  context: GateContext,
): void {
  if (method !== "POST") {
    refuse(response, {
      status: 405,
      body: { code: "method_not_allowed", message: "只接受 POST" },
    });
    return;
  }
  if (
    admission.principal === undefined ||
    admission.accessToken === undefined ||
    admission.origin === undefined ||
    context.wsTickets === undefined
  ) {
    refuse(response, {
      status: 401,
      body: { code: "unauthenticated", message: "需要一个已配对设备的会话" },
    });
    return;
  }
  const issued = context.wsTickets.issue({
    accessToken: admission.accessToken,
    origin: admission.origin,
  });
  const payload = Buffer.from(
    JSON.stringify({
      ticket: issued.ticket,
      expiresAt: new Date(issued.expiresAtMs).toISOString(),
    }),
    "utf8",
  );
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
  });
  response.end(payload);
}

/**
 * 匿名面上的请求身份：一个什么授权都没有的成员。
 *
 * 不留空（留空 core 会当成本机 owner）：身份域自己的登录面不经路由门，而除它
 * 以外任何一处判定问到这个身份，答案都该是「不行」。
 */
const ANONYMOUS: RequestIdentity = {
  subject: { principalId: "", kind: "member", scopes: [] },
};

function subjectOf(principal: Principal): AuthorizationSubject {
  return {
    principalId: principal.principalId,
    kind: principal.role === "member" ? "member" : "owner",
    scopes: principal.scopes,
  };
}

function requestIdentityOf(
  admission: Admission,
  context: GateContext,
): RequestIdentity {
  const principal = admission.principal;
  if (principal === undefined) return ANONYMOUS;
  const accessToken = admission.accessToken ?? "";
  const origin = admission.origin ?? "";
  return {
    subject: subjectOf(principal),
    device: { deviceId: principal.deviceId, deviceName: principal.deviceName },
    // 长连接的复核：会话还在就给出当前主体。访问密钥过期（页面会刷新出一把
    // 新的）也算失效——被关掉的 socket 由页面带着新凭据重连，门在升级前。
    revalidate: () => {
      try {
        return subjectOf(
          context.service.authenticate({
            accessToken,
            hostId: context.hostId,
            origin,
          }),
        );
      } catch {
        return undefined;
      }
    },
  };
}

function refuse(response: ServerResponse, refusal: Refusal): void {
  const payload = Buffer.from(JSON.stringify(refusal.body), "utf8");
  response.writeHead(refusal.status, {
    "content-type": "application/json",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function listen(
  server: Server,
  address: ListenAddress,
): Promise<ListenAddress> {
  return new Promise((done, failed) => {
    server.once("error", failed);
    server.listen(address.port, address.host, () => {
      const bound = server.address() as AddressInfo | null;
      if (bound === null) {
        failed(new Error("TLS 服务没有绑定到任何地址"));
        return;
      }
      server.removeListener("error", failed);
      done({ host: address.host, port: bound.port });
    });
  });
}
