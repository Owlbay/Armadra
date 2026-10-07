import type { DatabaseSync } from "node:sqlite";
import type { QueueItem } from "../collab/send-queue";
import type { DriveActor } from "../collab/service";
import type { NodeRef } from "../collab/nodes";

/** The existing pump owns PTY submission; this bridge owns durable run evidence. */
export interface RunDeliveryBridge {
  authorize(item: QueueItem): NodeRef;
  authorizeSession(
    controllerId: string,
    sessionId: string,
    generation: number,
  ): void;
  nodeOccupied(nodeId: string): boolean;
  beforeSubmit(
    item: QueueItem,
    binding: { sessionId: string; generation: number },
    envelope: string,
  ): void;
  afterSubmit(
    item: QueueItem,
    outcome: "applied" | "uncertain",
    inputRevision?: number,
  ): void;
  driver(item: QueueItem, sessionId: string): DriveActor;
}
const bridges = new WeakMap<DatabaseSync, RunDeliveryBridge>();
export function setRunDeliveryBridge(
  database: DatabaseSync,
  bridge: RunDeliveryBridge | undefined,
): void {
  if (bridge) bridges.set(database, bridge);
  else bridges.delete(database);
}
export function runDeliveryBridge(
  database: DatabaseSync,
): RunDeliveryBridge | undefined {
  return bridges.get(database);
}
