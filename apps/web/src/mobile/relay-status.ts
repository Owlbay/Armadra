import { useQuery } from "@tanstack/react-query";

import { CloudError, cloudPlatformInfo } from "../sources/cloud-client";

/**
 * 手机经中继的连接：中继自己停了要与中继托管的页面一样说清楚（P3 只做了托管页，
 * `sources/hosted.ts` 的 `relayDown`）。
 *
 * 手机的本机源就是选中的那条连接；走中继时运行时的每个请求都经中继，所以
 * 「运行时连不上」时再问一次中继自己的平台信息（`/.well-known/armadra-platform`，
 * 匿名、不带凭据）：中继连不上就是中继停了，答了（哪怕是拒绝）就不是中继的事
 * （主机下线、凭据失效照旧由运行时断开与源状态说）。
 */

let relayOrigin: string | null = null;

/** 入口选好路之后记下：经中继时是中继的来源，直连是 `null`（`entry.ts`）。 */
export function setMobileRelayRoute(origin: string | null): void {
  relayOrigin = origin === "" ? null : origin;
}

export function mobileRelayRoute(): string | null {
  return relayOrigin;
}

/**
 * 中继还连得上吗：传输层失败与前面那层代理的 502–504 算连不上，中继自己的
 * 其余答复都算连得上。
 */
export type RelayProbe = (origin: string) => Promise<boolean>;

export const probeRelay: RelayProbe = (origin) =>
  cloudPlatformInfo(origin, { timeoutMs: 4_000 }).then(
    () => true,
    (error: unknown) =>
      error instanceof CloudError &&
      // 答了但形状不认识（`bad_response`）也是有人在答。
      (error.code === "bad_response" ||
        error.status < 502 ||
        error.status > 504),
  );

let probe: RelayProbe = probeRelay;

/** 测试换掉探测与路线。 */
export function resetMobileRelayStatus(
  next: { readonly probe?: RelayProbe; readonly origin?: string | null } = {},
): void {
  probe = next.probe ?? probeRelay;
  relayOrigin = next.origin ?? null;
}

/** 运行时连不上、且这条连接走中继、中继也连不上：中继停了。 */
export function useMobileRelayDown(runtimeDown: boolean): boolean {
  const origin = relayOrigin;
  const reachable = useQuery({
    queryKey: ["mobile-relay-reachable", origin],
    queryFn: () => probe(origin!),
    enabled: runtimeDown && origin !== null,
    retry: false,
    gcTime: 0,
    refetchInterval: 5_000,
  });
  return runtimeDown && origin !== null && reachable.data === false;
}
