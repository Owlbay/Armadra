import { existsSync } from "node:fs";
import {
  HOOK_CLIENT_REVISION,
  INTEGRATION_REVISION,
  SKILLS_REVISION,
} from "./events";
import {
  CLAUDE_MODS_MIN,
  type ClaudeModsReason,
  type InjectionOptions,
  artifactLayout,
  canvasInjection,
  claudeModsGate,
  codexHooksWarning,
  currentLauncher,
  globalWritesDisabled,
  isInjected,
  prepareInjection,
  readLauncherMarker,
  probedClaudeVersion,
  readMarker,
  removeInjection,
  resetClaudeMod,
  shimPath,
} from "./inject";
import { hookService } from "../service";
import {
  type MigrationRecord,
  migrateGlobalInstalls,
  readMigration,
} from "./migrate";
import { type LegacyFinding, OWN_SKILL_DIRS, scanIn } from "./repair";
import {
  type ClientEnvironment,
  InstallError,
  configHome,
  describe,
} from "./shared";
import { SKILLS_ROOT, revisionOf } from "./skills";
import { type AcpCanvasTools, acpAdapter } from "../../acp/adapters";
import { acpClientFeatures } from "../../acp/client";
import { definition, resolveCommand } from "../../agent/registry";
import type { OutdatedHost } from "../../remote/fleet";

/**
 * What the settings page reads and does for one CLI's integration
 * (docs/design/canvas-only-integration.md §5).
 *
 * There is no "install into the CLI" any more: hook, skill and canvas
 * instructions are artifacts under our data directory that only a canvas
 * launch hands over through its launcher (docs/design/canvas-launcher.md
 * §8.2). So the state answers "are the artifacts and the launcher current" and
 * the one action is "regenerate them". Nothing is written into the CLI's own
 * configuration any more — {@link IntegrationState.globalWrites} is always
 * empty — and what the one-time migration took out of the old global install
 * is reported rather than hidden.
 */

/** Half of the integration, as the settings page reads it. */
export interface IntegrationPart {
  readonly installed: boolean;
  /** The artifact this half lives in, present or not. */
  readonly path?: string;
  /** The revision on disk; `0` when this half is missing. */
  readonly revision: number;
}

/** What the migration did for this CLI — the page's "cleaned up" badge. */
export interface MigrationSummary {
  readonly migratedAt: string;
  readonly removed: readonly string[];
  readonly backups: readonly string[];
  readonly error?: string;
  /** Codex only: the session-flag trust records the second step took out. */
  readonly sessionTrust?: {
    readonly at: string;
    readonly removed: readonly string[];
    readonly backup?: string;
    readonly error?: string;
  };
}

/** `GET /api/agents/{id}/integration`. */
export interface IntegrationState {
  readonly agentId: string;
  /** Always `canvas`: injected into canvas launches only. */
  readonly mode: string;
  readonly hook: IntegrationPart;
  readonly skill: IntegrationPart;
  readonly legacy: { readonly found: readonly LegacyFinding[] };
  /** The revision a regeneration writes. */
  readonly revision: number;
  /** The revision the artifacts on disk were written by. */
  readonly installedRevision?: number;
  /** Written by an older Armadra; the next launch rewrites them anyway. */
  readonly stale: boolean;
  /** Argv the launcher appends to a canvas launch of this CLI, literal. */
  readonly launchArgs: readonly string[];
  /** Names of the environment variables the launcher sets for the CLI. */
  readonly launchEnv: readonly string[];
  /**
   * Files outside our data directory this integration writes: none. Kept one
   * release for older pages, always `[]`.
   */
  readonly globalWrites: readonly string[];
  /** `run/<cli>` on this machine, when it is there and current. */
  readonly launcher?: string;
  /** `shims/<cli>` on this machine, when it is there. */
  readonly shim?: string;
  /**
   * Why canvas launches of this CLI carry less than they should: no
   * launcher on Windows (no `armadra-launch.exe`), or a Codex too old for
   * hooks.
   */
  readonly launcherWarning?: string;
  readonly migration?: MigrationSummary;
  /** Absolute path of the hook client the artifacts name. */
  readonly clientBin?: string;
  /**
   * Execution hosts whose Worker is out of date (contract §21.2): canvas
   * launches in SSH terminals there carry a stale injection until the host is
   * resynced. Present whenever the core has a remote domain; usually `[]`.
   */
  readonly outdatedHosts?: readonly OutdatedHost[];
  readonly warning?: string;
  /** 能不能在画布中创建 Agent（契约 §48）。 */
  readonly canvasAgents: CanvasAgents;
  /** Claude only: whether canvas launches load the mod (contract §57.5). */
  readonly mods?: ModsState;
}

