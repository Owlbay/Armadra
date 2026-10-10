import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  AgentHistory,
  AgentInfo,
  CanvasAgents,
  HistoryState,
  LegacyIntegrationFinding,
} from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useT, type Translate } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { ScrollArea } from "@/ui/scroll-area";
import type { AgentIntegration, IntegrationRepairReport } from "./types";
import { useIntegrationRefresh } from "./use-integration";

/**
 * Agent CLI 主表与子页共用的几样：行右侧的值、两行的取值规则、「清理旧版」
 * 弹层、重新生成与清理两个动作、一次性的迁移提示。
 */

/** `on` 持续 `ms` 之后才答真：短的读取不闪一下骨架（设计系统 §3.2）。 */
export function useDelayed(on: boolean, ms: number): boolean {
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

/** 一行右侧的值：13px 灰字，不是徽标。 */
export function RowValue({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span title={title} className="text-[13px] text-muted-foreground">
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

/** 「在画布中创建 Agent」的取值（契约 §48）；旧 core 不带时答 `null`。 */
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
 * 「Mods」一行（契约 §57.5，设计 claude-mods.md §4.4）：门开着就是「已启用」，
 * 有会话报到时带个数；关着说「未启用」，原因放进 `title`。`fallback` 是有会话
 * 的上报退回了 `armadra-hook` 进程（宿主拒绝了 mod 的请求）。只说本产品自己的
 * mod，不列别的插件，也不列 MCP 工具名。旧 core 不带 `mods` 时答 `null`。
 */
export function modsValue(
  t: Translate,
  mods: AgentIntegration["mods"],
): { value: string; reason?: string; fallback: boolean } | null {
  if (!mods) return null;
  const sessions = mods.sessions.length;
  if (mods.gate === "enabled") {
    return {
      value:
        sessions === 0
          ? t("integration.mods.on")
          : t(
              sessions === 1
                ? "integration.mods.onSession"
                : "integration.mods.onSessions",
              { n: sessions },
            ),
      fallback: mods.sessions.some(
        (session) => session.transport === "process",
      ),
    };
  }
  return {
    value: t("integration.mods.off"),
    ...(mods.reason
      ? {
          reason: t(`integration.mods.reason.${mods.reason}`, {
            version: mods.probedVersion ?? "",
            min: mods.minVersion,
          }),
        }
      : {}),
    fallback: false,
  };
}

/** 画布注入哪里不对；没问题答 `null`。只看数据目录里的产物。 */
export function injectionProblem(
  t: Translate,
  integration: AgentIntegration | null,
): string | null {
  if (!integration) return null;
  const hookMissing = !integration.hook.installed;
  const skillMissing = !integration.skill.installed;
  if (hookMissing && skillMissing) return t("integration.state.notGenerated");
  if (hookMissing) return t("integration.state.hookMissing");
  if (skillMissing) return t("integration.state.skillMissing");
  if (integration.stale) return t("integration.state.stale");
  return null;
}

/** 「清理」之后把 found / removed / kept / backup 四段原样报给用户。 */
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

/** 重新生成注入产物与清理旧版两个动作：主表的「更新」和子页共用。 */
export function useIntegrationActions(agent: AgentInfo) {
  const t = useT();
  const refresh = useIntegrationRefresh();
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
  return {
    regenerate,
    repair,
    busy: regenerate.isPending || repair.isPending,
  };
}

/**
 * 升级时清掉本产品旧安装是一次性事件：第一次看到时一条提示，记进
 * `localStorage`，之后不再说。备份路径在提示的描述里。
 */
export function useMigrationNotice(
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
 * 「清理旧版 N」：本产品旧版本留下的条目（core 只报带我们签名的），点开是按
 * 文件分组的清单，看过再按清单底下的「清理」。
 *
 * 同一文件里相同的条目只列一次并标出次数，命令超过两行就截断，完整内容在
 * 悬停提示里。
 */
export function CleanupButton({
  findings,
  busy,
  onCleanup,
}: {
  findings: readonly LegacyIntegrationFinding[];
  busy: boolean;
  onCleanup: () => void;
}) {
  const t = useT();
  const groups = groupFindings(findings);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" type="button">
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
            onClick={onCleanup}
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
