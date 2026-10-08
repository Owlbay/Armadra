import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { agentPath, hookClient } from "../terminal/environment";
import { type ShimTarget, fileProbe, shimTarget } from "./windows-shim";

/**
 * The seven agent CLIs this build knows, and what each of them can do.
 *
 * Ported from the pre-merge implementation. Only what the core needs lives here
 * — ids, labels, launch programs and capabilities. The canonical registry
 * (flags, prompt assembly, hook events) stays in `packages/shared`; the launch
 * line is assembled in the web app and typed into the PTY.
 *
 * Gemini is not in this list and is not coming back: migration 0014 retired it.
 */

export const AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
  "ama",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_CAPABILITIES = [
  "hooks",
  // May drive a linked browser node's session. A custom Agent can switch it
  // off; nothing can switch it on for a base adapter that does not declare it.
  "browser",
  "resume",
  "subagent",
  "contextLink",
  "usage",
  "nativeRecurrence",
  "structuredInputAck",
  "supportsModelSelection",
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/* ------------------------------ state sources ----------------------------- */

/** A command Hook the CLI forked: `armadra-hook <provider>` over `hook.sock`. */
export const STATE_SOURCE_HOOK = "hook";
/**
 * An extension inside the CLI's own process, speaking the same HTTP on the
 * same socket. Same bearer, same node token, same terminal binding — it is the
 * in-process form of the command Hook, not a more trusted one.
 */
export const STATE_SOURCE_EXTENSION = "extension";
/**
 * The PTY-side guess for a terminal with no adapter at all. A display-level
 * hint and nothing more; see {@link stateSourceIsReported}.
 */
export const OBSERVED = "observed";
/**
 * A session the core drives over the Agent Client Protocol (ACP 会话视图设计
 * §4.1): the protocol itself reports every turn and every permission request,
 * so it is as much a report as `hook`. Set by `core/acp`, never by a client.
 */
export const STATE_SOURCE_ACP = "acp";

export const AGENT_STATE_SOURCES = [
  STATE_SOURCE_HOOK,
  STATE_SOURCE_EXTENSION,
  OBSERVED,
  STATE_SOURCE_ACP,
] as const;

/**
 * Which channel a provider's status reports arrive on.
 *
 * A property of how that adapter is installed, not of the request: an
 * extension and a command Hook post the same body with the same headers, so
 * trusting a client's own claim would let any of them name the strongest
 * source. `undefined` is a provider with no adapter.
 */
export function stateSourceFor(provider: string): string | undefined {
  switch (provider) {
    case "claude":
    case "codex":
    case "copilot":
      return STATE_SOURCE_HOOK;
    // Pi, Oh My Pi and opencode report from a module inside the CLI's own
    // process. Same socket, same bearer, same node token: a different
    // transport, not a different authority.
    // `ama` reports through its host adapter, a module inside its own process
    // (docs/design/coordinator-agent.md §2.3).
    case "pi":
    case "omp":
    case "opencode":
    case "ama":
      return STATE_SOURCE_EXTENSION;
    default:
      return undefined;
  }
}

/**
 * Whether a source is a *report* rather than a guess.
 *
 * The one question every gate has to ask. `hook` and `extension` are two
 * transports for the same authenticated report and both count; `observed` and
 * "nothing has reported" do not — an observation may never satisfy the
 * scheduler's idle gate. Written here, once, so a later caller cannot
 * accidentally spell it as "the source is set".
 */
export function stateSourceIsReported(source: string | null | undefined) {
  return (
    source === STATE_SOURCE_HOOK ||
    source === STATE_SOURCE_EXTENSION ||
    source === STATE_SOURCE_ACP
  );
}

/**
 * 这个 provider 启动完成时会不会一条 hook 事件都不发（`startsSilently`）。
 *
 * 与 {@link stateSourceFor} 并排放：两个都是「这家 CLI 的适配长什么样」的事实，
 * 与此刻的观测无关。自定义 Agent 按 base 问——换一个标签或程序名不会让 Codex
 * 突然开始发 `session_start`。
 *
 * 它**只**回答「第一次空闲能不能靠观察」。有这一位的 CLI 仍然有状态通道：第一
 * 条投递之后，`user_prompt_submit` 与 `stop` 照常到，此后每一条都走上报那条路。
 */
export function startsSilently(provider: string): boolean {
  return definition(provider)?.startsSilently === true;
}

/* -------------------------------- definitions ------------------------------ */

export interface AgentDefinition {
  readonly id: AgentId;
  readonly label: string;
  readonly color: string;
  readonly launchCmd: string;
  readonly promptMode: string;
  readonly capabilities: readonly AgentCapability[];
  /**
   * argv[0] basenames that mean "this pane is still running that agent"
   * (`packages/shared`'s `expectedProcess`). A CLI the launcher execs into a
   * runner (ama on the bundled Electron) is seen by tmux as the runner.
   */
  readonly expectedProcess: readonly string[];
  /**
   * 这家 CLI **启动完成时一条 hook 事件都不发**。
   *
   * 不是「没装适配」，也不是「适配坏了」：事件全部 enabled，第一条仍然要等人
   * 在里面提交过一次输入。所以这种节点的第一次「空闲」不存在于任何上报里，
   * 只能靠观察（§4.3 的那条路），而后续每一条照常走 hook。
   */
  readonly startsSilently?: boolean;
}

export const AGENT_REGISTRY: readonly AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    color: "#d97757",
    launchCmd: "claude",
    promptMode: "argv",
    expectedProcess: ["claude"],
    capabilities: [
      "hooks",
      "resume",
      "subagent",
      "contextLink",
      "browser",
      "usage",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
  {
    id: "codex",
    label: "Codex",
    color: "#10a37f",
    launchCmd: "codex",
    promptMode: "argv",
    expectedProcess: ["codex"],
    // 实测 0.155.1（2026-09-21，真机）：`session_start` 等六个事件全部 enabled，
    // 进程起到「Ask Codex to do anything」提示符也一条都不发；`agent_status`
    // 里根本没有这个节点的行，直到人手动提交一次输入
    // （`user_prompt_submit` → `stop`）。
    startsSilently: true,
    capabilities: [
      "hooks",
      "resume",
      "subagent",
      "contextLink",
      "browser",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    color: "#a78bfa",
    launchCmd: "opencode",
    promptMode: "flag-prompt",
    expectedProcess: ["opencode"],
    capabilities: [
      "hooks",
      "resume",
      "contextLink",
      "browser",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
  {
    id: "pi",
    label: "Pi",
    color: "#e8b86d",
    launchCmd: "pi",
    promptMode: "argv",
    expectedProcess: ["pi"],
    // `hooks` means "there is a status source", not "there is a hooks key in a
    // settings file": Pi's is an in-process extension on the same socket.
    capabilities: [
      "hooks",
      "resume",
      "browser",
      "contextLink",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
  {
    id: "omp",
    label: "Oh My Pi",
    color: "#d4a373",
    launchCmd: "omp",
    promptMode: "argv",
    expectedProcess: ["omp"],
    // Same extension API as Pi, under its own config home.
    capabilities: [
      "hooks",
      "resume",
      "browser",
      "contextLink",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    color: "#a371f7",
    launchCmd: "copilot",
    promptMode: "flag-prompt",
    expectedProcess: ["copilot"],
    // A command hook like Claude's.
    capabilities: [
      "hooks",
      "resume",
      "browser",
      "contextLink",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
  {
    id: "ama",
    label: "Armadra Agent",
    color: "#2f6fed",
    launchCmd: "ama",
    promptMode: "argv",
    // The launcher execs the bundled runtime, so tmux's `pane_current_command`
    // names the runner rather than `ama` (docs/design/coordinator-agent.md §2.2).
    expectedProcess: [
      "ama",
      "ama.cjs",
      "armadra",
      "Armadra",
      "Electron",
      "electron",
    ],
    // Our own agent. No `subagent`: the canvas rules want sibling nodes.
    capabilities: [
      "hooks",
      "resume",
      "contextLink",
      "browser",
      "usage",
      "structuredInputAck",
      "supportsModelSelection",
    ],
  },
];

export function definition(agentId: string): AgentDefinition | undefined {
  return AGENT_REGISTRY.find((agent) => agent.id === agentId);
}

/** Whether an id names a built-in agent or a `custom:` entry. */
export function validAgentId(agentId: string): boolean {
  if (definition(agentId) !== undefined) return true;
  const suffix = agentId.startsWith("custom:")
    ? agentId.slice("custom:".length)
    : undefined;
  return suffix !== undefined && suffix.length > 0 && suffix.length <= 64;
}

/* ------------------------------ custom agents ------------------------------ */

/**
 * A `settings.agents.custom[]` entry, as the settings domain stores it.
 *
 * Structural rather than imported so the agent domain does not have to know
 * which module the settings document is parsed in; the fields are the ones
 * the pre-merge implementation defines.
 */
export interface CustomAgent {
  readonly id: string;
  readonly label: string;
  readonly color?: string;
  readonly launchCmd: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly baseAgent: string;
  readonly disabledCapabilities?: readonly string[];
  /**
   * How this entry's first prompt reaches it, overriding its base's shape.
   *
   * `packages/shared` has carried this field since custom agents existed
   * (`customAgentSchema`); the core did not, so an entry that declared
   * `stdin-after-start` — "never put it on the launch line" — got its prompt
   * put on the launch line (设计 `agent-delivery.md` §8.2 E2).
   */
  readonly promptMode?: "argv" | "flag-prompt" | "stdin-after-start";
}

/** The settings this domain reads. Injected, so a test can pass a literal. */
export interface AgentSettings {
  customAgents(): readonly CustomAgent[];
}

export const NO_CUSTOM_AGENTS: AgentSettings = { customAgents: () => [] };

export function customAgent(
  settings: AgentSettings,
  agentId: string,
): CustomAgent | undefined {
  return settings.customAgents().find((custom) => custom.id === agentId);
}

/** The built-in whose adapter an id borrows. A built-in is its own base. */
export function baseAgent(settings: AgentSettings, agentId: string): string {
  return customAgent(settings, agentId)?.baseAgent ?? agentId;
}

/**
 * Capability narrowing concerns application features, not manual CLI commands
 * and not workspace authorization (which remains a separate check).
 *
 * A custom entry may disable its base's capabilities; it cannot grant another
 * adapter's abilities merely by changing its label or launch program, and an
 * entry whose base is not a known agent has no capabilities at all.
 */
export function hasCapability(
  settings: AgentSettings,
  agentId: string,
  capability: string,
): boolean {
  if (!agentId.startsWith("custom:")) {
    return (
      definition(agentId)?.capabilities.includes(
        capability as AgentCapability,
      ) === true
    );
  }
  const custom = customAgent(settings, agentId);
  if (custom === undefined) return false;
  const base = definition(custom.baseAgent);
  if (base === undefined) return false;
  if (!base.capabilities.includes(capability as AgentCapability)) return false;
  return !(custom.disabledCapabilities ?? []).includes(capability);
}

/* -------------------------------- detection -------------------------------- */

/** One `GET /api/agents` row, as far as this domain fills it in. */
export interface AgentInfo {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly launchCmd: string;
  readonly promptMode: string;
  readonly capabilities: readonly string[];
  /** Extra argv the launch line appends after the flags. Built-ins: empty. */
  readonly args: readonly string[];
  /** The built-in a `custom:` entry borrows from; absent on the built-ins. */
  readonly baseAgent?: string;
  readonly resolvedPath: string | null;
  readonly installed: boolean;
  /**
   * What to start instead of {@link resolvedPath} when that is an npm / pnpm
   * wrapper on Windows (`claude.cmd`): the program behind it and the words
   * that go in front of the CLI's own (`node.exe <cli.js>`). Absent when the
   * path is the program itself, or the wrapper could not be read.
   *
   * 自协议 1.24 起也用于版本管理器的垫片（mise / asdf，契约 §52）：
   * `program` 是垫片背后那份真实的 CLI，`args` 为空。
   */
  readonly launchTarget?: ShimTarget;
}

/** The two detection fields plus the wrapper's target, for one command. */
function located(
  command: string,
): Pick<AgentInfo, "resolvedPath" | "installed" | "launchTarget"> {
  const resolved = resolveCommand(command);
  const target = launchTargetOf(resolved) ?? versionManagerTarget(resolved);
  return {
    resolvedPath: resolved ?? null,
    installed: resolved !== undefined,
    ...(target === undefined ? {} : { launchTarget: target }),
  };
}

function infoOf(agent: AgentDefinition): AgentInfo {
  return {
    id: agent.id,
    label: agent.label,
    color: agent.color,
    launchCmd: agent.launchCmd,
    promptMode: agent.promptMode,
    capabilities: [...agent.capabilities],
    args: [],
    ...located(agent.launchCmd),
  };
}

/**
 * A `settings.agents.custom[]` entry as a row.
 *
 * The base supplies prompt behaviour, colour and available capabilities. The
 * colour in particular is the base's, so a custom Claude reads as Claude on
 * the canvas; `settings.color` is only the settings-page dot.
 */
export function customInfo(custom: CustomAgent): AgentInfo {
  const base = definition(custom.baseAgent);
  const disabled = custom.disabledCapabilities ?? [];
  const info: AgentInfo = {
    id: custom.id,
    label: custom.label,
    color: base?.color ?? (AGENT_REGISTRY[0] as AgentDefinition).color,
    launchCmd: custom.launchCmd,
    promptMode: base?.promptMode ?? "argv",
    capabilities:
      base === undefined
        ? []
        : base.capabilities.filter(
            (capability) => !disabled.includes(capability),
          ),
    args: [...(custom.args ?? [])],
    ...located(custom.launchCmd),
  };
  return base === undefined ? info : { ...info, baseAgent: base.id };
}

/** Probe every built-in agent against the augmented PATH. */
export function detect(): AgentInfo[] {
  return AGENT_REGISTRY.map(infoOf);
}

/**
 * Resolve `command` against the same PATH used to launch agent CLIs.
 *
 * A command that already carries a path separator (`/opt/bin/claude`,
 * `./wrapper.sh`) is never searched for on PATH — that is what a custom agent
 * pointing at a script outside PATH looks like, and joining it onto every PATH
 * entry would only produce nonsense.
 */
export function resolveCommand(
  command: string,
  ambient: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (command === "") return undefined;
  const looksLikePath =
    isAbsolute(command) || command.includes("/") || command.includes(sep);
  if (looksLikePath) {
    return isExecutable(command) ? command : withPlatformSuffix(command);
  }
  // `<data>/bin` holds the `armadra-hook` launcher and the bundled `ama`'s,
  // and is searched first: an `ama` some other install put on PATH is not the
  // pinned one, and a host API it does not speak makes it refuse to start.
  // Nothing else of ours lives there, so no other CLI is shadowed.
  const client = hookClient();
  const directories = agentPath(ambient).split(delimiter);
  if (client !== undefined) directories.unshift(dirname(client));
  for (const directory of directories) {
    if (directory === "") continue;
    const candidate = join(directory, command);
    if (isExecutable(candidate)) return candidate;
    const suffixed = withPlatformSuffix(candidate);
    if (suffixed !== undefined) return suffixed;
  }
  return undefined;
}

/**
 * The program behind an npm / pnpm wrapper (`agent/windows-shim.ts`), or
 * `undefined` when `resolved` is the program itself or the wrapper could not
 * be read. `node` is looked up on the same PATH as the CLI.
 */
export function launchTargetOf(
  resolved: string | undefined,
  ambient: NodeJS.ProcessEnv = process.env,
): ShimTarget | undefined {
  if (resolved === undefined) return undefined;
  return shimTarget(
    resolved,
    fileProbe((name) => resolveCommand(name, ambient)),
  );
}

/* --------------------------- version-manager shims -------------------------- */

/** 解析垫片最多等这么久。 */
const SHIM_WHICH_TIMEOUT_MS = 10_000;

/** 跑一次 `<manager> which <cli>`，答标准输出；失败答 `undefined`。 */
export type ShimWhich = (
  manager: string,
  args: readonly string[],
) => string | undefined;

const runWhich: ShimWhich = (manager, args) => {
  try {
    return execFileSync(manager, [...args], {
      encoding: "utf8",
      timeout: SHIM_WHICH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      // 在家目录里问：答的是全局那一版，不受 core 恰好站在哪个项目里影响。
      cwd: homedir(),
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
};

/** `(垫片路径, mtime)` → 背后的程序；`null` 是问过但没问出来。 */
const shimCache = new Map<string, ShimTarget | null>();

/** 用例之间换一份干净的。 */
export function clearShimCache(): void {
  shimCache.clear();
}

/**
 * 垫片是哪家版本管理器的：mise 的垫片是指向 `mise` 本体的符号链接，asdf 的是
 * `~/.asdf/shims/` 下的脚本。都不是答 `undefined`。
 */
function shimManager(
  path: string,
): { readonly name: "mise" | "asdf"; readonly program?: string } | undefined {
  const posix = path.split(sep).join("/");
  let target: string | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path);
  } catch {
    target = undefined;
  }
  const real = target === undefined ? "" : basename(target);
  if (real === "mise" || real === "mise.exe")
    return { name: "mise", program: target as string };
  if (real === "asdf") return { name: "asdf", program: target as string };
  if (posix.includes("/mise/shims/")) return { name: "mise" };
  if (posix.includes("/.asdf/shims/")) return { name: "asdf" };
  return undefined;
}

/**
 * 穿透 mise / asdf 的垫片（界面第二波 §8.4、契约 §52）。
 *
 * 启动行若用 PATH 上第一个命中的垫片，每次启动都要多一层版本解析进程；几个节点
 * 同时起时这一层也一起并发。这里问一次 `mise which <cli>`（asdf 同理），把真实
 * 路径作为 `launchTarget.program`。只读：不写任何 CLI 或版本管理器的配置，问不
 * 出来就维持原样。真实路径是 node 脚本时不再往下穿（`node` 本身也可能是垫片）。
 */
export function versionManagerTarget(
  resolved: string | undefined,
  which: ShimWhich = runWhich,
  ambient: NodeJS.ProcessEnv = process.env,
): ShimTarget | undefined {
  if (resolved === undefined || process.platform === "win32") return undefined;
  const manager = shimManager(resolved);
  if (manager === undefined) return undefined;
  let mtime: number;
  try {
    mtime = lstatSync(resolved).mtimeMs;
  } catch {
    return undefined;
  }
  const key = `${resolved}\u0000${mtime}`;
  const cached = shimCache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const program =
    manager.program ?? resolveCommand(manager.name, ambient) ?? undefined;
  let found: ShimTarget | undefined;
  if (program !== undefined) {
    const answer = which(program, ["which", basename(resolved)]);
    const line = answer
      ?.split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry !== "");
    if (
      line !== undefined &&
      isAbsolute(line) &&
      line !== resolved &&
      shimManager(line) === undefined &&
      isExecutable(line)
    ) {
      found = { program: line, args: [] };
    }
  }
  shimCache.set(key, found ?? null);
  return found;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function withPlatformSuffix(candidate: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  for (const extension of [".exe", ".cmd", ".bat"]) {
    const path = `${candidate}${extension}`;
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // Not there: try the next one.
    }
  }
  return undefined;
}
