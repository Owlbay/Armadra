import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { type PermissionMode, PERMISSION_MODES } from "../agent/launch";
import {
  type AgentId,
  type AgentSettings,
  baseAgent,
  customAgent,
} from "../agent/registry";
import { homeDir } from "../history/home";

/**
 * 七家 Agent 以 ACP 驱动时的启动与映射表（ACP 会话视图设计 §5.2，补全架构
 * §5.1 第 3 条）。
 *
 * 纯数据加两个纯函数，不起进程：程序在补齐过的 PATH 上找（`resolveCommand`，
 * 与终端驱动同一条规则），起进程在 `client.ts`，协商在 `host.ts`。
 *
 * `modes` 的键与 `agent/launch.ts` 的 `permissionFlag` 是同一个集合——
 * `adapters.test.ts` 守着。`null` 表示这家在 ACP 下没有这个模式，界面不出现，
 * 与设置页「只提供有对应参数的权限模式」同一规矩。
 */

/** 这家怎么说 ACP：自带入口、官方适配器、社区适配器。 */
export const ACP_SUPPORT = ["native", "official", "community"] as const;
export type AcpSupport = (typeof ACP_SUPPORT)[number];

/** 跨进程接回用哪个方法；`none` = 只能新开（Copilot）。 */
export const ACP_RESUME = ["load", "resume", "none"] as const;
export type AcpResume = (typeof ACP_RESUME)[number];

/**
 * ACP `sessionId` 与 CLI 自己的会话 id 怎么对上（设计 §4.3）：
 * `same` 相等；`mapFile` 读适配器自己的映射文件；`opaque` 对不上，读镜像。
 */
export const ACP_SESSION_ID = ["same", "mapFile", "opaque"] as const;
export type AcpSessionIdRule = (typeof ACP_SESSION_ID)[number];

/** 一个权限模式在 ACP 下的落点：`session/set_mode` 的 id、启动 argv，或两者。 */
export interface AcpModeMapping {
  readonly modeId?: string;
  readonly args?: readonly string[];
}

export interface AcpAdapter {
  /** 内置 id；`ama` 在 core 的注册表补上之前单列（G1-7）。 */
  readonly agentId: AgentId | "ama";
  readonly support: AcpSupport;
  /** 在补齐过的 PATH 上找的程序名。 */
  readonly program: string;
  /** 程序之后固定的 argv。 */
  readonly args: readonly string[];
  /**
   * 运行时才知道值的那个旗标：`ama --profile <path>`。给了 profile 路径才加，
   * 没给就不加（ama 自己用缺省 profile）。
   */
  readonly profileFlag?: string;
  readonly sessionId: AcpSessionIdRule;
  /**
   * `sessionId: "mapFile"` 时适配器自己的映射文件：相对家目录的路径段。形状
   * 见 {@link readSessionMap}。
   */
  readonly sessionMap?: readonly string[];
  readonly resume: AcpResume;
  readonly modes: Readonly<Record<PermissionMode, AcpModeMapping | null>>;
  /**
   * 画布注入在 ACP 下还能用的那一半（设计 §5.8）。值（目录、令牌）由会话层
   * 从集成状态里取，这里只说用哪几条：
   *   * `mcp`：`session/new.mcpServers` 带 `armadra-hook mcp`；ama 走 profile
   *     的 host 适配器，不加，免得两套工具表；
   *   * `reuse`：终端启动器给的环境变量 / argv 照用；
   *   * `passthrough`：注入 argv 前面要隔一个 `--`（pi-acp 透传给 pi）。
   */
  readonly injection: {
    readonly mcp: boolean;
    readonly reuse: readonly ("env" | "args")[];
    readonly passthrough?: "--";
  };
  /** 前台进程门认的 argv[0] basename（会话 pid 就是适配器 pid）。 */
  readonly expectedProcess: readonly string[];
}

const NONE: AcpModeMapping = {};

