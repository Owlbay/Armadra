import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  type AgentHistory,
  type AgentInfo,
  type CanvasAgents,
  type HistoryState,
  type LegacyIntegrationFinding,
} from "@armadra/shared";

import { runtimeApi } from "../../../api/client";
import { useAgentsQuery } from "../../../app/use-agents";
import { useT, type Translate } from "../../../app/preferences-store";
import {
  CopyCommandButton,
  InstallButton,
  InstallFailure,
  useInstallJob,
} from "@/acp/adapter-install";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { ScrollArea } from "@/ui/scroll-area";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";
import type {
  AgentIntegration,
  IntegrationRepairReport,
} from "./integration/types";
import {
  useAgentIntegration,
  useIntegrationRefresh,
} from "./integration/use-integration";

/**
 * 设置 → 集成（[界面与 ACP 刷新](../../../../../docs/design/ui-acp-refresh.md) §1）。
 *
 * 页首一组「Worker 待升级」的执行主机（契约 §21.2，集成状态的 `outdatedHosts`）；
 * 然后一家 CLI 一张分组，固定五行，顺序按用户要做的事排：CLI、ACP、画布注入、
 * 在画布中创建 Agent、本地历史。每行右侧一个值、至多一个动作；**没有问题的行不
 * 出任何徽标**（设计系统 §5.15）。安装失败时行下一条 `Alert`。
 */
export function IntegrationPage() {
  const t = useT();
  const agents = useAgentsQuery();
  const list = agents.data ?? [];
  const slow = useDelayed(agents.isPending, 300);

  if (agents.isPending) {
    return slow ? <IntegrationSkeleton /> : <div aria-busy="true" />;
  }
  if (list.length === 0) {
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
    <div className="flex flex-col gap-6">
      {list[0] && <OutdatedWorkers agent={list[0]} />}
      {list.map((agent) => (
        <AgentIntegrationGroup key={agent.id} agent={agent} />
      ))}
    </div>
  );
}

