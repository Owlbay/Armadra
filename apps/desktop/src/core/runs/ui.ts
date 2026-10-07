import type { CoreContext } from "../main";
import { currentSubject } from "../identity/gate";
import { ControllerError } from "../controller/errors";
import { loadNode } from "../collab/nodes";
import { getWorkspace } from "../workspaces/table";
import type { ControllerActor } from "../controller/store";
import type { RunService } from "./service";

/** GUI owner authority delegates the node's actual profile; no profile token enters the page. */
export function installRunUi(
  context: CoreContext,
  runs: Pick<RunService, "start">,
): void {
  context.server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/boards/{boardId}/nodes/{nodeId}/run",
    (match, request) => {
      try {
        const subject = currentSubject();
        if (subject.kind !== "owner")
          throw new ControllerError(
            "scope_denied",
            "Manual controller runs require the workspace owner",
            403,
          );
        const workspaceId = match.params.workspaceId!,
          boardId = match.params.boardId!,
          nodeId = match.params.nodeId!;
        const node = loadNode(context.db.database, nodeId),
          workspace = getWorkspace(context.db.database, workspaceId);
        if (
          !node ||
          node.workspaceId !== workspaceId ||
          node.boardId !== boardId ||
          node.data.launchPolicy !== "manual" ||
          workspace.executionHostId
        )
          throw new ControllerError(
            "scope_denied",
            "This manual node is outside the selected local board",
            403,
          );
        const row = context.db.database
          .prepare(
            "SELECT p.id,p.capabilities_json FROM controller_objects o JOIN controller_profiles p ON p.id=o.controller_id WHERE o.node_id=? AND o.workspace_id=?",
          )
          .get(nodeId, workspaceId) as
          | { id: string; capabilities_json: string }
          | undefined;
        if (!row)
          throw new ControllerError(
            "scope_denied",
            "This node has no controller ownership",
            403,
          );
        const body = request.json<Record<string, unknown>>();
        if (
          typeof body.key !== "string" ||
          !body.key ||
          body.key.length > 100 ||
          typeof body.prompt !== "string" ||
          typeof body.expectedUpdatedAt !== "string"
        )
          throw new ControllerError(
            "invalid_arguments",
            "A task prompt, current board revision and key are required",
          );
        const actor: ControllerActor = {
          kind: "controller",
          controllerId: row.id,
          workspaceId,
          capabilities: JSON.parse(row.capabilities_json),
        };
        const input = {
          schemaVersion: 1,
          expectedUpdatedAt: body.expectedUpdatedAt,
          tasks: [
            {
              key: "manual",
              nodeId,
              prompt: body.prompt,
              after: [],
              outputs: [],
            },
          ],
          maxConcurrency: 2,
          deadlineSeconds: 3600,
        };
        const result = runs.start(
          actor,
          boardId,
          input,
          {
            schemaVersion: 1,
            requestId: "ui",
            instanceId: "ui",
            method: "run.start",
            params: { boardId, input },
            idempotencyKey: "ui:" + body.key,
          },
          { kind: "human", principalId: subject.principalId },
        );
        return { status: 200, body: result };
      } catch (error) {
        if (error instanceof ControllerError)
          return {
            status: error.status,
            body: { code: error.code, message: error.message },
          };
        throw error;
      }
    },
  );
}