/* ---------------------------------- mods ---------------------------------- */

/** One session that said hello (`POST /node/mod`), as the page reads it. */
export interface ModSession {
  readonly nodeId: string;
  readonly version: string;
  readonly profile: "terminal" | "acp";
  readonly transport: "socket" | "tcp" | "process";
  readonly reportedAt: string;
}

/** `agents.integration.mods` (contract §57.5). */
export interface ModsState {
  readonly gate: "enabled" | "disabled";
  readonly reason: ClaudeModsReason | null;
  readonly minVersion: string;
  readonly probedVersion: string | null;
  readonly sessions: readonly ModSession[];
}

/** The gate as this machine's next launch reads it, and the hellos heard. */
export function modsState(
  probedVersion: string | null | undefined,
  sessions: readonly ModSession[],
  windows: boolean = process.platform === "win32",
): ModsState {
  const gate = claudeModsGate(probedVersion, { windows });
  return {
    gate: gate.enabled ? "enabled" : "disabled",
    reason: gate.reason,
    minVersion: CLAUDE_MODS_MIN,
    probedVersion: probedVersion ?? null,
    sessions,
  };
}

function heardModSessions(): ModSession[] {
  return (hookService()?.modSessions() ?? [])
    .filter((hello) => hello.engine === "claude")
    .map((hello) => ({
      nodeId: hello.nodeId,
      version: hello.version,
      profile: hello.profile,
      transport: hello.transport,
      reportedAt: hello.reportedAt,
    }));
}

/* ---------------------------- 在画布中创建 Agent ---------------------------- */

export type CanvasAgentState = "available" | "limited" | "unavailable";
export type CanvasAgentReason =
  | "hook_missing"
  | "skill_missing"
  | "launcher_limited"
  | "cli_missing"
  | "acp_missing"
  | "mcp_not_wired"
  | "client_without_mcp";

export interface CanvasAgents {
  readonly terminal: CanvasAgentState;
  readonly acp: CanvasAgentState | "none";
  readonly reasons: readonly CanvasAgentReason[];
}

export interface CanvasAgentsInput {
  readonly cliInstalled: boolean;
  readonly hookInstalled: boolean;
  readonly skillInstalled: boolean;
  readonly launcherLimited: boolean;
  /** 这家没有 ACP 入口时缺席。 */
  readonly acp?: {
    readonly installed: boolean;
    readonly canvasTools: AcpCanvasTools;
  };
  /** 这一版 ACP 客户端开会话时能不能带 MCP 服务器。 */
  readonly clientMcp: boolean;
}

/**
 * 两种驱动下能不能建 Agent（契约 §48）。终端驱动靠注入的技能与 Hook 身份：技能
 * 在而 Hook 缺或启动器受限 = `limited`（能发命令，但没有节点身份，core 会拒）；
 * CLI 没装或技能缺 = `unavailable`。会话视图靠适配器的画布工具。
 */
export function canvasAgentsOf(input: CanvasAgentsInput): CanvasAgents {
  const reasons: CanvasAgentReason[] = [];
  let terminal: CanvasAgentState;
  if (!input.cliInstalled) reasons.push("cli_missing");
  if (!input.skillInstalled) reasons.push("skill_missing");
  if (!input.hookInstalled) reasons.push("hook_missing");
  if (input.launcherLimited) reasons.push("launcher_limited");
  if (!input.cliInstalled || !input.skillInstalled) terminal = "unavailable";
  else if (!input.hookInstalled || input.launcherLimited) terminal = "limited";
  else terminal = "available";

  let acp: CanvasAgents["acp"];
  if (input.acp === undefined) acp = "none";
  else if (!input.acp.installed) {
    acp = "unavailable";
    reasons.push("acp_missing");
  } else if (input.acp.canvasTools === "none") {
    acp = "limited";
    reasons.push("mcp_not_wired");
  } else if (input.acp.canvasTools === "mcp" && !input.clientMcp) {
    acp = "limited";
    reasons.push("client_without_mcp");
  } else acp = "available";
  return { terminal, acp, reasons };
}

