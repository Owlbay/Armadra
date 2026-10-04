import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ExecutionHost } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import {
  AgentIntegrationRow,
  OutdatedWorkers,
} from "@/panels/settings/pages/IntegrationPage";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { FleetGroup } from "@/panels/settings/pages/execution-hosts/FleetGroup";
import { integrationKey } from "@/panels/settings/pages/integration/use-integration";
import {
  BUILD_BOX,
  CLI_GROUP,
  FLEET,
  GPU_NODE,
  LOCAL,
} from "../fixtures/integration";

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
 * 同步」，那一台正在同步）。
 *
 * CLI 分组：集成设置页真的行组件，集成状态预先放进 query 缓存（永不过期，
 * 不去请求 core）——正常、版本过旧（页首带一台 Worker 待升级的主机）、启动器
 * 异常、ACP 未装各一行。
 */
function CliGroup() {
  const client = useQueryClient();
  // 渲染之前放好：行组件第一次读缓存就拿到，不出现「读取中」也不发请求。
  useState(() => {
    client.setQueryDefaults(["agent-integration"], { staleTime: Infinity });
    for (const { agent, integration } of CLI_GROUP) {
      client.setQueryData(integrationKey(agent.id), integration);
    }
    return true;
  });
  const outdated = CLI_GROUP.find(
    ({ integration }) => (integration.outdatedHosts?.length ?? 0) > 0,
  );
  return (
    <div className="flex flex-col gap-3">
      {outdated && <OutdatedWorkers agent={outdated.agent} />}
      <SettingsGroup>
        {CLI_GROUP.map(({ agent }) => (
          <AgentIntegrationRow key={agent.id} agent={agent} />
        ))}
      </SettingsGroup>
    </div>
  );
}

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
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
        <Sample caption={t("showcase.integration.cli")}>
          <CliGroup />
        </Sample>
      </div>
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
