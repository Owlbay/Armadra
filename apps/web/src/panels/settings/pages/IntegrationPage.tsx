import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Wrench } from "lucide-react";
import { toast } from "sonner";
import type {
  AgentHistory,
  AgentInfo,
  HistoryState,
  LegacyIntegrationFinding,
} from "@armadra/shared";

import { runtimeApi } from "../../../api/client";
import { useAgentsQuery } from "../../../app/use-agents";
import { useT, type Translate } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { ScrollArea } from "@/ui/scroll-area";
import type { IntegrationRepairReport } from "./integration/types";
import {
  useAgentIntegration,
  useIntegrationRefresh,
} from "./integration/use-integration";

/**
 * 设置 → 集成（[画布内注入](../../../../../docs/design/canvas-only-integration.md) §5）。
 *
 * Hook、技能与画布说明只在从画布启动 CLI 时交给它：产物生成在应用数据目录
 * 里，由启动行与节点终端的环境带过去，画布外启动的 CLI 什么都看不到。所以
 * 这里不再有「安装 / 卸载」——每种 CLI 一行，回答四件事（启动器见
 * [画布启动器](../../../../../docs/design/canvas-launcher.md) §8.2）：
 *
 *  1. **注入方式**——画布内注入。
 *  2. **Hook / 技能**——注入产物是不是当前版本。唯一的动作是「重新生成」，
 *     平时不用点：每次从画布启动都会先确保它们是最新的。
 *  3. **启动器警告**——画布内启动少带了东西（Windows 没有启动器、Codex 太旧
 *     不带 Hook）；原因在悬停提示里。数据目录之外不写任何文件，所以不再有
 *     「信任记录写在…」。
 *  4. **迁移与旧残留**——升级时清掉的旧全局安装（备份在哪），以及更早的产品
 *     名留下的条目与「修复」。
 *
 * 页首另有一组「Worker 待升级」的执行主机（契约 §21.2，集成状态的
 * `outdatedHosts`）：那些主机上 SSH 终端里的画布启动带的是旧注入，每台一个
 * 「重新同步」。各 CLI 的集成状态给的是同一份主机表，所以只画一次。
 */
export function IntegrationPage() {
  const t = useT();
  const agents = useAgentsQuery();
  const list = agents.data ?? [];

  return (
    <>
      {list[0] && <OutdatedWorkers agent={list[0]} />}
      <SettingsGroup>
        {list.map((agent) => (
          <AgentIntegrationRow key={agent.id} agent={agent} />
        ))}
        {/* 一行都没有时整页是空白的——没有 CLI 与还没读完看起来一模一样。 */}
        {list.length === 0 && (
          <SettingsRow
            label={t(
              agents.isPending ? "integration.loading" : "integration.empty",
            )}
          />
        )}
      </SettingsGroup>
    </>
  );
}

