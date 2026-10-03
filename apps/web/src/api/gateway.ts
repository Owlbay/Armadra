import {
  gatewayConfigPatchSchema,
  gatewayPairingPayloadSchema,
  gatewayStatusSchema,
  type GatewayConfigPatch,
} from "@armadra/shared";

import { json, request } from "./request";

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

export const GATEWAY_QUERY_KEY = ["gateway"] as const;

/**
 * 桌面壳的托盘菜单里也有一个「对外服务」开关；页面改了之后告诉壳重读一次，
 * 免得托盘上的勾停在旧值。浏览器里没有壳，什么也不做。
 */
export function notifyShellGatewayChanged(): void {
  const bridge = typeof window === "undefined" ? undefined : window.armadra;
  void bridge?.gateway?.refresh().catch(() => undefined);
}
