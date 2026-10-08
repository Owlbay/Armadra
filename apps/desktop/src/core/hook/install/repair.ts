import {
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { SKILLS_ROOT, instructionFile } from "./skills";
import {
  type JsonObject,
  type JsonValue,
  configHome,
  readJsonObject,
  writeJsonObject,
} from "./shared";

/**
 * What earlier versions of this product left in the user's CLI configuration
 * (docs/design/agent-integration.md §4), cleaned up only when the user asks.
 *
 * What is on disk out there, all of it ours:
 *
 *   * hook entries and status lines whose program is our hook client, under
 *     its current name or the one before the rename — including a developer
 *     build of it that was installed once and then moved;
 *   * the generated status modules that call that client;
 *   * skill directories we installed (`armadra`, the revision-4 pair and the
 *     pair before the rename), when the `SKILL.md` in them carries our
 *     signature;
 *   * the instruction block we fenced into the CLI's global `AGENTS.md` /
 *     `CLAUDE.md` before skills were separate;
 *   * the top-level `version` our installer wrote into Codex's `hooks.json`,
 *     which that CLI parses with `deny_unknown_fields` — one stale key and
 *     *every* hook in the file stops running.
 *
 * Three rules, in order of how much they matter:
 *
 *   1. **Ours by signature, never by resemblance.** An entry counts only when
 *      it names our own client binary, carries our skill trailer, or is fenced
 *      with our exact block names. Other tools install hooks, skills and
 *      instruction blocks into the same files; those are not looked at, not
 *      listed, not reported and never changed — not even when their names
 *      look like something we might once have written.
 *   2. **Back up before rewriting.** Any file this module rewrites is copied
 *      to `<file>.armadra-backup-<timestamp>` first. Our skills are not
 *      backed up: their body is a generated file of ours, and a backup beside
 *      a `SKILL.md` is a second skill the CLI would have to ignore.
 *   3. **Change only when asked.** Nothing here runs at start-up; the
 *      settings page's Repair button is the only thing that writes.
 */

/**
 * Our hook client as a path's last segment: the current name, the one before
 * the rename, and the Windows launchers of either. A directory of that name
 * (`…/<name>/x.sh`) is not the client and does not count.
 */
const OWN_CLIENT =
  /(?:^|[\s"'`=/\\])(?:armadra-hook|aicc-hook)(?:\.exe|\.cmd)?(?=$|[\s"'`;)])/i;

/** The instruction blocks we fenced, by their exact marker names. */
const OWN_BLOCKS = ["armadra:skills", "aicc:skills"];

/** Our skill trailer (`skills.ts` `revisionOf`). */
const OWN_SKILL_TRAILER = /<!--\s*armadra:skill-revision\s+\d+\s*-->/;

/**
 * Skill directories we installed under the CLI's skills root. A directory is
 * ours only when it has one of these names *and* its `SKILL.md` carries our
 * trailer or calls our client.
 */
export const OWN_SKILL_DIRS = [
  "armadra",
  "armadra-canvas",
  "armadra-linked-context",
  "aicc-canvas",
  "aicc-linked-context",
];

/** The providers a scan walks, in registry order. */
export const AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
] as const;

/** One thing of ours found, in the words the settings page shows. */
export interface LegacyFinding {
  /**
   * `hook_entry` / `skill_dir` / `codex_unknown_key` / `status_line` /
   * `instruction_block`.
   */
  readonly kind: string;
  /** The file or directory it was found in. */
  readonly path: string;
  /** The command, key or directory name of ours. */
  readonly detail: string;
}

/** What a repair pass did, per CLI (设计 §4). */
export interface RepairReport {
  agentId: string;
  /** Everything recognised, whether or not it was removed. */
  found: LegacyFinding[];
  /** Entries, keys and directories that are gone. */
  removed: string[];
  /**
   * Things of ours left in place: a skill directory something else sits in,
   * the rest of an instruction file. Never another tool's entries.
   */
  kept: string[];
  /** The newest backup written, for the sentence the settings page shows. */
  backup?: string;
  /** Every backup, in the order they were written. */
  backups: string[];
}

/** True when this command (or generated file) runs our own hook client. */
export function isOwnCommand(command: string): boolean {
  return OWN_CLIENT.test(command);
}

/** True when a `SKILL.md` body is one we generated. */
export function isOwnSkill(body: string): boolean {
  return OWN_SKILL_TRAILER.test(body) || isOwnCommand(body);
}

/* ---------------------------------- scan ---------------------------------- */

/** What this machine still carries for one provider, without changing anything. */
export function scan(agentId: string): LegacyFinding[] {
  return scanIn(agentId, configHome(agentId));
}

/**
 * Every provider's findings, in registry order. Used by startup detection,
 * where one provider's unreadable file must not hide the rest.
 */
export function scanAll(): LegacyFinding[] {
  return AGENT_IDS.flatMap((agentId) => {
    try {
      return scan(agentId);
    } catch {
      return [];
    }
  });
}

/**
 * The scan, with the config home passed in so the fixtures can be real file
 * shapes rather than the machine's own directories.
 */
export function scanIn(agentId: string, home: string): LegacyFinding[] {
  const found: LegacyFinding[] = [];
  for (const path of hookFiles(agentId, home)) {
    found.push(...scanHookFile(agentId, path));
  }
  for (const path of generatedModuleFiles(agentId, home)) {
    if (readText(path).some(isOwnCommand)) {
      found.push(finding("hook_entry", path, basename(path)));
    }
  }
  found.push(...scanSkills(home));
  for (const path of instructionFiles(agentId, home)) {
    for (const [name] of legacyBlocks(readText(path)[0] ?? "")) {
      found.push(finding("instruction_block", path, name));
    }
  }
  return found;
}

function finding(kind: string, path: string, detail: string): LegacyFinding {
  return { kind, path, detail };
}

function readText(path: string): [string] | [] {
  try {
    return [readFileSync(path, "utf8")];
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The global instruction files a provider reads and earlier versions of us wrote into. */
function instructionFiles(agentId: string, home: string): string[] {
  const files = [instructionFile(home)];
  if (agentId === "claude") files.push(join(home, "CLAUDE.md"));
  return files.filter(isFile);
}

/**
 * Every block of ours in an instruction file: its name and its character
 * range, start marker through end marker inclusive. Only {@link OWN_BLOCKS}
 * count; a start without its end is not a block we recognise, and is left
 * alone.
 */
export function legacyBlocks(text: string): [string, [number, number]][] {
  const blocks: [string, [number, number]][] = [];
  let cursor = 0;
  for (;;) {
    const offset = text.indexOf("<!-- ", cursor);
    if (offset < 0) break;
    const nameStart = offset + "<!-- ".length;
    const close = text.indexOf(" -->", nameStart);
    if (close < 0) break;
    const marker = text.slice(nameStart, close);
    cursor = close + " -->".length;
    if (!marker.endsWith(":start")) continue;
    const name = marker.slice(0, -":start".length);
    if (!OWN_BLOCKS.includes(name)) continue;
    const endMarker = `<!-- ${name}:end -->`;
    const endOffset = text.indexOf(endMarker, cursor);
    if (endOffset < 0) continue;
    const end = endOffset + endMarker.length;
    blocks.push([name, [offset, end]]);
    cursor = end;
  }
  return blocks;
}

/**
 * The file without our blocks, and the names of what went. The text
 * around them is kept character for character; only the blank lines a removed
 * block leaves behind are collapsed to one.
 */
export function stripLegacyBlocks(text: string): [string, string[]] {
  const blocks = legacyBlocks(text);
  if (blocks.length === 0) return [text, []];
  let out = "";
  let cursor = 0;
  const names: string[] = [];
  for (const [name, [start, end]] of blocks) {
    out += text.slice(cursor, start);
    cursor = end;
    names.push(name);
  }
  out += text.slice(cursor);

  let collapsed = "";
  let blank = 0;
  for (const line of out.split("\n").slice(0, -1).concat(lastLine(out))) {
    if (line.trim() === "") {
      blank += 1;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    collapsed += `${line}\n`;
  }
  return [collapsed, names];
}

/** `lines()` in Rust drops a trailing newline's empty tail; this matches it. */
function lastLine(text: string): string[] {
  const parts = text.split("\n");
  const tail = parts[parts.length - 1] ?? "";
  return tail === "" ? [] : [tail];
}

/**
 * The JSON files a provider keeps hook entries in. Copilot merges a whole
 * directory, so every file in it is read — and none of them is rewritten
 * unless it holds one of our commands.
 */
function hookFiles(agentId: string, home: string): string[] {
  switch (agentId) {
    case "claude":
      return [join(home, "settings.json")];
    case "codex":
      return [join(home, "hooks.json")];
    case "copilot":
      return jsonFiles(join(home, "hooks"));
    default:
      return [];
  }
}

/** The modules a provider auto-discovers; only ones calling our client count. */
function generatedModuleFiles(agentId: string, home: string): string[] {
  const directory =
    agentId === "opencode"
      ? join(home, "plugins")
      : agentId === "pi" || agentId === "omp"
        ? join(home, "extensions")
        : undefined;
  if (directory === undefined) return [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .map((name) => join(directory, name))
    .filter((path) => isFile(path) && [".js", ".ts"].includes(extname(path)));
}

function jsonFiles(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .map((name) => join(directory, name))
    .filter((path) => isFile(path) && extname(path) === ".json")
    .sort();
}

function scanHookFile(agentId: string, path: string): LegacyFinding[] {
  let document: JsonObject;
  try {
    document = readJsonObject(path);
  } catch {
    // A file we cannot parse is not residue we recognise. Codex reports it
    // itself, and guessing at its contents is how a repair turns into a
    // deletion.
    return [];
  }
  const found: LegacyFinding[] = [];
  if (hasOwnVersionKey(agentId, document)) {
    found.push(finding("codex_unknown_key", path, "version"));
  }
  const command = statusLineCommand(document);
  if (command !== undefined && isOwnCommand(command)) {
    found.push(finding("status_line", path, command));
  }
  for (const entry of hookCommands(document)) {
    if (isOwnCommand(entry)) found.push(finding("hook_entry", path, entry));
  }
  return found;
}

/**
 * The `version` key our Codex installer wrote, recognised only beside an
 * entry of ours: any other top-level key — or a `version` in a file we have
 * no entry in — belongs to whoever wrote it.
 */
function hasOwnVersionKey(agentId: string, document: JsonObject): boolean {
  return (
    agentId === "codex" &&
    document.version !== undefined &&
    hookCommands(document).some(isOwnCommand)
  );
}

function statusLineCommand(document: JsonObject): string | undefined {
  const statusLine = document.statusLine;
  if (
    typeof statusLine !== "object" ||
    statusLine === null ||
    Array.isArray(statusLine)
  ) {
    return undefined;
  }
  return typeof statusLine.command === "string"
    ? statusLine.command
    : undefined;
}

/**
 * Every command string under `hooks`, in both shapes: the grouped one Claude
 * and Codex use, and Copilot's flat list of entries with `exec`/`args`.
 */
function hookCommands(document: JsonObject): string[] {
  const commands: string[] = [];
  const events = document.hooks;
  if (typeof events !== "object" || events === null || Array.isArray(events)) {
    return commands;
  }
  for (const groups of Object.values(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const handlers =
        typeof group === "object" && group !== null && !Array.isArray(group)
          ? group.hooks
          : undefined;
      if (Array.isArray(handlers)) {
        for (const handler of handlers) {
          const command = entryCommand(handler);
          if (command !== undefined) commands.push(command);
        }
      } else {
        const command = entryCommand(group);
        if (command !== undefined) commands.push(command);
      }
    }
  }
  return commands;
}

/** The program an entry runs, in whichever key that entry spells it with. */
function entryCommand(entry: JsonValue): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return undefined;
  }
  for (const key of ["command", "exec", "bash", "powershell"]) {
    const value = entry[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function scanSkills(home: string): LegacyFinding[] {
  const root = join(home, SKILLS_ROOT);
  return OWN_SKILL_DIRS.map((name) => join(root, name))
    .filter((path) => readText(join(path, "SKILL.md")).some(isOwnSkill))
    .map((path) => finding("skill_dir", path, basename(path)));
}

/* --------------------------------- repair --------------------------------- */

export function repair(agentId: string): RepairReport {
  return repairIn(agentId, configHome(agentId));
}

/**
 * Backs up, removes what is ours, and rewrites each file in the current
 * shape. Everything else is left alone and not reported.
 */
export function repairIn(
  agentId: string,
  home: string,
  now: Date = new Date(),
): RepairReport {
  const report: RepairReport = {
    agentId,
    found: scanIn(agentId, home),
    removed: [],
    kept: [],
    backups: [],
  };
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);

  for (const path of hookFiles(agentId, home)) {
    repairHookFile(agentId, path, stamp, report);
  }
  for (const path of generatedModuleFiles(agentId, home)) {
    if (readText(path).some(isOwnCommand)) {
      rmSync(path, { force: true });
      report.removed.push(path);
    }
  }
  for (const entry of report.found.filter((one) => one.kind === "skill_dir")) {
    // The body is a generated file of ours; what a user may have put beside it
    // is not, so the directory goes only when nothing else is in it.
    rmSync(join(entry.path, "SKILL.md"), { force: true });
    try {
      rmdirSync(entry.path);
      report.removed.push(entry.path);
    } catch {
      report.removed.push(join(entry.path, "SKILL.md"));
      report.kept.push(entry.path);
    }
  }
  for (const path of instructionFiles(agentId, home)) {
    repairInstructionFile(path, stamp, report);
  }
  report.backup = report.backups[report.backups.length - 1];
  return report;
}

/**
 * Backs the instruction file up, drops the marked blocks, and writes the rest
 * back exactly as it was — or removes the file if nothing else was in it.
 */
function repairInstructionFile(
  path: string,
  stamp: string,
  report: RepairReport,
): void {
  const [text] = readText(path);
  if (text === undefined) return;
  const [stripped, names] = stripLegacyBlocks(text);
  if (names.length === 0) return;
  const backup = backupPath(path, stamp);
  copyFileSync(path, backup);
  report.backups.push(backup);
  if (stripped.trim() === "") {
    rmSync(path, { force: true });
    report.removed.push(path);
  } else {
    writeFileSync(path, stripped, "utf8");
    report.kept.push(`${path}: everything outside the marked blocks`);
  }
  for (const name of names) report.removed.push(`${path}: <!-- ${name} -->`);
}

function repairHookFile(
  agentId: string,
  path: string,
  stamp: string,
  report: RepairReport,
): void {
  let document: JsonObject;
  try {
    document = readJsonObject(path);
  } catch {
    return;
  }
  const removed: string[] = [];

  if (hasOwnVersionKey(agentId, document)) {
    // Codex reads this file with `deny_unknown_fields`: the key our installer
    // wrote stops every hook in it, the user's included.
    removed.push(`${path}: version`);
    delete document.version;
  }
  const command = statusLineCommand(document);
  if (command !== undefined && isOwnCommand(command)) {
    delete document.statusLine;
    removed.push(`${path}: statusLine`);
  }
  const events = document.hooks;
  if (typeof events === "object" && events !== null && !Array.isArray(events)) {
    stripOwnEntries(events, path, removed);
    if (Object.keys(events).length === 0) delete document.hooks;
  }

  if (removed.length === 0) return;
  const backup = backupPath(path, stamp);
  copyFileSync(path, backup);
  report.backups.push(backup);
  // Copilot's file is ours outright: once our entries are gone there is
  // nothing for it to say, and an empty `{"version":1}` is a file the user has
  // to wonder about later.
  if (document.hooks === undefined && isOursAlone(agentId, path, document)) {
    rmSync(path, { force: true });
    removed.push(path);
  } else {
    writeJsonObject(path, document);
  }
  report.removed.push(...removed);
}

/** Whether a file with no hooks left in it has nothing of the user's either. */
function isOursAlone(
  agentId: string,
  path: string,
  document: JsonObject,
): boolean {
  return (
    agentId === "copilot" &&
    basename(path) === "armadra.json" &&
    Object.keys(document).every((key) => key === "version")
  );
}

/**
 * Removes every entry of ours from a `hooks` map in either shape, recording
 * what went. Entries that are not ours are kept in place and not recorded.
 */
function stripOwnEntries(
  events: JsonObject,
  path: string,
  removed: string[],
): void {
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (typeof group !== "object" || group === null || Array.isArray(group)) {
        continue;
      }
      const handlers = group.hooks;
      if (Array.isArray(handlers)) {
        group.hooks = handlers.filter((handler) =>
          retainEntry(handler, path, event, removed, "hooks"),
        );
      }
    }
    // Copilot's flat shape: the group *is* the entry.
    const surviving = groups.filter((group) => {
      const handlers =
        typeof group === "object" && group !== null && !Array.isArray(group)
          ? group.hooks
          : undefined;
      if (handlers !== undefined) {
        return !Array.isArray(handlers) || handlers.length > 0;
      }
      return retainEntry(group, path, event, removed, "entry");
    });
    if (surviving.length === 0) delete events[event];
    else events[event] = surviving;
  }
}

function retainEntry(
  entry: JsonValue,
  path: string,
  event: string,
  removed: string[],
  shape: string,
): boolean {
  const command = entryCommand(entry);
  if (command === undefined || !isOwnCommand(command)) return true;
  removed.push(`${path}: ${event} ${shape} → ${command}`);
  return false;
}

function backupPath(path: string, stamp: string): string {
  return `${path}.armadra-backup-${stamp}`;
}