export interface IntegrationOptions {
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly client?: ClientEnvironment;
  /** The CLI's config home; resolved from the environment when absent. */
  readonly home?: string;
  readonly now?: () => Date;
  /** Windows: the `armadra-launch.exe` to copy (`InjectionOptions.launchExe`). */
  readonly launchExe?: string;
  /** The Worker fleet's outdated hosts (`remote/fleet.ts::outdatedHosts`). */
  readonly outdatedHosts?: () => readonly OutdatedHost[];
  /** ACP 客户端能不能带 MCP；缺省问 `acpClientFeatures()`（用例注入）。 */
  readonly clientMcp?: () => boolean;
  /** The mod hellos heard; the running hook service's when absent. */
  readonly modSessions?: () => readonly ModSession[];
}

function requireInjected(agentId: string): void {
  if (!isInjected(agentId)) {
    throw new InstallError(
      400,
      "bad_request",
      `${agentId} has no canvas injection`,
    );
  }
}

function injectionOptions(
  agentId: string,
  options: IntegrationOptions,
): InjectionOptions {
  return {
    dataDir: options.dataDir,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.launchExe === undefined
      ? {}
      : { launchExe: options.launchExe }),
  };
}

function migrationFor(
  record: MigrationRecord | undefined,
  agentId: string,
): MigrationSummary | undefined {
  const entry = record?.agents[agentId];
  if (record === undefined || entry === undefined) return undefined;
  const trust = agentId === "codex" ? record.sessionTrust : undefined;
  return {
    migratedAt: record.migratedAt,
    removed: entry.removed.filter(isOwnRecordEntry),
    backups: entry.backups.filter(isOwnRecordEntry),
    ...(entry.error === undefined ? {} : { error: entry.error }),
    ...(trust === undefined
      ? {}
      : {
          sessionTrust: {
            at: trust.at,
            removed: trust.removed,
            ...(trust.backup === undefined ? {} : { backup: trust.backup }),
            ...(trust.error === undefined ? {} : { error: trust.error }),
          },
        }),
  };
}

/**
 * Whether a line of an earlier build's migration record is about something of
 * ours. Those builds also removed skill directories under names that are not
 * Armadra's; those lines are not ours to show.
 */
function isOwnRecordEntry(entry: string): boolean {
  const segments = entry.split(/[\\/]/);
  const at = segments.lastIndexOf(SKILLS_ROOT);
  if (at < 0 || at + 1 >= segments.length) return true;
  return OWN_SKILL_DIRS.includes(segments[at + 1] as string);
}

function isPresent(path: string | undefined): boolean {
  return path !== undefined && existsSync(path);
}

/* --------------------------------- reading -------------------------------- */

