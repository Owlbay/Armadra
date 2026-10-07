import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  renameSync,
  truncateSync,
} from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { fixture, type Fixture } from "../workspaces/fixture";
import { createWorkspace } from "../workspaces/table";
import { listBoards } from "../canvas/boards";
import { connect } from "../controller/store";
import { uuidV7, rfc3339 } from "../workspaces/support";
import { runById, event } from "./store";
import {
  artifactPage,
  eventPage,
  runSnapshot,
  pruneRunEvents,
} from "./queries";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    openSync: vi.fn(original.openSync),
    readSync: vi.fn(original.readSync),
  };
});

let core: Fixture, runId: string;
beforeEach(() => {
  core = fixture([]);
  const workspace = createWorkspace(core.database, {
    name: "query",
    rootPath: core.directory,
  });
  const controller = connect(core.database, workspace.id);
  runId = uuidV7();
  const at = rfc3339();
  core.database
    .prepare(
      "INSERT INTO runs (id, controller_id, workspace_id, board_id, state, max_concurrency, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 2, ?, ?, ?)",
    )
    .run(
      runId,
      controller.controllerId,
      workspace.id,
      listBoards(core.database, workspace.id)[0]!.id,
      Date.now() + 3600000,
      at,
      at,
    );
});
afterEach(() => {
  vi.restoreAllMocks();
  core.close();
});
function task(outputs: string[], key = "task") {
  const id = uuidV7(),
    at = rfc3339();
  core.database
    .prepare(
      "INSERT INTO run_tasks (id, run_id, task_key, node_id, config_json, prompt, after_json, outputs_json, state, delivery_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'private prompt never in responses', '[]', ?, 'pending', ?, ?, ?)",
    )
    .run(
      id,
      runId,
      key,
      uuidV7(),
      JSON.stringify({ workspaceRoot: core.directory }),
      JSON.stringify(outputs),
      uuidV7(),
      at,
      at,
    );
}
it("returns bounded current artifact references and missing files without inferring task success", () => {
  mkdirSync(join(core.directory, "reports"));
  writeFileSync(join(core.directory, "reports/change.md"), "report");
  task(["reports/change.md", "reports/missing.md"]);
  const result = artifactPage(core.database, runById(core.database, runId)!, 0);
  expect(result.artifacts).toEqual([
    expect.objectContaining({
      path: "reports/change.md",
      exists: true,
      type: "file",
      size: 6,
      contentVersion: expect.stringMatching(/^sha256:/),
    }),
    expect.objectContaining({ path: "reports/missing.md", exists: false }),
  ]);
  expect(runSnapshot(core.database, runById(core.database, runId)!).state).toBe(
    "queued",
  );
  expect(JSON.stringify(result)).not.toContain("private prompt");
});
it("rejects a symlink escape created after the run was frozen", () => {
  const outside = fixture([]);
  try {
    mkdirSync(join(outside.directory, "outside"));
    writeFileSync(join(outside.directory, "outside/report.md"), "secret");
    symlinkSync(
      join(outside.directory, "outside"),
      join(core.directory, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    task(["escape/report.md"]);
    expect(() =>
      artifactPage(core.database, runById(core.database, runId)!, 0),
    ).toThrow();
  } finally {
    outside.close();
  }
});
it.each([8, 16 * 1024 * 1024 + 1])(
  "refuses an artifact replaced between validation and open before reading any bytes (%i bytes)",
  (size) => {
    const path = join(core.directory, "report.md");
    writeFileSync(path, "original");
    truncateSync(path, size);
    task(["report.md"]);
    const realOpen = vi.mocked(fs.openSync).getMockImplementation()!;
    const readCalls = vi.mocked(fs.readSync).mock.calls.length;
    vi.mocked(fs.openSync).mockImplementationOnce(
      (...args: Parameters<typeof fs.openSync>) => {
        renameSync(path, path + ".original");
        writeFileSync(path, "replacement");
        return realOpen(...args);
      },
    );
    expect(() =>
      artifactPage(core.database, runById(core.database, runId)!, 0),
    ).toThrow("Artifact changed");
    expect(vi.mocked(fs.readSync).mock.calls.length).toBe(readCalls);
  },
);
it("returns metadata for a large output without reading its content", () => {
  const path = join(core.directory, "large.md");
  writeFileSync(path, "x");
  truncateSync(path, 16 * 1024 * 1024 + 1);
  task(["large.md"]);
  const readCalls = vi.mocked(fs.readSync).mock.calls.length;
  const result = artifactPage(core.database, runById(core.database, runId)!, 0);
  expect(result.artifacts[0]).toMatchObject({
    exists: true,
    size: 16 * 1024 * 1024 + 1,
    versionKind: "metadata",
    contentVersion: expect.stringMatching(/^metadata:/),
  });
  expect(vi.mocked(fs.readSync).mock.calls.length).toBe(readCalls);
});
it("rejects an ancestor replaced with a symlink or junction before opening the artifact", () => {
  const directory = join(core.directory, "reports");
  mkdirSync(directory);
  mkdirSync(directory + ".other");
  writeFileSync(join(directory, "report.md"), "original");
  writeFileSync(join(directory + ".other", "report.md"), "other content");
  task(["reports/report.md"]);
  const realOpen = vi.mocked(fs.openSync).getMockImplementation()!;
  const readCalls = vi.mocked(fs.readSync).mock.calls.length;
  vi.mocked(fs.openSync).mockImplementationOnce(
    (...args: Parameters<typeof fs.openSync>) => {
      renameSync(directory, directory + ".original");
      symlinkSync(
        directory + ".other",
        directory,
        process.platform === "win32" ? "junction" : "dir",
      );
      return realOpen(...args);
    },
  );
  expect(() =>
    artifactPage(core.database, runById(core.database, runId)!, 0),
  ).toThrow("Artifact changed");
  expect(vi.mocked(fs.readSync).mock.calls.length).toBe(readCalls);
});

// The controller is Unix-only. Windows file symlinks need privileges, unlike
// junctions; the parent swap above exercises descriptor validation there too.
if (process.platform !== "win32")
  it("does not follow a file symlink swapped in immediately before opening the artifact", () => {
    const path = join(core.directory, "report.md");
    writeFileSync(path, "original");
    writeFileSync(path + ".other", "other content");
    task(["report.md"]);
    const realOpen = vi.mocked(fs.openSync).getMockImplementation()!;
    const readCalls = vi.mocked(fs.readSync).mock.calls.length;
    vi.mocked(fs.openSync).mockImplementationOnce(
      (...args: Parameters<typeof fs.openSync>) => {
        renameSync(path, path + ".original");
        symlinkSync(path + ".other", path);
        return realOpen(...args);
      },
    );
    expect(() =>
      artifactPage(core.database, runById(core.database, runId)!, 0),
    ).toThrow("Artifact changed");
    expect(vi.mocked(fs.readSync).mock.calls.length).toBe(readCalls);
  });
it("paginates long output declarations without breaking JSON or exceeding the summary limit", () => {
  task(
    Array.from(
      { length: 16 },
      (_, i) =>
        "reports/" + Array(20).fill("x".repeat(90)).join("/") + "/file" + i,
    ),
  );
  const run = runById(core.database, runId)!;
  const first = artifactPage(core.database, run, 0);
  expect(first.truncated).toBe(true);
  expect(first.nextCursor).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(8192);
  expect(
    Buffer.byteLength(JSON.stringify(runSnapshot(core.database, run))),
  ).toBeLessThanOrEqual(8192);
  const second = artifactPage(core.database, run, first.nextCursor);
  expect(second.artifacts[0]).not.toEqual(first.artifacts[0]);
});
it("persists retention floors and never treats expired or ahead cursors as no events", () => {
  for (let i = 0; i < 120; i++)
    event(core.database, runId, "task.changed", { state: "running", i });
  pruneRunEvents(core.database, runId, 20);
  const run = runById(core.database, runId)!;
  expect(run.event_floor).toBeGreaterThan(0);
  expect(eventPage(core.database, run, 0)).toMatchObject({
    snapshotRequired: true,
  });
  const page = eventPage(core.database, run, run.event_floor);
  expect(page.events).toHaveLength(20);
  expect(page.snapshotRequired).toBe(false);
  expect(() => eventPage(core.database, run, page.nextCursor + 1)).toThrow();
});
