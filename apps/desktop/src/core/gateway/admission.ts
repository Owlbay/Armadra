import type { IncomingHttpHeaders } from "node:http";
import { cookieName } from "../identity/http";
import { canonicalOrigin } from "../identity/origin";
import type { IdentityService, Principal } from "../identity/service";
import { IdentityError } from "../identity/errors";
import {
  WS_TICKET_PATH,
  type WsTickets,
  anonymousPath,
  protocolTicket,
} from "../identity/transport";

// 与 core 回环监听上的门共用（`identity/transport.ts`）；这里原样转出，调用方
// 不必知道它们搬过家。
export {
  PAIRING_CODE_EXCHANGE_PATH,
  WS_TICKET_PATH,
  WS_TICKET_PROTOCOL,
  WS_TICKET_TTL_MS,
  WsTickets,
  anonymousPath,
  protocolTicket,
} from "../identity/transport";

/**
 * Gateway 的认证门（从服务器壳下沉，服务器壳与桌面对外服务共用）。
 *
 * 桌面壳靠 preload 注入凭据，因为壳和 core 在同一棵进程树里。服务器壳没有这条
 * 缝：页面在一台别的设备上，凭据必须自己跨进程边界走一趟。所以这一层存在，
 * 而**认证本身不在这里**——票据、设备、会话、轮转、撤销全是 `core/identity`
 * 已经实现的那一套，这里只决定「这次请求要不要一个会话，以及拿哪一份凭据去
 * 问它」。多写一套判定就是多一套会漂移的判定。
 *
 * 四道，按请求遇到它们的顺序：
 *
 *   1. **面**。对外只有三样东西：静态产物、`/health`、`/api/**`。core 的
 *      `/hook/**`、`/control/**`、`/rpc/**` 是同机回环上的面，公网这一侧一律
 *      404——不是 403，因为「这里有没有这个接口」本身不必回答。
 *   2. **Origin**。只接受 `--public-origin` 列表与监听地址自己那个来源，逐字节
 *      比较规范化之后的拼法。浏览器对 WebSocket 升级不发预检，所以这一道是流
 *      那边唯一的门。
 *   3. **CSRF**。写方法要求 `x-armadra-csrf` 与会话里那把 csrf 密钥相等（常量
 *      时间，由 `IdentityService` 比），也就是双提交；同时，浏览器**发了**
 *      `Sec-Fetch-Site` 时要求它是 `same-origin`。
 *
 *      为什么两条都要：双提交是唯一在所有浏览器上都成立的那条——密钥只在页面
 *      内存里，跨站页面既读不到 Cookie 也读不到它。`Sec-Fetch-Site` 更强（连
 *      带把表单提交和跨站导航挡在外面），但它是「有就查，没有不放宽」的补充，
 *      因为一个不发这个头的客户端不该因此获得豁免。`SameSite=Strict` 是第三层，
 *      Cookie 自己带着，这里不重复表达。
 *   4. **会话**。Cookie 里的访问密钥交给 `IdentityService.authenticate`，它每次
 *      重读库并核对设备 epoch——撤销一台设备之后的下一个请求就是 401，没有任何
 *      内存缓存能比一次撤销活得更久。
 */

export interface GateInput {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** WebSocket 升级。写方法的 CSRF 规则对它不适用，Origin 那道照旧。 */
  readonly upgrade?: boolean;
}

export interface GateContext {
  readonly origins: ReadonlySet<string>;
  readonly service: IdentityService;
  readonly hostId: string;
  /**
   * 原生 App 的 WebSocket 票（Bearer 模式）。不给时 Bearer 模式的升级一律
   * 401——浏览器 WS 带不了 `Authorization`，没有票就没有第二条路。
   */
  readonly wsTickets?: WsTickets;
}

export interface Refusal {
  readonly status: number;
  readonly body: { readonly code: string; readonly message: string };
}

/** core 的回环专用面。公网一侧当作不存在。 */
export function loopbackOnlyPath(path: string): boolean {
  return (
    path.startsWith("/hook/") ||
    path.startsWith("/control/") ||
    path.startsWith("/context-link/") ||
    path.startsWith("/browser/") ||
    path === "/verify"
  );
}

/**
 * 同源只读请求里浏览器没发的那个 Origin。
 *
 * Fetch 规范只对跨源请求与写方法发 Origin；服务器壳的页面与接口同源，于是页面
 * 的每一个 GET 都不带它。门对 API 要求 Origin（会话也绑在来源上），所以这里按
 * 浏览器自己的说法补上：`Sec-Fetch-Site: same-origin` 说明发起者就是这个来源，
 * 这个来源就是 `https://<Host>`，而且它必须在白名单里。其余情况一律不补——
 * 不是浏览器（没有 Sec-Fetch-Site）、跨站、写方法（浏览器一定带 Origin），
 * 仍由 {@link admit} 照原样拒绝。
 */
