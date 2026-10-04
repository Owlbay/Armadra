import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
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
      className="h-[18px] cursor-pointer px-1.5 text-[length:var(--text-caption)]"
    >
      <button
        type="button"
        data-slot="coordinator-members-chip"
        aria-haspopup="dialog"
        onClick={() => openDispatchDrawer(nodeId)}
      >
        {t("coordinator.members", { count })}
      </button>
    </Badge>
  );
}
