/**
 * 驱动方式（ACP 设计 §4.1–§4.2）：同一个终端节点，PTY 或 ACP。
 *
 * 只认节点数据里写明的 `acp`：缺省按 core 的 `agents.defaultDriver` 定，那是
 * core 起会话时的决定，页面不替它猜——猜错了就是对着一个 PTY 会话画消息流。
 */
import type { AgentDriver, TerminalAgent } from "@armadra/shared";
import { toast } from "sonner";

import { agentAcpInfo } from "@/agent/launch";
import { RuntimeRequestError } from "@/api/request";
import { t } from "@/app/preferences-store";
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
    useCanvasStore
      .getState()
      .updateNodeData(
        nodeId,
        { agent: { ...agent, driver }, sessionId: result.sessionId },
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