export function impliedOrigin(
  method: string,
  headers: IncomingHttpHeaders,
  origins: ReadonlySet<string>,
): string | undefined {
  if (headers.origin !== undefined || !safeMethod(method)) return undefined;
  if (singleHeader(headers, "sec-fetch-site") !== "same-origin")
    return undefined;
  const host = singleHeader(headers, "host");
  if (host === undefined) return undefined;
  const origin = canonicalOrigin(`https://${host}`);
  return origin !== undefined && origins.has(origin) ? origin : undefined;
}

/** 只读方法。CSRF 只对会改变状态的那些要求。 */
export function safeMethod(method: string): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function singleHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const raw = headers[name];
  if (typeof raw === "string") return raw;
  // 两条同名头是一次注入尝试，不是一个可以挑一条的选择。
  return undefined;
}

/** 一条 Cookie。同名出现两次同样按「没有」处理。 */
export function cookieValue(
  headers: IncomingHttpHeaders,
  name: string,
): string {
  const raw = headers.cookie;
  if (typeof raw !== "string") return "";
  const found = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return found.length === 1 ? (found[0] as string).slice(name.length + 1) : "";
}

export function accessCookieName(hostId: string): string {
  return cookieName(hostId, true, "access");
}

const FORBIDDEN: Refusal = {
  status: 403,
  body: { code: "forbidden", message: "来源不被允许" },
};

const UNAUTHENTICATED: Refusal = {
  status: 401,
  body: { code: "unauthenticated", message: "需要一个已配对设备的会话" },
};

/**
 * 判一次请求。放行是 `undefined`，其余都是一个可以直接写出去的
 * `{ code, message }`。
 */
export function gate(
  input: GateInput,
  context: GateContext,
): Refusal | undefined {
  return admit(input, context).refusal;
}

/**
 * 放行时一并交出这次请求是谁。
 *
 * `principal` 与 `accessToken` 只在要求会话的那几条路径上有；匿名面（健康检查、
 * 身份域自己的登录面、静态产物）两者都没有。壳拿它们把请求放进 core 的
 * 请求身份里（`runAs`），core 里的路由门与事件流就按这个人判。
 */
export interface Admission {
  readonly refusal?: Refusal;
  readonly principal?: Principal;
  readonly accessToken?: string;
  readonly origin?: string;
  /**
   * Bearer 模式：请求来自原生 App 的固定来源。`origin` 是会话绑定的那个来源
   * （App 配对时连的 Gateway 来源），`appOrigin` 是请求头里 App 自己的来源，
   * CORS 只回它。
   */
  readonly bearer?: { readonly appOrigin: string };
}

export function admit(input: GateInput, context: GateContext): Admission {
  const declared = singleHeader(input.headers, "origin");
  if (
    declared !== undefined &&
    nativeAppOrigin(declared) &&
    !context.origins.has(declared)
  ) {
    return admitBearer(input, context, declared);
  }
  const refusal = screen(input, context);
  if (refusal !== undefined) return { refusal };
  const isApi = input.path === "/api" || input.path.startsWith("/api/");
  if (!isApi || anonymousPath(input.path)) return {};
  const origin = canonicalOrigin(
    singleHeader(input.headers, "origin") as string,
  ) as string;
  const accessToken = cookieValue(
    input.headers,
    accessCookieName(context.hostId),
  );
  const requireCsrf = input.upgrade !== true && !safeMethod(input.method);
  try {
    const principal = context.service.authenticate({
      accessToken,
      hostId: context.hostId,
      origin,
      requireCsrf,
      csrfToken: singleHeader(input.headers, "x-armadra-csrf") ?? "",
    });
    return { principal, accessToken, origin };
  } catch (error) {
    if (error instanceof IdentityError && error.kind === "permission") {
      return {
        refusal: {
          status: 403,
          body: { code: "forbidden", message: "CSRF 校验未通过" },
        },
      };
    }
    return { refusal: UNAUTHENTICATED };
  }
}

/**
 * OAuth 回调（契约 §18.5）：从提供方跳回来的顶层导航，没有 `Origin`、
 * `Sec-Fetch-Site: cross-site`。它不认会话——安全性来自一次性的 `state` 与
 * 浏览器绑定 Cookie（`core/identity/oauth/flow.ts`），所以 Origin 与
 * `Sec-Fetch-Site` 两道对它不适用。只放行 GET、只放行这一种路径。
 */
export function oauthCallbackPath(method: string, path: string): boolean {
  return (
    method.toUpperCase() === "GET" &&
    /^\/api\/identity\/oauth\/[a-z0-9][a-z0-9-]{0,31}\/callback$/.test(path)
  );
}

