import type { ExecutionHost, ExecutionHostHealth } from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import { sshHostTarget } from "../../ssh-hosts";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/ui/item";
import { Spinner } from "@/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

export interface MachinesTableProps {
  hosts: readonly ExecutionHost[];
  /** 正在验证的那一台；`null` 是没有。 */
  validating: string | null;
  onValidate: (hostId: string) => void;
  onOpen: (hostId: string) => void;
  /** 窄屏：一台一张 `Item`，不画表格。 */
  compact?: boolean;
}

/**
 * 远程机器表（§2.6）：名称 · 地址 · Worker · 工作区数 · 「验证」。
 *
 * Worker 一列只在不正常时用徽标：过期是 `destructive`，没配置是 `outline`；
 * 正常时是版本号灰字。点名称进这台机器的子页。纯展示：数据与动作都由调用方给，
 * 展示页用假数据渲染同一个组件。
 */
export function MachinesTable({
  hosts,
  validating,
  onValidate,
  onOpen,
  compact = false,
}: MachinesTableProps) {
  const t = useT();
  const validate = (host: ExecutionHost) => (
    <Button
      size="sm"
      variant="secondary"
      disabled={validating !== null}
      onClick={() => onValidate(host.executionHostId)}
    >
      {validating === host.executionHostId && <Spinner aria-hidden />}
      {t("executionHosts.validate")}
    </Button>
  );
  const name = (host: ExecutionHost) => (
    <Button
      type="button"
      variant="link"
      className="h-auto max-w-[16rem] justify-start truncate p-0 text-[13px] font-medium text-foreground"
      onClick={() => onOpen(host.executionHostId)}
    >
      {host.name || host.executionHostId}
    </Button>
  );

  if (compact) {
    return (
      <ItemGroup className="gap-2">
        {hosts.map((host) => (
          <Item key={host.executionHostId} variant="outline" size="sm">
            <ItemContent className="min-w-0">
              <ItemTitle>{name(host)}</ItemTitle>
              <ItemDescription className="truncate">
                {[host.ssh ? sshHostTarget(host.ssh) : "", workerText(host, t)]
                  .filter(Boolean)
                  .join(" · ")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>{validate(host)}</ItemActions>
          </Item>
        ))}
      </ItemGroup>
    );
  }

  return (
    <Card className="gap-0 overflow-visible rounded-lg border border-border/70 px-2 py-0 text-[length:inherit] ring-0">
      <Table className="text-[13px]">
        <TableHeader>
          <TableRow>
            <TableHead>{t("executionHosts.column.name")}</TableHead>
            <TableHead>{t("executionHosts.column.address")}</TableHead>
            <TableHead>{t("executionHosts.column.worker")}</TableHead>
            <TableHead className="text-right">
              {t("executionHosts.column.workspaces")}
            </TableHead>
            <TableHead className="w-0">
              <span className="sr-only">{t("executionHosts.validate")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {hosts.map((host) => (
            <TableRow key={host.executionHostId}>
              <TableCell>{name(host)}</TableCell>
              <TableCell className="max-w-[16rem] truncate text-muted-foreground">
                {host.ssh ? sshHostTarget(host.ssh) : "—"}
              </TableCell>
              <TableCell>
                <WorkerCell host={host} />
              </TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">
                {host.workspaceCount}
              </TableCell>
              <TableCell className="text-right">{validate(host)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function workerText(host: ExecutionHost, t: (key: string) => string): string {
  if (!host.workerConfigured) return t("executionHosts.workerMissing");
  if (host.worker?.outdated) return t("executionHosts.worker.outdated");
  return host.worker?.version ?? "";
}

function WorkerCell({ host }: { host: ExecutionHost }) {
  const t = useT();
  if (!host.workerConfigured)
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        {t("executionHosts.workerMissing")}
      </Badge>
    );
  if (host.worker?.outdated)
    return (
      <Badge
        variant="destructive"
        className="font-normal"
        title={host.worker.version || undefined}
      >
        {t("executionHosts.worker.outdated")}
      </Badge>
    );
  return (
    <span className="text-muted-foreground tabular-nums">
      {host.worker?.version || "—"}
    </span>
  );
}

const DOT: Record<ExecutionHostHealth["event"], string> = {
  handshake: "bg-[var(--success)]",
  disconnected: "bg-[var(--warn)]",
  failed: "bg-[var(--danger)]",
};

/** 这次运行里的健康记录，新的在上（契约 §21.3）。没有记录就什么都不画。 */
export function HealthTable({
  samples,
}: {
  samples: readonly ExecutionHostHealth[];
}) {
  const t = useT();
  if (samples.length === 0) return null;
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="px-0.5 text-[13px] font-medium">
        {t("executionHosts.fleet.events")}
      </h3>
      <Card className="gap-0 overflow-visible rounded-lg border border-border/70 px-2 py-0 text-[length:inherit] ring-0">
        <Table className="text-[13px]">
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
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={cn("size-1.5 rounded-full", DOT[sample.event])}
                    />
                    {t(`executionHosts.fleet.event.${sample.event}`)}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {sample.version ??
                    (sample.code ? codeLabel(sample.code, t) : "")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </section>
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
