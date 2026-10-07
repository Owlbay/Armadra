import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ControllerCommand } from "@armadra/shared";
import { canonicalJson } from "../canvas/documents";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { getWorkspace } from "../workspaces/table";
import { ControllerError } from "./errors";

export const CONTROLLER_CAPABILITIES = [
  "canvas:read",
  "canvas:write",
  "agent:execute",
  "run:read",
  "run:cancel",
] as const;
export type ControllerActor = {
  readonly kind: "controller";
  readonly controllerId: string;
  readonly workspaceId: string;
  readonly capabilities: readonly string[];
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function connect(database: DatabaseSync, workspaceId: string) {
  const workspace = getWorkspace(database, workspaceId);
  if (workspace.executionHostId)
    throw new ControllerError(
      "scope_denied",
      "Only an existing local workspace can be selected",
      403,
    );
  const controllerId = uuidV7();
  const credential = randomBytes(32).toString("base64url");
  database
    .prepare(
      "INSERT INTO controller_profiles (id, workspace_id, credential_hash, capabilities_json, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      controllerId,
      workspaceId,
      hash(credential),
      JSON.stringify(CONTROLLER_CAPABILITIES),
      rfc3339(),
    );
  return {
    controllerId,
    credential,
    workspaceId,
    scope: [...CONTROLLER_CAPABILITIES],
  };
}
export function authenticate(
  database: DatabaseSync,
  credential?: string,
): ControllerActor {
  if (!credential)
    throw new ControllerError(
      "authorization_required",
      "An explicit controller profile is required",
      401,
    );
  const row = database
    .prepare(
      "SELECT id, workspace_id, capabilities_json, revoked_at FROM controller_profiles WHERE credential_hash = ?",
    )
    .get(hash(credential)) as
    | {
        id: string;
        workspace_id: string;
        capabilities_json: string;
        revoked_at: string | null;
      }
    | undefined;
  if (!row)
    throw new ControllerError(
      "authorization_required",
      "Invalid controller profile",
      401,
    );
  if (row.revoked_at)
    throw new ControllerError(
      "authorization_revoked",
      "Controller profile has been revoked",
      403,
    );
  const workspace = getWorkspace(database, row.workspace_id);
  if (workspace.executionHostId)
    throw new ControllerError(
      "scope_denied",
      "Workspace is no longer local",
      403,
    );
  return {
    kind: "controller",
    controllerId: row.id,
    workspaceId: row.workspace_id,
    capabilities: JSON.parse(row.capabilities_json) as string[],
  };
}
export function requireCapability(actor: ControllerActor, capability: string) {
  if (!actor.capabilities.includes(capability))
    throw new ControllerError(
      "scope_denied",
      "Profile lacks the required capability",
      403,
    );
}
export function ownsNode(
  database: DatabaseSync,
  actor: ControllerActor,
  nodeId: string,
): boolean {
  return !!database
    .prepare(
      "SELECT 1 FROM controller_objects WHERE node_id = ? AND controller_id = ? AND workspace_id = ?",
    )
    .get(nodeId, actor.controllerId, actor.workspaceId);
}
export function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
/** Always reconcile before revision validation. The receipt shares the business transaction. */
export function idempotent<T>(
  database: DatabaseSync,
  actor: ControllerActor,
  command: ControllerCommand,
  work: () => T,
): { result: T; replayed: boolean } {
  const key = command.idempotencyKey;
  if (!key)
    throw new ControllerError(
      "invalid_arguments",
      "Mutation requires an idempotency key",
    );
  return transaction(database, () => {
    const digest = hash(canonicalJson(command.params));
    const previous = database
      .prepare(
        "SELECT request_hash, result_json FROM controller_commands WHERE controller_id = ? AND workspace_id = ? AND command = ? AND command_key = ?",
      )
      .get(actor.controllerId, actor.workspaceId, command.method, key) as
      | { request_hash: string; result_json: string }
      | undefined;
    if (previous) {
      if (previous.request_hash !== digest)
        throw new ControllerError(
          "idempotency_conflict",
          "This key was already used with different content",
          409,
        );
      return { result: JSON.parse(previous.result_json) as T, replayed: true };
    }
    const result = work();
    database
      .prepare("INSERT INTO controller_commands VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        actor.controllerId,
        actor.workspaceId,
        command.method,
        key,
        digest,
        JSON.stringify(result),
        rfc3339(),
      );
    return { result, replayed: false };
  });
}
