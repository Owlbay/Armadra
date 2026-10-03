import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join as nativeJoin } from "node:path";
import { AMA_KEY_VARIABLES } from "../../agent/ama-credentials";
import { variablesFor } from "../../agent/credentials/inject";
import { storedProbe } from "../../agent/probe";
import { eventKey } from "./codex";
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  COPILOT_HOOK_EVENTS,
  INTEGRATION_REVISION,
  OMP_HOOK_EVENTS,
  PI_HOOK_EVENTS,
} from "./events";
import { opencodePluginSource, piExtensionSource } from "./extension-template";
import {
  type LauncherSpec,
  launcherFiles,
  runDirectory,
  shimsDirectory,
} from "./launcher";
import {
  type ClientEnvironment,
  InstallError,
  type JsonObject,
  agentHostBundle,
  appendManagedGroup,
  hookCommand,
  resolveClientBinary,
  writeAtomically,
} from "./shared";
import { SKILLS_ROOT, SKILL_NAME, skillContent } from "./skills";
import {
  findLaunchExe,
  shimTargetFor,
  windowsLauncherFiles,
  windowsShimPath,
  writeWindowsLauncherFiles,
} from "./windows-launcher";

/**
 * Canvas-only integration: the one place that decides what a CLI started from
 * the board is handed, and the one place that writes it
 * (docs/design/canvas-only-integration.md, docs/design/canvas-launcher.md).
 *
 * The rule is "a CLI started outside the canvas is not touched at all, and
 * nothing is written outside our data directory". Every hook, skill and
 * instruction lives under `<data>/integration/<cli>/`, and reaches the CLI
 * through the canvas launcher `<data>/integration/run/<cli>`: the line typed
 * into the node's shell is only "launcher + program + the CLI's own flags",
 * and the launcher appends the injected argv and sets the injected variables
 * for the CLI process — only when `ARMADRA_NODE_ID` says this is a canvas
 * node. Codex trusts our session-flag hooks through
 * `--dangerously-bypass-hook-trust`; nothing goes into its `config.toml`.
 *
 * Three functions, in the order a launch uses them:
 *
 *   * {@link prepareInjection} writes the artifacts and the launcher and shim
 *     (idempotently, byte for byte);
 *   * {@link canvasInjection} answers the argv and the environment the
 *     launcher carries — pure apart from reading which artifacts are on disk
 *     and the cached Codex probe, so a list of agents can ask it per request;
 *   * {@link removeInjection} takes all of it back.
 */

/** The CLIs that have an injection. */
export const INJECTED_AGENTS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
  "ama",
] as const;

export function isInjected(agentId: string): boolean {
  return (INJECTED_AGENTS as readonly string[]).includes(agentId);
}

/** `<data>/integration/<cli>` — everything of one CLI's injection. */
export function integrationDir(dataDir: string, agentId: string): string {
  return nativeJoin(dataDir, "integration", agentId);
}

/**
 * How a layout joins its paths. The native one for this machine's data
 * directory; `path.posix.join` for the copy synced to an execution host
 * (`remote.ts`), which is POSIX whatever the controller runs on.
 */
export type PathJoin = (...parts: string[]) => string;

/* --------------------------------- layout --------------------------------- */

/**
 * Where each artifact of one CLI lives. Fixed, so a regeneration overwrites
 * its own files and OpenCode — which installs packages into its config
 * directory — keeps reusing the same one.
 */
export interface ArtifactLayout {
  readonly dir: string;
  /** The full `SKILL.md`. */
  readonly skill: string;
  /** The canvas instructions appended to the system prompt; not for Codex. */
  readonly instructions?: string;
  /** Claude's `--settings` file. */
  readonly settings?: string;
  /** Claude's and Copilot's `--plugin-dir`. */
  readonly pluginDir?: string;
  /** The plugin manifest inside {@link pluginDir}. */
  readonly manifest?: string;
  /** Copilot's plugin hooks file. */
  readonly pluginHooks?: string;
  /** OpenCode's `OPENCODE_CONFIG_DIR`. */
  readonly configDir?: string;
  /** The generated status reporter (OpenCode plugin, Pi / OMP extension). */
  readonly module?: string;
  /** OMP's `--config` overlay. */
  readonly overlay?: string;
  /** Pi's `--skill` directory, OMP's `customDirectories` entry. */
  readonly skillDir?: string;
  /** Copilot's `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`. */
  readonly instructionsDir?: string;
  /** ama's `--profile` (docs/design/coordinator-agent.md §2.4). */
  readonly profile?: string;
  /** ama's `profile.config`. */
  readonly config?: string;
  /** ama's `profile.sessionDir`: `<data>/ama/sessions`. */
  readonly sessionDir?: string;
  /** The marker naming the revision and client that wrote all of the above. */
  readonly marker: string;
}

