import {
  type CredentialProvider,
  SOURCE_ERROR,
  type SourceAccess,
  type SourceDescriptor,
  SourceError,
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
}

/** 这个源有哪几条路可走（按优先次序）。 */
export function candidateRoutes(descriptor: SourceDescriptor): Via[] {
  if (descriptor.kind === "local") return ["local"];
  const routes: Via[] = [];
  if (descriptor.baseUrl !== "") routes.push("direct");
  if (descriptor.kind !== "direct" && descriptor.relayOrigin !== "")
    routes.push("relayed");
  return routes;
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
  const routes = candidateRoutes(descriptor);
  if (routes.length === 0 || routes[0] === "local")
    throw new SourceError(SOURCE_ERROR.unreachable, "no route");
  const id = descriptor.sourceId;

  // 只有直连一条路：不必先探，凭据来源换票时自然会连它。
  if (routes.length === 1 && routes[0] === "direct") {
    return { via: "direct", access: await provider.getAccess(id, "direct") };
  }
  const relayed = routes.includes("relayed")
    ? provider
        .getAccess(id, "relayed")
        .then((access): Route => ({ via: "relayed", access }))
    : null;
  // 中继那条先挂一个空处理：直连成功时它的失败没人等，不该成为未处理的拒绝。
  relayed?.catch(() => undefined);

  if (
    routes.includes("direct") &&
    (await probeDirect(descriptor.baseUrl, id, options))
  ) {
    try {
      return { via: "direct", access: await provider.getAccess(id, "direct") };
    } catch (error) {
      if (relayed === null) throw error;
    }
  }
  if (relayed === null)
    throw new SourceError(SOURCE_ERROR.unreachable, "direct unreachable");
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
