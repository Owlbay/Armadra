import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readSync,
  statSync,
  fstatSync,
  constants,
  type Stats,
} from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { CONTROLLER_LIMITS } from "@armadra/shared";
import { ControllerError } from "../controller/errors";
import { scopedPath } from "../controller/paths";
import { getWorkspace } from "../workspaces/table";
import { tasksOf, type RunRow } from "./store";

const PAGE_BYTES = CONTROLLER_LIMITS.summaryBytes - 512;
export function runSnapshot(database: DatabaseSync, run: RunRow, offset = 0) {
  const tasks = tasksOf(database, run.id);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > tasks.length)
    throw new ControllerError("invalid_arguments", "Invalid task cursor");
  const cursor = Number(
    (
      database
        .prepare(
          "SELECT COALESCE(MAX(seq), ?) seq FROM run_events WHERE run_id = ?",
        )
        .get(run.event_floor, run.id) as { seq: number }
    ).seq,
  );
  const base = {
    runId: run.id,
    boardId: run.board_id,
    state: run.state,
    reason: run.reason,
    cursor,
    updatedAt: run.updated_at,
    counts: Object.fromEntries(
      [...new Set(tasks.map((task) => task.state))].map((state) => [
        state,
        tasks.filter((task) => task.state === state).length,
      ]),
    ),
    completedMeans: "agent_turn_finished; quality_requires_report_review",
    artifactQuery: { method: "run.artifacts", runId: run.id },
  };
  const entries: Record<string, unknown>[] = [];
  let nextCursor = offset;
  for (const task of tasks.slice(offset)) {
    const allOutputs = JSON.parse(task.outputs_json) as string[];
    const entry: Record<string, unknown> = {
      taskId: task.id,
      key: task.task_key,
      nodeId: task.node_id,
      state: task.state,
      reason: task.reason,
      sessionId: task.session_id,
      generation: task.generation,
      deliveryId: task.delivery_id,
      after: JSON.parse(task.after_json),
      outputs: allOutputs.slice(0, 2),
      outputsTruncated: allOutputs.length > 2,
    };
    if (
      Buffer.byteLength(
        JSON.stringify({
          ...base,
          tasks: [entry],
          truncated: true,
          nextCursor: nextCursor + 1,
        }),
      ) > PAGE_BYTES
    ) {
      entry.outputs = [];
      entry.outputsTruncated = allOutputs.length > 0;
    }
    if (
      Buffer.byteLength(
        JSON.stringify({
          ...base,
          tasks: [...entries, entry],
          truncated: true,
          nextCursor: nextCursor + 1,
        }),
      ) > PAGE_BYTES
    )
      break;
    entries.push(entry);
    nextCursor++;
  }
  return {
    ...base,
    tasks: entries,
    truncated: nextCursor < tasks.length,
    nextCursor,
  };
}