function skillUnder(root: string, join: PathJoin): string {
  return join(root, SKILLS_ROOT, SKILL_NAME, "SKILL.md");
}

export function artifactLayout(
  dataDir: string,
  agentId: string,
  join: PathJoin = nativeJoin,
): ArtifactLayout {
  const dir = join(dataDir, "integration", agentId);
  const marker = join(dir, "injection.json");
  const instructions = join(dir, "instructions.md");
  switch (agentId) {
    case "claude": {
      const pluginDir = join(dir, "plugin");
      return {
        dir,
        marker,
        instructions,
        settings: join(dir, "settings.json"),
        pluginDir,
        manifest: join(pluginDir, ".claude-plugin", "plugin.json"),
        skill: skillUnder(pluginDir, join),
      };
    }
    case "codex":
      return { dir, marker, skill: skillUnder(dir, join) };
    case "opencode": {
      const configDir = join(dir, "config");
      return {
        dir,
        marker,
        instructions,
        configDir,
        module: join(configDir, "plugins", "armadra-status.js"),
        skill: skillUnder(configDir, join),
      };
    }
    case "pi":
    case "omp":
      return {
        dir,
        marker,
        instructions,
        module: join(dir, "armadra-status.ts"),
        skill: skillUnder(dir, join),
        skillDir: join(dir, SKILLS_ROOT, SKILL_NAME),
        ...(agentId === "omp" ? { overlay: join(dir, "overlay.yml") } : {}),
      };
    case "ama":
      return {
        dir,
        marker,
        instructions,
        skill: skillUnder(dir, join),
        skillDir: join(dir, SKILLS_ROOT),
        config: join(dir, "config.json"),
        profile: join(dir, "profile.json"),
        sessionDir: join(dataDir, "ama", "sessions"),
      };
    case "copilot": {
      const pluginDir = join(dir, "plugin");
      const instructionsDir = join(dir, "instructions");
      return {
        dir,
        marker,
        pluginDir,
        manifest: join(pluginDir, "plugin.json"),
        pluginHooks: join(pluginDir, "hooks.json"),
        skill: skillUnder(pluginDir, join),
        instructionsDir,
        instructions: join(
          instructionsDir,
          ".github",
          "instructions",
          "armadra.instructions.md",
        ),
      };
    }
    default:
      throw new InstallError(
        400,
        "bad_request",
        `${agentId} has no canvas injection`,
      );
  }
}

/* --------------------------------- marker --------------------------------- */

export interface InjectionMarker {
  readonly revision: number;
  /** The hook client every artifact names. */
  readonly clientBin: string;
  readonly writtenAt: string;
}

export function readMarker(
  dataDir: string,
  agentId: string,
): InjectionMarker | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(artifactLayout(dataDir, agentId).marker, "utf8"),
    ) as Partial<InjectionMarker>;
    return typeof parsed.revision === "number" &&
      typeof parsed.clientBin === "string"
      ? (parsed as InjectionMarker)
      : undefined;
  } catch {
    return undefined;
  }
}