export const ACP_ADAPTERS: readonly AcpAdapter[] = [
  {
    agentId: "claude",
    support: "official",
    program: "claude-agent-acp",
    args: [],
    sessionId: "same",
    resume: "load",
    modes: {
      default: { modeId: "default" },
      "auto-edit": { modeId: "acceptEdits" },
      "full-auto": { modeId: "bypassPermissions" },
      plan: { modeId: "plan" },
    },
    // `--settings` / `--plugin-dir` / `--append-system-prompt-file` 在 ACP
    // 下没有对应参数（D6）；`CLAUDE_CONFIG_DIR` 不设，沿用用户登录。
    injection: { mcp: true, reuse: [] },
    expectedProcess: ["claude-agent-acp"],
  },
  {
    agentId: "codex",
    support: "official",
    program: "codex-acp",
    args: [],
    sessionId: "same",
    resume: "load",
    modes: {
      default: { modeId: "workspace-write" },
      "auto-edit": { modeId: "agent" },
      "full-auto": { modeId: "agent-full-access" },
      plan: { modeId: "read-only" },
    },
    injection: { mcp: true, reuse: ["env"] },
    expectedProcess: ["codex-acp"],
  },
  {
    agentId: "opencode",
    support: "native",
    program: "opencode",
    args: ["acp"],
    sessionId: "same",
    resume: "load",
    modes: {
      default: { modeId: "build" },
      "auto-edit": null,
      "full-auto": null,
      plan: { modeId: "plan" },
    },
    injection: { mcp: true, reuse: ["env"] },
    expectedProcess: ["opencode"],
  },
  {
    agentId: "pi",
    support: "community",
    program: "pi-acp",
    args: [],
    sessionId: "mapFile",
    // `~/.pi/acp/sessions.json`：`{ "<ACP 会话 id>": { "sessionFile": "<Pi 会话文件>" } }`。
    sessionMap: [".pi", "acp", "sessions.json"],
    resume: "load",
    modes: {
      default: NONE,
      "auto-edit": null,
      "full-auto": null,
      plan: null,
    },
    injection: { mcp: true, reuse: ["args"], passthrough: "--" },
    expectedProcess: ["pi-acp"],
  },
  {
    agentId: "omp",
    support: "native",
    program: "omp",
    args: ["acp"],
    sessionId: "same",
    resume: "load",
    modes: {
      default: { modeId: "default" },
      "auto-edit": { args: ["--approval-mode", "write"] },
      "full-auto": { args: ["--approval-mode", "yolo"] },
      plan: { modeId: "plan" },
    },
    injection: { mcp: true, reuse: ["args"] },
    expectedProcess: ["omp"],
  },
  {
    agentId: "copilot",
    support: "native",
    program: "copilot",
    args: ["--acp", "--stdio"],
    sessionId: "opaque",
    resume: "none",
    // 三条旗标在 `--acp` 下是否生效待真跑核实（G3-7）。
    modes: {
      default: NONE,
      "auto-edit": { args: ["--allow-tool=write"] },
      "full-auto": { args: ["--allow-all-tools"] },
      plan: { args: ["--plan"] },
    },
    injection: { mcp: true, reuse: ["args", "env"] },
    expectedProcess: ["copilot"],
  },
  {
    agentId: "ama",
    support: "native",
    program: "ama",
    args: ["--mode", "acp"],
    profileFlag: "--profile",
    sessionId: "same",
    resume: "resume",
    // 模式 id 就是 ama 的权限模式（`@armadra/agent` docs/acp.md）。
    modes: {
      default: { modeId: "default" },
      "auto-edit": { modeId: "auto-edit" },
      "full-auto": { modeId: "full-auto" },
      plan: { modeId: "plan" },
    },
    injection: { mcp: false, reuse: [] },
    expectedProcess: ["ama", "ama.cjs"],
  },
];

export function acpAdapter(agentId: string): AcpAdapter | undefined {
  return ACP_ADAPTERS.find((adapter) => adapter.agentId === agentId);
}

/** 这家在 ACP 下真有落点的权限模式；`default` 总在。 */
export function acpPermissionModes(
  adapter: AcpAdapter,
): readonly PermissionMode[] {
  return PERMISSION_MODES.filter(
    (mode) => mode === "default" || adapter.modes[mode] !== null,
  );
}

export interface AcpLaunchOptions {
  readonly mode?: PermissionMode;
  /** ama 的 profile 路径（G1-7 的注入产物）。 */
  readonly profilePath?: string;
  /** 终端注入复用的 argv（`reuse` 含 `args` 时才用）。 */
  readonly injectionArgs?: readonly string[];
}

export interface AcpLaunchPlan {
  /** 程序之后的完整 argv。 */
  readonly args: readonly string[];
  /** 起会话后要 `session/set_mode` 的 id；缺席 = 不调。 */
  readonly modeId?: string;
}

export type AcpLaunchError = {
  readonly code: "acp_mode_unsupported";
  readonly message: string;
};

/**
 * 一次启动的 argv 与模式 id。顺序：固定 argv → profile → 模式 argv → 注入
 * （`passthrough` 的放最后，前面隔 `--`）。没有落点的模式答错误而不是悄悄
 * 用缺省：一个说了 `plan` 却以可写模式起来的会话比起不来更糟。
 */
export function acpLaunchPlan(
  adapter: AcpAdapter,
  options: AcpLaunchOptions = {},
): AcpLaunchPlan | AcpLaunchError {
  const mode = options.mode ?? "default";
  const mapping = adapter.modes[mode];
  if (mapping === null) {
    return {
      code: "acp_mode_unsupported",
      message: `${adapter.agentId} has no ACP mapping for permission mode ${mode}`,
    };
  }
  const args = [...adapter.args];
  if (adapter.profileFlag !== undefined && options.profilePath !== undefined) {
    args.push(adapter.profileFlag, options.profilePath);
  }
  args.push(...(mapping.args ?? []));
  const injection = adapter.injection.reuse.includes("args")
    ? (options.injectionArgs ?? [])
    : [];
  if (injection.length > 0) {
    if (adapter.injection.passthrough !== undefined) {
      args.push(adapter.injection.passthrough);
    }
    args.push(...injection);
  }
  return mapping.modeId === undefined
    ? { args }
    : { args, modeId: mapping.modeId };
}

