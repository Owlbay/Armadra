/**
 * 隧道来的请求的准入（契约 §32，平台规格 core 包 §4.4）：与 Gateway 的 Bearer 模式
 * 等价，不享受回环的匿名，也不认 Cookie。挂在 `CoreServer.createListener({
 * admitted: true, gate })` 上，在路由与流之前判：
 *
 *   1. 路径落在 `loopbackOnlyPath`（`/hook/`、`/control/`、`/context-link/`、
 *      `/browser/`、`/verify`）→ `403 forbidden`。
 *   2. 来源以 `OPEN.clientOrigin` 为准（中继给的元数据），请求头里的 `Origin` 与它
 *      不一致 → 403。来源必须在这条登记的可信来源 ∪ 原生 App 的两个来源之内；
 *      没有来源（非浏览器）只放行 `/health` 与身份域自己的匿名面。
 *   3. 匿名面放行（以一个没有任何授权的成员身份跑）；`POST /api/identity/ws-ticket`
 *      由这里签票；其余要 `Authorization: Bearer`，升级要 `armadra-ticket.<票>`。
 *      拒绝一律 `401 unauthenticated`。
 *
 * 会话绑在这个远程服务的中继来源上（`relayOrigins[0]`，缺省就是 issuer）：经隧道
 * 换来的会话只在隧道上有效，回环与 Gateway 的会话也进不了隧道。放行前把请求头的
 * `Origin` 换成它，并标成 Bearer 传输（`markBearerTransport`），身份域据此按原生
 * 会话答、不发 Cookie。CORS 只回客户端自己的来源。
 */

import type { IncomingHttpHeaders } from "node:http";

import {
  bearerToken,
  loopbackOnlyPath,
  nativeAppOrigin,
} from "../gateway/admission";
import type { RequestIdentity } from "../identity/gate";
import { markBearerTransport } from "../identity/http";
import { canonicalOrigin } from "../identity/origin";
import type { IdentityService } from "../identity/service";
import {
  WS_TICKET_PATH,
  type WsTickets,
  anonymousPath,
  protocolTicket,
  sessionIdentity,
} from "../identity/transport";
import type { CoreRequest } from "../http/router";
import type { ListenerGate, ListenerVerdict } from "../http/server";
import { TunnelDuplex } from "./streams";

export interface TunnelRegistration {
  readonly issuer: string;
  readonly trustedOrigins: readonly string[];
  readonly relayOrigins: readonly string[];
}

export interface TunnelGateOptions {
  readonly service: IdentityService;
  /** 有效登记；撤销了就是 `undefined`（这条隧道上的请求一律 403）。 */
  readonly registration: (issuer: string) => TunnelRegistration | undefined;
  readonly tickets: WsTickets;
}

/**
 * 匿名面上的请求身份：一个什么授权都没有的成员（与 Gateway 同一个做法）。不留空——
 * 留空 core 会当成本机 owner。
 */
const ANONYMOUS: RequestIdentity = {
  subject: { principalId: "", kind: "member", scopes: [] },
};

const FORBIDDEN_BODY = { code: "forbidden", message: "来源不被允许" };
const UNAUTHENTICATED_BODY = {
  code: "unauthenticated",
  message: "需要一个经远程服务登录的会话",
};

/** 会话绑定的来源：这条登记的第一个中继来源，缺省 issuer。 */
export function sessionOriginOf(registration: TunnelRegistration): string {
  for (const origin of registration.relayOrigins) {
    const canonical = canonicalOrigin(origin);
    if (canonical !== undefined) return canonical;
  }
  return registration.issuer;
}

