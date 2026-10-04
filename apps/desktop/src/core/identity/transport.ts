import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { AuthorizationSubject } from "./authorize";
import type { RequestIdentity } from "./gate";
import type { IdentityService, Principal } from "./service";

/**
 * 两道准入共用的那几样：Gateway 的门（`gateway/admission.ts`）与 core 回环监听
 * 上的门（`identity/loopback.ts`，安全审查 L9）。
 *
 * 判定只有一套：哪些路径不要会话、WebSocket 的一次性票长什么样、认出来的会话
 * 怎么变成 core 里的请求身份。两道门各自决定「凭据从哪来」（Cookie、Bearer、
 * 票），认证本身都是 `IdentityService` 那一套。
 */

export const PAIRING_CODE_EXCHANGE_PATH = "/api/gateway/pairing-code/exchange";

/**
 * 不需要会话的那几条：健康探针、身份域自己的登录面（配对、hello、刷新、登录
 * 都在这里，各自认自己的凭据），以及配对短码换票（契约 §24：手机还没有身份，
 * 短码就是凭据，限流与档位在 Gateway 域里判）。
 */
export function anonymousPath(path: string): boolean {
  return (
    path === "/health" ||
    path === "/api/health" ||
    path.startsWith("/api/identity/") ||
    path === PAIRING_CODE_EXCHANGE_PATH
  );
}

/* ------------------------------ WebSocket 票 ------------------------------ */

/** 升级 WebSocket 时在 `Sec-WebSocket-Protocol` 里带的票的前缀。 */
export const WS_TICKET_PROTOCOL = "armadra-ticket.";
export const WS_TICKET_PATH = "/api/identity/ws-ticket";
export const WS_TICKET_TTL_MS = 30_000;
const WS_TICKET_LIMIT = 4096;

/**
 * 一次性 WebSocket 票：30 秒、用一次就没。浏览器的 WebSocket 带不了
 * `Authorization`，Bearer 传输（原生 App、桌面壳的页面）升级前先拿访问密钥换
 * 一张。票只在内存里——它比访问密钥活得短得多，core 重启后丢掉正合适。兑出来
 * 的是签票那一刻的访问密钥与会话来源，升级时照样再认证一次，所以撤销设备之后
 * 手里的票也换不出流。
 */
export class WsTickets {
  private readonly tickets = new Map<
    string,
    { accessToken: string; origin: string; expiresAtMs: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  issue(input: { accessToken: string; origin: string }): {
    ticket: string;
    expiresAtMs: number;
  } {
    this.sweep();
    if (this.tickets.size >= WS_TICKET_LIMIT) {
      // 塞满的表是一次滥用；最老的那张先让位，而不是让下一次合法的升级失败。
      const oldest = this.tickets.keys().next().value as string;
      this.tickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString("base64url");
    const expiresAtMs = this.now() + WS_TICKET_TTL_MS;
    this.tickets.set(ticket, { ...input, expiresAtMs });
    return { ticket, expiresAtMs };
  }

  consume(ticket: string): { accessToken: string; origin: string } | undefined {
    const found = this.tickets.get(ticket);
    if (found === undefined) return undefined;
    this.tickets.delete(ticket);
    if (found.expiresAtMs <= this.now()) return undefined;
    return { accessToken: found.accessToken, origin: found.origin };
  }

  private sweep(): void {
    const now = this.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAtMs <= now) this.tickets.delete(ticket);
    }
  }
}

/** `Sec-WebSocket-Protocol` 里的那张票；没有或不止一张都按没有。 */
export function protocolTicket(headers: IncomingHttpHeaders): string {
  const raw = headers["sec-websocket-protocol"];
  // 两条同名头是一次注入尝试，不是一个可以挑一条的选择。
  if (typeof raw !== "string") return "";
  const found = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(WS_TICKET_PROTOCOL));
  return found.length === 1
    ? (found[0] as string).slice(WS_TICKET_PROTOCOL.length)
    : "";
}

/* ------------------------------- 请求身份 -------------------------------- */

export function subjectOf(principal: Principal): AuthorizationSubject {
  return {
    principalId: principal.principalId,
    kind: principal.role === "member" ? "member" : "owner",
    scopes: principal.scopes,
  };
}

/**
 * 认出来的会话 → core 里的请求身份（`runAs`）。路由门、事件订阅与长连接的复核
 * 都认它。
 *
 * 长连接的复核按会话认（升级前已经用访问令牌认过它）：页面刷新过访问令牌，
 * 流照旧；会话失效、或访问期已过而没有刷新，就不再给主体——被关掉的 socket
 * 由页面带着新凭据重连，门在升级前。
 */
export function sessionIdentity(
  service: IdentityService,
  hostId: string,
  principal: Principal,
  origin: string,
): RequestIdentity {
  const renew = () => {
    try {
      const current = service.sessionAccess({
        sessionId: principal.sessionId,
        hostId,
        origin,
      });
      return {
        subject: subjectOf(current),
        accessExpiresAtMs: current.accessExpiresAtMs,
      };
    } catch {
      return undefined;
    }
  };
  return {
    subject: subjectOf(principal),
    device: { deviceId: principal.deviceId, deviceName: principal.deviceName },
    accessExpiresAtMs: principal.accessExpiresAtMs,
    renew,
    revalidate: () => renew()?.subject,
  };
}
