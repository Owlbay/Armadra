import { RunInputSchema, type RunInput } from "@armadra/shared";
import type { DatabaseSync } from "node:sqlite";
import { loadBoard } from "../canvas/documents";
import { loadNode, loadSession, type NodeRef } from "../collab/nodes";
import { pendingFor } from "../collab/send-queue";
import type { CollabContext } from "../collab/service";
import { getAgentStatus } from "../agent/status";
import { ControllerError } from "../controller/errors";
import {
  ownsNode,
  requireCapability,
  type ControllerActor,
} from "../controller/store";
import { scopedPath } from "../controller/paths";
import { getWorkspace } from "../workspaces/table";
import { launchLine } from "../dependencies/launch";
import { occupied } from "./store";

export interface FrozenConfig {
  node: NodeRef;
  workspaceRoot: string;
  cwd: string;
  launchCommand?: string;
}
export interface AgentRunProbe {
  installed: boolean;
  trustedCompletion: boolean;
}
export function validateRun(
  database: DatabaseSync,
  actor: ControllerActor,
  boardId: string,
  raw: unknown,
  collab: CollabContext,
  probe: (agentId: string) => AgentRunProbe,
  now: number,
): { input: RunInput; configs: FrozenConfig[] } {
  requireCapability(actor, "agent:execute");
  const parsed = RunInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new ControllerError(
      "invalid_run",
      `Invalid run at ${parsed.error.issues[0]?.path.join(".") ?? "input"}`,
    );
  const input = parsed.data;
  const board = loadBoard(database, actor.workspaceId, boardId).board;
  if (board.updatedAt !== input.expectedUpdatedAt)
    throw new ControllerError(
      "revision_conflict",
      "Board has changed; reload before starting",
      409,
    );
  const workspace = getWorkspace(database, actor.workspaceId);
  if (workspace.executionHostId || !workspace.permissions.execute)
    throw new ControllerError(
      "scope_denied",
      "The selected local workspace must allow Agent execution",
      403,
    );
  const keys = new Map(input.tasks.map((task) => [task.key, task]));
  if (keys.size !== input.tasks.length)
    throw new ControllerError("duplicate_key", "Task keys must be unique");
  if (
    new Set(input.tasks.map((task) => task.nodeId)).size !== input.tasks.length
  )
    throw new ControllerError(
      "node_busy",
      "A node may occur only once in a run",
      409,
    );
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key))
      throw new ControllerError(
        "dependency_cycle",
        "Execution dependencies must form a DAG",
      );
    if (visited.has(key)) return;
    const task = keys.get(key);
    if (!task)
      throw new ControllerError(
        "invalid_dependency",
        "Dependencies must reference keys in this run",
      );
    visiting.add(key);
    for (const dependency of task.after) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys.keys()) visit(key);
  const configs = input.tasks.map((task) => {
    const node = loadNode(database, task.nodeId);
    if (
      !node ||
      node.workspaceId !== actor.workspaceId ||
      node.boardId !== boardId ||
      !ownsNode(database, actor, task.nodeId)
    )
      throw new ControllerError(
        "scope_denied",
        "Only this profile's Agent nodes on the selected board may run",
        403,
      );
    if (
      node.data.launchPolicy !== "manual" ||
      node.nodeType !== "terminal" ||
      !node.agentId ||
      node.data.ssh ||
      !["codex", "claude"].includes(node.agentId)
    )
      throw new ControllerError(
        "completion_adapter_unavailable",
        "This Agent has no supported trusted completion adapter",
      );
    const capability = probe(node.agentId);
    if (!capability.installed)
      throw new ControllerError(
        "agent_unavailable",
        `Install and sign in to ${node.agentId} before running`,
      );
    if (!capability.trustedCompletion)
      throw new ControllerError(
        "completion_adapter_unavailable",
        "Trusted completion is unavailable for this Agent",
      );
    const session = loadSession(database, node.id),
      status = getAgentStatus(database, node.id);
    if (
      occupied(database, node.id) ||
      pendingFor(database, node.id, Math.floor(now / 1000)).length ||
      (session?.status === "running" &&
        (collab.terminals?.generation(session.sessionId) === undefined ||
          ["working", "waiting", "blocked"].includes(status?.state ?? "")))
    )
      throw new ControllerError(
        "node_busy",
        "The selected node is occupied or already working",
        409,
      );
    const legacy = database
      .prepare(
        "SELECT 1 FROM agent_dependency_launches WHERE node_id = ? AND state = 'waiting' AND run_id IS NULL",
      )
      .get(node.id);
    if (legacy)
      throw new ControllerError(
        "node_busy",
        "An existing dependency launch owns this node",
        409,
      );
    for (const path of task.outputs) scopedPath(workspace.rootPath, path);
    // Freeze only execution configuration, never provider credentials or state.
    const agent = node.data.agent as Record<string, unknown>;
    const frozen: NodeRef = {
      ...node,
      data: {
        kind: "terminal",
        launchPolicy: "manual",
        agent: {
          id: node.agentId,
          ...(agent.model === undefined ? {} : { model: agent.model }),
          ...(agent.permissionMode === undefined
            ? {}
            : { permissionMode: agent.permissionMode }),
        },
      },
    };
    if (node.data.cwd !== undefined && node.data.cwd !== workspace.rootPath) {
      const cwd = String(node.data.cwd);
      if (cwd.startsWith(workspace.rootPath + "/"))
        frozen.data.cwd = scopedPath(
          workspace.rootPath,
          cwd.slice(workspace.rootPath.length + 1),
        ).path;
      else frozen.data.cwd = scopedPath(workspace.rootPath, cwd).path;
    }
    if (typeof node.data.shell === "string")
      frozen.data.shell = node.data.shell;
    const liveShell = session
      ? (
          database
            .prepare("SELECT shell FROM terminal_sessions WHERE id = ?")
            .get(session.sessionId) as { shell?: string }
        )?.shell
      : undefined;
    const launchCommand = launchLine(
      collab,
      node.agentId,
      frozen.data,
      liveShell,
    );
    return {
      node: frozen,
      launchCommand,
      workspaceRoot: workspace.rootPath,
      cwd:
        typeof frozen.data.cwd === "string"
          ? frozen.data.cwd
          : workspace.rootPath,
    };
  });
  return { input, configs };
}
