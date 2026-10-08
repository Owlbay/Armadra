import type { AgentInfo } from "@armadra/shared";

import {
  AGENT_MODES,
  usePreferencesStore,
  useT,
  type AgentMode,
} from "../../../app/preferences-store";
import {
  CopyCommandButton,
  InstallButton,
  InstallFailure,
  useInstallJob,
} from "@/acp/adapter-install";
import { ScopeBadge } from "../scope-badge";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useAgentIntegration } from "./integration/use-integration";
import {
  CleanupButton,
  RowValue,
  canvasAgentsValue,
  historyValue,
  injectionProblem,
  useIntegrationActions,
  useMigrationNotice,
} from "./integration/parts";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";

/** 默认 / 启用 / 禁用（本设备，`agentModes`）。主表与子页同一个控件。 */
export function AgentModeSelect({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const mode = usePreferencesStore(
    (state) => state.agentModes[agent.id] ?? "default",
  );
  const setAgentMode = usePreferencesStore((state) => state.setAgentMode);
  return (
    <Select
      value={mode}
      onValueChange={(value) => setAgentMode(agent.id, value as AgentMode)}
    >
      <SelectTrigger
        aria-label={`${agent.label} ${t("agents.row.mode")}`}
        size="sm"
        className="w-24"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="z-[var(--z-dialog)]">
        {AGENT_MODES.map((choice) => (
          <SelectItem key={choice} value={choice}>
            {t(`settings.agentMode.${choice}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Agent CLI 子页（§2.5）：启动 · 安装 · 画布注入三组。
 *
 * 画布注入只说数据目录里本产品的产物（Hook、技能、启动器），不读也不展示
 * CLI 配置里别的东西。「清理旧版」只在 core 报出本产品旧版本的条目时出现。
 */
export function AgentDetailPage({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const { integration } = useAgentIntegration(agent);
  const cli = useInstallJob(agent, "cli");
  const adapter = useInstallJob(agent, "adapter");
  const { regenerate, repair, busy } = useIntegrationActions(agent);
  useMigrationNotice(agent, integration);
  const override = usePreferencesStore(
    (state) => state.launchOverrides[agent.id] ?? "",
  );
  const setLaunchOverride = usePreferencesStore(
    (state) => state.setLaunchOverride,
  );

  /* ---------------------------------- 安装 --------------------------------- */
  const version = agent.probe?.version;
  const cliValue = agent.installed
    ? version
      ? t("integration.state.installedVersion", { version })
      : t("integration.state.installed")
    : t("integration.state.cliMissing");
  const acp = agent.acp;
  const native = acp?.support === "native";
  const acpValue = !acp
    ? null
    : native && agent.installed
      ? t("integration.state.viaCli")
      : acp.installed
        ? acp.version
          ? t("integration.state.installedVersion", { version: acp.version })
          : t("integration.state.installed")
        : t("integration.state.missing");

  /* -------------------------------- 画布注入 -------------------------------- */
  const hooked = agent.capabilities.includes("hooks");
  const problem = injectionProblem(t, integration);
  const limited = integration?.launcherWarning;
  const legacy = integration?.legacy.found ?? [];
  const spawn = canvasAgentsValue(integration?.canvasAgents);
  const reasons = integration?.canvasAgents?.reasons ?? [];
  const history = historyValue(t, agent.history);

  return (
    <>
      <SettingsGroup title={t("agents.group.launch")}>
        <SettingsRow label={t("agents.row.mode")}>
          <ScopeBadge scope="device" />
          <AgentModeSelect agent={agent} />
        </SettingsRow>
        <SettingsRow label={t("settings.launchCommand")}>
          <ScopeBadge scope="device" />
          <Input
            className="h-8 w-36 text-xs sm:w-[240px]"
            aria-label={`${agent.label} ${t("settings.launchCommand")}`}
            placeholder={agent.resolvedPath ?? agent.launchCmd}
            value={override}
            onChange={(event) =>
              setLaunchOverride(agent.id, event.target.value)
            }
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("agents.group.install")}>
        <SettingsRow label={t("integration.row.cli")}>
          <RowValue title={agent.resolvedPath ?? undefined}>
            {cliValue}
          </RowValue>
          {cli.available ? (
            <InstallButton install={cli} installed={agent.installed} />
          ) : !agent.installed ? (
            <CopyCommandButton command={agent.launchCmd} />
          ) : null}
        </SettingsRow>
        {acpValue !== null && (
          <SettingsRow label={t("integration.row.acp")}>
            <RowValue title={acp?.program}>{acpValue}</RowValue>
            {acp && !native && (
              <InstallButton install={adapter} installed={acp.installed} />
            )}
          </SettingsRow>
        )}
        <InstallFailure agent={agent} jobs={[cli, adapter]} />
      </SettingsGroup>

      {(hooked || spawn !== null || history !== null) && (
        <SettingsGroup title={t("agents.group.injection")}>
          {hooked && (
            <SettingsRow label={t("agents.row.artifacts")}>
              {integration ? (
                problem ? (
                  <RowValue title={integration.hook.path ?? undefined}>
                    {problem}
                  </RowValue>
                ) : limited ? (
                  <RowValue title={limited}>
                    {t("integration.state.limited")}
                  </RowValue>
                ) : null
              ) : (
                <Skeleton className="h-4 w-16" />
              )}
              {legacy.length > 0 && (
                <CleanupButton
                  findings={legacy}
                  busy={busy}
                  onCleanup={() => repair.mutate()}
                />
              )}
              <Button
                variant={problem ? "secondary" : "ghost"}
                size="sm"
                disabled={busy || !integration}
                title={
                  integration
                    ? t("integration.revision", { n: integration.revision })
                    : undefined
                }
                onClick={() => regenerate.mutate()}
              >
                {regenerate.isPending && <Spinner aria-hidden />}
                {t("integration.regenerate")}
              </Button>
            </SettingsRow>
          )}
          {spawn !== null && (
            <SettingsRow label={t("integration.row.canvasAgents")}>
              <RowValue
                title={
                  reasons.length > 0
                    ? reasons
                        .map((reason) => t(`integration.reason.${reason}`))
                        .join(" · ")
                    : undefined
                }
              >
                {t(`integration.canvasAgents.${spawn}`)}
              </RowValue>
            </SettingsRow>
          )}
          {history !== null && (
            <SettingsRow label={t("integration.row.history")}>
              <RowValue>{history}</RowValue>
            </SettingsRow>
          )}
        </SettingsGroup>
      )}
    </>
  );
}
