import {
  type CredentialProvider,
  SOURCE_ERROR,
  type SourceAccess,
  type SourceDescriptor,
  SourceError,
  type SourceRoute,
  type Via,
} from "./types";

/**
 * 选路（平台设计 D27、§17.5）：直连优先。
 *
 * 1. 并行：向直连地址问一次匿名 `GET /api/identity/hello`（1.5 秒），同时向
 *    凭据来源要中继的访问；
 * 2. 直连答了而且 `hostId` 就是这个源 → 走直连；否则走中继；
 * 3. 两条都不通 → `source_unreachable`。
 *
 * 在中继上不中途切换：重连、`online`、页面回到前台时由连接重新走一遍。本机源
 * 不选路。
 */

export const DIRECT_PROBE_TIMEOUT_MS = 1500;

export interface ProbeOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** 直连地址答不答、答的是不是这个源。任何失败（超时、证书、形状）都是 `false`。 */
export async function probeDirect(
  baseUrl: string,
  sourceId: string,
  options: ProbeOptions = {},
): Promise<boolean> {
  if (baseUrl === "") return false;
  const send = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DIRECT_PROBE_TIMEOUT_MS,
  );
  try {
    const response = await send(
      `${baseUrl.replace(/\/+$/, "")}/api/identity/hello`,
      {
        headers: { Accept: "application/json" },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (!response.ok) return false;
    const body = (await response.json()) as { hostId?: unknown } | null;
    return body !== null && body.hostId === sourceId;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface Route {
  readonly via: Via;
  readonly access: SourceAccess;
  /** 走的是哪一条（§55）；凭据来源自己选的中继是 `undefined`。 */
  readonly origin?: string;
}

/**
 * 这个源的全部路（§55），按次序：直连在前（首选的先），中继按首选、最近成功。
 * 旧描述没有 `routes` 时由镜像字段推出。
 */
export function routesOf(descriptor: SourceDescriptor): SourceRoute[] {
  if (descriptor.kind === "local") return [];
  const listed =
    descriptor.routes !== undefined && descriptor.routes.length > 0
      ? [...descriptor.routes]
      : legacyRoutes(descriptor);
  const rank = (route: SourceRoute) => (route.via === "direct" ? 0 : 1);
  return listed.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(b.preferred) - Number(a.preferred) ||
      b.lastOkAtMs - a.lastOkAtMs,
  );
}

function legacyRoutes(descriptor: SourceDescriptor): SourceRoute[] {
  const routes: SourceRoute[] = [];
  if (descriptor.baseUrl !== "")
    routes.push({
      via: "direct",
      origin: descriptor.baseUrl,
      cloudIssuer: "",
      fingerprint: descriptor.fingerprint,
      preferred: descriptor.kind === "direct",
      lastOkAtMs: 0,
    });
  if (descriptor.kind !== "direct" && descriptor.relayOrigin !== "")
    routes.push({
      via: "relayed",
      origin: descriptor.relayOrigin,
      cloudIssuer: descriptor.cloudIssuer,
      fingerprint: "",
      preferred: descriptor.kind === "relayed",
      lastOkAtMs: 0,
    });
  return routes;
}

/** 这个源有哪几类路可走（按优先次序）。 */
export function candidateRoutes(descriptor: SourceDescriptor): Via[] {
  if (descriptor.kind === "local") return ["local"];
  const vias: Via[] = [];
  for (const route of routesOf(descriptor))
    if (!vias.includes(route.via)) vias.push(route.via);
  return vias;
}

/**
 * 给一个远程源选一条路并拿到那条路的访问。直连探测与中继取访问同时发出；
 * 直连通就不等中继（它的答案丢掉，凭据来源自己缓存着）。
 */
export async function pickRoute(
  descriptor: SourceDescriptor,
  provider: CredentialProvider,
  options: ProbeOptions = {},
): Promise<Route> {
  if (descriptor.kind === "local")
    throw new SourceError(SOURCE_ERROR.unreachable, "no route");
  const routes = routesOf(descriptor);
  if (routes.length === 0)
    throw new SourceError(SOURCE_ERROR.unreachable, "no route");
  const id = descriptor.sourceId;
  const directs = routes.filter((route) => route.via === "direct");
  const relays = routes.filter((route) => route.via === "relayed");
  // 这一类只有一条路时凭据来源不必知道是哪一条（与 §55 之前一样）。
  const directOf = (route: SourceRoute) =>
    directs.length === 1
      ? provider.getAccess(id, "direct")
      : provider.getAccess(id, "direct", route.origin);

  // 只有直连：不必先探，凭据来源换票时自然会连它。
  if (relays.length === 0 && directs.length === 1) {
    const route = directs[0] as SourceRoute;
    return {
      via: "direct",
      access: await directOf(route),
      origin: route.origin,
    };
  }
  const relayed = relays.length === 0 ? null : relayRace(id, relays, provider);
  // 中继那条先挂一个空处理：直连成功时它的失败没人等，不该成为未处理的拒绝。
  relayed?.catch(() => undefined);

  let directFailure: unknown;
  for (const route of directs) {
    if (!(await probeDirect(route.origin, id, options))) continue;
    try {
      return {
        via: "direct",
        access: await directOf(route),
        origin: route.origin,
      };
    } catch (error) {
      directFailure = error;
    }
  }
  if (relayed === null) {
    if (directFailure !== undefined) throw directFailure;
    throw new SourceError(SOURCE_ERROR.unreachable, "direct unreachable");
  }
  try {
    return await relayed;
  } catch (cause) {
    if (cause instanceof SourceError) throw cause;
    throw new SourceError(
      typeof (cause as { code?: unknown })?.code === "string"
        ? (cause as { code: string }).code
        : SOURCE_ERROR.unreachable,
      cause instanceof Error ? cause.message : "relay unreachable",
      { cause },
    );
  }
}

/**
 * 中继：凭据来源自己会选（桌面）就问一次；否则按次序逐条试，第一条成的用。
 * 全不成时抛第一条的失败（首选的那条最能说明问题）。
 */
async function relayRace(
  id: string,
  relays: readonly SourceRoute[],
  provider: CredentialProvider,
): Promise<Route> {
  if (provider.selectsRelay === true || relays.length === 1) {
    const access = await provider.getAccess(id, "relayed");
    return { via: "relayed", access };
  }
  let first: unknown;
  for (const route of relays) {
    try {
      const access = await provider.getAccess(id, "relayed", route.origin);
      return { via: "relayed", access, origin: route.origin };
    } catch (error) {
      first ??= error;
    }
  }
  throw first;
}