function isFile(path: string | undefined): path is string {
  if (path === undefined) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------ what to write ------------------------------ */

/** Seconds; the client has its own 1.5s deadline. */
const HOOK_TIMEOUT_SECONDS = 5;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Which machine the artifacts are written for; this one when absent. */
export interface ArtifactTarget {
  readonly join?: PathJoin;
  readonly windows?: boolean;
  /**
   * ama's host adapter (`agent-host/ama-armadra.cjs`); {@link agentHostBundle}
   * when absent. `null`: none — the profile then names no `host`, and ama
   * starts without the canvas tools rather than failing on a missing file.
   */
  readonly amaHost?: string | null;
}

/**
 * ama's `config.json`: the profile-level defaults (coordinator-agent §2.4).
 * The node's own `--permission-mode` still wins — the command line is above
 * the profile.
 */
export const AMA_CONFIG = {
  version: 1,
  permission: { mode: "default" },
  compaction: { enabled: true },
  // `task` 不在 ama 的缺省预设里（只在 codemode 脚本里，而 codemode 只在
  // Node ≥ 25 开）。画布上它由适配器的 runner 接到画布节点（契约 §15.5），
  // 协调者得直接看得到它。
  tools: { default: ["+task"] },
} as const;

/**
 * ama's `profile.json`. Paths only, never a key and no key file: the keys the
 * settings hold reach ama as `AMA_API_KEY_<PROVIDER>` on its own process,
 * set by the launcher after a node-token exchange (contract §12.4), so ama
 * must read its environment (`authEnv` stays at its default). Without
 * `authFile` ama's own user-level `auth.json` — its `ama auth` / ChatGPT
 * login — keeps working. `trustProject` is left out (false): a repository's own
 * `.ama/` hooks and skills stay behind ama's trust prompt, as they would
 * outside the canvas.
 */
export function amaProfile(
  layout: ArtifactLayout,
  host: string | undefined,
): Record<string, unknown> {
  return {
    version: 1,
    ...(host === undefined ? {} : { host }),
    instructions: [layout.instructions as string],
    skillDirs: [layout.skillDir as string],
    config: layout.config as string,
    sessionDir: layout.sessionDir as string,
  };
}

function amaHostOf(target: ArtifactTarget): string | undefined {
  if (target.amaHost === null) return undefined;
  return target.amaHost ?? agentHostBundle();
}

/**
 * Every file of one CLI's injection, path → contents. Deterministic: the same
 * revision and client produce the same bytes, so regenerating is a no-op on
 * disk.
 */
export function artifactFiles(
  dataDir: string,
  agentId: string,
  clientBin: string,
  target: ArtifactTarget = {},
): Map<string, string> {
  const join = target.join ?? nativeJoin;
  const windows = target.windows ?? process.platform === "win32";
  const layout = artifactLayout(dataDir, agentId, join);
  const content = skillContent();
  const files = new Map<string, string>();
  if (content !== undefined) {
    files.set(layout.skill, content.skill());
    if (layout.instructions !== undefined) {
      const instructions = content.instructions(layout.skill);
      files.set(
        layout.instructions,
        agentId === "copilot"
          ? `---\napplyTo: "**"\n---\n\n${instructions}`
          : instructions,
      );
    }
  }
  const manifest = {
    name: "armadra",
    description: "Armadra canvas collaboration — loaded only for canvas nodes.",
    version: String(INTEGRATION_REVISION),
  };
  switch (agentId) {
    case "claude": {
      const events: JsonObject = {};
      appendManagedGroup(events, CLAUDE_HOOK_EVENTS, {
        type: "command",
        command: hookCommand(clientBin, agentId),
        timeout: HOOK_TIMEOUT_SECONDS,
      });
      files.set(layout.settings as string, json({ hooks: events }));
      files.set(layout.manifest as string, json(manifest));
      break;
    }
    case "codex":
      // Codex's hooks and instructions are all on the launch line.
      break;
    case "opencode":
      files.set(
        layout.module as string,
        opencodePluginSource(agentId, clientBin),
      );
      break;
    case "pi":
    case "omp":
      files.set(
        layout.module as string,
        piExtensionSource(
          agentId,
          clientBin,
          agentId === "omp" ? OMP_HOOK_EVENTS : PI_HOOK_EVENTS,
        ),
      );
      if (layout.overlay !== undefined) {
        files.set(
          layout.overlay,
          `skills:\n  customDirectories:\n    - ${JSON.stringify(join(layout.dir, SKILLS_ROOT))}\n`,
        );
      }
      break;
    case "copilot": {
      // `preToolUse` stays out: it is Copilot's one blocking event, and a
      // missing client would turn into "every tool call refused".
      const entry: JsonObject = {
        type: "command",
        bash: hookCommand(clientBin, agentId),
        ...(windows
          ? { powershell: `& ${hookCommand(clientBin, agentId)}` }
          : {}),
        timeoutSec: HOOK_TIMEOUT_SECONDS,
      };
      const hooks: JsonObject = {};
      for (const event of COPILOT_HOOK_EVENTS) hooks[event] = [{ ...entry }];
      files.set(layout.pluginHooks as string, json({ version: 1, hooks }));
      files.set(
        layout.manifest as string,
        json({ ...manifest, hooks: "hooks.json", skills: "skills/" }),
      );
      break;
    }
    case "ama":
      // The adapter speaks the hook HTTP itself; `clientBin` is not named.
      files.set(layout.config as string, json(AMA_CONFIG));
      files.set(
        layout.profile as string,
        json(amaProfile(layout, amaHostOf(target))),
      );
      break;
    default:
      break;
  }
  return files;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Writes what differs; answers the paths written. */
function writeFiles(files: Map<string, string>): string[] {
  const written: string[] = [];
  for (const [path, contents] of files) {
    if (readOrEmpty(path) === contents) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeAtomically(path, contents);
    written.push(path);
  }
  return written;
}

/** Writes what differs, with its mode; answers the paths written. */
function writeExecutables(
  files: Map<string, { content: string | Buffer; mode: number }>,
): string[] {
  const written: string[] = [];
  for (const [path, file] of files) {
    const bytes =
      typeof file.content === "string"
        ? Buffer.from(file.content, "utf8")
        : file.content;
    let same = false;
    try {
      same =
        readFileSync(path).equals(bytes) &&
        (statSync(path).mode & 0o777) === file.mode;
    } catch {
      same = false;
    }
    if (same) continue;
    mkdirSync(dirname(path), { recursive: true });
    const temporary = nativeJoin(
      dirname(path),
      `.${basename(path)}.armadra-tmp`,
    );
    writeFileSync(temporary, bytes);
    chmodSync(temporary, file.mode);
    renameSync(temporary, path);
    written.push(path);
  }
  return written;
}

/* ---------------------------------- Codex --------------------------------- */

/**
 * The flag that lets Codex run our session-flag hooks without a trust record
 * in the user's `config.toml` (docs/design/canvas-launcher.md §7). Only the
 * command-line flag works: `-c bypass_hook_trust=true` is ignored by the
 * session-flag layer (measured on Codex 0.160.0).
 */
export const CODEX_BYPASS_HOOK_TRUST = "--dangerously-bypass-hook-trust";

/**
 * The first Codex that honours {@link CODEX_BYPASS_HOOK_TRUST} in its TUI
 * (openai/codex#24317). Where the flag itself first appeared was not
 * verified; the design fixes the gate here.
 */
export const CODEX_HOOK_TRUST_BYPASS_MIN = "0.134.0";

function versionParts(version: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/**
 * Whether a Codex of this version gets the flag and the hooks. An unknown
 * version (not probed yet, the probe failed, unparsable) gets them: that is
 * what every launch did before the gate, and the probe answers within
 * seconds of start-up.
 */
export function codexBypassesTrust(
  version: string | null | undefined,
): boolean {
  if (version === undefined || version === null) return true;
  const have = versionParts(version);
  const need = versionParts(CODEX_HOOK_TRUST_BYPASS_MIN) as number[];
  if (have === undefined) return true;
  for (let index = 0; index < need.length; index += 1) {
    const a = have[index] as number;
    const b = need[index] as number;
    if (a !== b) return a > b;
  }
  return true;
}

/** The built-in Codex's cached probe version, read only. */
function probedCodexVersion(): string | undefined {
  const probe = storedProbe("codex");
  return probe?.status === "ok" && probe.version !== null
    ? probe.version
    : undefined;
}

/**
 * Why a canvas Codex starts without hooks, or `undefined` when it does not.
 * Too old a Codex neither knows the flag (it refuses to start) nor runs an
 * untrusted hook (it stops on "Hooks need review", in front of the first
 * delivery) — both worse than no hooks; status falls back to the screen.
 */
export function codexHooksWarning(
  version: string | null | undefined = probedCodexVersion(),
): string | undefined {
  if (codexBypassesTrust(version)) return undefined;
  return `Codex ${version as string} is older than ${CODEX_HOOK_TRUST_BYPASS_MIN}: canvas launches carry no hooks`;
}

function codexEvents(): string[] {
  return CODEX_HOOK_EVENTS.filter((event) => eventKey(event) !== undefined);
}

/** One hook table for Codex: `[{hooks=[{type="command",command=…}]}]`. */
function codexHookTable(command: string): string {
  return `[{hooks=[{type=${tomlString("command")},command=${tomlString(command)}}]}]`;
}

/** A TOML basic string; JSON's escapes are a subset TOML accepts. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * What Codex gets: the trust flag, no update prompt, the hooks, the
 * instructions. Without `hooks` (a Codex older than the gate) only the last
 * two.
 */
export function codexArgs(
  command: string,
  instructions?: string,
  hooks = true,
): string[] {
  const args = [
    ...(hooks ? [CODEX_BYPASS_HOOK_TRUST] : []),
    // The start-up "Update now?" prompt takes the first task as its answer
    // (Enter = upgrade). Key read off Codex 0.155.1 and checked in its TUI.
    "-c",
    "check_for_update_on_startup=false",
  ];
  if (hooks) {
    for (const event of codexEvents()) {
      args.push("-c", `hooks.${event}=${codexHookTable(command)}`);
    }
  }
  if (instructions !== undefined) {
    // Appended as a developer message; `model_instructions_file` would
    // replace the base prompt instead.
    args.push("-c", `developer_instructions=${tomlString(instructions)}`);
  }
  return args;
}

/* --------------------------------- launcher -------------------------------- */

/** `<data>/integration/launcher.json`: the launcher layer's marker. */
export interface LauncherMarker {
  readonly revision: number;
  readonly clientBin: string;
  /** `process.platform` the launchers were written for. */
  readonly platform: string;
  readonly writtenAt: string;
  /** Why there are no launchers (Windows without `armadra-launch.exe`). */
  readonly warning?: string;
}

export function launcherMarkerPath(dataDir: string): string {
  return nativeJoin(dataDir, "integration", "launcher.json");
}

export function readLauncherMarker(
  dataDir: string,
): LauncherMarker | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(launcherMarkerPath(dataDir), "utf8"),
    ) as Partial<LauncherMarker>;
    return typeof parsed.revision === "number" &&
      typeof parsed.clientBin === "string" &&
      typeof parsed.platform === "string"
      ? (parsed as LauncherMarker)
      : undefined;
  } catch {
    return undefined;
  }
}

