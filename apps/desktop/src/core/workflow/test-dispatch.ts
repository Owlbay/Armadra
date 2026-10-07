import type { CoreRequest } from "../http/router";
import { Router } from "../http/router";
import type { CoreServer } from "../http/server";
import { installWorkflowRoutes } from "./routes";
import type { WorkflowService } from "./service";

/**
 * 用例用：把工作流的旧路径装进一张新的路由表，一次请求答 `{ status, body }`，
 * 不经 socket。路由、权限门与 procedure 的对偶在 `contract/parity-workflows.test.ts`。
 */
export function workflowDispatcher(
  service: WorkflowService,
): (request: CoreRequest) => Promise<{ status: number; body?: unknown }> {
  const router = new Router();
  installWorkflowRoutes({ router } as unknown as CoreServer, service);
  return async (request) => {
    const answer = await router.dispatch(request.method, request.path, request);
    return {
      status: answer.status,
      body: "body" in answer ? answer.body : undefined,
    };
  };
}
