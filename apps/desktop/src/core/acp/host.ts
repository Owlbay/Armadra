/**
 * 起一个 ACP 会话：协商、开会话、能力探测（ACP 会话视图设计 §5.1–§5.3、
 * §4.2；补全架构 §5.1）。
 *
 * 一个节点一个适配器进程、一个会话。这里只做「起到能 prompt 为止」：
 *
 *   1. `initialize`（协议版本 1；不声明 `fs` / `terminal`），带截止时间；
 *   2. 按适配器表的 `resume` 与 Agent 声明的能力选接回方法——优先表里写的，
 *      不支持就换另一个，两个都不支持（或表里是 `none`）就新开，并如实答
 *      `resumed: false`；接回失败同样新开（设计 §4.2 第 3 步）；
 *   3. `session/load` 回放的 `session/update` 标 `replay`，会话层不写镜像、
 *      不发给页面（§5.3）；
 *   4. 权限模式落到 `session/set_mode`；`plan` 找不到对应模式 id 时拒绝启动
 *      ——说了只读却以可写模式起来比起不来更糟；
 *   5. 开会话（new / load / resume）带 `mcpServers`（画布工具，§5.8，`mcp.ts`）
 *      ——客户端不支持时照旧开，结果里 `mcpInjected: false`。
 *   6. 模型目录（契约 §26.2）：开会话答的 `configOptions`（没有就看
 *      `initialize` 答的）里的模型那一项；节点数据记着模型且目录里有时经
 *      `session/set_config_option` 落上。落不上不拦启动——模型不是安全边界，
 *      与只读模式不同。客户端没有 `configOptions` 能力时没有目录。
 *
 * 会话、桥、归一化与路由在 G2-1；这里不碰数据库。
 */

import type { PermissionMode } from "../agent/launch";
import { launchTargetOf, resolveCommand } from "../agent/registry";
import { agentPath } from "../terminal/environment";
import { type AcpAdapter, type AcpResume, acpLaunchPlan } from "./adapters";
import { type CanvasMcpInput, acpMcpServers, sessionOpener } from "./mcp";
import {
  type AcpElicitationSettlement,
  AcpError,
  type AcpExit,
  type AcpPendingElicitation,
  type AcpPendingPermission,
  type AcpPermissionSettlement,
  AcpProcess,
  acpClientFeatures,
  messageOf,
} from "./client";
import {
  type AcpModelCatalog,
  configOptionsOf,
  modelCatalogOf,
} from "./models";
import type {
  AcpInitializeResult,
  AcpMcpServer,
  AcpSessionModeState,
  AcpSessionNotification,
} from "./types";

/** `initialize` 的缺省截止时间：`npx` 起的适配器第一次可能要装包。 */
export const INITIALIZE_TIMEOUT_MS = 30_000;

/** Agent 在 `initialize` 里说了什么，摊平成会话层要问的几个问题。 */
export interface AcpCapabilities {
  readonly protocolVersion: number;
  readonly agent?: { readonly name: string; readonly version: string };
  readonly load: boolean;
  readonly resume: boolean;
  readonly list: boolean;
  readonly close: boolean;
  readonly images: boolean;
  readonly embeddedContext: boolean;
  /** 声明了鉴权方法：没登录时 `session/new` 会答 auth_required。 */
  readonly authMethods: readonly string[];
}

export type AcpOpenMethod = "new" | "load" | "resume";

export interface AcpUpdateMeta {
  /** `session/load` 回放的历史：不进镜像、不发给页面。 */
  readonly replay: boolean;
}

/**
 * 适配器进程实际怎么起（契约 §26 的 SSH 小节）：缺省在本机直接起
 * `program args`；SSH 节点换成 `ssh … -- 目的主机 <远端命令>`，stdio 照旧是
 * ACP 的传输。`cwd` 是会话的工作目录（`session/new` 用它），答复里的 `cwd`
 * 只是本机子进程的起点。
 */
export type AcpTransport = (command: {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv | undefined;
}) => {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
};

