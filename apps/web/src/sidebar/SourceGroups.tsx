import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Folder } from "lucide-react";
import { toast } from "sonner";

import type { WorkspaceSummary } from "@armadra/shared";

import { reorderSources } from "../api/remote-services";
import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import { useT } from "../app/preferences-store";
import { isDesktop } from "../platform";
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
 *
 * 挂载的源按组头拖动排序（桌面壳与服务器壳的页面，源表在本机 core）：新顺序
 * 写回 `sources.update.orderIndex`。写回期间与之后侧栏先按新顺序画，不为此
 * 重连各源；源表下次读到时（启动、设置页）编号就是新的。
 */
export function SourceGroups() {
  const sources = useSources();
  // 零配置不挂分组，也就不多发一次工作空间查询。
  if (sources.length < 2) return null;
  return <Groups sources={sources} />;
}

/** 源表在本机 core 里、能写回顺序的页面（同 `sources/bootstrap.ts` 的判断）。 */
function canReorder(): boolean {
  return isDesktop() || RUNTIME_VIA_SERVER_SHELL;
}

/** 拖动定下的顺序先盖在源表的顺序上：认得的按它排，其余按原顺序跟在后面。 */
export function applyOrder(
  sources: readonly SourceConnection[],
  order: readonly string[] | null,
): SourceConnection[] {
  if (order === null) return [...sources];
  const rank = new Map(order.map((sourceId, index) => [sourceId, index]));
  return sources
    .map((source, index) => ({ source, index }))
    .sort(
      (a, b) =>
        (rank.get(a.source.descriptor.sourceId) ?? order.length + a.index) -
        (rank.get(b.source.descriptor.sourceId) ?? order.length + b.index),
    )
    .map((entry) => entry.source);
}

function Groups({ sources }: { sources: readonly SourceConnection[] }) {
  const t = useT();
  const client = useQueryClient();
  const current = useCurrentSource();
  const workspaces = useWorkspaces();
  const [order, setOrder] = React.useState<readonly string[] | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const others = sources.filter(
    (source) => source.descriptor.sourceId !== current.descriptor.sourceId,
  );
  // 本机（当前源是别的源时它也在这里）总在最前，不参与排序。
  const fixed = others.filter((source) => source.descriptor.kind === "local");
  const movable = applyOrder(
    others.filter((source) => source.descriptor.kind !== "local"),
    order,
  );
  const sortable = canReorder() && movable.length > 1;
  const workspacesOf = (source: SourceConnection) =>
    workspaces.data
      .filter((one) => one.sourceId === source.descriptor.sourceId)
      .map((one) => one.workspace);

  const onDragEnd = (event: DragEndEvent) => {
    const over = event.over;
    if (!over || event.active.id === over.id) return;
    const ids = movable.map((source) => source.descriptor.sourceId);
    const next = arrayMove(
      ids,
      ids.indexOf(String(event.active.id)),
      ids.indexOf(String(over.id)),
    );
    setOrder(next);
    // 当前源不在侧栏的分组里：它留在源表里原来的位置，其余按新顺序填进去。
    const queue = [...next];
    const all = sources
      .filter((source) => source.descriptor.kind !== "local")
      .map((source) =>
        source.descriptor.sourceId === current.descriptor.sourceId
          ? source.descriptor.sourceId
          : (queue.shift() ?? source.descriptor.sourceId),
      );
    void reorderSources(all).then(
      () => client.invalidateQueries({ queryKey: ["sources"] }),
      (error: Error) => {
        setOrder(null);
        toast.error(error.message);
      },
    );
  };

  return (
    <>
      {fixed.map((source) => (
        <SourceGroup
          key={source.descriptor.sourceId}
          source={source}
          workspaces={workspacesOf(source)}
        />
      ))}
      {sortable ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={movable.map((source) => source.descriptor.sourceId)}
            strategy={verticalListSortingStrategy}
          >
            {movable.map((source) => (
              <SortableSourceGroup
                key={source.descriptor.sourceId}
                source={source}
                workspaces={workspacesOf(source)}
                reorderLabel={(name) => t("remote.sources.reorder", { name })}
              />
            ))}
          </SortableContext>
        </DndContext>
      ) : (
        movable.map((source) => (
          <SourceGroup
            key={source.descriptor.sourceId}
            source={source}
            workspaces={workspacesOf(source)}
          />
        ))
      )}
    </>
  );
}

function SortableSourceGroup({
  source,
  workspaces,
  reorderLabel,
}: {
  source: SourceConnection;
  workspaces: readonly WorkspaceSummary[];
  reorderLabel(name: string): string;
}) {
  const sortable = useSortable({ id: source.descriptor.sourceId });
  return (
    <SourceGroup
      source={source}
      workspaces={workspaces}
      sortable={{
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Transform.toString(sortable.transform),
          transition: sortable.transition,
          zIndex: sortable.isDragging ? 1 : undefined,
        },
        handle: { ...sortable.attributes, ...sortable.listeners },
        label: reorderLabel,
        dragging: sortable.isDragging,
      }}
    />
  );
}

interface SortableProps {
  readonly ref: (node: HTMLElement | null) => void;
  readonly style: React.CSSProperties;
  readonly handle: React.HTMLAttributes<HTMLDivElement>;
  readonly label: (name: string) => string;
  readonly dragging: boolean;
}

function SourceGroup({
  source,
  workspaces,
  sortable,
}: {
  source: SourceConnection;
  workspaces: readonly WorkspaceSummary[];
  sortable?: SortableProps;
}) {
  const t = useT();
  const status = useSourceStatus(source);
  const openWorkspace = useOpenWorkspace();
  const registry = useSourceRegistry();
  const local = source.descriptor.kind === "local";
  const state = local ? "ready" : status.state;
  const pill = sourcePill(state);
  const sourceId = source.descriptor.sourceId;
  const label =
    source.descriptor.label || (local ? t("remote.kind.local") : sourceId);
  const dimmed = state !== "ready" && state !== "connecting";
  return (
    <section
      ref={sortable?.ref}
      style={sortable?.style}
      aria-label={label}
      data-source-group={sourceId}
      data-state={state}
      data-dragging={sortable?.dragging || undefined}
      className={cn(
        "relative mt-2",
        dimmed && "opacity-60",
        sortable?.dragging && "rounded-md bg-sidebar shadow-sm",
      )}
    >
      <div
        {...sortable?.handle}
        aria-label={sortable ? sortable.label(label) : undefined}
        className={cn(
          "flex h-7 items-center gap-2 rounded-md px-1.5",
          sortable &&
            "cursor-grab touch-none outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing",
        )}
        title={t(pill.key)}
      >
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