function executableName(agentId: string, platform: string): string {
  return platform === "win32" ? `${agentId}.exe` : agentId;
}

/** `run/<cli>` (`run\<cli>.exe` on Windows), present or not. */
export function launcherPath(
  dataDir: string,
  agentId: string,
  platform: string = process.platform,
): string {
  return nativeJoin(
    runDirectory(dataDir, nativeJoin),
    executableName(agentId, platform),
  );
}

/** `shims/<cli>` (`shims\<cli>.exe` on Windows), present or not. */
export function shimPath(
  dataDir: string,
  agentId: string,
  platform: string = process.platform,
): string {
  return nativeJoin(
    shimsDirectory(dataDir, nativeJoin),
    executableName(agentId, platform),
  );
}

/** `<data>/integration/shims` — what a node terminal puts first on `PATH`. */
export function shimDirectoryOf(dataDir: string): string {
  return shimsDirectory(dataDir, nativeJoin);
}

/**
 * The launcher a canvas line of `agentId` (a built-in id) goes through on
 * this machine, or `undefined` when there is none to trust: not written yet,
 * written by another revision or for another platform. Callers then build a
 * bare line — no injection rather than the old injection on the line.
 */
export function currentLauncher(
  dataDir: string,
  agentId: string,
): string | undefined {
  if (!isInjected(agentId)) return undefined;
  const marker = readLauncherMarker(dataDir);
  if (
    marker === undefined ||
    marker.revision !== INTEGRATION_REVISION ||
    marker.platform !== process.platform ||
    // Windows without `armadra-launch.exe` (§5.3): an older `run\` left
    // behind would carry an older injection.
    marker.warning !== undefined
  ) {
    return undefined;
  }
  const path = launcherPath(dataDir, agentId);
  return isFile(path) ? path : undefined;
}

