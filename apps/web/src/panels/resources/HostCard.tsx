/**
 * 主机总览卡（T02，终端宿主设计 §8「Host」行）。
 *
 * 每格都可能是短横线：这台机器答不出来的指标就是答不出来，不折成 0。
 * 「已用比例」与「内存压力」是两码事，这里只给比例，不下压力结论。
 */
import type { HostResources } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import {
  UNKNOWN,
  diskUsedPercent,
  formatLoad,
  formatMetricBytes,
  formatPercent,
  formatUptime,
  memoryUsedPercent,
} from "./metrics";

export function HostCard({
  host,
  name,
}: {
  host: HostResources;
  /** 远端主机的名字；本机不需要。 */
  name?: string;
}) {
  const t = useT();
  const uptime = formatUptime(host.uptimeSeconds, {
    day: t("resources.unit.day"),
    hour: t("resources.unit.hour"),
    minute: t("resources.unit.minute"),
  });

  const cores =
    typeof host.cpuCores === "number"
      ? t("resources.host.cores", { count: host.cpuCores })
      : UNKNOWN;

  const swap =
    typeof host.memory.swapTotalBytes === "number"
      ? `${formatMetricBytes(host.memory.swapUsedBytes)} / ${formatMetricBytes(
          host.memory.swapTotalBytes,
        )}`
      : UNKNOWN;

  const load = host.loadAverage
    ? `${formatLoad(host.loadAverage.one)} · ${formatLoad(
        host.loadAverage.five,
      )} · ${formatLoad(host.loadAverage.fifteen)}`
    : UNKNOWN;

  const disk = host.disk
    ? `${formatMetricBytes(host.disk.availableBytes)} / ${formatMetricBytes(
        host.disk.totalBytes,
      )}`
    : UNKNOWN;

  return (
    <section className="rounded-[var(--r-card)] border border-border p-3">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold">{t("resources.host")}</h3>
        {/* 测量来源必须一直显示：控制机的内存不能代表 SSH 主机（设计 §8）。 */}
        <Badge variant="outline" className="font-mono text-[11px]">
          {host.platform}
        </Badge>
        <Badge variant="ghost" className="text-[11px]">
          {t(`resources.location.${host.location}`)}
        </Badge>
        {name !== undefined && (
          <Badge variant="secondary" className="max-w-40 truncate text-[11px]">
            {name}
          </Badge>
        )}
        <div className="flex-1" />
        <PowerBadge host={host} />
      </header>

      {/*
        两列而不是按视口切到三列：抽屉固定是窄的，`sm:` 看的是窗口宽度，桌面窗口
        一定满足，结果每格只剩一百来像素，「99% 326 MB / …」这类值全被截掉。
      */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
        <Metric
          label={t("resources.host.cpu")}
          value={formatPercent(host.cpuPercent)}
          hint={cores}
        />
        <Metric
          label={t("resources.host.memory")}
          value={formatPercent(memoryUsedPercent(host))}
          hint={`${formatMetricBytes(
            host.memory.availableBytes,
          )} / ${formatMetricBytes(host.memory.totalBytes)}`}
        />
        {/*
          压力是系统自己的判断，不是从已用比例推出来的——可回收缓存也算「已用」，
          一台 95% 的机器常常毫无压力。读不到就是「未知」，不是「正常」。
        */}
        <Metric
          slot="memory-pressure"
          label={t("resources.host.pressure")}
          value={t(`resources.pressure.${host.memory.pressure ?? "unknown"}`)}
          title={t("resources.pressure.hint")}
        />
        <Metric label={t("resources.host.swap")} value={swap} />
        <Metric label={t("resources.host.load")} value={load} />
        <Metric
          label={t("resources.host.disk")}
          value={formatPercent(diskUsedPercent(host))}
          hint={host.disk ? disk : undefined}
          // 挂载点可能是一长串临时目录，折行会把卡片撑高四五行；放进悬停提示。
          title={host.disk?.mountPoint}
        />
        <Metric label={t("resources.host.uptime")} value={uptime} />
      </dl>
    </section>
  );
}

/** 电源。桌面机没有电池，那时只有 `ac` 而没有百分比——和「读不出来」不同。 */
function PowerBadge({ host }: { host: HostResources }) {
  const t = useT();
  const { source, batteryPercent, charging } = host.power;
  if (source === null && batteryPercent === null) {
    return (
      <span className="text-[11px] text-muted-foreground">
        {t("resources.host.powerUnknown")}
      </span>
    );
  }
  const parts = [
    source ? t(`resources.power.${source}`) : null,
    typeof batteryPercent === "number" ? formatPercent(batteryPercent) : null,
    charging === true ? t("resources.power.charging") : null,
  ].filter((part): part is string => part !== null);
  return (
    <Badge variant="ghost" className="text-[11px] tabular-nums">
      {parts.join(" · ")}
    </Badge>
  );
}

function Metric({
  label,
  value,
  hint,
  title,
  slot,
}: {
  label: string;
  value: string;
  hint?: string;
  /** Long-form explanation, shown on hover; the cell stays one short value. */
  title?: string;
  slot?: string;
}) {
  return (
    <div className="min-w-0" data-slot={slot} title={title}>
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className="tabular-nums [overflow-wrap:anywhere]">{value}</dd>
      {/* 补充说明另起一行、可以折行：和值挤在一行时被截掉的总是它。 */}
      {hint ? (
        <dd className="text-[11px] text-muted-foreground tabular-nums [overflow-wrap:anywhere]">
          {hint}
        </dd>
      ) : null}
    </div>
  );
}
