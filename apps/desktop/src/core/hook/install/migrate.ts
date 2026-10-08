import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { INJECTED_AGENTS, integrationDir } from "./inject";
import { writeAtomically } from "./shared";

/**
 * The one-time start-up step of canvas-only integration
 * (docs/design/canvas-only-integration.md §4), confined to our own data
 * directory.
 *
 * Earlier builds of this step also took the old global installs back out of
 * each CLI's configuration and cleared Codex's session-flag trust records.
 * Start-up no longer touches anything under the user's home: whatever an
 * earlier version of us left there is listed on the settings page and removed
 * only when the user presses Repair (`repair.ts`), and only when it carries
 * our signature.
 *
 * What remains is the marker the old installer kept beside our own files,
 * removed once. The result is recorded in `<data>/integration/
 * global-migration.json`; a record present means "done". Records written by
 * earlier builds are read as they are, for the settings page.
 */

export interface AgentMigration {
  /** Files, entries and directories that are gone. */
  readonly removed: string[];
  /** Every backup written, in order. */
  readonly backups: string[];
  /** Why this CLI's part stopped half-way, when it did. */
  error?: string;
}

/** What an earlier build's second step did to Codex's `config.toml`. */
export interface SessionTrustMigration {
  readonly at: string;
  /** The `config.toml` looked at; absent when Codex has no home here. */
  readonly path?: string;
  /** The `hooks.state` keys taken out. */
  readonly removed: string[];
  /** The copy made beside it, only when the bytes changed. */
  readonly backup?: string;
  /** Why the file was left alone. */
  readonly error?: string;
}

export interface MigrationRecord {
  /**
   * 1: global installs removed; 2: and the session-flag trust records (both
   * by earlier builds); 3: our data directory only.
   */
  readonly version: 1 | 2 | 3;
  readonly migratedAt: string;
  readonly agents: Record<string, AgentMigration>;
  readonly sessionTrust?: SessionTrustMigration;
}

/** The record version this build writes. */
export const MIGRATION_VERSION = 3;

export interface MigrationOptions {
  readonly dataDir: string;
  readonly now?: () => Date;
}

export function migrationPath(dataDir: string): string {
  return join(dataDir, "integration", "global-migration.json");
}

export function readMigration(dataDir: string): MigrationRecord | undefined {
  try {
    return JSON.parse(
      readFileSync(migrationPath(dataDir), "utf8"),
    ) as MigrationRecord;
  } catch {
    return undefined;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Runs the step unless a record — this build's or an earlier one's — is
 * already there, and answers the record either way. Touches nothing outside
 * `dataDir`.
 */
export function migrateGlobalInstalls(
  options: MigrationOptions,
): MigrationRecord {
  const existing = readMigration(options.dataDir);
  if (existing !== undefined) return existing;
  const now = (options.now ?? (() => new Date()))();
  for (const agentId of INJECTED_AGENTS) {
    const marker = join(
      integrationDir(options.dataDir, agentId),
      "installed.json",
    );
    if (isFile(marker)) rmSync(marker, { force: true });
  }
  const record: MigrationRecord = {
    version: MIGRATION_VERSION,
    migratedAt: now.toISOString(),
    agents: {},
  };
  writeAtomically(
    migrationPath(options.dataDir),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}
