/**
 * 工作流域：草案、模板、运行与关卡（协调 Agent 设计 §5；补全架构 §5.4）。
 *
 * 边界：
 *   * 运行在画布上建 Frame、按 `roles` 开节点与连线；投递与 runner 共用
 *     `workflow/dispatch.ts`。
 *   * 页面不在也推进：引擎订阅 bus 事件、周期扫描，与依赖编排同一处判定。
 *   * 路由 `/api/workflows/*` 的权限在 `http/route-scopes.ts`：读
 *     `canvas:read`，写要 operator 那一档（`agent:launch`）；关卡答复的权限
 *     由 G2-9 收紧（契约 §23）。路径里没有工作空间，成员一律 403。契约 §15。
 *
 * **只在工作流的表已经存在时装**（与 `schedule/index.ts` 同款）：没有表就不装，
 * 这一面根本不在，而不是第一个请求撞上一条 SQL 错误。装配排在协作与终端之后：
 * 起节点要借终端桥，投递要借协作上下文，两者都每次现取。
 */

import { collab } from "../agent";
import type { CoreContext } from "../main";
import { WorkflowEngine } from "./engine";
import { installWorkflowRoutes } from "./routes";
import { type WorkflowDomain, setWorkflowDomain } from "./registry";
import { WorkflowService } from "./service";

export { WorkflowEngine } from "./engine";
export { WorkflowService } from "./service";
export { API_PREFIX } from "./routes";

export { setWorkflowDomain, workflowDomain } from "./registry";
export type { WorkflowDomain } from "./registry";

export const WORKFLOW_TABLES = [
  "workflow_drafts",
  "workflow_templates",
  "workflow_runs",
  "workflow_run_steps",
  "workflow_task_runs",
] as const;

export function install(context: CoreContext): WorkflowDomain | undefined {
  if (!context.db.unified || !tablesReady(context)) {
    context.log.info("工作流域未装配：工作流的表尚未建立");
    return undefined;
  }
  const database = context.db.database;
  const engine = new WorkflowEngine({
    database,
    collab: () => collab(),
    bus: context.bus,
    log: (message, fields) => context.log.info(message, fields),
  });
  const service = new WorkflowService({
    database,
    engine,
    collab: () => collab(),
  });
  installWorkflowRoutes(context.server, service);
  engine.start();
  const domain: WorkflowDomain = {
    engine,
    service,
    stop: async () => {
      await engine.stop();
      setWorkflowDomain(undefined);
    },
  };
  setWorkflowDomain(domain);
  context.onStop?.(() => domain.stop());
  context.log.info("工作流域已装配");
  return domain;
}

function tablesReady(context: CoreContext): boolean {
  try {
    const row = context.db.database
      .prepare(
        "SELECT count(*) AS total FROM sqlite_schema WHERE type = 'table' AND name IN (" +
          WORKFLOW_TABLES.map(() => "?").join(", ") +
          ")",
      )
      .get(...WORKFLOW_TABLES) as { total?: unknown } | undefined;
    return Number(row?.total ?? 0) === WORKFLOW_TABLES.length;
  } catch {
    return false;
  }
}
