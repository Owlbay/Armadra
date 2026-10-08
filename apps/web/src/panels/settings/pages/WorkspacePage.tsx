import { useQuery } from "@tanstack/react-query";

import { runtimeApi } from "../../../api/client";
import { RealtimeSetting } from "../../../realtime/RealtimeSetting";
import { useSubpage } from "../subpage";
import { SwitchExecutionHost } from "./execution-hosts/SwitchExecutionHost";
import { executionHostLabel } from "./MachinesPage";
import { WorkspaceExecution } from "./WorkspaceExecution";
import { LanguageServicePanel } from "./LanguageServicePanel";
import { useAgentsQuery } from "../../../app/use-agents";
import { useT } from "../../../app/preferences-store";
import { useCanvasStore } from "../../../store/canvas-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CONTROL_WIDTH } from "./GeneralPage";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Button } from "@/ui/button";

/** 「跟随全局」在 Select 里需要一个值——空串会被 Radix 当成未选中。 */
const INHERIT = "__inherit__";

/**
 * 设置 → 工作空间（§2.1）：**当前**这块工作空间的开关。
 *
 * 允许执行命令、运行在哪台机器上（切换推入子页）、默认 Agent 覆盖（存在
 * Runtime 的 `workspaces.<id>` 段里）、语言服务；最后是全局的实时协同。
 */
export function WorkspacePage() {
  const t = useT();
  const agents = useAgentsQuery();
  const { settings, save } = useRuntimeSettings();

  const subpage = useSubpage();
  const workspace = useCanvasStore((state) => state.workspace);
  const workspaceId = workspace?.id ?? null;
  const hosts = useQuery({
    queryKey: ["execution-hosts"],
    queryFn: runtimeApi.executionHosts,
    retry: false,
    enabled: workspaceId !== null,
  });

  const section = workspaceId
    ? settings.data?.workspaces?.[workspaceId]
    : undefined;
  const defaultAgent = section?.defaultAgent ?? INHERIT;

  if (!workspace || !workspaceId) {
    return (
      <>
        <SettingsGroup>
          <SettingsRow label={t("settings.noWorkspace")} />
        </SettingsGroup>
        <RealtimeSetting />
      </>
    );
  }

  if (subpage.current === "executionHosts:switch") {
    return (
      <SwitchExecutionHost
        workspace={workspace}
        hosts={hosts.data ?? []}
        onDone={subpage.close}
      />
    );
  }

  const current = (hosts.data ?? []).find(
    (host) => host.executionHostId === (workspace.executionHostId ?? ""),
  );

  return (
    <>
      <WorkspaceExecution />
      <SettingsGroup>
        <SettingsRow label={t("executionHosts.runsOn")}>
          <span className="max-w-[240px] truncate text-[13px] text-muted-foreground">
            {executionHostLabel(current, workspace.executionHostId ?? "", t)}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => subpage.open("executionHosts", "switch")}
          >
            {t("executionHosts.switch")}
          </Button>
        </SettingsRow>
        <SettingsRow label={t("settings.workspaceDefaultAgent")}>
          <Select
            value={defaultAgent}
            disabled={!settings.data}
            onValueChange={(value) =>
              save.mutate({
                workspaces: {
                  // `null` 让 Runtime 的 merge 删掉这个键，回到全局默认。
                  [workspaceId]: {
                    defaultAgent: value === INHERIT ? null : value,
                  },
                },
              })
            }
          >
            <SelectTrigger
              aria-label={t("settings.workspaceDefaultAgent")}
              size="sm"
              className={CONTROL_WIDTH}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              <SelectItem value={INHERIT}>
                {t("settings.defaultAgent.inherit")}
              </SelectItem>
              {(agents.data ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>
      {/* 每种语言一行：有什么、缺什么、能不能启动（语言服务设计 §4.2）。 */}
      <LanguageServicePanel workspaceId={workspaceId} />
      <RealtimeSetting />
    </>
  );
}
