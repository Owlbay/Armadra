/**
 * Stopping what this shell owns before an install, and checking afterwards
 * that the update actually happened (design §2.3). A port of
 * the Rust shell this one replaced.
 *
 * 壳只拥有一个后台：进程内的 core（Runtime）。原先还要先认一遍「这个 Host 是不是
 * 我拉起的」（读 `launcher.json`、探 Host 的版本），独立 Host 进程拆掉之后那套
 * 判断没有对象了，一并删掉；装更新前只停 Runtime。
 *
 * 它还记着「什么时候再问」：自动检查的间隔（不短于 6 小时，带抖动）、发布索引
 * 上一次的 `ETag` 与正文，以及决定灰度归属的安装 id——都是 `<data dir>/updates/`
 * 下的小文件，与 `pending-restart.json` 放在一起。
 *
 * The rule that shapes the module: **the restart proves itself.** A new shell
 * reads `pending-restart.json` and compares the versions before it says
 * anything about an update; a mismatch is reported as "the update did not
 * finish", with the previous release's link, rather than being quietly
 * forgotten.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path, { join } from "node:path";

import type { Reason } from "./machine";

/**
 * What the shell writes before handing control to the installer, so the build
 * that starts next knows an update was supposed to happen.
 */
export interface PendingRestart {
  /** The version every side should report once the install worked. */
  expectedVersion: string;
  /** What was running before, so a failed update can point back at it. */
  previousVersion: string;
  /** Where to download the previous release by hand, if it comes to that. */
  previousPackageUrl: string;
  notesUrl: string;
  startedAtMs: number;
}

/** `<data dir>/updates/pending-restart.json`. */
export function pendingPath(
  dataDir: string,
  pathModule: typeof path = path,
): string {
  return pathModule.join(dataDir, "updates", "pending-restart.json");
}

export type Written = { ok: true } | { ok: false; reason: Reason };

/**
 * Records the restart. Written before the installer runs, because after it
 * runs this process may not exist.
 */
export function writePending(
  dataDir: string,
  pending: PendingRestart,
): Written {
  const path = pendingPath(dataDir);
  try {
    mkdirSync(join(dataDir, "updates"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: writeReason(error) };
  }
}

/**
 * "No space left" is the one write failure a person can act on, so it is told
 * apart from the rest instead of all of them becoming "install failed".
 */
function writeReason(error: unknown): Reason {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOSPC" ? "diskFull" : "installFailed";
}

/** Reads the record, or `null` when no update was pending. */
export function readPending(dataDir: string): PendingRestart | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pendingPath(dataDir), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.expectedVersion !== "string") return null;
  if (typeof record.previousVersion !== "string") return null;
  return {
    expectedVersion: record.expectedVersion,
    previousVersion: record.previousVersion,
    previousPackageUrl:
      typeof record.previousPackageUrl === "string"
        ? record.previousPackageUrl
        : "",
    notesUrl: typeof record.notesUrl === "string" ? record.notesUrl : "",
    startedAtMs:
      typeof record.startedAtMs === "number" ? record.startedAtMs : 0,
  };
}

/**
 * Drops the record. A missing file is success: the point is that no record
 * remains, not that this call is the one that removed it.
 */
export function clearPending(dataDir: string): void {
  const path = pendingPath(dataDir);
  if (!existsSync(path)) return;
  rmSync(path, { force: true });
}

/**
 * What the shell and the Runtime reported after the restart. An absent reading
 * is `null`, which is never treated as agreement.
 */
export interface HealthReadings {
  shell: string | null;
  runtime: string | null;
}

export function noReadings(): HealthReadings {
  return { shell: null, runtime: null };
}

/** Which of the two did not report the expected version. */
export type Component = "shell" | "runtime";

/** The verdict a restarted shell reaches (design §2.3, acceptance R6). */
export type RestartOutcome =
  /** Both report the expected version. */
  | { outcome: "completed"; version: string }
  /**
   * At least one does not. The pending record is kept so the page can offer
   * the previous release; nothing is rolled back automatically, because a
   * migrated database cannot be un-migrated (design §2.3).
   */
  | {
      outcome: "incomplete";
      mismatched: Component[];
      expectedVersion: string;
      previousVersion: string;
      previousPackageUrl: string;
    };

/**
 * Compares what the shell and the Runtime report with what the install promised.
 *
 * A reading that is missing counts as a mismatch. "I could not ask" and "it
 * answered with the new version" are different answers, and only the second
 * one means the update finished.
 */
