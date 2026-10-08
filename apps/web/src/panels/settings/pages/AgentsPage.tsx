import * as React from "react";
import type { AgentInfo } from "@armadra/shared";

import { useAgentsQuery } from "../../../app/use-agents";
import {
  usePreferencesStore,
  useT,
  type AgentMode,
} from "../../../app/preferences-store";
import { InstallButton, useInstallJob } from "@/acp/adapter-install";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { parseSubpage, useSubpage } from "../subpage";
import { AgentDetailPage, AgentModeSelect } from "./AgentDetailPage";
import type { AgentIntegration } from "./integration/types";
import { useAgentIntegration } from "./integration/use-integration";
import {
  canvasAgentsValue,
  useDelayed,
  useIntegrationActions,
  useMigrationNotice,
} from "./integration/parts";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";

/** 一家 CLI 在这台主机上的状态；`ready` 时主表上不画徽标。 */
export type AgentState =
  | "ready"
  | "installNeeded"
  | "updateNeeded"
  | "disabled";

/**
 * 主表一行的状态（§2.5）：禁用优先，其次没装，再次注入产物要重新生成。
 * 集成状态还没读回来时按「可用」算，读回来再换。
 */
export function agentState(
  agent: AgentInfo,
  integration: AgentIntegration | null,
  mode: AgentMode,
): AgentState {
  if (mode === "disabled") return "disabled";
  if (!agent.installed) return "installNeeded";
  if (
    integration &&
    agent.capabilities.includes("hooks") &&
    (integration.stale ||
      !integration.hook.installed ||
      !integration.skill.installed)
  )
    return "updateNeeded";
  return "ready";
}

/**
 * 设置 → Agent CLI（§2.5）。
 *
 * 一家一行：名称 · 状态（只在不正常时出现）· 能在画布里用哪种视图 · 一个
 * 主动作；点名称进这一家的子页看安装与注入的细节。自定义 Agent 在自己那一页。
 */
export function AgentsPage() {
  const t = useT();
  const agents = useAgentsQuery();
  const subpage = parseSubpage(useSubpage().current);
  const builtins = React.useMemo(
    () => (agents.data ?? []).filter((agent) => !agent.baseAgent),
    [agents.data],
  );
  const slow = useDelayed(agents.isPending, 300);

  if (subpage?.kind === "cli") {
    const agent = builtins.find((entry) => entry.id === subpage.ref);
    if (agent) return <AgentDetailPage agent={agent} />;
  }
  if (agents.isPending) {
    return slow ? <AgentsSkeleton /> : <div aria-busy="true" />;
  }
  if (builtins.length === 0) {
    return (
      <Empty className="border-0 p-6">
        <EmptyHeader>
          <EmptyTitle className="text-[13px] font-normal">
            {t("integration.empty")}
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <SettingsGroup>
      {builtins.map((agent) => (
        <AgentRow key={agent.id} agent={agent} />
      ))}
    </SettingsGroup>
  );
}

function AgentsSkeleton() {
  return (
    <SettingsGroup>
      {[0, 1, 2].map((row) => (
        <SettingsRow key={row} label={<Skeleton className="h-4 w-28" />}>
          <Skeleton className="h-4 w-32" />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

/** 主表一行；展示页用假数据渲染同一个组件。 */
export function AgentRow({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const subpage = useSubpage();
  const { integration } = useAgentIntegration(agent);
  const mode = usePreferencesStore(
    (state) => state.agentModes[agent.id] ?? "default",
  );
  const cli = useInstallJob(agent, "cli");
  const { regenerate, busy } = useIntegrationActions(agent);
  useMigrationNotice(agent, integration);

  const state = agentState(agent, integration, mode);
  const spawn = canvasAgentsValue(integration?.canvasAgents);
  const views =
    spawn === null || spawn === "none"
      ? "—"
      : t(`integration.canvasAgents.${spawn}`);

  return (
    <SettingsRow
      label={agent.label}
      onClick={() => subpage.open("cli", agent.id)}
    >
      {state !== "ready" && (
        <Badge
          variant="outline"
          data-agent-state={state}
          className="font-normal text-muted-foreground"
        >
          {t(`agents.state.${state}`)}
        </Badge>
      )}
      <span className="hidden w-36 truncate text-right text-[13px] text-muted-foreground sm:inline">
        {views}
      </span>
      <div className="flex w-24 justify-end">
        {state === "installNeeded" && cli.available ? (
          <InstallButton install={cli} installed={false} />
        ) : state === "updateNeeded" ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => regenerate.mutate()}
          >
            {regenerate.isPending && <Spinner aria-hidden />}
            {t("agents.action.update")}
          </Button>
        ) : (
          <AgentModeSelect agent={agent} />
        )}
      </div>
    </SettingsRow>
  );
}