export function eventPage(
  database: DatabaseSync,
  run: RunRow,
  cursor: number,
  detailed = false,
) {
  const watermark = Number(
    (
      database
        .prepare(
          "SELECT COALESCE(MAX(seq), ?) seq FROM run_events WHERE run_id = ?",
        )
        .get(run.event_floor, run.id) as { seq: number }
    ).seq,
  );
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new ControllerError("invalid_arguments", "Invalid event cursor");
  if (cursor > watermark)
    throw new ControllerError(
      "cursor_ahead",
      "Cursor is ahead of this run's history",
      409,
    );
  if (cursor < run.event_floor)
    return {
      events: [],
      nextCursor: watermark,
      snapshotRequired: true,
      snapshotMethod: "run.get",
      state: run.state,
      truncated: false,
    };
  const rows = database
    .prepare(
      "SELECT seq, event_json, created_at FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    )
    .all(run.id, cursor, CONTROLLER_LIMITS.events + 1) as {
    seq: number;
    event_json: string;
    created_at: string;
  }[];
  const records: Record<string, unknown>[] = [];
  let bytes = 512,
    nextCursor = cursor;
  const limit = detailed ? CONTROLLER_LIMITS.responseBytes - 512 : PAGE_BYTES;
  for (const row of rows.slice(0, CONTROLLER_LIMITS.events)) {
    const record = {
      cursor: row.seq,
      ...JSON.parse(row.event_json),
      createdAt: row.created_at,
    };
    const size = Buffer.byteLength(JSON.stringify(record));
    if (bytes + size > limit) break;
    bytes += size;
    records.push(record);
    nextCursor = row.seq;
  }
  return {
    events: records,
    nextCursor,
    snapshotRequired: false,
    state: run.state,
    truncated: rows.length > records.length,
  };
}

export { pruneRunEvents } from "./store";

function fileVersion(
  path: string,
  initial: Stats,
): { contentVersion: string; versionKind: string } {
  const { size, mtimeMs } = initial;
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (
      ["ELOOP", "ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw new ControllerError(
        "artifact_changed",
        "Artifact changed before opening; query again",
        409,
      );
    throw error;
  }
  try {
    // The path can be replaced after scopedPath/stat (including a parent
    // directory swap). Verify the descriptor before reading even one byte.
    const opened = fstatSync(descriptor);
    if (opened.dev !== initial.dev || opened.ino !== initial.ino)
      throw new ControllerError(
        "artifact_changed",
        "Artifact changed before opening; query again",
        409,
      );
    // Large outputs still validate the descriptor, but never read its content.
    if (size > 16 * 1024 * 1024)
      return {
        contentVersion: `metadata:${size}:${mtimeMs}`,
        versionKind: "metadata",
      };
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let read;
    let position = 0;
    while (
      position < size &&
      (read = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      )) > 0
    ) {
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    const after = fstatSync(descriptor);
    if (position !== size || after.size !== size || after.mtimeMs !== mtimeMs)
      return {
        contentVersion: `metadata:${after.size}:${after.mtimeMs}`,
        versionKind: "changedDuringCheck",
      };
    return {
      contentVersion: "sha256:" + hash.digest("hex"),
      versionKind: "contentHash",
    };
  } finally {
    closeSync(descriptor);
  }
}

export function artifactPage(database: DatabaseSync, run: RunRow, offset = 0) {
  const workspace = getWorkspace(database, run.workspace_id),
    tasks = tasksOf(database, run.id);
  const declarations = tasks.flatMap((task) =>
    (JSON.parse(task.outputs_json) as string[]).map((path) => ({
      taskId: task.id,
      key: task.task_key,
      path,
      root: (JSON.parse(task.config_json) as { workspaceRoot: string })
        .workspaceRoot,
    })),
  );
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > declarations.length
  )
    throw new ControllerError("invalid_arguments", "Invalid artifact cursor");
  const artifacts: Record<string, unknown>[] = [];
  let nextCursor = offset;
  const checkedAt = new Date().toISOString();
  for (const declaration of declarations.slice(offset)) {
    if (workspace.rootPath !== declaration.root)
      throw new ControllerError(
        "scope_changed",
        "Workspace root changed; artifact scope must be reviewed",
        403,
      );
    const resolved = scopedPath(declaration.root, declaration.path);
    let stat;
    try {
      stat = statSync(resolved.path, { throwIfNoEntry: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENAMETOOLONG") throw error;
    }
    const { root: _, ...reference } = declaration;
    const metadata = stat
      ? {
          exists: true,
          type: stat.isFile()
            ? "file"
            : stat.isDirectory()
              ? "directory"
              : "other",
          size: stat.size,
          ...(stat.isFile()
            ? fileVersion(resolved.path, stat)
            : {
                contentVersion: `metadata:${stat.size}:${stat.mtimeMs}`,
                versionKind: "metadata",
              }),
        }
      : { exists: false, type: "missing", size: null, contentVersion: null };
    const entry = { ...reference, ...metadata, checkedAt };
    if (
      Buffer.byteLength(
        JSON.stringify({
          runId: run.id,
          artifacts: [...artifacts, entry],
          truncated: true,
          nextCursor: nextCursor + 1,
          immutableSnapshot: false,
        }),
      ) > PAGE_BYTES
    )
      break;
    artifacts.push(entry);
    nextCursor++;
  }
  return {
    runId: run.id,
    artifacts,
    truncated: nextCursor < declarations.length,
    nextCursor,
    immutableSnapshot: false,
  };
}
