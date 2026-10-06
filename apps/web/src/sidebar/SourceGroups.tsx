import { useT } from "../app/preferences-store";
import { sourcePill } from "../panels/settings/source-status";
import { type SourceConnection, useSourceStatus, useSources } from "../sources";
import { cn } from "@/lib/cn";
import { ColorDot } from "@/ui/color-dot";
import { TONE_COLOR } from "@/ui/status-pill";

/**
 * 侧栏按源分组（客户端包 §3.3）：本机那一组（「项目」）永远在最前，挂载的源
 * 各一组跟在后面——组头是源的名字加状态点，离线与失权的组灰显。组里的工作
 * 空间随查询键加源（A1-2）接上；零配置时只有本机，这里什么也不画。
 */
export function SourceGroups() {
  const sources = useSources();
  const remote = sources.filter((source) => source.descriptor.kind !== "local");
  if (remote.length === 0) return null;
  return (
    <>
      {remote.map((source) => (
        <SourceGroup key={source.descriptor.sourceId} source={source} />
      ))}
    </>
  );
}

function SourceGroup({ source }: { source: SourceConnection }) {
  const t = useT();
  const status = useSourceStatus(source);
  const pill = sourcePill(status.state);
  const label = source.descriptor.label || source.descriptor.sourceId;
  const dimmed = status.state !== "ready" && status.state !== "connecting";
  return (
    <section
      aria-label={label}
      data-source-group={source.descriptor.sourceId}
      data-state={status.state}
      className={cn("mt-2", dimmed && "opacity-60")}
    >
      <div className="flex h-7 items-center gap-2 px-1.5" title={t(pill.key)}>
        <ColorDot color={TONE_COLOR[pill.tone]} size={6} />
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-caption)] font-medium tracking-[.04em] text-muted-foreground uppercase">
          {label}
        </h2>
        <span className="sr-only">{t(pill.key)}</span>
      </div>
    </section>
  );
}
