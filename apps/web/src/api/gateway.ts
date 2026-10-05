import {
  gatewayConfigPatchSchema,
  gatewayPairingPayloadSchema,
  gatewayStatusSchema,
  type GatewayConfigPatch,
  type GatewayPairingPayload,
} from "@armadra/shared";

import { IdentityRequestError, IdentityTransportError } from "./identity";
import { RUNTIME_URL, json, request } from "./request";
import { localSource } from "./source";

/**
 * 对外服务（Gateway，契约 §17）。三条路由只有 owner 进得来，成员 403——设置页
 * 据此决定这一块出不出现。
 */
export const gatewayApi = {
  status: (signal?: AbortSignal) =>
    request("/api/gateway", gatewayStatusSchema, { signal }),
  /** 未给的键不动；回答是写入并对账之后的状态。 */
  configure: (patch: GatewayConfigPatch) =>
    request("/api/gateway", gatewayStatusSchema, {
      method: "PUT",
      ...json(gatewayConfigPatchSchema.parse(patch)),
    }),
  /** 铸一张两分钟的一次性配对票；`origin` 缺省用首选来源。 */
  pair: (origin?: string) =>
    request("/api/gateway/pairing", gatewayPairingPayloadSchema, {
      method: "POST",
      ...json(origin ? { origin } : {}),
    }),
};

/**
 * `POST /api/gateway/pairing-code/exchange`（契约 §24）：手机上手输的 8 位配对码
 * 换出与 `#pair=` 同一张票。匿名、不带 Cookie 也不带 CSRF——这时还没有任何
 * 会话；失败与身份面同一种错误，连接页按 `code` 分原因。`base` 给原生 App
 * 用（它连的 Gateway 来源）。
 */
export async function exchangePairingCode(
  code: string,
  base: string = RUNTIME_URL,
): Promise<GatewayPairingPayload> {
  let response: Response;
  try {
    response = await localSource.fetch(
      `${base}/api/gateway/pairing-code/exchange`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      },
    );
  } catch (cause) {
    throw new IdentityTransportError(cause);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = (payload ?? {}) as { code?: unknown; message?: unknown };
    const retry = Number(response.headers?.get?.("retry-after") ?? 0);
    throw new IdentityRequestError(
      response.status,
      typeof body.code === "string" ? body.code : "UNKNOWN",
      typeof body.message === "string" ? body.message : "",
      Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 0,
    );
  }
  return gatewayPairingPayloadSchema.parse(payload);
}

export const GATEWAY_QUERY_KEY = ["gateway"] as const;

/**
 * 桌面壳的托盘菜单里也有一个「对外服务」开关；页面改了之后告诉壳重读一次，
 * 免得托盘上的勾停在旧值。浏览器里没有壳，什么也不做。
 */
export function notifyShellGatewayChanged(): void {
  const bridge = typeof window === "undefined" ? undefined : window.armadra;
  void bridge?.gateway?.refresh().catch(() => undefined);
}
