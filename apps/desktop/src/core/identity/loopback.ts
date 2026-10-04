import type { AdmissionVerdict, RequestAdmission } from "../http/server";
import type { CoreRequest } from "../http/router";
import { IdentityError } from "./errors";
import { credential, csrfRequired } from "./http";
import { canonicalOrigin } from "./origin";
import type { IdentityService } from "./service";
import {
  type WsTickets,
  anonymousPath,
  protocolTicket,
  sessionIdentity,
} from "./transport";

/**
 * core 自己那几个回环监听上的门（契约 §3.2，安全审查 L9）。
 *
 * 0.2.0 之前，明文回环上没带凭据的请求一律按本机主人放行：本机任何一个回环
 * 端口上的网页都能读设置、开终端、连事件流。现在除了不要会话的那几条
 * （{@link anonymousPath}：健康检查、身份域自己的登录面、配对短码换票）与
 * `/api/` 之外的路径，每个请求都要带一个会话：
 *
 *   * **HTTP**：`Authorization: Bearer <访问密钥>`（桌面壳的页面与托盘，票据
 *     换来的原生会话）；来源不是回环明文时按 Cookie 读（`identity/http.ts` 的
 *     {@link credential}），写方法照旧要 CSRF。
 *   * **WebSocket**：浏览器的升级带不了头，凭据是 `Sec-WebSocket-Protocol` 里
 *     一张 30 秒的一次性票（`POST /api/identity/ws-ticket` 换，与 Gateway 的
 *     原生 App 同一个做法）。票绑着签票时的来源，升级的来源对不上就不认。
 *
 * 认出来的人进这次请求的身份（`runAs`），路由门、事件订阅与长连接的到期复核都
 * 按它判——和 Gateway 进来的请求走同一条路。
 *
 * 只在回环匿名按主人**关着**时装（`core/main.ts` 的 `loopbackAnonymousOwner`）。
 * 探针与 `armadra.sh run web` 起的裸 core 显式打开它，那里这道门不存在。
 */

const UNAUTHENTICATED: AdmissionVerdict = {
  refusal: {
    status: 401,
    body: { code: "unauthenticated", message: "需要一个已配对设备的会话" },
  },
};

const CSRF_REFUSED: AdmissionVerdict = {
  refusal: {
    status: 403,
    body: { code: "forbidden", message: "CSRF 校验未通过" },
  },
};

/** 这条路径要不要会话：`/api/` 之下、不在匿名名单里的都要。 */
export function loopbackSessionPath(path: string): boolean {
  const api = path === "/api" || path.startsWith("/api/");
  return api && !anonymousPath(path);
}

export function createLoopbackAdmission(options: {
  readonly service: IdentityService;
  readonly tickets: WsTickets;
}): RequestAdmission {
  const { service, tickets } = options;
  return (request, upgrade) => {
    // 升级一律要票：core 的每一条流都在 `/api/` 之下，没有哪条是匿名的。
    if (!upgrade && !loopbackSessionPath(request.path)) return {};
    const declared = single(request, "origin");
    const origin =
      declared === undefined ? undefined : canonicalOrigin(declared);
    // 会话绑在来源上；不报来源的调用（`curl`、别的本机进程）没有会话可言。
    if (origin === undefined) return UNAUTHENTICATED;
    const hostId = service.hostId();
    let accessToken: string;
    if (upgrade) {
      const ticket = protocolTicket(request.headers);
      const redeemed = ticket === "" ? undefined : tickets.consume(ticket);
      if (redeemed === undefined || redeemed.origin !== origin) {
        return UNAUTHENTICATED;
      }
      accessToken = redeemed.accessToken;
    } else {
      accessToken = credential(request, hostId, "access");
    }
    if (accessToken === "") return UNAUTHENTICATED;
    try {
      const principal = service.authenticate({
        accessToken,
        hostId,
        origin,
        requireCsrf: !upgrade && csrfRequired(request) && unsafe(request),
        csrfToken: single(request, "x-armadra-csrf") ?? "",
      });
      return { identity: sessionIdentity(service, hostId, principal, origin) };
    } catch (error) {
      if (error instanceof IdentityError && error.kind === "permission") {
        return CSRF_REFUSED;
      }
      return UNAUTHENTICATED;
    }
  };
}

function unsafe(request: CoreRequest): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
}

function single(request: CoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  // 两条同名头是一次注入尝试，不是一个可以挑一条的选择。
  return typeof value === "string" ? value : undefined;
}