export interface AcpStartOptions {
  /** 版本缓存的键（`GET /api/agents` 的 `acp.version`）；缺席不记。 */
  readonly agentId?: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 起会话后 `session/set_mode` 的 id。 */
  readonly modeId?: string;
  /** 找不到 {@link modeId} 时拒绝启动（只读模式）。 */
  readonly requireMode?: boolean;
  /** 起会话后要落的模型（节点数据 `agent.model`）；目录里没有就不落。 */
  readonly modelId?: string;
  /** 接回这个会话；`method` 是适配器表的偏好。 */
  readonly resume?: { readonly sessionId: string; readonly method: AcpResume };
  /** 开会话时交给 Agent 的 MCP 服务器（§5.8）；缺席或空 = 不带。 */
  readonly mcpServers?: readonly AcpMcpServer[];
  readonly initializeTimeoutMs?: number;
  /** 缺省在本机直接起；见 {@link AcpTransport}。 */
  readonly transport?: AcpTransport;
  readonly onUpdate?: (
    notification: AcpSessionNotification,
    meta: AcpUpdateMeta,
  ) => void;
  readonly onPermission?: (pending: AcpPendingPermission) => void;
  readonly onPermissionSettled?: (
    pending: AcpPendingPermission,
    settlement: AcpPermissionSettlement,
  ) => void;
  readonly onElicitation?: (pending: AcpPendingElicitation) => void;
  readonly onElicitationSettled?: (
    pending: AcpPendingElicitation,
    settlement: AcpElicitationSettlement,
  ) => void;
  readonly onStderr?: (text: string) => void;
  readonly onExit?: (exit: AcpExit) => void;
}

export interface AcpHostSession {
  readonly process: AcpProcess;
  readonly sessionId: string;
  readonly opened: AcpOpenMethod;
  /** 要求接回且接上了。要求接回却答 false：页面说「没有接上原会话，已新开」。 */
  readonly resumed: boolean;
  /** 接回失败的原因（接回被拒、能力不支持）；新开成功时才有。 */
  readonly resumeError?: { readonly code: string; readonly message: string };
  readonly capabilities: AcpCapabilities;
  readonly modes: AcpSessionModeState | null;
  /** 要求了模式：落上了没有。没要求时缺席。 */
  readonly modeApplied?: boolean;
  /** 模型目录（§26.2）；客户端或 Agent 不给时为 `null`。 */
  readonly models: AcpModelCatalog | null;
  /** 要求了模型：落上了没有。没要求时缺席。 */
  readonly modelApplied?: boolean;
  /**
   * 要求带 MCP 服务器：真的随开会话发出去了没有（客户端旧版不支持时为
   * false，会话照样可用、只是没有画布工具）。没要求时缺席。
   */
  readonly mcpInjected?: boolean;
}

/* -------------------------------- 版本缓存 -------------------------------- */

const versions = new Map<string, string>();

/** 这家最近一次 `initialize` 报的 `agentInfo.version`；列表只读缓存、不起进程。 */
export function rememberedAcpVersion(agentId: string): string | undefined {
  return versions.get(agentId);
}

/** 测试用。 */
export function forgetAcpVersions(): void {
  versions.clear();
}

/* --------------------------------- 协商 ---------------------------------- */

export function capabilitiesOf(result: AcpInitializeResult): AcpCapabilities {
  const agent = result.agentCapabilities ?? {};
  const info = result.agentInfo;
  return {
    protocolVersion: result.protocolVersion,
    ...(info === undefined
      ? {}
      : { agent: { name: info.name, version: info.version } }),
    load: agent.loadSession === true,
    resume: agent.sessionCapabilities?.resume != null,
    list: agent.sessionCapabilities?.list != null,
    close: agent.sessionCapabilities?.close != null,
    images: agent.promptCapabilities?.image === true,
    embeddedContext: agent.promptCapabilities?.embeddedContext === true,
    authMethods: (result.authMethods ?? []).map((method) => method.id),
  };
}

/**
 * 实际用哪个方法接回。表里的偏好优先；Agent 不支持就换另一个；表里是
 * `none`（Copilot：`loadSession` 只在同一进程内有效）就新开，不管它声明了什么。
 */
export function resumeMethod(
  preferred: AcpResume,
  capabilities: Pick<AcpCapabilities, "load" | "resume">,
): AcpResume {
  if (preferred === "none") return "none";
  const order: AcpResume[] =
    preferred === "resume" ? ["resume", "load"] : ["load", "resume"];
  return (
    order.find((method) => capabilities[method as "load" | "resume"]) ?? "none"
  );
}

