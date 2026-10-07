import {
  type ShellDialect,
  shellCommandLine,
  shellDialect,
} from "../terminal/shell";
import {
  canvasInjection,
  currentLauncher,
  isInjected,
  prepareInjection,
  shimDirectoryOf,
} from "../hook/install/inject";
import { canvasPath, defaultShell } from "../terminal/environment";
import { planLaunch } from "./launch";
import {
  type AgentSettings,
  baseAgent,
  launchTargetOf,
  resolveCommand,
} from "./registry";

/**
 * The one exit every canvas launch line leaves the core through
 * (docs/design/canvas-launcher.md §9).
 *
 * The core starts a CLI on four roads — dependency orchestration, the Eco
 * wake-up, a schedule's cold start, and (through the page, which builds its
 * own line from `GET /api/agents`' `launcher`) every node the user or
 * `open-agent` / `team` creates. The first three all build their line here. A
 * structural test (`canvas-launch.test.ts`) fails if a launch line is built
 * anywhere else.
 *
 * The line carries no injection. It starts the data directory's launcher
 * `run/<cli>` with the program and the CLI's own flags as its arguments; the
 * launcher appends the injected argv and sets the injected environment for
 * the CLI process alone, and only when `ARMADRA_NODE_ID` is set — the same
 * line run again from shell history outside the canvas is a plain start.
 * Without a current launcher the line is bare: no injection rather than the
 * old injection on the line.
 *
 * The node terminal's half ({@link canvasEnvironment}) puts `shims/` first on
 * its `PATH`, so a CLI the user types by name goes through the launcher too.
 *
 * On Windows the program is what the npm / pnpm wrapper runs, not the wrapper
 * (`windows-shim.ts`): a `.cmd` has `cmd.exe` read every argument a second
 * time. A wrapper that cannot be read stays the program, and then only words
 * that survive both reads go on the line (`shellCommandLine`).
 */

export interface CanvasLaunchRequest {
  readonly settings: AgentSettings;
  /** Our data directory; without one there is nothing to inject. */
  readonly dataDir?: string;
  /** The node's agent id — a `custom:` entry is injected as its base. */
  readonly agentId: string;
  readonly nodeId?: string;
  readonly permissionMode?: string;
  readonly model?: string;
  /** Continue this provider session. */
  readonly resume?: string;
  /**
   * The program resolved on this machine (`GET /api/agents`' `resolvedPath`);
   * the registry's name otherwise — looked up on PATH here on Windows, where
   * the shell would find the `.cmd` wrapper.
   */
  readonly program?: string;
  /**
   * A frozen argv (a schedule's plan) used *instead of* the flags derived
   * from the permission mode and model — the plan already carries those.
   */
  readonly frozenArgs?: readonly string[];
  /**
   * The dialect of the shell the line is typed into ({@link nodeDialect}).
   * The core's own default shell's when absent.
   */
  readonly dialect?: ShellDialect;
  /**
   * The node's terminal is an SSH session: the line is read by a POSIX shell
   * on the execution host. It names no launcher and no program resolved
   * here — those paths are this machine's; the host's shims
   * (`hook/install/remote.ts`) hand the CLI to the host's launcher.
   */
  readonly ssh?: boolean;
}

export interface CanvasLaunch {
  /** The launcher when there is one, the CLI's program otherwise. */
  readonly program: string;
  /**
   * The whole argv after {@link program}, literal — for a caller that execs
   * it. Through a launcher the CLI's program is its first word; the
   * injection is never here, the launcher adds it.
   */
  readonly args: readonly string[];
  /** `run/<cli>` this line goes through; absent on a bare line. */
  readonly launcher?: string;
  /** The line typed into the node's shell, quoted for its dialect. */
  readonly line: string;
}

/**
 * The dialect a node's launch line is written in: the shell its terminal
 * runs. An SSH node's line is read by the shell on the far host, which is a
 * POSIX login shell whatever this machine is; a local node without a shell
 * of its own runs the default one ({@link defaultShell}, `COMSPEC` on
 * Windows).
 */
export function nodeDialect(
  shell: string | undefined,
  ssh = false,
): ShellDialect {
  if (ssh) return "posix";
  return shellDialect(shell ?? defaultShell());
}

/**
 * The launcher a canvas line of `agentId` goes through on this machine — a
 * `custom:` entry's is its base CLI's — or `undefined` when there is none
 * current (`hook/install/inject.ts::currentLauncher`): not written yet, no data
 * directory, Windows without `armadra-launch.exe`. The one place the core asks.
 */
export function launcherFor(
  settings: AgentSettings,
  dataDir: string | undefined,
  agentId: string,
): string | undefined {
  if (dataDir === undefined) return undefined;
  return currentLauncher(dataDir, baseAgent(settings, agentId));
}

