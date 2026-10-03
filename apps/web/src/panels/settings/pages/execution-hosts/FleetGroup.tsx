import type { ExecutionHost, ExecutionHostHealth } from "@armadra/shared";
import { Activity, PlugZap, RefreshCw } from "lucide-react";

import { useT } from "../../../../app/preferences-store";
import { SettingsGroup } from "../../SettingsGroup";
import { SettingsRow } from "../../SettingsRow";
import { sshHostTarget } from "../../ssh-hosts";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Spinner } from "@/ui/spinner";
import { StatusPill } from "@/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

/**
 * 执行主机的舰队视图（契约 §21.2、§21.3，补全架构 §11「多执行主机管理」）。
 *
 * 每台主机一行：在线与否、Worker 版本（过旧时换成 destructive 徽标）、这次
 * 运行里的健康记录（最近 20 条，一格一条，点开是明细表）、重新同步与验证。
 * 有两台以上配了 Worker 的主机时，第一行是「全部重新同步」。
 *
 * 纯展示：数据与动作都由调用方给，展示页用假数据渲染同一个组件。
 */
export function FleetGroup({
  hosts,
  resyncing,
  resyncingAll,
  validating,
  onResync,
  onResyncAll,
  onValidate,
  label,
}: {
  hosts: readonly ExecutionHost[];
  /** 正在重新同步的那一台；`null` 是没有。 */
  resyncing: string | null;
  resyncingAll: boolean;
  validating: boolean;
  onResync: (hostId: string) => void;
  onResyncAll: () => void;
  onValidate: (hostId: string) => void;
  label: (host: ExecutionHost) => string;
}) {
  const t = useT();
  const syncable = hosts.filter(
    (host) => host.kind === "ssh" && host.workerConfigured,
  );
  const busy = resyncingAll || resyncing !== null;

  return (
    <SettingsGroup>
      {syncable.length > 1 && (
        <SettingsRow label={null}>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={onResyncAll}
          >
            {resyncingAll ? (
              <Spinner aria-label={t("executionHosts.resyncing")} />
            ) : (
              <RefreshCw />
            )}
            {t("executionHosts.fleet.resyncAll")}
          </Button>
        </SettingsRow>
      )}
      {hosts.map((host) => (
        <SettingsRow
          key={host.executionHostId || "local"}
          label={label(host)}
          footnote={
            host.ssh
              ? sshHostTarget(host.ssh)
              : t("executionHosts.workspaces", { count: host.workspaceCount })
          }
        >
          {host.kind === "ssh" && !host.workerConfigured && (
            <Badge variant="outline" className="font-normal">
              {t("executionHosts.workerMissing")}
            </Badge>
          )}
          {host.worker && (
            <StatusPill
              tone={host.worker.connected ? "working" : "idle"}
              pulse={false}
              label={t(
                host.worker.connected
                  ? "executionHosts.fleet.online"
                  : "executionHosts.fleet.offline",
              )}
            />
          )}
          {host.worker &&
            (host.worker.outdated ? (
              <Badge
                variant="destructive"
                className="font-normal"
                title={host.worker.version || undefined}
              >
                {t("executionHosts.worker.outdated")}
              </Badge>
            ) : (
              host.worker.version && (
                <Badge variant="secondary" className="font-normal">
                  {t("executionHosts.worker.version", {
                    version: host.worker.version,
                  })}
                </Badge>
              )
            ))}
          {host.health && host.health.length > 0 && (
            <HealthHistory samples={host.health} />
          )}
          {host.kind === "ssh" && host.workerConfigured && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onResync(host.executionHostId)}
            >
              <RefreshCw />
              {resyncing === host.executionHostId
                ? t("executionHosts.resyncing")
                : t("executionHosts.resync")}
            </Button>
          )}
          {host.kind === "ssh" && (
            <Button
              size="sm"
              variant="secondary"
              disabled={validating}
              onClick={() => onValidate(host.executionHostId)}
            >
              <PlugZap />
              {validating
                ? t("executionHosts.validating")
                : t("executionHosts.validate")}
            </Button>
          )}
        </SettingsRow>
      ))}
      {hosts.length <= 1 && <SettingsRow label={t("executionHosts.empty")} />}
    </SettingsGroup>
  );
}

const DOT: Record<ExecutionHostHealth["event"], string> = {
  handshake: "bg-[var(--success)]",
  disconnected: "bg-[var(--warn)]",
  failed: "bg-[var(--danger)]",
};

/** 一格一条健康记录，旧的在左；点开是明细（新的在上）。 */
function HealthHistory({
  samples,
}: {
  samples: readonly ExecutionHostHealth[];
}) {
  const t = useT();
  const failures = samples.filter((sample) => !sample.ok).length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("executionHosts.fleet.health", {
            failed: failures,
            total: samples.length,
          })}
          className="gap-1.5 px-2"
        >
          <Activity className="text-muted-foreground" />
          <span className="flex items-center gap-0.5" aria-hidden>
            {samples.map((sample, index) => (
              <span
                key={`${sample.at}-${index}`}
                className={cn("h-3 w-1 rounded-full", DOT[sample.event])}
              />
            ))}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("executionHosts.fleet.at")}</TableHead>
              <TableHead>{t("executionHosts.fleet.event")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...samples].reverse().map((sample, index) => (
              <TableRow key={`${sample.at}-${index}`}>
                <TableCell className="tabular-nums text-muted-foreground">
                  {formatTime(sample.at)}
                </TableCell>
                <TableCell>
                  {t(`executionHosts.fleet.event.${sample.event}`)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {sample.version ??
                    (sample.code ? codeLabel(sample.code, t) : "")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </PopoverContent>
    </Popover>
  );
}

/** 验证的 `reason` 有现成译文；重新同步的错误码原样显示。 */
function codeLabel(code: string, t: (key: string) => string): string {
  const key = `executionHosts.${code}`;
  const text = t(key);
  return text === key ? code : text;
}

function formatTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleTimeString(undefined, { hour12: false });
}