const WINDOWS_LAUNCHER_MISSING =
  "armadra-launch.exe is not available: canvas launches start without injection";

/**
 * The `armadra-launch.exe` the Windows launchers are copies of: the caller's
 * `launchExe`, else `ARMADRA_LAUNCH_EXE`, else the built one next to the app
 * ({@link findLaunchExe}). An empty override means "none"; an override that
 * is not a file is none as well — never a guess at another one.
 */
function launchExeOf(
  options: InjectionOptions,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const override = options.launchExe ?? env.ARMADRA_LAUNCH_EXE;
  if (override === undefined) return findLaunchExe();
  return isFile(override) ? override : undefined;
}

/**
 * A shim whose CLI can no longer be resolved would start the old target;
 * without one, a hand-typed name falls through to the next on `PATH` (§5.4).
 * Best effort: a shim that is running stays until the next terminal.
 */
function removeStaleShim(shimDir: string, agentId: string): void {
  const exe = windowsShimPath(shimDir, agentId);
  for (const file of [exe, `${exe.slice(0, -".exe".length)}.launch`]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // In use.
    }
  }
}

interface LauncherReport {
  readonly written: readonly string[];
  readonly launcher?: string;
  readonly warning?: string;
}

/**
 * Writes `run/<cli>` and `shims/<cli>` from what the launcher must carry, and
 * the launcher layer's marker. Deterministic, byte-compared: a launch that
 * changed nothing writes nothing. Rewritten on every prepare rather than
 * behind a marker, because the content also follows the Codex probe.
 */