/* --------------------------------- 起会话 --------------------------------- */

export async function startAcp(
  options: AcpStartOptions,
): Promise<AcpHostSession> {
  let replaying: string | undefined;
  const launch = launchOf(options);
  const process_ = AcpProcess.spawn({
    program: launch.program,
    args: launch.args,
    cwd: launch.cwd,
    ...(launch.env === undefined ? {} : { env: launch.env }),
    clientInfo: { name: "armadra", title: "Armadra", version: "1" },
    onUpdate: (notification) =>
      options.onUpdate?.(notification, {
        replay: replaying !== undefined && notification.sessionId === replaying,
      }),
    ...(options.onPermission === undefined
      ? {}
      : { onPermission: options.onPermission }),
    ...(options.onPermissionSettled === undefined
      ? {}
      : { onPermissionSettled: options.onPermissionSettled }),
    ...(options.onElicitation === undefined
      ? {}
      : { onElicitation: options.onElicitation }),
    ...(options.onElicitationSettled === undefined
      ? {}
      : { onElicitationSettled: options.onElicitationSettled }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
  });

  try {
    const { capabilities, initialized } = await negotiate(process_, options);
    if (options.agentId !== undefined && capabilities.agent !== undefined) {
      versions.set(options.agentId, capabilities.agent.version);
    }

    const opener = sessionOpener(process_.client, options.mcpServers ?? []);
    let opened: AcpOpenMethod = "new";
    let sessionId: string | undefined;
    let modes: AcpSessionModeState | null = null;
    let config: unknown;
    let resumeError: { code: string; message: string } | undefined;

    if (options.resume !== undefined) {
      const method = resumeMethod(options.resume.method, capabilities);
      if (method === "none") {
        resumeError = {
          code: "acp_resume_unsupported",
          message: "the agent cannot resume a session across processes",
        };
      } else {
        const id = options.resume.sessionId;
        try {
          if (method === "load") {
            replaying = id;
            const result = await opener.loadSession(id, options.cwd);
            modes = result.modes ?? null;
            config = configOptionsOf(result);
            opened = "load";
          } else {
            const result = await opener.resumeSession(id, options.cwd);
            modes = result.modes ?? null;
            config = configOptionsOf(result);
            opened = "resume";
          }
          sessionId = id;
        } catch (error) {
          if (await gone(process_, error)) throw exitedError(process_);
          resumeError = {
            code: "acp_resume_failed",
            message: messageOf(error),
          };
        } finally {
          replaying = undefined;
        }
      }
    }

    if (sessionId === undefined) {
      try {
        const result = await opener.newSession(options.cwd);
        sessionId = result.sessionId;
        modes = result.modes ?? null;
        config = configOptionsOf(result);
      } catch (error) {
        if (await gone(process_, error)) throw exitedError(process_);
        if (rpcCode(error) === -32000) {
          throw new AcpError(
            "acp_auth_required",
            "the agent is not signed in; sign in with the CLI itself first",
          );
        }
        throw new AcpError("acp_session_failed", messageOf(error));
      }
    }

    let modeApplied: boolean | undefined;
    if (options.modeId !== undefined) {
      modeApplied = await applyMode(process_, sessionId, modes, options.modeId);
      if (!modeApplied && options.requireMode === true) {
        throw new AcpError(
          "acp_mode_unavailable",
          `the agent has no mode ${options.modeId}`,
        );
      }
      if (modeApplied && modes !== null) {
        modes = { ...modes, currentModeId: options.modeId };
      }
    }

    let models: AcpModelCatalog | null = acpClientFeatures().configOptions
      ? (modelCatalogOf(config) ?? modelCatalogOf(configOptionsOf(initialized)))
      : null;
    let modelApplied: boolean | undefined;
    if (options.modelId !== undefined) {
      const applied = await applyModel(
        process_,
        sessionId,
        models,
        options.modelId,
      );
      modelApplied = applied.applied;
      models = applied.models;
    }

    return {
      process: process_,
      sessionId,
      opened,
      resumed: options.resume !== undefined && opened !== "new",
      ...(resumeError === undefined || opened !== "new" ? {} : { resumeError }),
      capabilities,
      modes,
      ...(modeApplied === undefined ? {} : { modeApplied }),
      models,
      ...(modelApplied === undefined ? {} : { modelApplied }),
      ...((options.mcpServers?.length ?? 0) === 0
        ? {}
        : { mcpInjected: opener.mcpInjected }),
    };
  } catch (error) {
    await process_.terminate();
    throw error;
  }
}

/** 实际起的子进程：缺省就是选项里的那一个，给了 transport 由它改写。 */
function launchOf(
  options: Pick<
    AcpStartOptions,
    "program" | "args" | "cwd" | "env" | "transport"
  >,
): {
  program: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
} {
  const direct = {
    program: options.program,
    args: options.args,
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
  };
  if (options.transport === undefined) return direct;
  return options.transport({ ...direct, env: options.env });
}

async function negotiate(
  process_: AcpProcess,
  options: Pick<AcpStartOptions, "initializeTimeoutMs">,
): Promise<{
  capabilities: AcpCapabilities;
  initialized: AcpInitializeResult;
}> {
  const timeout = AbortSignal.timeout(
    options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS,
  );
  try {
    const initialized = await process_.client.initialize(timeout);
    return { capabilities: capabilitiesOf(initialized), initialized };
  } catch (error) {
    if (await gone(process_, error)) throw exitedError(process_);
    if (timeout.aborted) {
      throw new AcpError(
        "acp_initialize_timeout",
        "the agent did not answer initialize in time",
      );
    }
    const message = messageOf(error);
    if (message.includes("incompatible ACP protocol version")) {
      throw new AcpError("acp_protocol_version", message);
    }
    throw new AcpError("acp_initialize_failed", message);
  }
}

/** 落模式；Agent 没给模式表、表里没有这个 id、或 set_mode 被拒都答 false。 */
async function applyMode(
  process_: AcpProcess,
  sessionId: string,
  modes: AcpSessionModeState | null,
  modeId: string,
): Promise<boolean> {
  if (modes === null) return false;
  if (!modes.availableModes.some((mode) => mode.id === modeId)) return false;
  if (modes.currentModeId === modeId) return true;
  try {
    await process_.setMode(sessionId, modeId);
    return true;
  } catch (error) {
    if (await gone(process_, error)) throw exitedError(process_);
    return false;
  }
}

/**
 * 落模型。目录里没有、已经是它、或 Agent 拒了都不拦启动；答落上了没有与改后
 * 的目录（Agent 答复里带了 `configOptions` 就以它为准）。
 */
async function applyModel(
  process_: AcpProcess,
  sessionId: string,
  models: AcpModelCatalog | null,
  modelId: string,
): Promise<{ applied: boolean; models: AcpModelCatalog | null }> {
  if (models === null) return { applied: false, models };
  if (!models.availableModels.some((model) => model.modelId === modelId)) {
    return { applied: false, models };
  }
  if (models.currentModelId === modelId) return { applied: true, models };
  try {
    const answer = await process_.setConfigOption(
      sessionId,
      models.configId,
      modelId,
    );
    return {
      applied: true,
      models: modelCatalogOf(answer) ?? { ...models, currentModelId: modelId },
    };
  } catch (error) {
    if (await gone(process_, error)) throw exitedError(process_);
    return { applied: false, models };
  }
}

/**
 * 这次失败是不是因为进程没了。stdout 关闭（`connection_closed`）往往先于
 * `exit` 事件到达，所以先等一小会儿退出信息，再按「退了」作答。
 */
async function gone(process_: AcpProcess, error: unknown): Promise<boolean> {
  if (!process_.alive) return true;
  const reason = (error as { data?: { reason?: unknown } } | null)?.data
    ?.reason;
  if (reason !== "connection_closed") return false;
  await Promise.race([
    process_.exited,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, EXIT_SETTLE_MS);
      timer.unref?.();
    }),
  ]);
  return true;
}

