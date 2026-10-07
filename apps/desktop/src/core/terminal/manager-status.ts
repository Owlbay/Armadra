import type { DatabaseSync } from "node:sqlite";
import { getAgentStatus } from "../agent/status";
import { targetState, type ObservedActivity } from "../agent/target-state";
import { loadSession } from "../collab/nodes";
import { freeLease, type Lease } from "../drive/lease";
import type { DriveTarget, SessionRecord } from "./manager";
import type { Actor } from "../drive/lease";
import { runDeliveryBridge } from "../runs/registry";
import { TerminalError } from "./backend";

export function authorizeManagedInput(
  database: DatabaseSync,
  record: SessionRecord,
  driver: Actor | undefined,
): void {
  const run = runDeliveryBridge(database);
  if (driver?.kind === "controller") {
    if (!run)
      throw new TerminalError(
        403,
        "scope_denied",
        "Controller run authority is unavailable",
      );
    run.authorizeSession(driver.controllerId, record.id, record.generation);
  } else if (
    driver?.kind !== "human" &&
    record.ownerNodeId &&
    run?.nodeOccupied(record.ownerNodeId)
  )
    throw new TerminalError(
      409,
      "node_busy",
      "This node is occupied by a controller run",
    );
}

export function assertSubmitInput(
  database: DatabaseSync,
  record: SessionRecord,
): void {
  if (!automatedInputWritable(database, record) || record.inputSafety.pending)
    throw new TerminalError(
      409,
      "input_not_safe",
      "The target is waiting for input or has a partial input line",
    );
}

/** The existing state/lease snapshot, kept separate from PTY lifecycle mutation. */
export function driveTargetFor(
  database: DatabaseSync,
  nodeId: string,
  generation: (id: string) => number | undefined,
  lease: (id: string) => Lease,
): DriveTarget {
  const sessionId = loadSession(database, nodeId)?.sessionId;
  const live = sessionId === undefined ? undefined : generation(sessionId);
  const status = getAgentStatus(database, nodeId);
  const currentLease =
    sessionId === undefined ? freeLease(0) : lease(sessionId);
  return {
    nodeId,
    ...(sessionId === undefined ? {} : { sessionId }),
    state: targetState(status, live),
    ...(status?.stateSource === undefined
      ? {}
      : { stateSource: status.stateSource }),
    lease: currentLease,
    driveGeneration: currentLease.generation,
  };
}

/** Observation is a delivery gate input, never evidence of task completion. */
export function observedActivityFor(
  record: SessionRecord | undefined,
): ObservedActivity | undefined {
  if (!record || record.exited) return undefined;
  return {
    pending: record.inputSafety.pending,
    lastInputAt: record.lastActivity,
    lastOutputAt: record.lastActivity,
    startedAt: record.startedAt,
  };
}

/** Programmatic input cannot answer a permission or input question. */
export function automatedInputWritable(
  database: DatabaseSync,
  record: SessionRecord | undefined,
): boolean {
  if (!record || record.exited) return false;
  if (record.ownerNodeId === null) return true;
  const row = database
    .prepare("SELECT state FROM agent_status WHERE node_id = ?")
    .get(record.ownerNodeId) as { state?: string } | undefined;
  return row?.state !== "blocked" && row?.state !== "waiting";
}