function writeLaunchers(
  agentId: string,
  clientBin: string,
  options: InjectionOptions,
): LauncherReport {
  const { dataDir } = options;
  const env = options.env ?? process.env;
  const injection = launchInjection({ dataDir, agentId });
  const spec: LauncherSpec = {
    agentId,
    runDir: runDirectory(dataDir, nativeJoin),
    shimDir: shimsDirectory(dataDir, nativeJoin),
    args: injection.args,
    env: injection.env,
    credential: { client: clientBin, variables: variablesFor(agentId) },
    ...(agentId === "ama"
      ? { amaKeys: { client: clientBin, variables: AMA_KEY_VARIABLES } }
      : {}),
  };
  let written: string[];
  let warning: string | undefined;
  if (process.platform === "win32") {
    const exe = launchExeOf(options, env);
    if (exe === undefined) {
      // §5.3: no launcher at all; the marker's warning makes every line bare.
      written = [];
      warning = WINDOWS_LAUNCHER_MISSING;
    } else {
      const target = shimTargetFor(agentId, {
        ambient: env,
        shimDir: spec.shimDir,
      });
      if (target === undefined) removeStaleShim(spec.shimDir, agentId);
      written = writeWindowsLauncherFiles(
        windowsLauncherFiles({
          ...spec,
          exe,
          ...(target === undefined ? {} : { shimTarget: target }),
        }),
      );
    }
  } else {
    written = writeExecutables(launcherFiles(spec, nativeJoin));
  }
  const previous = readLauncherMarker(dataDir);
  if (
    previous === undefined ||
    previous.revision !== INTEGRATION_REVISION ||
    previous.clientBin !== clientBin ||
    previous.platform !== process.platform ||
    previous.warning !== warning
  ) {
    const marker: LauncherMarker = {
      revision: INTEGRATION_REVISION,
      clientBin,
      platform: process.platform,
      writtenAt: (options.now ?? (() => new Date()))().toISOString(),
      ...(warning === undefined ? {} : { warning }),
    };
    writeAtomically(launcherMarkerPath(dataDir), json(marker));
  }
  const launcher = currentLauncher(dataDir, agentId);
  return {
    written,
    ...(launcher === undefined ? {} : { launcher }),
    ...(warning === undefined ? {} : { warning }),
  };
}

/* --------------------------------- prepare -------------------------------- */

export interface InjectionOptions {
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly client?: ClientEnvironment;
  readonly now?: () => Date;
  /** Rewrite even when the marker says the artifacts are current. */
  readonly force?: boolean;
  /**
   * Windows: the `armadra-launch.exe` the launchers are copies of;
   * `ARMADRA_LAUNCH_EXE`, then the built one ({@link findLaunchExe}), when
   * absent. `""` means none: the launch lines go bare (§5.3).
   */
  readonly launchExe?: string;
}

export interface PrepareReport {
  readonly agentId: string;
  readonly clientBin: string;
  /** Paths whose bytes changed: artifacts, launcher and shim. */
  readonly written: readonly string[];
  /** `run/<cli>` when there is one on this machine. */
  readonly launcher?: string;
  /** Why there is no launcher (Windows without `armadra-launch.exe`). */
  readonly launcherWarning?: string;
}

/**
 * The switch that keeps a process from touching any CLI's global
 * configuration (the one-time migration). The test suite sets it: its cores
 * run with the developer's real `HOME`.
 */
