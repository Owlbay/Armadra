import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { memberCount } from "./model";
import { openDispatchDrawer } from "./store";

/**
 * 协调者（ama）节点头部的「N 成员」（设计系统 §5.4）：点开右侧分派抽屉。只给
 * ama 节点画；0 个成员也画——抽屉的空态就是「让 ama 组织一次分工」。
 */
export function MembersChip({ nodeId }: { nodeId: string }) {
  const t = useT();
  const count = useCanvasStore((state) =>
    state.document
      ? memberCount(nodeId, state.document.nodes, state.document.edges)
      : 0,
  );
  return (
    <Badge
      asChild
      variant="secondary"
      className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
    >
      <Button
        variant="secondary"
        size="xs"
        type="button"
        data-slot="coordinator-members-chip"
        data-no-drag="true"
        aria-haspopup="dialog"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          openDispatchDrawer(nodeId);
        }}
      >
        {t("coordinator.members", { count })}
      </Button>
    </Badge>
  );
}