export function verifyRestart(
  pending: PendingRestart,
  readings: HealthReadings,
): RestartOutcome {
  const expected = pending.expectedVersion.trim();
  const mismatched: Component[] = [];
  const pairs: [Component, string | null][] = [
    ["shell", readings.shell],
    ["runtime", readings.runtime],
  ];
  for (const [component, reading] of pairs) {
    const agrees =
      reading !== null && expected.length > 0 && reading.trim() === expected;
    if (!agrees) mismatched.push(component);
  }
  if (mismatched.length === 0)
    return { outcome: "completed", version: expected };
  return {
    outcome: "incomplete",
    mismatched,
    expectedVersion: expected,
    previousVersion: pending.previousVersion,
    previousPackageUrl: pending.previousPackageUrl,
  };
}

/* --------------------------- when to ask again ---------------------------- */

/**
 * The shortest interval between two automatic checks (external services §3.1).
 * GitHub allows 60 anonymous API calls an hour per IP, and an office behind one
 * NAT shares that; checking every six hours, with a 304 for an unchanged index,
 * keeps a room full of installations well inside it.
 */
export const MIN_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Spread so installations started together do not ask together. */
export const CHECK_JITTER_MS = 30 * 60 * 1000;
/** Nothing is asked while the app is still starting (first-run, pairing). */
export const FIRST_CHECK_DELAY_MS = 60 * 1000;

/**
 * How long until the next automatic check. `random` is in [0, 1). A check that
 * never happened is due after the start-up delay; otherwise not before the
 * interval plus jitter has passed since the last one — whatever the clock says,
 * never sooner than the start-up delay, so a restart is not a check.
 */
export function nextCheckDelayMs(
  lastCheckedAtMs: number | null,
  nowMs: number,
  random: number,
): number {
  const jitter = Math.floor(Math.min(Math.max(random, 0), 1) * CHECK_JITTER_MS);
  if (lastCheckedAtMs === null) return FIRST_CHECK_DELAY_MS + jitter;
  const due = lastCheckedAtMs + MIN_CHECK_INTERVAL_MS + jitter;
  return Math.max(FIRST_CHECK_DELAY_MS, due - nowMs);
}

/* ---------------------------- the release index --------------------------- */

/**
 * The last answer the release index gave, kept so the next check can ask
 * `If-None-Match` and reuse the body on a 304 (which does not count against the
 * rate limit). Keyed by everything that changes what the answer means — the
 * source and the channel — so switching to beta never reuses a stable answer.
 */
export interface ReleaseCache {
  key: string;
  etag: string;
  body: string;
  checkedAtMs: number;
}

/** `<data dir>/updates/release-index.json`. */
export function releaseCachePath(dataDir: string): string {
  return join(dataDir, "updates", "release-index.json");
}

export function releaseCacheKey(source: string, channel: string): string {
  return `${source}\n${channel}`;
}

/** The cached answer, or `null` when there is none (or it is unreadable). */
export function readReleaseCache(dataDir: string): ReleaseCache | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(releaseCachePath(dataDir), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.key !== "string" ||
    typeof record.etag !== "string" ||
    typeof record.body !== "string" ||
    typeof record.checkedAtMs !== "number"
  ) {
    return null;
  }
  return {
    key: record.key,
    etag: record.etag,
    body: record.body,
    checkedAtMs: record.checkedAtMs,
  };
}

/** Best-effort: a cache that cannot be written only costs one full answer. */
export function writeReleaseCache(dataDir: string, cache: ReleaseCache): void {
  try {
    mkdirSync(join(dataDir, "updates"), { recursive: true });
    writeFileSync(releaseCachePath(dataDir), JSON.stringify(cache));
  } catch {
    // Nothing depends on it.
  }
}

/* ------------------------------ install id -------------------------------- */

/**
 * A random id for this installation, made once and kept in
 * `<data dir>/updates/install-id`. It decides which side of a staged rollout
 * this installation falls on (`offer.ts::rolloutAccepts`) and is never sent
 * anywhere. A file that cannot be written still yields an id for this run.
 */
export function installId(dataDir: string): string {
  const path = join(dataDir, "updates", "install-id");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing;
  } catch {
    // Made below.
  }
  const id = randomUUID();
  try {
    mkdirSync(join(dataDir, "updates"), { recursive: true });
    writeFileSync(path, `${id}\n`);
  } catch {
    // This run still has an id; the next one draws again.
  }
  return id;
}
