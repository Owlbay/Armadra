import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKey } from "../core/terminal/session-host/auth";
import { SessionHostBackend } from "../core/terminal/session-host/backend";
import { PIPE_PREFIX } from "../core/terminal/session-host/protocol";
import { sessionKey } from "../core/terminal/backend";
import { type FakePty, fakeSpawner } from "./fake-pty";
import { SessionHost } from "./server";

/**
 * The session-host backend's `capture` (status §60.5): the host keeps bytes,
 * the core lays them out on a screen (`replay-screen.ts`) the way the direct
 * backend does. Runs everywhere — the host is the same code over a Unix
 * socket and a fake console (`server.test.ts` explains why) — and on Windows
 * over a real named pipe.
 */

const scrap: (() => void)[] = [];

afterEach(async () => {
  for (const undo of scrap.splice(0).reverse()) await undo();
});

interface Harness {
  readonly backend: SessionHostBackend;
  last(): FakePty;
}

async function serve(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-capture-"));
  const endpoint =
    process.platform === "win32"
      ? `${PIPE_PREFIX}capture-${randomBytes(8).toString("hex")}`
      : join(dataDir, "s");
  const spawner = fakeSpawner();
  const host = new SessionHost({
    dataDir,
    endpoint,
    key: ensureKey(dataDir),
    version: "armadra-session-host/test",
    spawn: spawner.spawn,
    tickMs: 60_000,
  });
  await host.listen();
  scrap.push(async () => {
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const backend = new SessionHostBackend({
    dataDir,
    endpoint,
    version: "test",
  });
  return { backend, last: spawner.last };
}

const KEY = sessionKey("node-capture");
const SIZE = { cols: 40, rows: 6 };

async function started(harness: Harness): Promise<void> {
  await harness.backend.create({
    sessionKey: KEY,
    generation: 1,
    workspaceId: "ws",
    cwd: tmpdir(),
    shell: "powershell.exe",
    args: [],
    env: [],
    size: SIZE,
  } as unknown as Parameters<SessionHostBackend["create"]>[0]);
}

async function attached(harness: Harness): Promise<() => void> {
  const attachment = await harness.backend.attach(KEY, 1, SIZE);
  attachment.onData(() => {});
  return () => {
    void harness.backend.detach(KEY, attachment.attachmentId);
  };
}

async function eventually(
  read: () => Promise<string>,
  wanted: (text: string) => boolean,
): Promise<string> {
  let text = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    text = await read();
    if (wanted(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return text;
}

describe("session-host capture", () => {
  it("reads a full-screen redraw as the screen, not as a run-on line", async () => {
    const harness = await serve();
    await started(harness);
    const detach = await attached(harness);
    scrap.push(detach);
    // A TUI: clear, then place two rows by cursor position, with a column
    // jump instead of spaces — what stripping escapes used to glue together.
    harness
      .last()
      .emit("\u001b[2J\u001b[1;1H> prompt\u001b[3;1Hstatus\u001b[3;20Hready");
    const plain = await eventually(
      () => harness.backend.capture(KEY, 50, false),
      (text) => text.includes("ready"),
    );
    expect(plain.split("\n")).toEqual([
      "> prompt",
      "",
      "status             ready",
    ]);
    const escaped = await harness.backend.capture(KEY, 50, true);
    expect(escaped).toContain("\u001b[3;20H");
  });

  it("keeps a character a chunk boundary split in two", async () => {
    const harness = await serve();
    await started(harness);
    const detach = await attached(harness);
    scrap.push(detach);
    const bytes = Buffer.from("画布 ok\r\n", "utf8");
    harness.last().emit(bytes.subarray(0, 2));
    harness.last().emit(bytes.subarray(2));
    const plain = await eventually(
      () => harness.backend.capture(KEY, 10, false),
      (text) => text.includes("ok"),
    );
    expect(plain).toBe("画布 ok");
  });

  it("starts the screen over from the host's replay on a re-attach", async () => {
    const harness = await serve();
    await started(harness);
    const first = await attached(harness);
    harness.last().emit("one\r\ntwo\r\n");
    await eventually(
      () => harness.backend.capture(KEY, 10, false),
      (text) => text.includes("two"),
    );
    first();
    // Output while nobody is attached reaches only the host's replay.
    harness.last().emit("three\r\n");
    const second = await attached(harness);
    scrap.push(second);
    const plain = await eventually(
      () => harness.backend.capture(KEY, 10, false),
      (text) => text.includes("three"),
    );
    // Not "one two one two three": the replay replaced what was there.
    expect(plain.split("\n")).toEqual(["one", "two", "three"]);
  });

  it("draws each byte once while two attachments are open", async () => {
    const harness = await serve();
    await started(harness);
    scrap.push(await attached(harness));
    harness.last().emit("before\r\n");
    await eventually(
      () => harness.backend.capture(KEY, 10, false),
      (text) => text.includes("before"),
    );
    const newer = await attached(harness);
    harness.last().emit("both\r\n");
    await eventually(
      () => harness.backend.capture(KEY, 10, false),
      (text) => text.includes("both"),
    );
    newer();
    // The older attachment takes over without a gap.
    harness.last().emit("after\r\n");
    const plain = await eventually(
      () => harness.backend.capture(KEY, 10, false),
      (text) => text.includes("after"),
    );
    expect(plain.split("\n")).toEqual(["before", "both", "after"]);
  });

  it("follows a resize", async () => {
    const harness = await serve();
    await started(harness);
    const detach = await attached(harness);
    scrap.push(detach);
    await harness.backend.resize(KEY, { cols: 10, rows: 4 });
    harness.last().emit("abcdefghijKLM");
    const plain = await eventually(
      () => harness.backend.capture(KEY, 10, false),
      (text) => text.includes("KLM"),
    );
    // Ten columns wide: the eleventh character wraps. (Shrinking the screen
    // may leave blank rows above, as it does for the direct backend.)
    expect(plain.split("\n").filter((line) => line !== "")).toEqual([
      "abcdefghij",
      "KLM",
    ]);
  });
});
