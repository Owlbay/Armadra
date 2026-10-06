import { Folder } from "lucide-react";

import type { WorkspaceSummary } from "@armadra/shared";

import { useT } from "../app/preferences-store";
import { useOpenWorkspace } from "../app/workspace-actions";
import { useWorkspaces } from "../app/workspaces-query";
import { sourcePill } from "../panels/settings/source-status";
import {
  type SourceConnection,
  useCurrentSource,
  useSourceRegistry,
  useSourceStatus,
  useSources,
} from "../sources";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import { TONE_COLOR } from "@/ui/status-pill";

/**
 * 侧栏按源分组（客户端包 §3.3）：当前源的工作空间在上面的「项目」里（树本身），
 * 其余每个源各一组跟在后面——组头是源的名字加状态点，离线与失权的组灰显；
 * 就绪的源列出它的工作空间（`useWorkspaces()`，每个就绪源一次查询），点一行
 * 就切到那个源再打开它。零配置时只有本机，这里什么也不画。
 */
export function SourceGroups() {
  const sources = useSources();
  // 零配置不挂分组，也就不多发一次工作空间查询。
  if (sources.length < 2) return null;
  return <Groups sources={sources} />;
}

function Groups({ sources }: { sources: readonly SourceConnection[] }) {
  const current = useCurrentSource();
  const workspaces = useWorkspaces();
  const others = sources.filter(
    (source) => source.descriptor.sourceId !== current.descriptor.sourceId,
  );
  return (
    <>
      {others.map((source) => (
        <SourceGroup
          key={source.descriptor.sourceId}
          source={source}
          workspaces={workspaces.data
            .filter((one) => one.sourceId === source.descriptor.sourceId)
            .map((one) => one.workspace)}
        />
      ))}
    </>
  );
}

function SourceGroup({
  source,
  workspaces,
}: {
  source: SourceConnection;
  workspaces: readonly WorkspaceSummary[];
}) {
  const t = useT();
  const status = useSourceStatus(source);
  const openWorkspace = useOpenWorkspace();
  const registry = useSourceRegistry();
  const local = source.descriptor.kind === "local";
  const state = local ? "ready" : status.state;
  const pill = sourcePill(state);
  const sourceId = source.descriptor.sourceId;
  const label = local
    ? t("remote.kind.local")
    : source.descriptor.label || sourceId;
  const dimmed = state !== "ready" && state !== "connecting";
  return (
    <section
      aria-label={label}
      data-source-group={sourceId}
      data-state={state}
      className={cn("mt-2", dimmed && "opacity-60")}
    >
      <div className="flex h-7 items-center gap-2 px-1.5" title={t(pill.key)}>
        <ColorDot color={TONE_COLOR[pill.tone]} size={6} />
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-caption)] font-medium tracking-[.04em] text-muted-foreground uppercase">
          {label}
        </h2>
        <span className="sr-only">{t(pill.key)}</span>
      </div>
      {state === "ready" && workspaces.length > 0 && (
        <ul>
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-source-workspace={workspace.id}
                className="h-7 w-full justify-start gap-2 px-1.5 font-normal"
                onClick={() => {
                  // 先切当前源：打开、事件流与不带源前缀的查询都跟着它走。
                  registry.setCurrent(sourceId);
                  openWorkspace(workspace as never, sourceId);
                }}
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{workspace.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
