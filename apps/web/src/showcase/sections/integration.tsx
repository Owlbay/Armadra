import type { ReactNode } from "react";
import type { ExecutionHost } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { FleetGroup } from "@/panels/settings/pages/execution-hosts/FleetGroup";
import { BUILD_BOX, FLEET, GPU_NODE, LOCAL } from "../fixtures/integration";

const noop = () => undefined;

function Sample({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-[12px] text-muted-foreground">
        {caption}
      </figcaption>
      {children}
    </figure>
  );
}

/**
 * `integration` 分区（设计展示页 §2.1，设计系统 §5.15）：执行主机页真的
 * `FleetGroup`，喂假数据。
 *
 * 舰队（在线且最新、离线且 Worker 过期带一串失败记录、配了 Worker 还没握过
 * 手、只跑终端）· 正在全部重新同步 · 只有一台 Worker 主机时（没有「全部重新
 * 同步」，那一台正在同步）。CLI 分组的启动器 / ACP 样本归集成设置页的实现包，
 * 加在这个文件里。
 */
export default function IntegrationSection() {
  const t = useT();
  const label = (host: ExecutionHost) =>
    host.kind === "local"
      ? t("executionHosts.local")
      : host.name || host.executionHostId;
  const fleet = {
    resyncing: null,
    resyncingAll: false,
    validating: false,
    onResync: noop,
    onResyncAll: noop,
    onValidate: noop,
    label,
  };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-6">
        <Sample caption={t("executionHosts.showcase.fleet")}>
          <FleetGroup {...fleet} hosts={FLEET} />
        </Sample>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <Sample caption={t("executionHosts.showcase.resyncingAll")}>
          <FleetGroup {...fleet} hosts={[BUILD_BOX, GPU_NODE]} resyncingAll />
        </Sample>
        <Sample caption={t("executionHosts.showcase.single")}>
          <FleetGroup
            {...fleet}
            hosts={[LOCAL, GPU_NODE]}
            resyncing={GPU_NODE.executionHostId}
          />
        </Sample>
      </div>
    </div>
  );
}
