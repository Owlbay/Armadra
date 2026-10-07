import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { retireGlobalEntries, settingsPath } from "./claude";
import {
  configPath as codexConfigPath,
  hooksPath as codexHooksPath,
  uninstall as uninstallCodex,
} from "./codex";
import {
  hooksPath as copilotHooksPath,
  uninstall as uninstallCopilot,
} from "./copilot";
import { modulePath } from "./extensions";
import { INJECTED_AGENTS, integrationDir } from "./inject";
import { LEGACY_SKILL_DIRS } from "./repair";
import {
  configHome,
  describe,
  isManagedCommand,
  writeAtomically,
} from "./shared";
import { SKILLS_ROOT, SKILL_NAME, revisionOf } from "./skills";
import {
  isEditable,
  readDocument,
  removeTrustState,
  stateKeys,
} from "./toml-state";

/**
 * The one-time move from global installs to canvas-only injection
 * (docs/design/canvas-only-integration.md §4).
 *
 * Until this revision Armadra installed into each CLI's own configuration:
 * Codex's `hooks.json`, Copilot's `hooks/armadra.json`, a status module in
 * OpenCode's / Pi's / OMP's scanned directories, and `skills/armadra` for all
 * six. All of it fires — or is read by the model — in sessions the user
 * starts outside the canvas. The first start of this build takes it back out:
 *
 *   * **back up first.** A file the user also edits is copied to
 *     `<file>.armadra-backup-<timestamp>` beside it, the convention the repair
 *     button uses. A file only we ever wrote (the module, `SKILL.md`) is
 *     copied under `<data>/integration/global-backup-<timestamp>/` instead: a
 *     backup beside a `SKILL.md` or in a plugin directory is one more file the
 *     CLI would scan.
 *   * **remove only ours.** Hook entries are recognised by the client's name,
 *     modules and skills by their content; anything else in the same files
 *     is written back as it was read.
 *   * **once.** The result is recorded in `<data>/integration/
 *     global-migration.json`, and a record present means "done", failures
 *     included — a start that edits the user's files again and again is the
 *     behaviour this whole change exists to end. The settings page reads the
 *     record.
 *
 * Version 2 of the record adds a second step (docs/design/canvas-launcher.md
 * §10): the `trusted_hash` records the canvas-only build itself wrote into
 * Codex's `config.toml` for its session-flag hooks. The launcher passes
 * `--dangerously-bypass-hook-trust` instead, so they are taken back out —
 * the last write this app ever makes outside its data directory. A machine
 * already carrying a version-1 record runs only this step, once.
 */

export interface AgentMigration {
  /** Files, entries and directories that are gone. */
  readonly removed: string[];
  /** Every backup written, in order. */
  readonly backups: string[];
  /** Why this CLI's part stopped half-way, when it did. */
  error?: string;
}

/** What the second step did to Codex's `config.toml`. */
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
  /** 1: global installs removed; 2: and the session-flag trust records. */
  readonly version: 1 | 2;
  readonly migratedAt: string;
  readonly agents: Record<string, AgentMigration>;
  readonly sessionTrust?: SessionTrustMigration;
}

/** The record version this build writes. */
export const MIGRATION_VERSION = 2;

/**
 * The key prefix Codex files a hook passed with `-c hooks.<Event>=…` under:
 * the literal pseudo-path of its session-flag layer. Only our hooks were ever
 * passed that way and trusted there, so the prefix alone identifies them.
 */
export const CODEX_SESSION_KEY_PREFIX = "/<session-flags>/config.toml:";

