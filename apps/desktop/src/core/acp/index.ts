/**
 * ACP 域：以 Agent Client Protocol 驱动 Agent 的会话视图（ACP 会话视图设计；
 * 补全架构 §5.1）。
 *
 * 边界：
 *   * 协议栈只包装 `@armadra/agent/acp` 的 `AcpClient`（`client.ts`），不自写
 *     JSON-RPC；适配器表在 `adapters.ts`，与 `permissionFlag` 的模式集合一致。
 *   * 会话行复用 `terminal_sessions`（`backend_kind = 'acp'`），不另建表；节点
 *     仍是终端节点，驱动方式在节点数据 `agent.driver`。
 *   * 路由 `/api/acp/*` 的权限在 `http/route-scopes.ts`：读 `terminal:read`，
 *     写 `terminal:create`；契约 §14。
 *
 * G1-4 填了传输（`client.ts`）、适配器表（`adapters.ts`）与起会话（`host.ts`），
 * `GET /api/agents` 的 `acp` 字段在 `agent/list.ts`（契约 §14.1）。`install`
 * 仍不登记任何东西：会话、桥、归一化与路由在 G2-1。
 */

import type { CoreContext } from "../main";

export {
  ACP_ADAPTERS,
  type AcpAdapter,
  acpAdapter,
  acpLaunchPlan,
  acpPermissionModes,
} from "./adapters";
export {
  AcpError,
  type AcpErrorCode,
  type AcpExit,
  type AcpPendingPermission,
  type AcpPermissionSettlement,
  AcpProcess,
} from "./client";
export {
  type AcpSessionOpener,
  type AcpStdioMcpServer,
  CANVAS_MCP_NAME,
  type CanvasMcpInput,
  acpMcpServers,
  canvasMcpServer,
  clientAcceptsMcpServers,
  sessionOpener,
} from "./mcp";
export {
  type AcpCapabilities,
  type AcpHostSession,
  type AcpStartOptions,
  probeAcp,
  rememberedAcpVersion,
  startAcp,
  startAdapter,
} from "./host";

export function install(_context: CoreContext): void {
  // G2-1 装配会话、桥与路由。
}
