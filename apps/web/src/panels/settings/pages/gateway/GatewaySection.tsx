import * as React from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  GatewayConfigPatch,
  GatewayPairingPayload,
  GatewayStatus,
} from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import { useAccess } from "../../../../app/use-access";
import {
  GATEWAY_QUERY_KEY,
  gatewayApi,
  notifyShellGatewayChanged,
} from "../../../../api/gateway";
import {
  listIdentityDevices,
  onIdentitySessionChange,
  revokeIdentityDevice,
} from "../../../../api/identity";
import { GatewayDevices, type GatewayDevice } from "./GatewayDevices";
import { GatewayPanel } from "./GatewayPanel";

const DEVICES_QUERY_KEY = [...GATEWAY_QUERY_KEY, "devices"] as const;

/** 托盘也能开关、地址也会变：开着这一页时隔一会儿重读一次。 */
export const GATEWAY_POLL_MS = 15_000;

/** 这台设备在身份面上的样子（由「设备登录」那一块报上来）。 */
export interface GatewayIdentity {
  deviceId: string;
  /** 会话带 `identity:manage`。 */
  canManage: boolean;
}

/**
 * 对外服务这一块的数据面：状态、配置、配对票、已配对设备。
 *
 * `GET /api/gateway` 只有 owner 答（契约 §17），成员 403——读不到时配置与
 * 配对整块不出现，设备表照样在。设备列表要一条身份会话；没有会话时（还没
 * 配对的浏览器）列表不出现，配置照常。这一页只有这一份设备表（G3-11 把
 * 「设备登录」里的那份并了进来）。
 */
export function GatewaySection({
  identity = null,
  onCurrentRevoked,
}: {
  identity?: GatewayIdentity | null;
  /** 撤销的正是这台设备：身份会话随之失效。 */
  onCurrentRevoked?(): void;
} = {}) {
  const t = useT();
  const client = useQueryClient();
  // 服务器壳上的成员连问都不问：必然 403 的请求不该发（会话没取回来时也按
  // 成员算，晚一拍出现）。
  const owner = !useAccess().member;
  const status = useQuery({
    queryKey: GATEWAY_QUERY_KEY,
    queryFn: ({ signal }) => gatewayApi.status(signal),
    refetchInterval: GATEWAY_POLL_MS,
    retry: false,
    enabled: owner,
  });
  const devices = useInfiniteQuery({
    queryKey: DEVICES_QUERY_KEY,
    queryFn: ({ pageParam }) => listIdentityDevices(pageParam),
    initialPageParam: "",
    getNextPageParam: (page) => (page.hasMore ? page.nextId : undefined),
    retry: false,
  });
  React.useEffect(
    () =>
      onIdentitySessionChange(() => {
        void client.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
      }),
    [client],
  );

  const configure = useMutation({
    mutationFn: (patch: GatewayConfigPatch) => gatewayApi.configure(patch),
    onSuccess: (next) => {
      client.setQueryData<GatewayStatus>(GATEWAY_QUERY_KEY, next);
      notifyShellGatewayChanged();
    },
    onError: () => toast.error(t("gateway.saveFailed")),
  });

  const [pairing, setPairing] = React.useState<GatewayPairingPayload | null>(
    null,
  );
  const pair = useMutation({
    mutationFn: (origin?: string) => gatewayApi.pair(origin),
    onSuccess: (payload) => setPairing(payload),
    onError: () => toast.error(t("gateway.pair.failed")),
  });

  const [revoking, setRevoking] = React.useState<string | null>(null);
  async function revoke(device: GatewayDevice) {
    setRevoking(device.deviceId);
    try {
      await revokeIdentityDevice(device.deviceId, device.epoch);
      if (device.deviceId === identity?.deviceId) onCurrentRevoked?.();
    } catch {
      toast.error(t("gateway.devices.revokeFailed"));
    } finally {
      setRevoking(null);
      void client.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
    }
  }

  const running = Boolean(status.data?.enabled && status.data.running);
  const origin = status.data?.origin ?? null;
  const fingerprint = status.data?.tls.fingerprint ?? null;
  // 开起来（或来源、信任锚变了）就铸一张；关掉就丢。票只活两分钟，过期后
  // 不自动续，等人点「新配对码」。
  const { mutate: mint } = pair;
  React.useEffect(() => {
    setPairing(null);
    if (running) mint(undefined);
  }, [running, origin, fingerprint, mint]);

  const list = devices.data?.pages.flatMap((page) => page.devices) ?? null;
  const deviceOptions = {
    currentDeviceId: identity?.deviceId ?? null,
    // owner 一定能撤销；成员要会话里带管理权。
    canRevoke: owner || Boolean(identity?.canManage),
    hasMore: devices.hasNextPage,
    loadingMore: devices.isFetchingNextPage,
    onMore: () => void devices.fetchNextPage(),
  };
  if (!owner || !status.data)
    return list ? (
      <GatewayDevices
        devices={list}
        revoking={revoking}
        onRevoke={(device) => void revoke(device)}
        {...deviceOptions}
      />
    ) : null;
  return (
    <GatewayPanel
      status={status.data}
      saving={configure.isPending}
      onConfigure={(patch) => configure.mutate(patch)}
      pairing={pairing}
      pairingBusy={pair.isPending}
      onNewPairing={(next) => pair.mutate(next)}
      devices={list}
      revoking={revoking}
      onRevoke={(device) => void revoke(device)}
      deviceOptions={deviceOptions}
    />
  );
}
