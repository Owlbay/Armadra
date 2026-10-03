/**
 * 驱动方式（ACP 设计 §4.1–§4.2）：同一个终端节点，PTY 或 ACP。
 *
 * 只认节点数据里写明的 `acp`：缺省按 core 的 `agents.defaultDriver` 定，那是
 * core 起会话时的决定，页面不替它猜——猜错了就是对着一个 PTY 会话画消息流。
 */
import * as React from "react";
import {
  completionSettingsSchema,
  type AgentDriver,
  type AgentInfo,
  type TerminalAgent,
} from "@armadra/shared";
import { toast } from "sonner";

import { agentAcpInfo } from "@/agent/launch";
import { RuntimeRequestError } from "@/api/request";
import { t } from "@/app/preferences-store";
import { useRuntimeSettings } from "@/panels/settings/use-runtime-settings";
import { useCanvasStore } from "@/store/canvas-store";
import { acpApi } from "./api";

export function driverOf(agent: TerminalAgent | undefined): AgentDriver {
  return agent?.driver === "acp" ? "acp" : "terminal";
}

/** 有 ACP 入口的 Agent 才给切换（不管装没装：没装由 core 答错误）。 */
export function canUseAcp(agent: TerminalAgent | undefined): boolean {
  return Boolean(agent && agentAcpInfo(agent.id));
}

/**
 * 切换：core 结束当前驱动、在另一种下接回（或新开），答回新会话行的 id。
 * 写回节点数据不进撤销栈——撤销改不回已经换掉的进程。
 */
export async function switchDriver(
  nodeId: string,
  driver: AgentDriver,
): Promise<void> {
  const node = useCanvasStore
    .getState()
    .document?.nodes.find((item) => item.id === nodeId);
  if (!node || node.data.kind !== "terminal" || !node.data.agent) return;
  const agent = node.data.agent;
  if (driverOf(agent) === driver) return;
  try {
    const result = await acpApi.switchDriver(nodeId, driver);
    useCanvasStore.getState().updateNodeData(
      nodeId,
      // 上一种驱动结束时页面记下的退出码不属于新的这一代：清掉，节点头才不
      // 会对着一个刚起来的会话写「已退出」。
      {
        agent: { ...agent, driver },
        sessionId: result.sessionId,
        lastExitCode: null,
      },
      { history: "ignore" },
    );
    if (!result.resumed) toast.info(t("acp.driver.notResumed"));
  } catch (error) {
    toast.error(
      t(
        error instanceof RuntimeRequestError &&
          error.code === "awaiting_approval"
          ? "acp.driver.awaitingApproval"
          : "acp.driver.failed",
      ),
    );
  }
}

/* ------------------------------ 缺省驱动 --------------------------------- */

/**
 * `agents.defaultDriver`（ACP 设计 §8 第 2 条）的最近一次读数。新建菜单的
 * 规格不是组件，拿不到查询，所以由挂着的组件（`useDefaultDriverSync`）把设置
 * 推到这里；还没读到时按缺省 `acp`。
 */
let defaultDriverSetting: AgentDriver = "acp";

export function defaultDriver(): AgentDriver {
  return defaultDriverSetting;
}

/** 仅测试用。 */
export function setDefaultDriverForTest(value: AgentDriver): void {
  defaultDriverSetting = value;
}

/** 设置文档里的 `agents.defaultDriver`；读不出就是缺省。 */
export function driverSettingOf(settings: unknown): AgentDriver {
  return completionSettingsSchema.parse(
    settings && typeof settings === "object" ? settings : {},
  ).agents.defaultDriver;
}

/** 读设置并推给 `defaultDriver()`；返回当前值。 */
export function useDefaultDriverSync(): AgentDriver {
  const { settings } = useRuntimeSettings();
  const value = settings.data ? driverSettingOf(settings.data) : null;
  React.useEffect(() => {
    if (value) defaultDriverSetting = value;
  }, [value]);
  return value ?? defaultDriverSetting;
}

/**
 * 新建节点时写进节点数据的驱动方式：设置是 `acp` 且这家的适配器装了才走 ACP，
 * 否则这一家退回终端。写明而不是留空：节点上的驱动是建它那一刻的决定，之后
 * 改设置不该把已有节点翻成另一种视图。
 */
export function preferredDriver(
  agent: Pick<AgentInfo, "acp">,
  setting: AgentDriver = defaultDriverSetting,
): AgentDriver {
  return setting === "acp" && agent.acp?.installed ? "acp" : "terminal";
}
