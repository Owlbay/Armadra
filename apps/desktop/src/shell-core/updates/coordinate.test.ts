/**
 * What a desktop update may stop, and how a restart proves itself
 * (docs/design/updates-and-service-install.md §2.3, §3.4; acceptance R5, R6).
 * Ported from the Rust shell's coordinate suite, all 7 test functions.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import {
  CHECK_JITTER_MS,
  FIRST_CHECK_DELAY_MS,
  MIN_CHECK_INTERVAL_MS,
  installId,
  nextCheckDelayMs,
  readReleaseCache,
  releaseCacheKey,
  writeReleaseCache,
  clearPending,
  noReadings,
  pendingPath,
  readPending,
  verifyRestart,
  writePending,
  type Component,
  type HealthReadings,
  type PendingRestart,
} from "./coordinate";

const temporaries: string[] = [];

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "armadra-updates-"));
  temporaries.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function pending(): PendingRestart {
  return {
    expectedVersion: "0.2.0",
    previousVersion: "0.1.0",
    previousPackageUrl:
      "https://releases.invalid/download/v0.1.0/Armadra_0.1.0.dmg",
    notesUrl: "https://releases.invalid/v0.2.0",
    startedAtMs: 1_700_000_000_000,
  };
}

it("the pending record survives a round trip and clears once", () => {
  const directory = temporary();
  expect(readPending(directory)).toBeNull();
  expect(writePending(directory, pending())).toEqual({ ok: true });
  expect(readPending(directory)).toEqual(pending());
  expect(pendingPath(directory)).toBe(
    join(directory, "updates", "pending-restart.json"),
  );
  expect(pendingPath(String.raw`C:\Users\x\AppData\Local\Armadra`, win32)).toBe(
    String.raw`C:\Users\x\AppData\Local\Armadra\updates\pending-restart.json`,
  );
  clearPending(directory);
  expect(readPending(directory)).toBeNull();
  // Clearing a record that is already gone is success: what matters is that
  // none remains.
  expect(() => clearPending(directory)).not.toThrow();
});

/** R6: the shell and the Runtime both have to report the new version. */
it("a restart is complete only when both report the new version", () => {
  const all: HealthReadings = {
    shell: "0.2.0",
    runtime: "0.2.0",
  };
  expect(verifyRestart(pending(), all)).toEqual({
    outcome: "completed",
    version: "0.2.0",
  });
});

/**
 * A reading that could not be taken is not agreement. "I could not ask" and
 * "it answered with the new version" are different answers.
 */
it("a missing or stale reading reports the update as unfinished", () => {
  const cases: [HealthReadings, Component[]][] = [
    [{ shell: "0.2.0", runtime: "0.1.0" }, ["runtime"]],
    [{ shell: "0.2.0", runtime: null }, ["runtime"]],
    [noReadings(), ["shell", "runtime"]],
  ];
  for (const [readings, expected] of cases) {
    expect(verifyRestart(pending(), readings)).toEqual({
      outcome: "incomplete",
      mismatched: expected,
      expectedVersion: "0.2.0",
      previousVersion: "0.1.0",
      previousPackageUrl:
        "https://releases.invalid/download/v0.1.0/Armadra_0.1.0.dmg",
    });
  }
});

/**
 * A record with no expected version cannot be satisfied by anything, so it
 * reports "unfinished" rather than agreeing with empty readings.
 */
it("an empty expected version never counts as agreement", () => {
  const record = { ...pending(), expectedVersion: "  " };
  const outcome = verifyRestart(record, {
    shell: "",
    runtime: "",
  });
  expect(outcome.outcome).toBe("incomplete");
});

describe("when to ask the release index again (external services §3.1)", () => {
  it("never sooner than six hours after the last check, spread by jitter", () => {
    const last = 1_000_000;
    expect(MIN_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000);
    expect(nextCheckDelayMs(last, last, 0)).toBe(MIN_CHECK_INTERVAL_MS);
    expect(nextCheckDelayMs(last, last, 0.999)).toBeLessThan(
      MIN_CHECK_INTERVAL_MS + CHECK_JITTER_MS,
    );
    expect(nextCheckDelayMs(last, last, 0.5)).toBe(
      MIN_CHECK_INTERVAL_MS + CHECK_JITTER_MS / 2,
    );
    // Long overdue is still not "now": a start is not a check.
    expect(nextCheckDelayMs(last, last + 10 * MIN_CHECK_INTERVAL_MS, 0)).toBe(
      FIRST_CHECK_DELAY_MS,
    );
  });

  it("a first check waits for the start-up to settle", () => {
    expect(nextCheckDelayMs(null, 5, 0)).toBe(FIRST_CHECK_DELAY_MS);
    expect(nextCheckDelayMs(null, 5, 2)).toBe(
      FIRST_CHECK_DELAY_MS + CHECK_JITTER_MS,
    );
  });

  it("keeps the last answer for If-None-Match, keyed by source and channel", () => {
    const directory = mkdtempSync(join(tmpdir(), "armadra-cache-"));
    try {
      expect(readReleaseCache(directory)).toBeNull();
      const cache = {
        key: releaseCacheKey("https://api.github.com/repos/o/r", "beta"),
        etag: '"abc"',
        body: "[]",
        checkedAtMs: 7,
      };
      writeReleaseCache(directory, cache);
      expect(readReleaseCache(directory)).toEqual(cache);
      expect(releaseCacheKey("s", "beta")).not.toBe(
        releaseCacheKey("s", "stable"),
      );
      writeFileSync(join(directory, "updates", "release-index.json"), "{");
      expect(readReleaseCache(directory)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("an installation keeps one id", () => {
    const directory = mkdtempSync(join(tmpdir(), "armadra-install-id-"));
    try {
      const id = installId(directory);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(installId(directory)).toBe(id);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