function corsFor(clientOrigin: string | null): Record<string, string> {
  if (clientOrigin === null) return {};
  return {
    "access-control-allow-origin": clientOrigin,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, x-armadra-csrf",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function originAllowed(
  clientOrigin: string,
  registration: TunnelRegistration,
): boolean {
  if (nativeAppOrigin(clientOrigin)) return true;
  const canonical = canonicalOrigin(clientOrigin);
  if (canonical === undefined) return false;
  return registration.trustedOrigins.some(
    (trusted) => canonicalOrigin(trusted) === canonical,
  );
}

/** 请求头里的 `Origin` 与 `OPEN.clientOrigin` 一致（都没有也算一致）。 */
function sameDeclaredOrigin(
  headers: IncomingHttpHeaders,
  clientOrigin: string | null,
): boolean {
  const declared = headers.origin;
  if (Array.isArray(declared)) return false;
  if (declared === undefined) return clientOrigin === null;
  return declared === clientOrigin;
}

/** 没有来源的客户端（非浏览器）只能碰这几条。 */
function anonymousWithoutOrigin(path: string): boolean {
  return (
    path === "/health" ||
    path === "/api/health" ||
    (path.startsWith("/api/identity/") &&
      anonymousPath(path) &&
      path !== WS_TICKET_PATH)
  );
}

export function createTunnelGate(options: TunnelGateOptions): ListenerGate {
  const { service, tickets } = options;
  return (request: CoreRequest, upgrade: boolean): ListenerVerdict => {
    const socket = request.raw.socket as unknown;
    const tunnel = socket instanceof TunnelDuplex ? socket.tunnel : undefined;
    const registration =
      tunnel === undefined ? undefined : options.registration(tunnel.issuer);
    if (tunnel === undefined || registration === undefined) {
      return { refusal: { status: 403, body: FORBIDDEN_BODY } };
    }
    const clientOrigin = tunnel.open.clientOrigin;
    const cors = corsFor(clientOrigin);
    const refuse = (status: number, body: typeof FORBIDDEN_BODY) => ({
      refusal: { status, body, cors },
    });
    const path = request.path;
    if (loopbackOnlyPath(path)) {
      return refuse(403, { code: "forbidden", message: "这条路径只在本机" });
    }
    if (!sameDeclaredOrigin(request.headers, clientOrigin)) {
      return refuse(403, FORBIDDEN_BODY);
    }
    if (clientOrigin !== null && !originAllowed(clientOrigin, registration)) {
      return { refusal: { status: 403, body: FORBIDDEN_BODY } };
    }
    if (clientOrigin === null && (upgrade || !anonymousWithoutOrigin(path))) {
      return refuse(403, FORBIDDEN_BODY);
    }

    // 下游（身份域、CORS、流）看到的来源是会话来源；凭据按 Bearer 模式。
    const origin = sessionOriginOf(registration);
    request.headers.origin = origin;
    markBearerTransport(request.raw);
    const hostId = service.hostId();
    const authenticated = (accessToken: string) => {
      try {
        const principal = service.authenticate({ accessToken, hostId, origin });
        return { principal, accessToken };
      } catch {
        return undefined;
      }
    };

    if (upgrade) {
      const ticket = protocolTicket(request.headers);
      const redeemed = ticket === "" ? undefined : tickets.consume(ticket);
      if (redeemed === undefined || redeemed.origin !== origin) {
        return refuse(401, UNAUTHENTICATED_BODY);
      }
      const who = authenticated(redeemed.accessToken);
      if (who === undefined) return refuse(401, UNAUTHENTICATED_BODY);
      return {
        cors,
        identity: sessionIdentity(service, hostId, who.principal, origin),
      };
    }
    // 预检不带凭据（浏览器规定），只回 CORS。
    if (request.method === "OPTIONS") return { cors, identity: ANONYMOUS };
    if (path === WS_TICKET_PATH) {
      if (request.method !== "POST") {
        return refuse(405, {
          code: "method_not_allowed",
          message: "只接受 POST",
        });
      }
      const token = bearerToken(request.headers);
      const who = token === "" ? undefined : authenticated(token);
      if (who === undefined) return refuse(401, UNAUTHENTICATED_BODY);
      const issued = tickets.issue({ accessToken: who.accessToken, origin });
      return {
        reply: {
          status: 200,
          body: {
            ticket: issued.ticket,
            expiresAt: new Date(issued.expiresAtMs).toISOString(),
          },
          cors: { ...cors, "cache-control": "no-store" },
        },
      };
    }
    const api = path === "/api" || path.startsWith("/api/");
    if (!api || anonymousPath(path)) return { cors, identity: ANONYMOUS };
    const token = bearerToken(request.headers);
    const who = token === "" ? undefined : authenticated(token);
    if (who === undefined) return refuse(401, UNAUTHENTICATED_BODY);
    return {
      cors,
      identity: sessionIdentity(service, hostId, who.principal, origin),
    };
  };
}
