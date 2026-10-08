import * as React from "react";
import type { FinalConnectionState } from "@xyflow/react";
import type { BoardDocument, Position } from "@armadra/shared";

import { useEnabledAgents } from "@/app/use-agents";
import { useCanvasStore } from "@/store/canvas-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { displayNameOf } from "../supervision";
import {
  ADD_MENU_CONTENT_CLASS,
  AddMenuContent,
} from "../menus/AddMenuContent";
import { getFlow } from "./flow-context";

/**
 * 拖线建从（ui-wave2 §6.3）：从 Agent 节点的把手拖到**空白处**松手，在落点
 * 弹出新建菜单的「派发」形态——只列各 Agent、顶上一行「派发自 @名字」，选中
 * 就在落点建一个从并连上主从边。Esc 或点空白关闭，什么都不建。
 *
 * 只对 Agent 终端起笔的线生效：从便签、文件等拖到空白处仍然是「取消」。
 */

export interface SpawnDrop {
  nodeId: string;
  name: string;
  agentId: string;
  /** 菜单贴着的屏幕点。 */
  client: Position;
  /** 新节点的中心（画布坐标）。 */
  position: Position;
}

/** 松手的屏幕坐标；触屏取最后一个离开的手指。 */
function clientPoint(event: MouseEvent | TouchEvent): Position | null {
  if ("changedTouches" in event) {
    const touch = event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return { x: event.clientX, y: event.clientY };
}

/**
 * 这次松手要不要弹派发菜单：落在空白处（没有落到节点上、也没连成）、起点是
 * Agent 终端。纯函数，拿得到的话返回起点的 id、名字与 Agent。
 */
export function spawnSourceOf(
  connection: Pick<FinalConnectionState, "isValid" | "toNode" | "fromNode">,
  document: Pick<BoardDocument, "nodes"> | null | undefined,
): { nodeId: string; name: string; agentId: string } | null {
  if (connection.isValid || connection.toNode) return null;
  const id = connection.fromNode?.id;
  if (!id) return null;
  const node = document?.nodes.find((entry) => entry.id === id);
  if (!node || node.data.kind !== "terminal") return null;
  const agentId = node.data.agent?.id;
  if (!agentId) return null;
  return { nodeId: node.id, name: displayNameOf(node, node.title), agentId };
}

export function useConnectEndSpawn(): {
  onConnectEnd: (
    event: MouseEvent | TouchEvent,
    connection: FinalConnectionState,
  ) => void;
  menu: React.ReactNode;
} {
  const [drop, setDrop] = React.useState<SpawnDrop | null>(null);

  const onConnectEnd = React.useCallback(
    (event: MouseEvent | TouchEvent, connection: FinalConnectionState) => {
      const state = useCanvasStore.getState();
      const source = spawnSourceOf(connection, state.document);
      if (!source) return;
      const client = clientPoint(event);
      const flow = getFlow();
      if (!client || !flow) return;
      setDrop({
        ...source,
        client,
        position: flow.screenToFlowPosition(client),
      });
    },
    [],
  );

  const menu = drop ? (
    <SpawnDropMenu drop={drop} onClose={() => setDrop(null)} />
  ) : null;
  return { onConnectEnd, menu };
}

function SpawnDropMenu({
  drop,
  onClose,
}: {
  drop: SpawnDrop;
  onClose: () => void;
}) {
  const workspace = useCanvasStore((state) => state.workspace);
  const agents = useEnabledAgents();
  // 一家可用的 Agent 都没有：菜单里只会剩一行标题，不如不弹。
  if (!workspace || agents.length === 0) return null;
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* 一个零尺寸的锚点钉在松手处，菜单从那里展开。 */}
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          data-slot="spawn-drop-anchor"
          className="pointer-events-none fixed size-0"
          style={{ left: drop.client.x, top: drop.client.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={`z-[var(--z-menu)] ${ADD_MENU_CONTENT_CLASS}`}
      >
        <AddMenuContent
          kind="dropdown"
          ctx={{
            addNode: useCanvasStore.getState().addNode,
            position: drop.position,
            workspace,
            agents,
          }}
          spawnFrom={{
            nodeId: drop.nodeId,
            name: drop.name,
            agentId: drop.agentId,
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
