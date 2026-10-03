/**
 * 实时协同域：每块板一个 `Y.Doc`，更新流与快照落库，物化回 `nodes` /
 * `edges` / `whiteboard_json`（补全架构 §6）。
 *
 * 边界：
 *   * 实时板上 core 自己的写者（控制动词、调度、依赖编排）经
 *     `canvas/documents.saveBoard` 前的拦截写进文档，不绕过文档直写表。
 *   * 评论不进 `Y.Doc`，落 `board_comments`，由 core 判权限与锚点。
 *   * `WS …/boards/{boardId}/sync` 升级要 `canvas:read`、更新帧要
 *     `canvas:write`；`…/comments*` 读 `canvas:read`、写 `canvas:write`
 *     （`http/route-scopes.ts`）。契约 §16。
 *   * 是否允许切到实时板看设置 `collab.realtime`。
 *
 * 现在只是骨架（G0-3）：`install` 什么也不登记。G1-9 填文档与同步，G2-6 填
 * 评论路由。
 */

import type { CoreContext } from "../main";

export function install(_context: CoreContext): void {
  // 骨架：G1-9 / G2-6 填。
}