/** 连接关了之后等退出信息的时长。 */
const EXIT_SETTLE_MS = 1_000;

/** 起会话的过程中进程没了。stderr 不进消息（它可能带着用户的输出）。 */
function exitedError(process_: AcpProcess): AcpError {
  const exit = process_.exit;
  const how =
    exit === undefined
      ? "exited"
      : exit.signal !== null
        ? `was killed by ${exit.signal}`
        : `exited with code ${String(exit.code)}`;
  return new AcpError("acp_exited", `the ACP agent ${how} during start`);
}

function rpcCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

/* ------------------------------- 按适配器起 ------------------------------- */

export interface AcpAdapterStart
  extends Omit<
    AcpStartOptions,
    "program" | "args" | "modeId" | "requireMode" | "resume" | "agentId"
  > {
  readonly mode?: PermissionMode;
  readonly profilePath?: string;
  readonly injectionArgs?: readonly string[];
  /** 接回这个 CLI 会话 id；方法按适配器表。 */
  readonly resumeSessionId?: string;
  /**
   * 画布工具注入的输入（§5.8）：适配器表 `injection.mcp` 为真时据此带
   * `armadra-hook mcp`；缺席不带。
   */
  readonly canvasMcp?: CanvasMcpInput;
}

/**
 * 按适配器表起：在补齐过的 PATH 上找程序（与 `GET /api/agents` 同一条规则），
 * Windows 的 npm 包装（`.cmd`）换成它背后的 `node <cli.js>`，再 {@link startAcp}。
 */