export function globalWritesDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.ARMADRA_NO_GLOBAL_WRITES === "1";
}

function current(
  dataDir: string,
  agentId: string,
  env: NodeJS.ProcessEnv,
): InjectionMarker | undefined {
  const marker = readMarker(dataDir, agentId);
  if (marker === undefined || marker.revision !== INTEGRATION_REVISION) {
    return undefined;
  }
  if (!isFile(marker.clientBin)) return undefined;
  const layout = artifactLayout(dataDir, agentId);
  // ama's profile names the adapter bundle, which moves with the app: a
  // profile naming another one is stale whatever the marker says.
  if (
    layout.profile !== undefined &&
    readOrEmpty(layout.profile) !==
      json(amaProfile(layout, agentHostBundle(env)))
  ) {
    return undefined;
  }
  const expected = [
    layout.settings,
    layout.module,
    layout.pluginHooks,
    layout.manifest,
    layout.overlay,
    layout.config,
    layout.profile,
    ...(skillContent() === undefined
      ? []
      : [layout.skill, layout.instructions]),
  ].filter((path): path is string => path !== undefined);
  return expected.every(isFile) ? marker : undefined;
}

/**
 * Makes one CLI's injection current: artifacts written for this revision and
 * this client, then its launcher and shim. Everything stays under the data
 * directory. Cheap when nothing moved: a marker read, a few `stat`s and two
 * small byte comparisons.
 */