/** 过旧 Worker 的执行主机，每台一行：徽标 + 「重新同步」。没有就什么都不画。 */
function OutdatedWorkers({ agent }: { agent: AgentInfo }) {
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

function AgentIntegrationRow({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const refresh = useIntegrationRefresh();
  const { integration } = useAgentIntegration(agent);

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

  // 能力位说的是「这个适配器有没有 Hook 通道」；没有的话生成什么都没有对象。
  const hooked = agent.capabilities.includes("hooks");
  const busy = regenerate.isPending || repair.isPending;
  // 第一次读还没回来：只画标签与一个「读取中」徽标，不猜任何状态。
  if (!integration) {
    return (
      <SettingsRow label={agent.label}>
        <Badge variant="outline">{t("integration.loading")}</Badge>
      </SettingsRow>
    );
  }
  const ready = integration.hook.installed;
  const legacy = integration.legacy.found;
  const sessionTrust = integration.migration?.sessionTrust;
  const migrated =
    (integration.migration?.removed.length ?? 0) +
    (sessionTrust?.removed.length ?? 0);
  const backups = [
    ...(integration.migration?.backups ?? []),
    ...(sessionTrust?.backup ? [sessionTrust.backup] : []),
  ];

  // 状态徽标放在名字下面、动作按钮留在右边：几样东西挤在一行时右侧不收缩，
  // 左列被压成一条窄缝，名字被推出视口。
  const label = (
    <span className="flex min-w-0 flex-col gap-1.5">
      <span>{agent.label}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">
          {t(`integration.mode.${integration.mode}`)}
        </Badge>

        {/* Hook 与技能各一个状态徽标：它们一起生成，但可以各自掉，而「掉了
            哪一半」正是用户要知道的事。 */}
        <Badge
          variant={ready ? "secondary" : "outline"}
          title={integration.hook.path ?? undefined}
        >
          {hooked && !agent.installed
            ? t("integration.agentMissing")
            : ready
              ? t("integration.hook.revision", {
                  value: integration.hook.revision ?? integration.revision,
                })
              : t("integration.hook.missing")}
        </Badge>
        <Badge
          variant={integration.skill.installed ? "secondary" : "outline"}
          title={integration.skill.path ?? undefined}
        >
          {integration.skill.installed
            ? t("integration.skill.revision", {
                value: integration.skill.revision ?? integration.revision,
              })
            : t("integration.skill.missing")}
        </Badge>

        {integration.launcherWarning && (
          <Badge variant="destructive" title={integration.launcherWarning}>
            {t("integration.launcherWarning")}
          </Badge>
        )}
        {migrated > 0 && (
          <Badge variant="secondary" title={backups.join("\n")}>
            {t("integration.migrated")}
          </Badge>
        )}
        {legacy.length > 0 && <LegacyBadge findings={legacy} />}
        {agent.history && <HistoryBadges history={agent.history} />}
      </span>
    </span>
  );

  return (
    <SettingsRow label={label}>
      <Button
        variant="secondary"
        size="sm"
        disabled={!hooked || busy}
        onClick={() => regenerate.mutate()}
      >
        {t("integration.regenerate")}
      </Button>
      {legacy.length > 0 && (
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={() => repair.mutate()}
        >
          <Wrench />
          {t("integration.repair")}
        </Button>
      )}
    </SettingsRow>
  );
}

const HISTORY_PARTS = ["index", "cost", "transcript"] as const;

const HISTORY_STATE_KEY: Record<HistoryState, string> = {
  available: "capability.state.supported",
  "not-found": "capability.state.notFound",
  unsupported: "capability.state.unsupported",
  disabled: "capability.state.disabled",
};

/**
 * 本机历史数据三项（契约 §12.2）。没有数据也写状态词，不写成 0 或留空：「没
 * 找到」和「这家不支持」是两回事。
 */
function HistoryBadges({ history }: { history: AgentHistory }) {
  const t = useT();
  return HISTORY_PARTS.map((part) => (
    <Badge
      key={part}
      variant={history[part] === "available" ? "secondary" : "outline"}
    >
      {t(`integration.history.${part}`, {
        state: t(HISTORY_STATE_KEY[history[part]]),
      })}
    </Badge>
  ));
}

/**
 * 「旧残留 N」徽标，点开是按文件分组的清单。
 *
 * 残留不放进行脚注：一条就是一整段 shell 命令，同一条命令在每个 Hook 事件下
 * 各挂一次，十几条拼成一段会把整行撑到几屏高。这里同一文件里相同的条目只
 * 列一次并标出次数，命令超过两行就截断，完整内容在悬停提示里。
 */
function LegacyBadge({ findings }: { findings: LegacyIntegrationFinding[] }) {
  const t = useT();
  const groups = groupFindings(findings);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge asChild variant="destructive">
          <Button variant="ghost" size="xs" type="button">
            {t("integration.legacy.count", { count: findings.length })}
          </Button>
        </Badge>
      </PopoverTrigger>
      {/* 设置对话框在 --z-dialog 上，弹层与它同层、后挂载，才不会被盖住。 */}
      <PopoverContent
        align="start"
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