export function canvasLaunch(request: CanvasLaunchRequest): CanvasLaunch {
  const plan = planLaunch(request.settings, {
    agentId: request.agentId,
    ...(request.resume === undefined ? {} : { resume: request.resume }),
    ...(request.permissionMode === undefined
      ? {}
      : { permissionMode: request.permissionMode }),
    ...(request.model === undefined ? {} : { model: request.model }),
  });
  const ssh = request.ssh === true;
  const flags = request.frozenArgs ?? plan.args;
  // 本机解析到的程序路径在执行主机上不存在：SSH 节点用注册表里的程序名，由
  // 远端 shell 的 PATH 找（垫片排在最前面）。本机在 Windows 上则绕过 npm 的
  // `.cmd` 包装，直接起它背后的程序。
  const resolved = ssh
    ? plan.program
    : (request.program ??
      (process.platform === "win32"
        ? resolveCommand(plan.program)
        : undefined) ??
      plan.program);
  const target = ssh ? undefined : launchTargetOf(resolved);
  const cli = target?.program ?? resolved;
  const launcher = ssh
    ? undefined
    : launcherFor(request.settings, request.dataDir, request.agentId);
  // 经启动器时，程序与它的前置词都是启动器的参数；注入由启动器接在最后。
  const lead = [
    ...(launcher === undefined ? [] : [cli]),
    ...(target?.args ?? []),
  ];
  const program = launcher ?? cli;
  const args = [...lead, ...flags];
  const dialect = ssh
    ? nodeDialect(undefined, true)
    : (request.dialect ?? nodeDialect(undefined));
  return {
    program,
    args,
    ...(launcher === undefined ? {} : { launcher }),
    line: shellCommandLine(program, args, dialect),
  };
}

/** The same launch as one line of shell text, each word quoted only if needed. */
export function canvasLaunchLine(request: CanvasLaunchRequest): string {
  return canvasLaunch(request).line;
}

/**
 * The environment a canvas node's terminal carries for its CLI
 * (docs/design/canvas-launcher.md §4.3), and the moment the artifacts and the
 * launcher are made current: a terminal is about to start this CLI.
 *
 * Two variables, whatever the CLI: `ARMADRA_SHIMS` and a `PATH` with that
 * directory first. The injection's own environment (`OPENCODE_CONFIG_DIR`,
 * `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`) is not here: the launcher sets it for
 * the CLI process alone, so nothing else the shell starts inherits it.
 *
 * Nothing for an SSH node — the far host's shims are put on its `PATH` by the
 * remote shell command (`remote/integration.ts`) — and nothing for a CLI
 * without an injection. A failure to write the files never stops the
 * terminal: the launch simply goes without, and the log says why.
 */
export function canvasEnvironment(
  settings: AgentSettings,
  dataDir: string,
  agentId: string,
  log?: (message: string, fields: Record<string, unknown>) => void,
  options: {
    readonly ssh?: boolean;
    readonly ambient?: NodeJS.ProcessEnv;
  } = {},
): readonly (readonly [string, string])[] {
  const base = baseAgent(settings, agentId);
  if (!isInjected(base)) return [];
  try {
    prepareInjection(base, { dataDir });
  } catch (error) {
    log?.("could not prepare the canvas injection", {
      agentId: base,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (options.ssh === true) return [];
  const shims = shimDirectoryOf(dataDir);
  return [
    ["ARMADRA_SHIMS", shims],
    ["PATH", canvasPath(shims, options.ambient)],
  ];
}

/* ------------------------------- ACP 驱动 -------------------------------- */

/** 适配器表里决定注入怎么复用的那两项（`core/acp/adapters.ts`）。 */
export interface AcpInjectionRule {
  readonly injection: { readonly reuse: readonly ("env" | "args")[] };
  /** ama：注入只有一个 `--profile <path>`，由适配器表单独接（`profileFlag`）。 */
  readonly profileFlag?: string;
}

export interface AcpInjection {
  readonly env: readonly (readonly [string, string])[];
  readonly args: readonly string[];
  /** `profileFlag` 的值（ama 的 profile 路径）；没有就缺席。 */
  readonly profilePath?: string;
}

/**
 * 画布注入在 ACP 驱动下还能用的那一半（ACP 会话视图设计 §5.8）。
 *
 * 终端驱动的注入由启动器 `run/<cli>` 接在 CLI 的 argv 与环境上；ACP 驱动由
 * core 直接起适配器，没有启动器，所以这里把同一份注入（`canvasInjection`，
 * 产物先确保为最新）按适配器表的 `reuse` 裁剪：只留这家的 ACP 入口真认的
 * 环境变量或 argv，其余（Hook 设置、插件目录、系统提示文件）在 ACP 下没有对应
 * 的参数，画布工具改由 `session/new.mcpServers` 承担。终端驱动的注入产物与
 * 启动行一个字节不改。
 */
export function acpInjection(
  settings: AgentSettings,
  dataDir: string,
  agentId: string,
  rule: AcpInjectionRule,
  log?: (message: string, fields: Record<string, unknown>) => void,
): AcpInjection {
  const base = baseAgent(settings, agentId);
  if (!isInjected(base)) return { env: [], args: [] };
  try {
    prepareInjection(base, { dataDir });
  } catch (error) {
    log?.("could not prepare the canvas injection", {
      agentId: base,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const injection = canvasInjection({ dataDir, agentId: base });
  if (rule.profileFlag !== undefined) {
    const at = injection.args.indexOf(rule.profileFlag);
    const profilePath = at >= 0 ? injection.args[at + 1] : undefined;
    return {
      env: [],
      args: [],
      ...(profilePath === undefined ? {} : { profilePath }),
    };
  }
  return {
    env: rule.injection.reuse.includes("env") ? injection.env : [],
    args: rule.injection.reuse.includes("args") ? injection.args : [],
  };
}
