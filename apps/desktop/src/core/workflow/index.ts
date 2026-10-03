/**
 * 工作流域：草案、模板、运行与关卡（协调 Agent 设计 §5；补全架构 §5.4）。
 *
 * 边界：
 *   * 运行在画布上建 Frame、按 `roles` 开节点与连线，走 `collab` 的 `team`
 *     同一段代码；投递与 runner 共用 `workflow/dispatch.ts`。
 *   * 页面不在也推进：引擎订阅 bus 事件，与依赖编排同一处。
 *   * 路由 `/api/workflows/*` 的权限在 `http/route-scopes.ts`：读
 *     `canvas:read`，写要 operator 那一档（`agent:launch`）；关卡答复的权限
 *     由 G2-9 收紧（契约 §23）。契约 §15。
 *
 * 现在只是骨架（G0-3）：`install` 什么也不登记。G1-8 填。
 */

import type { CoreContext } from "../main";

export function install(_context: CoreContext): void {
  // 骨架：G1-8 填。
}