/** 会话之前的三道：面、Origin、`Sec-Fetch-Site`，外加「有没有会话凭据」。 */
function screen(input: GateInput, context: GateContext): Refusal | undefined {
  if (loopbackOnlyPath(input.path)) {
    return {
      status: 404,
      body: { code: "notFound", message: `没有这个接口：${input.path}` },
    };
  }
  if (input.upgrade !== true && oauthCallbackPath(input.method, input.path)) {
    return undefined;
  }
  const isApi = input.path === "/api" || input.path.startsWith("/api/");
  const origin = singleHeader(input.headers, "origin");
  if (origin !== undefined) {
    const canonical = canonicalOrigin(origin);
    if (canonical === undefined || !context.origins.has(canonical)) {
      return FORBIDDEN;
    }
  } else if (isApi || input.upgrade === true) {
    // 页面发起的 API 调用永远带 Origin；不带的那些不是这张页面，而公开面上
    // 没有第二种合法的客户端。
    return FORBIDDEN;
  }
  const site = singleHeader(input.headers, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return FORBIDDEN;
  }
  if (!isApi || anonymousPath(input.path)) return undefined;
  const accessToken = cookieValue(
    input.headers,
    accessCookieName(context.hostId),
  );
  if (accessToken === "" || origin === undefined) return UNAUTHENTICATED;
  return undefined;
}

/* ------------------------------ Bearer 模式 ------------------------------ */

/**
 * 原生 App 的来源（架构 §7「原生 App 的准入」）：页面打在包里，iOS 是
 * `capacitor://localhost`，Android 是 `https://localhost`。CORS 只放行这两个。
 */
export const NATIVE_APP_ORIGINS: readonly string[] = [
  "capacitor://localhost",
  "https://localhost",
];

export function nativeAppOrigin(origin: string): boolean {
  return NATIVE_APP_ORIGINS.includes(origin);
}

/** 单独一个 Bearer，重复或不是 Bearer 一律当没有。 */
export function bearerToken(headers: IncomingHttpHeaders): string {
  const raw = singleHeader(headers, "authorization");
  if (raw === undefined) return "";
  const separator = raw.indexOf(" ");
  if (separator < 0) return "";
  if (raw.slice(0, separator).toLowerCase() !== "bearer") return "";
  const token = raw.slice(separator + 1).trim();
  return token === "" || /[\s,]/.test(token) ? "" : token;
}

/**
 * 原生 App 这条门。和 Cookie 模式的差别只有三处：
 *
 *   1. **会话来源**不是请求头里的 Origin（App 的来源对谁都一样，绑不住任何
 *      东西），而是 App 连上的这个 Gateway 来源：`https://<Host>`，必须在来源
 *      白名单里。配对票就绑在它上面。
 *   2. **凭据**只认 `Authorization: Bearer`，Cookie 一律不看——不是环境凭据，
 *      所以也没有 CSRF 可言，`Sec-Fetch-Site` 那道同理不查。
 *   3. **升级**带不了头，只认 `Sec-WebSocket-Protocol` 里的一次性票。
 */
function admitBearer(
  input: GateInput,
  context: GateContext,
  appOrigin: string,
): Admission {
  if (loopbackOnlyPath(input.path)) {
    return {
      refusal: {
        status: 404,
        body: { code: "notFound", message: `没有这个接口：${input.path}` },
      },
    };
  }
  const host = singleHeader(input.headers, "host");
  const origin =
    host === undefined ? undefined : canonicalOrigin(`https://${host}`);
  if (origin === undefined || !context.origins.has(origin)) {
    return { refusal: FORBIDDEN };
  }
  const bearer = { appOrigin };
  const isApi = input.path === "/api" || input.path.startsWith("/api/");
  if (input.upgrade === true) {
    const ticket = protocolTicket(input.headers);
    const redeemed =
      ticket === "" ? undefined : context.wsTickets?.consume(ticket);
    if (redeemed === undefined || redeemed.origin !== origin) {
      return { refusal: UNAUTHENTICATED };
    }
    return authenticated(context, redeemed.accessToken, origin, bearer);
  }
  if (!isApi) return { bearer };
  // 预检不带凭据（浏览器规定），只回 CORS；真正的请求再过下面那道。
  if (input.method.toUpperCase() === "OPTIONS") return { origin, bearer };
  if (anonymousPath(input.path) && input.path !== WS_TICKET_PATH) {
    return { origin, bearer };
  }
  const accessToken = bearerToken(input.headers);
  if (accessToken === "") return { refusal: UNAUTHENTICATED };
  return authenticated(context, accessToken, origin, bearer);
}

function authenticated(
  context: GateContext,
  accessToken: string,
  origin: string,
  bearer: { appOrigin: string },
): Admission {
  try {
    const principal = context.service.authenticate({
      accessToken,
      hostId: context.hostId,
      origin,
    });
    return { principal, accessToken, origin, bearer };
  } catch {
    return { refusal: UNAUTHENTICATED };
  }
}
