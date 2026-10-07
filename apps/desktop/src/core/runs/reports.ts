import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../bus";
import type { AgentEvent } from "../hook/normalize";
import type { TerminalBinding } from "../hook/ingest";
import { sanitizePaste } from "../terminal/backend";
import { rfc3339 } from "../workspaces/support";
import type { TrustedReport } from "./evaluate";

export function promptDigest(prompt: string): string {
  return createHash("sha256")
    .update(sanitizePaste(prompt).replace(/\r\n/g, "\n").trim())
    .digest("hex");
}
/** Reads the existing generation's allocator before submission, including in-flight older hooks. */
export function sourceRevision(
  dataDir: string,
  sessionId: string,
  generation: number,
): number | undefined {
  try {
    const bytes = readFileSync(
      join(dataDir, "context-sequences", `${sessionId}-${generation}.seq`),
    );
    if (bytes.length !== 16) return undefined;
    const count = bytes.readBigUInt64BE(0),
      inverse = bytes.readBigUInt64BE(8);
    if (
      count !== (~inverse & 0xffff_ffff_ffff_ffffn) ||
      count > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return undefined;
    return Number(count);
  } catch {
    return undefined;
  }
}
/** Only ingest's already verified, current PTY binding is accepted. Never from controller params. */
export function recordTrustedReport(
  database: DatabaseSync,
  binding: TerminalBinding,
  event: AgentEvent,
  payload: unknown,
  bus: EventBus,
): number | undefined {
  if (
    !event.verified ||
    !["hook", "extension"].includes(event.stateSource ?? "") ||
    !["state", "session"].includes(event.kind)
  )
    return undefined;
  const revision = Number(binding.sourceRevision);
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
  // Source order is authoritative. A late earlier report may be the start of
  // the turn whose Stop arrived first; the UNIQUE key rejects actual replay.
  if (
    event.state === "working" &&
    !event.newTurn &&
    !event.errored &&
    !event.interrupted
  ) {
    const waiting = database
      .prepare(
        "SELECT 1 FROM run_tasks WHERE node_id = ? AND state = 'blocked' AND reason IN ('awaiting_approval','awaiting_input')",
      )
      .get(event.nodeId);
    if (!waiting) return undefined;
  }
  const raw =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const prompt =
    typeof raw.prompt === "string"
      ? raw.prompt
      : typeof raw.initialPrompt === "string"
        ? raw.initialPrompt
        : undefined;
  const report = {
    nodeId: event.nodeId,
    sessionId: binding.sessionId,
    generation: binding.generation,
    sourceRevision: revision,
    stateSource: event.stateSource!,
    verified: true,
    providerSessionId: event.sessionId,
    kind: event.kind,
    state: event.state,
    newTurn: event.newTurn,
    promptHash: prompt === undefined ? undefined : promptDigest(prompt),
    errored: event.errored,
    interrupted: event.interrupted,
  };
  const inserted = database
    .prepare(
      "INSERT OR IGNORE INTO run_reports (node_id, session_id, generation, source_revision, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      event.nodeId,
      binding.sessionId,
      binding.generation,
      revision,
      JSON.stringify(report),
      rfc3339(),
    );
  if (!inserted.changes) return undefined;
  const seq = Number(inserted.lastInsertRowid);
  bus.emit("run.report", { nodeId: event.nodeId, seq });
  return seq;
}
export function reportsAfter(
  database: DatabaseSync,
  nodeId: string,
  sessionId: string,
  generation: number,
  cursor: number,
): TrustedReport[] {
  return (
    database
      .prepare(
        "SELECT seq, report_json FROM run_reports WHERE node_id = ? AND session_id = ? AND generation = ? AND seq > ? ORDER BY source_revision, seq LIMIT 100",
      )
      .all(nodeId, sessionId, generation, cursor) as {
      seq: number;
      report_json: string;
    }[]
  ).map(
    (row) =>
      ({ ...JSON.parse(row.report_json), seq: row.seq }) as TrustedReport,
  );
}
