import { join } from "node:path";
import { CoreFailure } from "../http/errors";
import type { HandlerResult } from "../http/router";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import type { CoreContext } from "../main";
import { validNodeId } from "./auth";
import { InstallError } from "./install/shared";
import {
  type IntegrationOptions,
  install as installIntegration,
  state as integrationState,
  uninstall as uninstallIntegration,
} from "./install/integration";
import { repair as repairIntegration } from "./install/repair";
import { outdatedHosts } from "../remote/fleet";
import type { HookService } from "./service";

/**
 * The hook domain's routes on the *main* surface.
 *
 * Only two things reach the hook service from the front end: the per-node
 * credential a terminal was created with, and the integration installer. Both
 * are here rather than in the terminal or agent domains because both are
 * statements about files this domain owns.
 *
 * The three integration routes are one unit with one revision (§2): reading
 * says what is on disk and what a fresh install would write, installing
 * writes both halves, and repairing is the *only* thing that touches a file an
 * earlier product name left behind — start-up scans and logs, it never edits.
 */
export function installRoutes(
  context: CoreContext,
  service: HookService,
): void {
  context.server.router.handle(
    "POST",
    "/api/terminals/{sessionId}/node-token/refresh",
    (match) => {
      const sessionId = match.params.sessionId ?? "";
      const row = context.db.database
        .prepare("SELECT owner_node_id FROM terminal_sessions WHERE id = ?")
        .get(sessionId) as Record<string, unknown> | undefined;
      if (row === undefined) {
        return error(404, "not_found", "没有这个终端会话");
      }
      const nodeId = row.owner_node_id;
      if (typeof nodeId !== "string" || nodeId === "") {
        return error(400, "bad_request", "This session has no owning node");
      }
      if (!validNodeId(nodeId)) {
        return error(400, "bad_request", "Node id is not path safe");
      }
      try {
        service.issueNodeToken(nodeId);
      } catch (failure) {
        return error(
          500,
          "internal",
          `Could not write the node token: ${describe(failure)}`,
        );
      }
      return {
        status: 200,
        body: {
          nodeId,
          tokenFile: join(service.nodeTokenDir(), nodeId),
        },
      };
    },
  );

  installRoutesFor(context);
}

function error(status: number, code: string, message: string): HandlerResult {
  return { status, body: { code, message } };
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * 集成的四条路由（契约 §39.1）：旧路径的 handler 与 `agents.*Integration`
 * procedure 调同一份实现。`InstallError` 是有意的拒绝（码与状态它自己带），
 * 其余失败是 500。
 */
function installRoutesFor(context: CoreContext): void {
  const options = (): IntegrationOptions => ({
    dataDir: context.dataDir,
    // Worker 舰队的过旧主机（契约 §21.2）。
    outdatedHosts,
  });
  const run = <T>(action: () => T): T => {
    try {
      return action();
    } catch (failure) {
      if (failure instanceof InstallError) {
        throw new CoreFailure(failure.status, failure.code, failure.message);
      }
      throw new CoreFailure(500, "internal", describe(failure));
    }
  };
  const operations = {
    integration: (agentId: string) =>
      run(() => integrationState(agentId, options())),
    install: (agentId: string) =>
      run(() => installIntegration(agentId, options())),
    uninstall: (agentId: string) =>
      run(() => uninstallIntegration(agentId, options())),
    repair: (agentId: string) => run(() => repairIntegration(agentId)),
  };
  registerProcedures(context.server, "agents", {
    integration: ({ agentId }: { agentId: string }) =>
      operations.integration(agentId),
    installIntegration: ({ agentId }: { agentId: string }) =>
      operations.install(agentId),
    uninstallIntegration: ({ agentId }: { agentId: string }) =>
      operations.uninstall(agentId),
    repairIntegration: ({ agentId }: { agentId: string }) =>
      operations.repair(agentId),
  } as unknown as DomainHandlers<"agents">);

  const guard = (answer: () => unknown): HandlerResult => {
    try {
      return { status: 200, body: answer() };
    } catch (failure) {
      if (failure instanceof CoreFailure) {
        return error(failure.status, failure.code, failure.message);
      }
      throw failure;
    }
  };

  context.server.router.handle(
    "GET",
    "/api/agents/{agentId}/integration",
    (match) => guard(() => operations.integration(match.params.agentId ?? "")),
  );
  context.server.router.handle(
    "POST",
    "/api/agents/{agentId}/integration/install",
    (match) => guard(() => operations.install(match.params.agentId ?? "")),
  );
  context.server.router.handle(
    "POST",
    "/api/agents/{agentId}/integration/uninstall",
    (match) => guard(() => operations.uninstall(match.params.agentId ?? "")),
  );
  context.server.router.handle(
    "POST",
    "/api/agents/{agentId}/integration/repair",
    (match) => guard(() => operations.repair(match.params.agentId ?? "")),
  );
}
