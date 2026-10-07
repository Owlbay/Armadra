import { CONTROLLER_PROTOCOL, type ControllerCommand } from "@armadra/shared";
import type { CoreContext } from "../main";
import { VERSION } from "../instance";
import { listBoards } from "../canvas/boards";
import { loadBoard } from "../canvas/documents";
import { canvasPresence } from "../canvas/routes";
import { notifyContextLinksChanged } from "../canvas/context-links";
import type { CanvasPresence } from "../canvas/presence";
import { appendEvent } from "../events/outbox";
import type { WorkspaceEvent } from "../bus";
import { DomainError, rfc3339 } from "../workspaces/support";
import { prepareGraph, writeGraph } from "./graph";
import { authenticate, connect, idempotent, requireCapability } from "./store";
import { ControllerError } from "./errors";
import type { RunService } from "../runs/service";

export class ControllerService {
  constructor(
    private readonly context: CoreContext,
    private readonly instanceId: string,
    private readonly options: {
      presence?: () => CanvasPresence | undefined;
      runs?: RunService;
    } = {},
  ) {}
  async dispatch(
    command: ControllerCommand,
    credential?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.execute(command, credential, signal);
    } catch (error) {
      if (error instanceof DomainError)
        throw new ControllerError(
          error.code === "canvas_lease_held" ? "lease_held" : error.code,
          error.message,
          error.status,
        );
      throw error;
    }
  }
  private execute(
    command: ControllerCommand,
    credential?: string,
    signal?: AbortSignal,
  ): unknown {
    const database = this.context.db.database;
    if (command.method === "doctor")
      return {
        instanceId: this.instanceId,
        protocolVersion: CONTROLLER_PROTOCOL,
        coreVersion: VERSION,
        capabilities: [
          "controller.v1",
          ...(this.options.runs ? ["runs.v1"] : []),
        ],
        platform: process.platform,
      };
    if (command.method === "workspaces.list")
      return {
        workspaces: this.context.db.database
          .prepare(
            "SELECT id, name, root_path AS rootPath FROM workspaces WHERE execution_host_id = '' ORDER BY created_at",
          )
          .all(),
      };
    if (command.method === "connect")
      return connect(
        database,
        requiredString(command.params.workspaceId, "workspaceId"),
      );
    const actor = authenticate(database, credential);
    if (
      command.params.workspaceId !== undefined &&
      command.params.workspaceId !== actor.workspaceId
    )
      throw new ControllerError(
        "scope_denied",
        "Profile is scoped to another workspace",
        403,
      );
    if (command.method === "disconnect") {
      database
        .prepare("UPDATE controller_profiles SET revoked_at = ? WHERE id = ?")
        .run(rfc3339(), actor.controllerId);
      this.options.runs?.revoke(actor.controllerId);
      return { controllerId: actor.controllerId, disconnected: true };
    }
    if (command.method.startsWith("run.")) {
      const runs = this.options.runs;
      if (!runs)
        throw new ControllerError(
          "run_capability_unavailable",
          "Run execution is not assembled",
        );
      if (command.method === "run.start")
        return runs.start(
          actor,
          requiredString(command.params.boardId, "boardId"),
          command.params.input,
          command,
        );
      const runId = requiredString(command.params.runId, "runId");
      if (command.method === "run.get")
        return runs.snapshot(actor, runId, Number(command.params.cursor ?? 0));
      if (command.method === "run.wait")
        return runs.wait(
          actor,
          runId,
          Number(command.params.cursor ?? 0),
          Number(command.params.timeoutSeconds ?? 30),
          signal,
          command.params.details === true,
        );
      if (command.method === "run.cancel")
        return runs.cancel(actor, runId, command);
      return runs.artifacts(actor, runId, Number(command.params.cursor ?? 0));
    }
    requireCapability(
      actor,
      command.method.startsWith("graph.") ? "canvas:write" : "canvas:read",
    );
    if (command.method === "boards.list")
      return {
        workspaceId: actor.workspaceId,
        boards: listBoards(database, actor.workspaceId).map((b) => ({
          id: b.id,
          name: b.name,
          updatedAt: b.updatedAt,
        })),
      };
    const boardId = requiredString(command.params.boardId, "boardId");
    if (command.method === "board.get") {
      const document = loadBoard(database, actor.workspaceId, boardId);
      return {
        boardId,
        workspaceId: actor.workspaceId,
        updatedAt: document.board.updatedAt,
        nodeCount: document.nodes.length,
        contextLinkCount: document.edges.length,
        nodes: document.nodes
          .slice(0, 32)
          .map((n) => ({ id: n.id, title: n.title, type: n.type })),
        truncated: document.nodes.length > 32,
      };
    }
    if (command.method === "graph.validate") {
      const prepared = prepareGraph(
        database,
        actor,
        boardId,
        command.params.input,
      );
      return {
        valid: true,
        newNodes: prepared.created.length,
        contextLinks: prepared.document.edges.length,
      };
    }
    if (command.method === "graph.apply") {
      let notifications: string[] = [];
      let event: WorkspaceEvent | undefined;
      let sequence: number | undefined;
      const applied = idempotent(database, actor, command, () => {
        const prepared = prepareGraph(
          database,
          actor,
          boardId,
          command.params.input,
        );
        (this.options.presence?.() ?? canvasPresence())?.authorizeWrite(
          actor.workspaceId,
          boardId,
          undefined,
        );
        const written = writeGraph(database, actor, prepared);
        notifications = written.notified;
        const { notified: _, ...result } = written;
        event = {
          type: "board.changed",
          boardId,
          updatedAt: written.updatedAt,
        };
        sequence = appendEvent(
          database,
          actor.workspaceId,
          event,
          JSON.stringify(event),
        );
        return result;
      });
      if (!applied.replayed && event) {
        this.context.bus.emit("workspace.event", {
          workspaceId: actor.workspaceId,
          event,
          persistedSequence: sequence,
        });
        for (const nodeId of notifications)
          notifyContextLinksChanged(actor.workspaceId, nodeId);
      }
      return applied.result;
    }
    throw new ControllerError(
      "unsupported_method",
      "Run support is not available in this core build",
    );
  }
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > 128)
    throw new ControllerError(
      "target_required",
      `Explicit ${name} is required`,
    );
  return value;
}
