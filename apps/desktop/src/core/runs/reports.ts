import { createHash } from "node:crypto";
import {
  closeSync,
  fdatasyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
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
/** Within this the core waits for a hook client holding the counter's lock. */
const ALLOCATE_LOCK_DEADLINE_MS = 200;
/** A lock older than this was left by a client that died mid-update. */
const ALLOCATE_LOCK_STALE_MS = 5_000;
const U64 = 0xffff_ffff_ffff_ffffn;

/**
 * Allocates the next `sourceRevision` of a terminal session's generation on
 * behalf of a client that cannot (contract §55.2): the Claude Code mod reports
 * with a binding that names the session and generation only, its runtime
 * having no way to write the 16-byte counter. Same file, same format, same
 * `<file>.lock` sidecar as the hook client's `nextRevision`
 * (`cli/armadra-hook/binding.ts`), so a PermissionRequest the settings hook
 * still reports for the same session draws from the same sequence.
 *
 * The file is opened, never created: the terminal manager initialises it
 * before the PTY starts, and a missing or corrupt one is not permission to
 * start over. `undefined` when it cannot allocate — the report then goes on
 * without a binding, as the hook client's does.
 */
export function allocateSourceRevision(
  dataDir: string,
  sessionId: string,
  generation: number,
): number | undefined {
  const directory = join(dataDir, "context-sequences");
  const file = join(directory, `${sessionId}-${generation}.seq`);
  try {
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) return undefined;
    if (process.platform !== "win32" && (dir.mode & 0o077) !== 0)
      return undefined;
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  const release = lockCounter(file);
  if (release === undefined) return undefined;
  try {
    const handle = openSync(file, "r+");
    try {
      if (fstatSync(handle).size !== 16) return undefined;
      const buffer = Buffer.alloc(16);
      readSync(handle, buffer, 0, 16, 0);
      const count = buffer.readBigUInt64BE(0);
      if (count !== (~buffer.readBigUInt64BE(8) & U64)) return undefined;
      const next = count + 1n;
      if (next > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      const out = Buffer.alloc(16);
      out.writeBigUInt64BE(next, 0);
      out.writeBigUInt64BE(~next & U64, 8);
      writeSync(handle, out, 0, 16, 0);
      fdatasyncSync(handle);
      return Number(next);
    } finally {
      closeSync(handle);
    }
  } catch {
    return undefined;
  } finally {
    release();
  }
}

/** The client's `O_EXCL` sidecar lock, bounded tighter: the core must not stall. */
function lockCounter(file: string): (() => void) | undefined {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + ALLOCATE_LOCK_DEADLINE_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      return () => {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Already taken over by a stale-lock sweep.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > ALLOCATE_LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() >= deadline) return undefined;
    const until = Date.now() + 2;
    while (Date.now() < until) {
      // A hold is one read-modify-write: microseconds.
    }
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
