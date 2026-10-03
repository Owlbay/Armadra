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
 * 现在只是骨架（G0-3）：`install` 什么也不登记。G1-4 填传输与适配器表，
 * G2-1 填会话、桥与路由。
 */

import type { CoreContext } from "../main";

export function install(_context: CoreContext): void {
  // 骨架：G1-4 / G2-1 填。
}
