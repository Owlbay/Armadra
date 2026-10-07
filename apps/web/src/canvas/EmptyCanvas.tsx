import { Plus, Terminal } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { useEnabledAgents } from "@/app/use-agents";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { ADD_MENU_CONTENT_CLASS, AddMenuContent } from "./menus/AddMenuContent";
import { buildAddMenu } from "./menus/add-menu";
import { currentViewportCenter } from "./placement";

/**
 * 空画布的起点：画布上既没有节点也没有白板对象时，在正中给两个动作——
 * 「新建终端」与完整的新建菜单（与 Dock 的 `+` 同一份 `AddMenuContent`）。
 * 「新建终端」直接跑菜单里那一项，落点与相机跟随和从菜单点完全一样。
 * 不写说明文字（界面约定：只放动作）；放下第一个东西它就消失。
 */
export function EmptyCanvas() {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const addNode = useCanvasStore((state) => state.addNode);
  const empty = useCanvasStore(
    (state) =>
      state.document !== null &&
      state.document.nodes.length === 0 &&
      state.whiteboard.items.length === 0,
  );
  const agents = useEnabledAgents();

  if (!workspace || !empty) return null;

  return (
    <div
      data-slot="empty-canvas"
      className="pointer-events-none absolute inset-0 z-[var(--z-pills)] grid place-items-center"
    >
      <div className="pointer-events-auto flex items-center gap-2">
        <Button
          onClick={() =>
            buildAddMenu(agents, t)
              .find((item) => item.id === "add.terminal")
              ?.run({
                addNode,
                position: currentViewportCenter(),
                workspace,
                agents,
              })
          }
        >
          <Terminal data-icon="inline-start" />
          {t("add.terminal")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              <Plus data-icon="inline-start" />
              {t("dock.add")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="center"
            className={cn("z-[var(--z-menu)]", ADD_MENU_CONTENT_CLASS)}
          >
            <AddMenuContent
              kind="dropdown"
              ctx={{
                addNode,
                position: currentViewportCenter(),
                workspace,
                agents,
              }}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