export function state(
  agentId: string,
  options: IntegrationOptions,
  warning?: string,
): IntegrationState {
  requireInjected(agentId);
  const env = options.env ?? process.env;
  // ama never had a global install, so there is no config home to scan.
  const home =
    agentId === "ama" ? undefined : (options.home ?? configHome(agentId, env));
  const layout = artifactLayout(options.dataDir, agentId);
  const marker = readMarker(options.dataDir, agentId);
  const hookFile =
    layout.settings ??
    layout.module ??
    layout.pluginHooks ??
    layout.profile ??
    layout.marker;
  const hookInstalled = marker !== undefined && isPresent(hookFile);
  const skillRevision = revisionOf(layout.skill);
  const injection = canvasInjection({ dataDir: options.dataDir, agentId });
  const migration = migrationFor(readMigration(options.dataDir), agentId);
  const launcher = currentLauncher(options.dataDir, agentId);
  const shim = shimPath(options.dataDir, agentId);
  const launcherWarning =
    readLauncherMarker(options.dataDir)?.warning ??
    (agentId === "codex" ? codexHooksWarning() : undefined);
  const launchCmd = definition(agentId)?.launchCmd;
  const adapter = acpAdapter(agentId);
  const canvasAgents = canvasAgentsOf({
    cliInstalled:
      launchCmd !== undefined && resolveCommand(launchCmd, env) !== undefined,
    hookInstalled,
    skillInstalled: skillRevision !== undefined,
    launcherLimited: launcherWarning !== undefined,
    ...(adapter === undefined
      ? {}
      : {
          acp: {
            installed: resolveCommand(adapter.program, env) !== undefined,
            canvasTools: adapter.canvasTools,
          },
        }),
    clientMcp: (options.clientMcp ?? (() => acpClientFeatures().mcpServers))(),
  });
  return {
    agentId,
    mode: "canvas",
    hook: {
      installed: hookInstalled,
      // Codex's hooks are `-c` pairs its launcher carries.
      path: agentId === "codex" ? (launcher ?? hookFile) : hookFile,
      revision: hookInstalled ? HOOK_CLIENT_REVISION : 0,
    },
    skill: {
      installed: skillRevision !== undefined,
      path: layout.skill,
      revision: skillRevision ?? 0,
    },
    legacy: { found: home === undefined ? [] : scanIn(agentId, home) },
    revision: INTEGRATION_REVISION,
    stale: marker !== undefined && marker.revision !== INTEGRATION_REVISION,
    ...(marker === undefined ? {} : { installedRevision: marker.revision }),
    launchArgs: injection.args,
    launchEnv: injection.env.map(([name]) => name),
    globalWrites: [],
    ...(launcher === undefined ? {} : { launcher }),
    ...(isPresent(shim) ? { shim } : {}),
    ...(launcherWarning === undefined ? {} : { launcherWarning }),
    ...(migration === undefined ? {} : { migration }),
    ...(marker === undefined ? {} : { clientBin: marker.clientBin }),
    ...(options.outdatedHosts === undefined
      ? {}
      : { outdatedHosts: options.outdatedHosts() }),
    ...(warning === undefined ? {} : { warning }),
    canvasAgents,
    ...(agentId === "claude"
      ? {
          mods: modsState(
            probedClaudeVersion(),
            (options.modSessions ?? heardModSessions)(),
          ),
        }
      : {}),
  };
}

/* -------------------------------- writing --------------------------------- */

/**
 * `POST …/integration/install`: regenerate the artifacts and the launcher
 * now, whatever the marker says.
 */
export function install(
  agentId: string,
  options: IntegrationOptions,
): IntegrationState {
  requireInjected(agentId);
  prepareInjection(agentId, {
    ...injectionOptions(agentId, options),
    force: true,
  });
  return state(agentId, options);
}

/** `POST …/integration/uninstall`: remove the artifacts and the launcher. */
export function uninstall(
  agentId: string,
  options: IntegrationOptions,
): IntegrationState {
  requireInjected(agentId);
  removeInjection(agentId, injectionOptions(agentId, options));
  return state(agentId, options);
}

/* -------------------------------- start-up -------------------------------- */

export interface StartupReport {
  readonly migration?: MigrationRecord;
  readonly prepared: readonly string[];
  readonly failures: readonly { agentId: string; error: string }[];
}

/**
 * What core start-up does: the one-time migration, then every CLI's artifacts
 * and launcher made current — all under the data directory.
 *
 * Nothing global happens when {@link globalWritesDisabled}: the test suite's
 * cores run with the developer's real `HOME`.
 */
export function prepareAtStartup(options: IntegrationOptions): StartupReport {
  const env = options.env ?? process.env;
  const global = !globalWritesDisabled(env);
  const migration = global
    ? migrateGlobalInstalls({
        dataDir: options.dataDir,
        ...(options.now === undefined ? {} : { now: options.now }),
      })
    : undefined;
  const prepared: string[] = [];
  const failures: { agentId: string; error: string }[] = [];
  for (const agentId of [
    "claude",
    "codex",
    "opencode",
    "pi",
    "omp",
    "copilot",
    "ama",
  ]) {
    try {
      // The mod is rebuilt at every start (contract §57.1): whatever Claude
      // wrote into its folder since (generated types) goes with it.
      if (agentId === "claude") resetClaudeMod(options.dataDir);
      prepareInjection(agentId, injectionOptions(agentId, options));
      prepared.push(agentId);
    } catch (error) {
      failures.push({ agentId, error: describe(error) });
    }
  }
  return {
    ...(migration === undefined ? {} : { migration }),
    prepared,
    failures,
  };
}

export { HOOK_CLIENT_REVISION, INTEGRATION_REVISION, SKILLS_REVISION };