/** `on` 持续 `ms` 之后才答真：短的读取不闪一下骨架（设计系统 §3.2）。 */
function useDelayed(on: boolean, ms: number): boolean {
  const [late, setLate] = React.useState(false);
  React.useEffect(() => {
    if (!on) {
      setLate(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return late;
}

function IntegrationSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-slot="integration-skeleton">
      {[0, 1].map((group) => (
        <section key={group} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <SettingsGroup>
            {[0, 1, 2].map((row) => (
              <SettingsRow key={row} label={<Skeleton className="h-4 w-28" />}>
                <Skeleton className="h-4 w-20" />
              </SettingsRow>
            ))}
          </SettingsGroup>
        </section>
      ))}
    </div>
  );
}

/** 过旧 Worker 的执行主机，每台一行：徽标 + 「重新同步」。没有就什么都不画。 */
export function OutdatedWorkers({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const client = useQueryClient();
  const { integration } = useAgentIntegration(agent);
  const resync = useMutation({
    mutationFn: (hostId: string) => runtimeApi.resyncExecutionHost(hostId),
    onSuccess: (host) => {
      void client.invalidateQueries({ queryKey: ["agent-integration"] });
      void client.invalidateQueries({ queryKey: ["execution-hosts"] });
      toast.success(
        t("integration.resynced", { name: host.name || host.executionHostId }),
      );
    },
    onError: (cause: Error) =>
      toast.error(t("integration.resyncFailed"), {
        description: cause.message,
      }),
  });
  const hosts = integration?.outdatedHosts ?? [];
  if (hosts.length === 0) return null;
  return (
    <SettingsGroup>
      {hosts.map((host) => (
        <SettingsRow key={host.hostId} label={host.name || host.hostId}>
          <Badge variant="destructive">
            {host.version
              ? t("integration.outdatedHost.version", {
                  version: host.version,
                })
              : t("integration.outdatedHost")}
          </Badge>
          <Button
            variant="secondary"
            size="sm"
            disabled={resync.isPending}
            onClick={() => resync.mutate(host.hostId)}
          >
            <RefreshCw />
            {t("integration.resync")}
          </Button>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

/** 「修复」之后把 found / removed / kept / backup 四段原样报给用户。 */
function repairDescription(
  t: Translate,
  report: IntegrationRepairReport,
): string {
  const lines = [
    t("integration.repair.found", { count: report.found.length }),
    t("integration.repair.removed", { count: report.removed.length }),
    t("integration.repair.kept", { count: report.kept.length }),
  ];
  if (report.backup)
    lines.push(t("integration.backup", { path: report.backup }));
  return lines.join("\n");
}

/** 一行右侧的值：13px 灰字，不是徽标。 */
function RowValue({
  children,
  title,
  tone = "muted",
}: {
  children: React.ReactNode;
  title?: string;
  tone?: "muted" | "danger";
}) {
  return (
    <span
      title={title}
      className={
        tone === "danger"
          ? "text-[13px] text-[var(--danger-text)]"
          : "text-[13px] text-muted-foreground"
      }
    >
      {children}
    </span>
  );
}

const HISTORY_PARTS = ["index", "cost", "transcript"] as const;

/** 本地历史一行的值：可用的列出来，没找到的带「（未找到）」，不支持的不列。 */
export function historyValue(
  t: Translate,
  history: AgentHistory | undefined,
): string | null {
  if (!history) return null;
  const parts: string[] = [];
  for (const part of HISTORY_PARTS) {
    const state: HistoryState = history[part];
    const name = t(`integration.history.${part}`);
    if (state === "available") parts.push(name);
    else if (state === "not-found" || state === "disabled") {
      parts.push(t("integration.history.notFound", { part: name }));
    }
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** 「在画布中创建 Agent」一行的值（契约 §48）；旧 core 不带时答 `null`。 */
export function canvasAgentsValue(
  canvasAgents: CanvasAgents | undefined,
): "both" | "terminal" | "acp" | "none" | null {
  if (!canvasAgents) return null;
  const terminal = canvasAgents.terminal === "available";
  const acp = canvasAgents.acp === "available";
  if (terminal && acp) return "both";
  if (terminal) return "terminal";
  if (acp) return "acp";
  return "none";
}

/**
 * 一家 CLI 一张分组（设计 §1.2）。标题是 CLI 名，不加头像。
 */
export function AgentIntegrationGroup({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const refresh = useIntegrationRefresh();
  const { integration } = useAgentIntegration(agent);
  const cli = useInstallJob(agent, "cli");
  const adapter = useInstallJob(agent, "adapter");

  const regenerate = useMutation({
    mutationFn: () => runtimeApi.installAgentIntegration(agent.id),
    onSuccess: () => {
      refresh(agent.id);
      toast.success(t("integration.regenerated"));
    },
    onError: (cause: Error) =>
      toast.error(t("integration.failed"), { description: cause.message }),
  });

  const repair = useMutation({
    mutationFn: () => runtimeApi.repairAgentIntegration(agent.id),
    onSuccess: (report) => {
      refresh(agent.id);
      toast.success(t("integration.repair.done"), {
        description: repairDescription(t, report),
      });
    },
    onError: (cause: Error) =>
      toast.error(t("integration.repair.failed"), {
        description: cause.message,
      }),
  });

  useMigrationNotice(agent, integration);

  // 能力位说的是「这个适配器有没有 Hook 通道」；没有的话注入那一行没有对象。
  const hooked = agent.capabilities.includes("hooks");
  const custom = agent.id.startsWith("custom:");
  const busy = regenerate.isPending || repair.isPending;

  /* ---------------------------------- CLI ---------------------------------- */
  // `custom:` 条目的 CLI 是用户自己的启动行：值就是它，动作只有「复制命令」。
  const version = agent.probe?.version;
  const cliValue = custom
    ? agent.launchCmd
    : agent.installed
      ? version
        ? t("integration.state.installedVersion", { version })
        : t("integration.state.installed")
      : t("integration.state.cliMissing");
  const cliAction = cli.available ? (
    <InstallButton install={cli} installed={agent.installed} />
  ) : custom && agent.launchCmd ? (
    <CopyCommandButton command={agent.launchCmd} />
  ) : null;

  /* ---------------------------------- ACP ---------------------------------- */
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
  const acpAction =
    acp && !native ? (
      <InstallButton install={adapter} installed={acp.installed} />
    ) : null;

  /* -------------------------------- 画布注入 -------------------------------- */
  const legacy = integration?.legacy.found ?? [];
  const hookMissing = integration ? !integration.hook.installed : false;
  const skillMissing = integration ? !integration.skill.installed : false;
  const injectionProblem = !integration
    ? null
    : hookMissing && skillMissing
      ? t("integration.state.notGenerated")
      : hookMissing
        ? t("integration.state.hookMissing")
        : skillMissing
          ? t("integration.state.skillMissing")
          : integration.stale
            ? t("integration.state.stale")
            : null;
  const limited = integration?.launcherWarning;
  const regenerateButton = (
    <Button
      variant={injectionProblem ? "secondary" : "ghost"}
      size="sm"
      disabled={!hooked || busy || !integration}
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
  );

  /* --------------------------- 在画布中创建 Agent --------------------------- */
  const canvasAgents = integration?.canvasAgents;
  const spawn = canvasAgentsValue(canvasAgents);
  const reasons = canvasAgents?.reasons ?? [];
  const spawnFix =
    spawn !== "none" ? null : reasons.includes("cli_missing") &&
      cli.available ? (
      <InstallButton install={cli} installed={false} />
    ) : reasons.includes("acp_missing") &&
      acp &&
      !native &&
      adapter.available ? (
      <InstallButton install={adapter} installed={false} />
    ) : reasons.some(
        (reason) => reason === "hook_missing" || reason === "skill_missing",
      ) && hooked ? (
      regenerateButton
    ) : null;

  const history = historyValue(t, agent.history);

  return (
    <SettingsGroup title={agent.label}>
      <SettingsRow label={t("integration.row.cli")}>
        <RowValue title={agent.resolvedPath ?? undefined}>{cliValue}</RowValue>
        {cliAction}
      </SettingsRow>
      {acpValue !== null && (
        <SettingsRow label={t("integration.row.acp")}>
          <RowValue title={acp?.program}>{acpValue}</RowValue>
          {acpAction}
        </SettingsRow>
      )}
      <InstallFailure agent={agent} jobs={[cli, adapter]} />
      {hooked && (
        <SettingsRow label={t("integration.row.injection")}>
          {integration ? (
            <>
              {injectionProblem && (
                <RowValue title={integration.hook.path ?? undefined}>
                  {injectionProblem}
                </RowValue>
              )}
              {!injectionProblem && limited && (
                <RowValue title={limited}>
                  {t("integration.state.limited")}
                </RowValue>
              )}
            </>
          ) : (
            <Skeleton className="h-4 w-16" />
          )}
          {regenerateButton}
          {legacy.length > 0 && (
            <RepairButton
              findings={legacy}
              busy={busy}
              onRepair={() => repair.mutate()}
            />
          )}
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
          {spawnFix}
        </SettingsRow>
      )}
      {history !== null && (
        <SettingsRow label={t("integration.row.history")}>
          <RowValue>{history}</RowValue>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

/**
 * 升级时清掉旧全局安装是一次性事件：第一次看到时一条提示，记进
 * `localStorage`，之后不再说（设计 §1.2）。备份路径在提示的描述里。
 */
function useMigrationNotice(
  agent: AgentInfo,
  integration: AgentIntegration | null,
) {
  const t = useT();
  const migration = integration?.migration;
  const sessionTrust = migration?.sessionTrust;
  const removed =
    (migration?.removed.length ?? 0) + (sessionTrust?.removed.length ?? 0);
  const stamp = migration
    ? `${migration.migratedAt}|${sessionTrust?.at ?? ""}`
    : null;
  React.useEffect(() => {
    if (stamp === null || removed === 0) return;
    const key = `armadra.integration.migrated.${agent.id}`;
    try {
      if (window.localStorage.getItem(key) === stamp) return;
      window.localStorage.setItem(key, stamp);
    } catch {
      return;
    }
    const backups = [
      ...(migration?.backups ?? []),
      ...(sessionTrust?.backup ? [sessionTrust.backup] : []),
    ];
    toast.success(t("integration.migrated.notice", { name: agent.label }), {
      ...(backups.length > 0 ? { description: backups.join("\n") } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, removed, agent.id]);
}

/**
 * 「清理旧版 N」：本产品旧版本留在 CLI 配置里的条目（core 只报带我们签名的），
 * 点开是按文件分组的清单，看过再按清单底下的「清理」。
 *
 * 残留不放进行脚注：一条就是一整段 shell 命令，同一条命令在每个 Hook 事件下
 * 各挂一次，十几条拼成一段会把整行撑到几屏高。这里同一文件里相同的条目只
 * 列一次并标出次数，命令超过两行就截断，完整内容在悬停提示里。
 */
function RepairButton({
  findings,
  busy,
  onRepair,
}: {
  findings: LegacyIntegrationFinding[];
  busy: boolean;
  onRepair: () => void;
}) {
  const t = useT();
  const groups = groupFindings(findings);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          type="button"
          className="text-[var(--danger-text)]"
        >
          {t("integration.action.repair", { count: findings.length })}
        </Button>
      </PopoverTrigger>
      {/* 设置对话框在 --z-dialog 上，弹层与它同层、后挂载，才不会被盖住。 */}
      <PopoverContent
        align="end"
        className="z-[var(--z-dialog)] w-[28rem] max-w-[90vw] p-0"
      >
        <ScrollArea className="max-h-80">
          <div className="flex flex-col gap-3 p-3">
            {groups.map((group) => (
              <section key={group.path} className="flex min-w-0 flex-col gap-1">
                <span
                  className="truncate text-xs font-medium text-foreground"
                  title={group.path}
                >
                  {shortenHome(group.path)}
                </span>
                <ul className="flex flex-col gap-1">
                  {group.entries.map((entry) => (
                    <li
                      key={entry.detail}
                      className="flex min-w-0 items-start gap-2"
                    >
                      <code
                        className="line-clamp-2 min-w-0 flex-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-4 break-all text-muted-foreground"
                        title={entry.detail}
                      >
                        {shortenHome(entry.detail)}
                      </code>
                      {entry.count > 1 && (
                        <span className="shrink-0 text-[11px] leading-5 text-muted-foreground tabular-nums">
                          ×{entry.count}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </ScrollArea>
        <div className="flex justify-end border-t border-border p-2">
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={onRepair}
          >
            {t("integration.repair")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface FindingGroup {
  path: string;
  entries: { detail: string; count: number }[];
}

/** 按文件分组、同一文件里相同的条目合并计数；顺序保持 core 给的顺序。 */
function groupFindings(
  findings: readonly LegacyIntegrationFinding[],
): FindingGroup[] {
  const groups = new Map<string, Map<string, number>>();
  for (const { path, detail } of findings) {
    const entries = groups.get(path) ?? new Map<string, number>();
    entries.set(detail, (entries.get(detail) ?? 0) + 1);
    groups.set(path, entries);
  }
  return [...groups].map(([path, entries]) => ({
    path,
    entries: [...entries].map(([detail, count]) => ({ detail, count })),
  }));
}

/** 用户主目录写成 `~`：绝对路径的前缀每条都一样，只占宽度。 */
function shortenHome(text: string): string {
  return text
    .replace(/(^|[\s'"(=])\/(?:Users|home)\/[^/\s'"]+(?=\/)/g, "$1~")
    .replace(/(^|[\s'"(=])[A-Za-z]:\\Users\\[^\\\s'"]+(?=\\)/g, "$1~");
}
