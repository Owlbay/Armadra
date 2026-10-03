import {
  AGENT_REGISTRY,
  agentDefinition,
  assembleLaunchArgv,
  assembleLaunchCommand,
  type AgentAcpInfo,
  type AgentInfo,
  type CreateTerminalAgent,
  type CustomAgent,
  type LaunchArgv,
  type LaunchCommand,
  type PermissionMode,
  type ShellDialect,
  type TerminalAgent,
  shellDialect,
} from "@armadra/shared";

import { defaultShellDialect } from "@/app/core-host";
import { t, usePreferencesStore } from "@/app/preferences-store";

/**
 * 前端侧的 Agent 启动薄封装（计划书 §5.1）。
 *
 * 拼命令行的规则全部在 `packages/shared/src/agents.ts` 里（纯函数、有测试），
 * 这里只做三件事：查显示名、查品牌色、把节点上的 `data.agent` 转成
 * `assembleLaunchCommand` 的入参。任何时候都不要在组件里直接拼字符串。
 */

/** `custom:` 的兜底品牌色，与 `customAgentSchema` 的默认色同源。 */
const FALLBACK_COLOR_VAR = "var(--agent-opencode)";

/**
 * `GET /api/agents` 的最新一份答案（§24.1）。
 *
 * 自定义 Agent 只存在于 Runtime 的设置里，内置注册表查不到；名字、颜色、
 * 启动程序都得从这份列表来。查显示名/颜色的地方分散在节点、画布、会话卡
 * 里，全都是同步调用，所以这里留一份模块级快照，由 `use-agents.ts` 在查询
 * 成功时推进来，而不是让每个调用点自己拿 react-query。
 */
let registry: readonly AgentInfo[] = [];

export function setAgentRegistry(agents: readonly AgentInfo[]): void {
  registry = agents;
}

function registryEntry(id: string | undefined): AgentInfo | undefined {
  return id ? registry.find((agent) => agent.id === id) : undefined;
}

/**
 * 这家 CLI 在这台机器上怎么说 ACP（契约 §14.1）。没有这个键就是没有 ACP
 * 入口；列表还没到时同样答不上来，切换项不出现。
 */
export function agentAcpInfo(id: string | undefined): AgentAcpInfo | undefined {
  return registryEntry(id)?.acp;
}

export function agentLabel(id: string | undefined): string {
  if (!id) return "";
  const definition = agentDefinition(id);
  if (definition) return definition.label;
  const custom = registryEntry(id);
  if (custom) return custom.label;
  return id.startsWith("custom:") ? id.slice("custom:".length) : id;
}

/** 品牌色原始值（`#d97757`…）。需要 alpha 混合时用它。 */
export function agentColor(id: string | undefined): string {
  const definition = id ? agentDefinition(id) : undefined;
  // `--agent-opencode` 的字面量，给需要 alpha 混合的地方兜底。
  return definition?.color ?? registryEntry(id)?.color ?? "#a78bfa";
}

/**
 * 品牌色的 CSS 变量形式。优先用变量而不是字面量：主题切换、强制配色
 * 模式都是靠变量兜住的（§4.3 规则一）。
 *
 * 自定义 Agent 没有自己的变量，用它借用的内置 Agent 的——画布上一个
 * 「自定义 Claude」看起来就该是 Claude 的颜色。
 */
export function agentColorVar(id: string | undefined): string {
  if (!id) return FALLBACK_COLOR_VAR;
  if (id in AGENT_REGISTRY) return `var(--agent-${id})`;
  const base = registryEntry(id)?.baseAgent;
  return base ? `var(--agent-${base})` : FALLBACK_COLOR_VAR;
}

/**
 * Agent 的文字色（设计系统 §2.4 第二层）：会话行里的 Agent 名、消息流里的
 * 发言人用它，标识色（`agentColorVar`）只给色点、头像底这类图形。
 *
 * 只有内置 Agent 有算过对比度的 `--agent-<id>-text`；自定义 Agent 一律退回
 * 正文色，靠旁边的色点认人，不为每个自定义色算文字变体。
 */