export function prepareInjection(
  agentId: string,
  options: InjectionOptions,
): PrepareReport {
  const env = options.env ?? process.env;
  const fresh =
    options.force === true ? undefined : current(options.dataDir, agentId, env);
  let clientBin: string;
  let written: string[] = [];
  if (fresh !== undefined) {
    clientBin = fresh.clientBin;
  } else {
    clientBin = resolveClientBinary({
      env,
      launcher: { dataDir: options.dataDir },
      ...options.client,
    });
    written = writeFiles(
      artifactFiles(options.dataDir, agentId, clientBin, {
        amaHost: agentHostBundle(env) ?? null,
      }),
    );
    const marker: InjectionMarker = {
      revision: INTEGRATION_REVISION,
      clientBin,
      writtenAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    writeAtomically(
      artifactLayout(options.dataDir, agentId).marker,
      json(marker),
    );
  }
  const launchers = writeLaunchers(agentId, clientBin, options);
  return {
    agentId,
    clientBin,
    written: [...written, ...launchers.written],
    ...(launchers.launcher === undefined
      ? {}
      : { launcher: launchers.launcher }),
    ...(launchers.warning === undefined
      ? {}
      : { launcherWarning: launchers.warning }),
  };
}

/**
 * Removes one CLI's artifacts, launcher and shim. What the settings page's
 * removal and the tests use; a normal launch never needs it. Touches nothing
 * outside the data directory.
 */
export function removeInjection(
  agentId: string,
  options: InjectionOptions,
): void {
  rmSync(artifactLayout(options.dataDir, agentId).dir, {
    recursive: true,
    force: true,
  });
  for (const directory of [
    runDirectory(options.dataDir, nativeJoin),
    shimsDirectory(options.dataDir, nativeJoin),
  ]) {
    for (const name of [agentId, `${agentId}.exe`, `${agentId}.launch`]) {
      rmSync(nativeJoin(directory, name), { force: true });
    }
  }
}

/* --------------------------------- inject --------------------------------- */

export interface InjectionRequest {
  readonly dataDir: string;
  /** The built-in id — a `custom:` entry resolves to its base first. */
  readonly agentId: string;
  /** The canvas node; carried in the environment, never in the argv. */
  readonly nodeId?: string;
  /**
   * A resumed session. Every CLI measured needs the same argv again on
   * resume, so this changes nothing today; it is part of the request so a
   * CLI that ever differs is answered here and nowhere else.
   */
  readonly resume?: boolean;
  /**
   * Codex's version, for the trust-bypass gate. The cached probe
   * (`agent/probe.ts::storedProbe`) when absent; `null` = unknown.
   */
  readonly codexVersion?: string | null;
}

export interface Injection {
  /**
   * Appended by the launcher after the caller's words, each value exactly
   * as the CLI should receive it.
   */
  readonly args: readonly string[];
  /** Set by the launcher for the CLI process only. */
  readonly env: readonly (readonly [string, string])[];
}

const NOTHING: Injection = { args: [], env: [] };

function codexInstructions(layout: ArtifactLayout, exists = isFile) {
  const content = skillContent();
  return exists(layout.skill) && content !== undefined
    ? content.developerInstructions(layout.skill)
    : undefined;
}

/**
 * What a canvas launch of `agentId` carries — what its launcher appends and
 * sets. Empty until {@link prepareInjection} has run for it: a flag pointing
 * at a file that is not there is an error the CLI prints on every start,
 * which is worse than starting with nothing.
 */
export function canvasInjection(request: InjectionRequest): Injection {
  return launchInjection(request);
}

function codexVersionOf(request: InjectionRequest): string | null | undefined {
  return request.codexVersion !== undefined
    ? request.codexVersion
    : probedCodexVersion();
}

/** The literal argv and environment: what the launcher carries. */
function launchInjection(request: InjectionRequest): Injection {
  if (!isInjected(request.agentId)) return NOTHING;
  const marker = readMarker(request.dataDir, request.agentId);
  if (marker === undefined) return NOTHING;
  return (
    injectionFromLayout(
      request.agentId,
      artifactLayout(request.dataDir, request.agentId),
      marker.clientBin,
      isFile,
      { codexHooks: codexBypassesTrust(codexVersionOf(request)) },
    ) ?? NOTHING
  );
}

/**
 * The argv and environment for one CLI's artifacts at `layout`, naming only
 * the files `exists` confirms. Shared by this machine's launcher (which asks
 * the disk) and the copy synced to an execution host (`remote.ts`, which
 * knows what it just wrote there and gives Codex its hooks: the host's Codex
 * version is not probed).
 */
export function injectionFromLayout(
  agentId: string,
  layout: ArtifactLayout,
  clientBin: string,
  exists: (path: string | undefined) => path is string,
  options: { readonly codexHooks?: boolean } = {},
): Injection | undefined {
  const isFile = exists;
  const skill = isFile(layout.skill);
  const instructions = isFile(layout.instructions)
    ? layout.instructions
    : undefined;
  switch (agentId) {
    case "claude":
      return {
        args: [
          ...(isFile(layout.settings) ? ["--settings", layout.settings] : []),
          ...(isFile(layout.manifest)
            ? ["--plugin-dir", layout.pluginDir as string]
            : []),
          ...(instructions === undefined
            ? []
            : ["--append-system-prompt-file", instructions]),
        ],
        env: [],
      };
    case "codex":
      return {
        args: codexArgs(
          hookCommand(clientBin, "codex"),
          codexInstructions(layout, exists),
          options.codexHooks ?? true,
        ),
        env: [],
      };
    case "opencode":
      return {
        args: [],
        env: [
          ["OPENCODE_CONFIG_DIR", layout.configDir as string],
          ...(instructions === undefined
            ? []
            : ([
                [
                  "OPENCODE_CONFIG_CONTENT",
                  JSON.stringify({ instructions: [instructions] }),
                ],
              ] as const)),
        ],
      };
    case "pi":
      return {
        args: [
          ...(isFile(layout.module) ? ["--extension", layout.module] : []),
          ...(skill ? ["--skill", layout.skillDir as string] : []),
          ...(instructions === undefined
            ? []
            : ["--append-system-prompt", instructions]),
        ],
        env: [],
      };
    case "omp":
      return {
        args: [
          ...(isFile(layout.module) ? [`--extension=${layout.module}`] : []),
          ...(skill && isFile(layout.overlay)
            ? [`--config=${layout.overlay}`]
            : []),
          ...(instructions === undefined
            ? []
            : [`--append-system-prompt=${instructions}`]),
        ],
        env: [],
      };
    case "ama":
      // One argument: everything else is in the profile, so the injection
      // never nears an argv limit (coordinator-agent §2.4).
      return {
        args: isFile(layout.profile) ? ["--profile", layout.profile] : [],
        env: [],
      };
    case "copilot":
      return {
        args: isFile(layout.manifest)
          ? ["--plugin-dir", layout.pluginDir as string]
          : [],
        env:
          instructions === undefined
            ? []
            : [
                [
                  "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
                  layout.instructionsDir as string,
                ],
              ],
      };
    default:
      return undefined;
  }
}
