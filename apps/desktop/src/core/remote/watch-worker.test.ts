import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { temporary, type Temporary } from "../files/workspace.fixture";
import { STARTUP_RECHECK_MS } from "../files/watch";
import { type RemotePush, WorkerSession } from "./session";

/**
 * A platform watcher that is not live yet when `watch` returns — FSEvents on
 * macOS for a moment after the call. Here it simply never fires, so the only
 * way the change below can reach the controller is the Worker's own late look.
 */
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    watch: () => Object.assign(new EventEmitter(), { close: () => undefined }),
  };
});

const { watchFiles } = await import("./watch-worker");

describe("a Worker watch whose platform watcher is not live yet", () => {
  let far: Temporary | undefined;
  let session: WorkerSession | undefined;
  afterEach(async () => {
    await session?.dispose();
    far?.remove();
  });

  it("still pushes a change made right after the watch was set up, once", async () => {
    far = temporary("armadra-watch-worker-");
    writeFileSync(join(far.path, "note.txt"), "one");
    const pushed: RemotePush[] = [];
    session = new WorkerSession((event) => pushed.push(event));
    watchFiles(session, far.path, "w1", ["note.txt"]);
    writeFileSync(join(far.path, "note.txt"), "two");

    const last = STARTUP_RECHECK_MS.at(-1) ?? 0;
    await new Promise((done) => setTimeout(done, last + 300));
    expect(pushed).toEqual([
      expect.objectContaining({
        type: "files.changed",
        watchId: "w1",
        path: "note.txt",
      }),
    ]);
  });
});