export function agentTextColorVar(id: string | undefined): string {
  if (id && id in AGENT_REGISTRY) return `var(--agent-${id}-text)`;
  return "var(--text)";
}

/**
 * 节点上的 `custom:` id → 拼启动行需要的那份定义。
 *
 * `env` 不在这里：它由 Runtime 在建终端时并进 PTY 环境，不上启动行
 * （否则会进用户的 shell 历史）。
 */
export function customAgentFor(id: string): CustomAgent | undefined {
  const info = registryEntry(id);
  if (!info || !info.baseAgent) return undefined;
  return {
    id: info.id,
    label: info.label,
    color: info.color,
    launchCmd: info.launchCmd,
    args: info.args,
    baseAgent: info.baseAgent,
    disabledCapabilities: AGENT_REGISTRY[info.baseAgent].capabilities.filter(
      (capability) => !info.capabilities.includes(capability),
    ),
  };
}

/**
 * 节点上的 Agent 配置 → `POST /api/terminals` 的 `agent` 段。
 *
 * 账号绑定（S02）：`agent.account` 缺省时请求里根本没有 `accountId`，不会凭空
 * 发一个 `"default"` 让 Runtime 以为客户端在选账号。字段存在时原样透传。
 *
 * `credentialRef`（契约 §20）上行：它是凭据存储里一个条目的**名字**，不是值。
 * 条目在不在、是不是这家 CLI 的、这台主机能不能用，全由 core 判，不满足就拒绝
 * 起终端——这里不做任何本地放行判断。
 */
export function agentSessionRequest(agent: TerminalAgent): CreateTerminalAgent {
  const accountId = agent.account?.accountId ?? agent.accountId;
  const credentialRef = agent.account?.credentialRef;
  return {
    id: agent.id,
    ...(accountId ? { accountId } : {}),
    ...(credentialRef ? { credentialRef } : {}),
    ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
  };
}

/** 权限模式的显示名。菜单是打开时才构建的，所以这里读当前语言即可。 */
export function permissionModeLabel(mode: PermissionMode): string {
  return t(`agent.mode.${mode}`);
}

/**
 * 启动行要按哪种 shell 引用：节点终端实际跑的那个。
 *
 * `sessionShell` 是会话记录里的 shell（最准：core 替节点选的缺省值也在里面）；
 * 还没有会话时用节点指定的，再没有就是 core 的缺省 shell。SSH 节点的行由远端
 * 的登录 shell 读，那边按 POSIX。
 */
export function launchDialect(
  node: { shell?: string; ssh?: unknown },
  sessionShell?: string,
): ShellDialect {
  if (node.ssh) return "posix";
  const shell = sessionShell || node.shell;
  return shell ? shellDialect(shell) : defaultShellDialect();
}

/**
 * 节点上的 Agent 配置 → 要敲进 shell 的那一行。
 *
 * `prompt` 单独传：它来自"带帧粘贴"或右键菜单，而不是节点数据，
 * 且必须由 shared 压成一行（它是被敲进 shell 的，不是 exec）。
 * `dialect` 缺省时按 core 的缺省 shell。
 */
export function buildAgentLaunch(
  agent: TerminalAgent,
  prompt?: string,
  dialect: ShellDialect = defaultShellDialect(),
  remote = false,
): LaunchCommand {
  return assembleLaunchCommand({
    ...launchInput(agent, prompt, remote),
    dialect,
  });
}

/**
 * 恢复一条历史对话的启动行（`--resume` / `resume` 子命令）。
 *
 * 与新开的节点走同一条拼法：本机程序路径、画布启动器都照带——恢复时每个 CLI
 * 都要把 Hook、技能与画布说明重新传一遍，少了它们，恢复出来的会话在画布上就
 * 不报状态、也不认画布规则。
 */