/**
 * 这个 Agent 以 ACP 起时用哪一行适配器。`custom:` 条目借它基础 CLI 的；基础
 * CLI 自己就是 ACP 入口（`native`）时，条目的启动程序与参数顶替表里的程序——
 * 一个包装了 `opencode` 的自定义条目，它的 ACP 入口就是那个包装。
 */
export function adapterFor(
  settings: AgentSettings,
  agentId: string,
): AcpAdapter | undefined {
  const adapter = acpAdapter(baseAgent(settings, agentId));
  if (adapter === undefined) return undefined;
  const custom = customAgent(settings, agentId);
  if (custom === undefined || adapter.support !== "native") return adapter;
  return {
    ...adapter,
    program: custom.launchCmd,
    args: [...(custom.args ?? []), ...adapter.args],
    expectedProcess: [
      ...adapter.expectedProcess,
      custom.launchCmd.split(/[/\\]/).pop() ?? custom.launchCmd,
    ],
  };
}

/* --------------------------- mapFile（契约 §26.3） --------------------------- */

/** 映射文件的上限：比这大的不是一张会话表。 */
const SESSION_MAP_BYTES = 4 * 1024 * 1024;

/** Pi 的会话文件名 `<ISO 时间>_<uuid>.jsonl` 里的会话 id。 */
const SESSION_UUID =
  /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

/** 一个 ACP 会话 id 在 CLI 那边对应的会话。 */
export interface MappedSession {
  readonly acpSessionId: string;
  /** CLI 自己的会话文件（绝对路径）。 */
  readonly sessionFile: string;
  /** 文件名里认得出的 CLI 会话 id；认不出时缺席，接回用文件路径。 */
  readonly cliSessionId?: string;
}

/**
 * 读适配器的映射文件：`{ "<ACP 会话 id>": { "sessionFile": "<路径>" } }`（值
 * 也可以直接是路径字符串）。不是 `mapFile` 的适配器、没有家目录、文件不在、
 * 过大或不是这个形状都答 `undefined`——调用方退回 `opaque` 的做法。只认绝对
 * 路径：相对路径不知道相对谁。
 */
export function readSessionMap(
  adapter: AcpAdapter,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, string> | undefined {
  if (adapter.sessionId !== "mapFile" || adapter.sessionMap === undefined) {
    return undefined;
  }
  const home = homeDir(env);
  if (home === undefined) return undefined;
  const path = join(home, ...adapter.sessionMap);
  let parsed: unknown;
  try {
    if (statSync(path).size > SESSION_MAP_BYTES) return undefined;
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const map = new Map<string, string>();
  for (const [acpSessionId, value] of Object.entries(parsed)) {
    const file =
      typeof value === "string"
        ? value
        : typeof value === "object" && value !== null
          ? (value as { sessionFile?: unknown }).sessionFile
          : undefined;
    if (typeof file === "string" && isAbsolute(file)) {
      map.set(acpSessionId, file);
    }
  }
  return map;
}

function mapped(acpSessionId: string, sessionFile: string): MappedSession {
  const id = SESSION_UUID.exec(basename(sessionFile))?.[1];
  return {
    acpSessionId,
    sessionFile,
    ...(id === undefined ? {} : { cliSessionId: id }),
  };
}

/** ACP 会话 id → CLI 的会话；映射里没有答 `undefined`。 */
export function mappedSession(
  adapter: AcpAdapter,
  acpSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): MappedSession | undefined {
  const file = readSessionMap(adapter, env)?.get(acpSessionId);
  return file === undefined ? undefined : mapped(acpSessionId, file);
}

/**
 * 接回时用哪个 ACP 会话 id。`mapFile` 的适配器：手里的 id 本来就是映射里的
 * ACP 会话 id 就用它；是 CLI 的会话 id（或会话文件）时反查映射；映射读不到或
 * 查不到时原样交回（与 `opaque` 一样试一次，接不回就新开）。其他适配器原样。
 */
export function acpResumeId(
  adapter: AcpAdapter,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const map = readSessionMap(adapter, env);
  if (map === undefined || map.has(id)) return id;
  for (const [acpSessionId, file] of map) {
    const session = mapped(acpSessionId, file);
    if (session.cliSessionId === id || session.sessionFile === id) {
      return acpSessionId;
    }
  }
  return id;
}

/**
 * 切回终端时 CLI 恢复行要的会话 id。`mapFile` 的适配器把 ACP 会话 id 映射回
 * CLI 的（文件名认不出 id 时用文件路径）；映射里没有答 `undefined`——接不回，
 * 敲普通启动行。其他适配器原样。
 */
export function cliResumeId(
  adapter: AcpAdapter,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (adapter.sessionId !== "mapFile") return id;
  const session = mappedSession(adapter, id, env);
  if (session !== undefined) return session.cliSessionId ?? session.sessionFile;
  // 映射里没有：手里的也许本来就是 CLI 的会话 id（终端驱动时由 Hook 报的）。
  const map = readSessionMap(adapter, env);
  if (map === undefined) return undefined;
  for (const [acpSessionId, file] of map) {
    const one = mapped(acpSessionId, file);
    if (one.cliSessionId === id) return id;
  }
  return undefined;
}