export interface MigrationOptions {
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** Config homes by CLI; resolved from the environment when absent. */
  readonly homes?: Readonly<Record<string, string>>;
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

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Runs the migration unless it already ran on this data directory: both steps
 * on a machine without a record, only the second on one the previous build
 * migrated (its record is kept and raised to version 2). Answers the record
 * either way.
 */
export function migrateGlobalInstalls(
  options: MigrationOptions,
): MigrationRecord {
  const existing = readMigration(options.dataDir);
  if (existing !== undefined && existing.version !== 1) return existing;
  const now = (options.now ?? (() => new Date()))();
  const codexHome = options.homes?.codex ?? configHome("codex", options.env);
  if (existing !== undefined) {
    // Migrated by the previous build: only the step it did not have.
    const record: MigrationRecord = {
      ...existing,
      version: 2,
      sessionTrust: clearCodexSessionTrust(codexHome, now),
    };
    writeRecord(options.dataDir, record);
    return record;
  }
  const stamp = stampOf(now);
  const vault = join(options.dataDir, "integration", `global-backup-${stamp}`);
  const agents: Record<string, AgentMigration> = {};
  for (const agentId of INJECTED_AGENTS) {
    // ama never had a global install to take back.
    if (agentId === "ama") continue;
    const report: AgentMigration = { removed: [], backups: [] };
    agents[agentId] = report;
    try {
      const home = options.homes?.[agentId] ?? configHome(agentId, options.env);
      migrateOne(agentId, home, { stamp, vault, report });
      // The marker the old installer kept beside our own files.
      const marker = join(
        integrationDir(options.dataDir, agentId),
        "installed.json",
      );
      if (isFile(marker)) {
        rmSync(marker, { force: true });
        report.removed.push(marker);
      }
    } catch (error) {
      report.error = describe(error);
    }
  }
  const record: MigrationRecord = {
    version: 2,
    migratedAt: now.toISOString(),
    agents,
    sessionTrust: clearCodexSessionTrust(codexHome, now),
  };
  writeRecord(options.dataDir, record);
  return record;
}

function stampOf(now: Date): string {
  return now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function writeRecord(dataDir: string, record: MigrationRecord): void {
  writeAtomically(
    migrationPath(dataDir),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/**
 * The second step: drops every `hooks.state` table under
 * {@link CODEX_SESSION_KEY_PREFIX} from `<codexHome>/config.toml`.
 *
 * By key alone, without recomputing any hash — a record the user wrote for
 * the same key goes too, the edge the first version's notes already accepted.
 * A missing Codex home is not created; a file the line editor would mangle is
 * recorded and left alone; the backup beside it is only kept when the bytes
 * changed. Never throws: whatever happened is the answer, and the caller
 * records it. The Worker runs the same step on an execution host.
 */
export function clearCodexSessionTrust(
  codexHome: string,
  now: Date = new Date(),
): SessionTrustMigration {
  const at = now.toISOString();
  if (!existsSync(codexHome)) return { at, removed: [] };
  const path = codexConfigPath(codexHome);
  try {
    if (!isFile(path)) return { at, path, removed: [] };
    const document = readDocument(path);
    if (!isEditable(document)) {
      return {
        at,
        path,
        removed: [],
        error: `${path} is not valid TOML; left as it is`,
      };
    }
    const removed = stateKeys(document).filter((key) =>
      key.startsWith(CODEX_SESSION_KEY_PREFIX),
    );
    const next = removeTrustState(document, CODEX_SESSION_KEY_PREFIX, []);
    if (next === document) return { at, path, removed: [] };
    const backup = freeBackupPath(path, stampOf(now));
    copyFileSync(path, backup);
    writeAtomically(path, next);
    return { at, path, removed, backup };
  } catch (error) {
    return { at, path, removed: [], error: describe(error) };
  }
}

/**
 * `<file>.armadra-backup-<stamp>`, or with a `-2`, `-3`… when that is taken —
 * on a first migration the first step may already have backed this very file
 * up under the same stamp, and that copy is the older one.
 */
function freeBackupPath(path: string, stamp: string): string {
  const base = `${path}.armadra-backup-${stamp}`;
  if (!existsSync(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }
}

interface Pass {
  readonly stamp: string;
  readonly vault: string;
  readonly report: AgentMigration;
}

function migrateOne(agentId: string, home: string, pass: Pass): void {
  switch (agentId) {
    case "claude":
      rewriteWithBackup(settingsPath(home), pass, () =>
        retireGlobalEntries(home),
      );
      break;
    case "codex":
      // Both files move together: the trust records in `config.toml` name the
      // handlers in `hooks.json` by index.
      if (mentionsClient(codexHooksPath(home))) {
        rewriteWithBackup(
          [codexHooksPath(home), codexConfigPath(home)],
          pass,
          () => {
            uninstallCodex(home);
            return true;
          },
        );
      }
      break;
    case "copilot":
      if (mentionsClient(copilotHooksPath(home))) {
        rewriteWithBackup(copilotHooksPath(home), pass, () => {
          uninstallCopilot(home);
          return true;
        });
      }
      break;
    default: {
      const path = modulePath(agentId, home);
      if (mentionsClient(path)) removeOwnFile(path, home, agentId, pass);
      break;
    }
  }
  for (const name of [SKILL_NAME, ...LEGACY_SKILL_DIRS]) {
    const path = join(home, SKILLS_ROOT, name, "SKILL.md");
    // Ours by content: the current skill carries a revision trailer, and the
    // legacy directory names were never anyone else's.
    if (name === SKILL_NAME && revisionOf(path) === undefined) continue;
    if (!isFile(path)) continue;
    removeOwnFile(path, home, agentId, pass);
    try {
      rmdirSync(dirname(path));
    } catch {
      // Something the user put beside it keeps the directory.
    }
  }
}

function mentionsClient(path: string): boolean {
  const text = readOrUndefined(path);
  return text !== undefined && isManagedCommand(text);
}

/**
 * Backs every existing file in `paths` up beside itself, runs `edit`, and
 * keeps only the backups of files whose bytes actually changed.
 */
function rewriteWithBackup(
  paths: string | readonly string[],
  pass: Pass,
  edit: () => boolean,
): void {
  const list = typeof paths === "string" ? [paths] : paths;
  const before = new Map<string, string>();
  for (const path of list) {
    const text = readOrUndefined(path);
    if (text === undefined) continue;
    before.set(path, text);
    copyFileSync(path, `${path}.armadra-backup-${pass.stamp}`);
  }
  if (before.size === 0) return;
  edit();
  for (const [path, text] of before) {
    const backup = `${path}.armadra-backup-${pass.stamp}`;
    const after = readOrUndefined(path);
    if (after === text) {
      rmSync(backup, { force: true });
      continue;
    }
    pass.report.backups.push(backup);
    pass.report.removed.push(
      after === undefined ? path : `${path}: armadra-hook`,
    );
  }
}

/** Copies a file only we wrote into the vault, then removes it. */
function removeOwnFile(
  path: string,
  home: string,
  agentId: string,
  pass: Pass,
): void {
  const backup = join(pass.vault, agentId, relative(home, path));
  mkdirSync(dirname(backup), { recursive: true });
  copyFileSync(path, backup);
  rmSync(path, { force: true });
  pass.report.backups.push(backup);
  pass.report.removed.push(path);
}