export function startAdapter(
  adapter: AcpAdapter,
  options: AcpAdapterStart,
): Promise<AcpHostSession> {
  const ambient = options.env ?? process.env;
  // 经 transport 起的程序在别的机器上：本机不解析，由那边的 PATH 找（是否装了
  // 由调用方先问过那台机器）。
  const resolved =
    options.transport === undefined
      ? resolveCommand(adapter.program, ambient)
      : adapter.program;
  if (resolved === undefined) {
    return Promise.reject(
      new AcpError(
        "acp_not_installed",
        `${adapter.program} is not installed on this machine`,
      ),
    );
  }
  const plan = acpLaunchPlan(adapter, {
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.profilePath === undefined
      ? {}
      : { profilePath: options.profilePath }),
    ...(options.injectionArgs === undefined
      ? {}
      : { injectionArgs: options.injectionArgs }),
  });
  if ("code" in plan) {
    return Promise.reject(new AcpError(plan.code, plan.message));
  }
  const target =
    options.transport === undefined
      ? launchTargetOf(resolved, ambient)
      : undefined;
  const env: NodeJS.ProcessEnv =
    options.transport === undefined
      ? { ...ambient, PATH: agentPath(ambient) }
      : ambient;
  const mode = options.mode ?? "default";
  const { canvasMcp, mcpServers: given, ...rest } = options;
  // 给了现成的服务器（SSH 节点：执行主机上的 Hook 客户端）就用它们。
  const mcpServers = given ?? acpMcpServers(adapter, canvasMcp);
  return startAcp({
    ...rest,
    env,
    ...(mcpServers.length === 0 ? {} : { mcpServers }),
    agentId: adapter.agentId,
    program: target?.program ?? resolved,
    args: [...(target?.args ?? []), ...plan.args],
    ...(plan.modeId === undefined
      ? {}
      : {
          modeId: plan.modeId,
          requireMode: mode === "plan",
        }),
    ...(options.resumeSessionId === undefined
      ? {}
      : {
          resume: {
            sessionId: options.resumeSessionId,
            method: adapter.resume,
          },
        }),
  });
}

/**
 * 能力探测：起一次、`initialize`、收掉。集成页「检查」与兼容区间核对用；
 * 列表从不调它（一次列表绝不等一个子进程）。
 */
export async function probeAcp(
  options: Pick<
    AcpStartOptions,
    | "agentId"
    | "program"
    | "args"
    | "cwd"
    | "env"
    | "initializeTimeoutMs"
    | "transport"
  >,
): Promise<AcpCapabilities> {
  const launch = launchOf(options);
  const process_ = AcpProcess.spawn({
    program: launch.program,
    args: launch.args,
    cwd: launch.cwd,
    ...(launch.env === undefined ? {} : { env: launch.env }),
  });
  try {
    const { capabilities } = await negotiate(process_, options);
    if (options.agentId !== undefined && capabilities.agent !== undefined) {
      versions.set(options.agentId, capabilities.agent.version);
    }
    return capabilities;
  } finally {
    await process_.terminate();
  }
}
