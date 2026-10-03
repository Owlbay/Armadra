import { type PermissionMode, PERMISSION_MODES } from "../agent/launch";
import type { AgentId } from "../agent/registry";

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
