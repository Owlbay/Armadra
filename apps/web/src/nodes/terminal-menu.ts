import {
  Check,
  History,
  KeyRound,
  MessagesSquare,
  Recycle,
  RotateCcw,
  SlidersHorizontal,
  SquareTerminal,
  Tag,
  UserPlus,
} from "lucide-react";
import { supportedPermissionModes, type PermissionMode } from "@armadra/shared";

import {
  registerNodeMenuItems,
  type NodeMenuItem,
} from "@/canvas/menus/node-menu";
import { useCanvasStore } from "@/store/canvas-store";
import {
  agentRegistry,
  customAgentFor,
  permissionModeLabel,
} from "@/agent/launch";
import {
  agentIsEnabled,
  t,
  usePreferencesStore,
} from "@/app/preferences-store";
import { openNodeAnnotation } from "@/meta/annotations";
import { canUseAcp, driverOf, switchDriver } from "@/acp/driver";
import { visibleNodeMenu } from "@/acp/simple-mode";
import { buildSpawnItems } from "@/canvas/menus/add-menu";
import { openAgentSettings } from "./agent-settings";
import { terminalHandle } from "./terminal-registry";

/**
 * 终端节点的 Agent 专属右键菜单项（§3.2）。
 *
 * 「权限模式」摊成四条，当前模式那条置灰——这样一眼看得出现在是哪种模式；
 * 「派生」是唯一的子菜单（注册表支持一层 `children`）。
 *
 * 切模式后必须重启：权限是启动行上的参数，改数据不改已经在跑的进程。
 */
let dispose: (() => void) | null = null;

export function registerTerminalNodeMenu(): () => void {
  // 幂等：模块加载时自动调一次，测试里再调也不会注册两份。
  if (dispose) return dispose;
  dispose = registerNodeMenuItems("terminal", ({ node }) => {
    if (node.data.kind !== "terminal") return [];
    // 「标签…」对所有终端都有（§17）：终端头部不许再多一行，标签只有这一个
    // 编辑入口，编辑结果显示在画布卡片上。
    const labels: NodeMenuItem = {
      id: "node.labels",
      label: `${t("meta.labels")}…`,
      icon: Tag,
      run: () => openNodeAnnotation(node.id, "labels"),
    };
    const agent = node.data.agent;
    if (!agent) return [labels];

    const current: PermissionMode = agent.permissionMode ?? "default";
    const items: NodeMenuItem[] = [
      labels,
      // 只读的历史面板：它不发起交接，所以和「交接到…」是两个入口。
      {
        id: "handoff.history",
        label: t("handoff.historyTitle"),
        icon: History,
        run: () => useCanvasStore.getState().setPanel("handoff", "drawer"),
      },
      // 派生（ui-wave2 §6.2）：人替它做 `canvas open-agent`——选哪家就直接
      // 建哪家的从，连主从边、按布局方向放，没有向导。
      {
        id: "agent.spawn",
        label: t("node.menu.spawn"),
        icon: UserPlus,
        run: () => undefined,
        children: spawnChildren(node.id, agent.id),
      },
      // Agent 设置（设计 §10）：收件箱唤醒、从的投递、转录读取三项的唯一入口。
      {
        id: "agent.settings",
        label: `${t("agentSettings.title")}…`,
        icon: SlidersHorizontal,
        run: () => openAgentSettings(node.id),
      },
      {
        id: "agent.restart",
        label: t("agent.restart"),
        icon: RotateCcw,
        run: () => terminalHandle(node.id)?.restart(),
      },
      {
        id: "agent.recycle",
        label: t("agent.recycle"),
        icon: Recycle,
        run: () => terminalHandle(node.id)?.recycle(),
      },
    ];

    // 驱动方式（ACP 设计 §4.2）：当前那一项打钩并置灰；没有 ACP 入口的
    // Agent 不出现。
    if (canUseAcp(agent)) {
      const driver = driverOf(agent);
      items.push(
        {
          id: "agent.driver.acp",
          label: t("acp.view.session"),
          icon: driver === "acp" ? Check : MessagesSquare,
          disabled: driver === "acp",
          run: () => void switchDriver(node.id, "acp"),
        },
        {
          id: "agent.driver.terminal",
          label: t("acp.view.terminal"),
          icon: driver === "terminal" ? Check : SquareTerminal,
          disabled: driver === "terminal",
          run: () => void switchDriver(node.id, "terminal"),
        },
      );
    }

    for (const mode of supportedPermissionModes(
      customAgentFor(agent.id)?.baseAgent ?? agent.id,
    )) {
      items.push({
        id: `agent.permission.${mode}`,
        label: `${t("agent.permissionMode")} · ${permissionModeLabel(mode)}`,
        icon: KeyRound,
        disabled: mode === current,
        run: () => {
          useCanvasStore.getState().updateNodeData(node.id, {
            agent: { ...agent, permissionMode: mode },
          });
          terminalHandle(node.id)?.restart();
        },
      });
    }

    // 简洁模式不显示「回收 / 权限模式 / 终端视图」（ACP 设计 §8 第 3 条）。
    return visibleNodeMenu(items);
  });
  return dispose;
}

/** 「派生」子菜单：新建菜单里同一批 Agent，与父同一家的排第一。 */
function spawnChildren(
  parentId: string,
  parentAgentId: string,
): NodeMenuItem[] {
  const modes = usePreferencesStore.getState().agentModes;
  const agents = agentRegistry().filter((entry) =>
    agentIsEnabled(modes[entry.id], entry.installed),
  );
  return buildSpawnItems(agents, t, parentId, parentAgentId).map((item) => {
    const reason = item.disabledReason();
    return {
      id: item.id,
      label: item.label,
      icon: item.icon,
      disabled: reason !== null,
      ...(reason ? { hint: reason } : {}),
      run: item.run,
    };
  });
}

/** 模块加载即注册一次；`TerminalNode` 以副作用方式引入本文件。 */
registerTerminalNodeMenu();
