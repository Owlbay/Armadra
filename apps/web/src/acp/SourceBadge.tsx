import type { ContentSource } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { formatRelativeTime } from "@/lib/format";
import { gotoNode } from "@/sidebar/goto-node";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";

/**
 * 输出到画板的对象上那枚「来自 · 节点名」（设计系统 §4 来源链接，ACP 设计 §7）。
 *
 * 只是显示与跳回：点一下回到来源 Agent 节点。来源节点已经不在这块画布上
 * 时不画——一个点了没反应的徽标比没有更糟。悬停给出时间。
 */
export function SourceBadge({
  source,
  at,
  className,
}: {
  source: ContentSource;
  /** 输出的时间（新对象的创建时间）。 */
  at?: string | undefined;
  className?: string;
}) {
  const t = useT();
  const boardId = useCanvasStore((state) => state.document?.board.id ?? null);
  const title = useCanvasStore(
    (state) =>
      state.document?.nodes.find((node) => node.id === source.nodeId)?.title ??
      null,
  );
  if (!boardId || title === null) return null;
  const when = at ? formatRelativeTime(at) : "";
  return (
    <Badge
      asChild
      variant="outline"
      className={
        className ??
        "h-[18px] max-w-40 px-1.5 text-[length:var(--text-caption)] font-normal text-muted-foreground"
      }
      data-no-drag="true"
    >
      <Button
        variant="ghost"
        size="xs"
        type="button"
        data-slot="content-source"
        aria-label={t("acp.source.goto", { name: title })}
        title={when ? `${title} · ${when}` : title}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          gotoNode(boardId, source.nodeId);
        }}
      >
        <span className="truncate">
          {t("acp.source.from", { name: title })}
        </span>
      </Button>
    </Badge>
  );
}