export function buildResumeLaunch(
  agentId: string,
  sessionId: string,
  dialect: ShellDialect = defaultShellDialect(),
): LaunchCommand {
  return assembleLaunchCommand({
    ...launchInput({ id: agentId }),
    resume: sessionId,
    dialect,
  });
}

/**
 * 冻结进后台计划的那份启动定义（自动化设计 §4）。
 *
 * 只带 argv：程序名由执行侧按 `agentId` 从自己的注册表解析，所以一份存下来的
 * 计划永远变不成「运行这个二进制」。这里也不带 `programOverride`——那是本机
 * 设置，不该被写进一份跨重启存活的计划里。
 */
export function buildAgentLaunchArgv(agent: TerminalAgent): LaunchArgv {
  const custom = customAgentFor(agent.id);
  return assembleLaunchArgv({
    agentId: agent.id,
    ...(custom ? { custom } : {}),
    ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
    ...(agent.model ? { model: agent.model } : {}),
  });
}

/**
 * 设置 → Agent 的「自定义启动命令」：CLI 装在 PATH 之外时用它替换程序名。
 * 没有它时用 Runtime 探测到的绝对路径：终端里的 shell 会按自己的 PATH 顺序
 * 再找一次 `codex`，找到的可能是另一份（比如 Homebrew 下签名已吊销的旧版本，
 * 一启动就被系统 SIGKILL）。探测过能用的那一份，就要原样启动它。
 *
 * 画布注入（Hook、技能、画布说明）不在行上：Runtime 的 `GET /api/agents` 答
 * 这台机器上的启动器 `launcher`（设计 canvas-launcher §8.1），行写成
 * `<launcher> <程序> [前置词] <旗标>`，启动器只在节点环境里有
 * `ARMADRA_NODE_ID` 时把注入接在后面。启动器路径是 Runtime 那台机器的，所以
 * 不落进节点数据，也不进后台计划。
 */
function launchInput(agent: TerminalAgent, prompt?: string, remote = false) {
  // SSH 节点的行由执行主机上的 shell 读：本机的程序路径与启动器那边都不存
  // 在。程序按名字由远端 PATH 找，注入由远端的垫片补上（Runtime 在开终端时
  // 已同步过去）。
  const row = remote ? undefined : registryEntry(agent.id);
  const override = usePreferencesStore.getState().launchOverrides[agent.id];
  // Windows 上 npm 装的 CLI 是 `.cmd` 包装：批处理会让 cmd.exe 把参数再读一遍，
  // 引用挡不住。Runtime 读出了包装背后的程序（`launchTarget`）时直接起它。
  const target = override ? undefined : row?.launchTarget;
  const program = remote
    ? undefined
    : override || target?.program || row?.resolvedPath || undefined;
  const lead = target?.args ?? [];
  const custom = customAgentFor(agent.id);
  const launcher = row?.launcher;
  // 有启动器时程序与前置词都是它的参数；程序缺省为条目自己的启动命令。
  const launch = row?.launcher
    ? {
        programOverride: row.launcher,
        programArgs: [program || row.launchCmd, ...lead],
      }
    : {
        ...(program ? { programOverride: program } : {}),
        ...(lead.length > 0 ? { programArgs: lead } : {}),
      };
  // 旧 Runtime 没有启动器，注入以 `launchWords` / `launchArgs` 给出：照旧写在
  // 行上（保留一个版本）。当前 Runtime 两个都不答，没有启动器时就是裸行。
  const words = launcher ? [] : (row?.launchWords ?? []);
  const injected = launcher || words.length > 0 ? [] : (row?.launchArgs ?? []);
  return {
    agentId: agent.id,
    ...(custom ? { custom } : {}),
    ...launch,
    ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
    ...(injected.length > 0 ? { extraArgs: injected } : {}),
    ...(words.length > 0 ? { shellWords: words } : {}),
    ...(prompt ? { prompt } : {}),
  };
}
