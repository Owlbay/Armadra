/**
 * ACP 域：以 Agent Client Protocol 驱动 Agent 的会话视图（ACP 会话视图设计；
 * 补全架构 §5.1）。
 *
 * 边界：
 *   * 协议栈只包装 `@armadra/agent/acp` 的 `AcpClient`（`client.ts`），不自写
 *     JSON-RPC；适配器表在 `adapters.ts`，与 `permissionFlag` 的模式集合一致。
 *   * 会话行复用 `terminal_sessions`（`backend_kind = 'acp'`），不另建表；节点
 *     仍是终端节点，驱动方式在节点数据 `agent.driver`。ACP 是终端管理器的一个
 *     **后端**（`bridge.ts`），所以行、代次、租约、退出、休眠只有一份实现。
 *   * 状态是第四种来源 `acp`：信号经 `hook/normalize` 的 `case "acp"` 与
 *     `hook/ingest.ts::apply` 进同一个 reducer；审批进同一张 `agent_approvals`，
 *     答复经 `agent/approvals.ts` 的 `"acp"` 路由回来。
 *   * 路由 `/api/acp/*` 的权限在 `http/route-scopes.ts` 与
 *     `identity/route-access.ts`；契约 §14。
 *
 * 装配次序：终端域先装（`terminal/install.ts` 用 {@link createAcpBackend} 把后端
 * 放进管理器，再用 {@link provideAcpTerminal} 交出管理器与休眠执行者），本域
 * 后装，只登记路由与审批的送回路。
 */

import { resolve } from "node:path";

import { collab } from "../agent";
import { setAcpApprovalAnswerer, cancelOpenApproval } from "../agent/approvals";
import { expectedProcesses } from "../agent/launch";
import { type AgentSettings, baseAgent, customAgent } from "../agent/registry";
import { acpInjection } from "../agent/canvas-launch";
import { getAgentStatus } from "../agent/status";
import { nodeRole } from "../canvas/context-links";
import { handleForNode } from "../canvas/handles";
import { loadNode } from "../collab/nodes";
import { historyAdapter } from "../history/registry";
import { hookService } from "../hook";
import { type IngestContext, apply } from "../hook/ingest";
import { normalizeAs } from "../hook/normalize";
import { newMemory, type Memory } from "../hook/reduce";
import type { HookService } from "../hook/service";
import type { CoreContext } from "../main";
import { settingsDomain } from "../settings";
import { parseCustomAgents } from "../settings/custom-agents";
import type { TerminalSpec } from "../terminal/backend";
import type { EnvPairs } from "../terminal/environment";
import type { Hibernator } from "../terminal/hibernator";
import type { TerminalManager } from "../terminal/manager";
import { type AcpAdapter, adapterFor } from "./adapters";
import { AcpBackend } from "./bridge";
import { AcpError } from "./client";
import { startAdapter } from "./host";
import { AcpMirror, mirrorPath } from "./mirror";
import { installRoutes } from "./routes";
import { AcpSession, type AcpSessionSink } from "./session";

export {
  ACP_ADAPTERS,
  type AcpAdapter,
  acpAdapter,
  adapterFor,
  acpLaunchPlan,
  acpPermissionModes,
} from "./adapters";
export {
  AcpError,
  type AcpErrorCode,
  type AcpExit,
  type AcpPendingPermission,
  type AcpPermissionSettlement,
  AcpProcess,
} from "./client";
export {
  type AcpSessionOpener,
  type AcpStdioMcpServer,
  CANVAS_MCP_NAME,
  type CanvasMcpInput,
  acpMcpServers,
  canvasMcpServer,
  clientAcceptsMcpServers,
  sessionOpener,
} from "./mcp";
export {
  type AcpCapabilities,
  type AcpHostSession,
  type AcpStartOptions,
  probeAcp,
  rememberedAcpVersion,
  startAcp,
  startAdapter,
} from "./host";
export { AcpBackend } from "./bridge";
export { AcpSession } from "./session";

/* ------------------------------ 起会话的计划 ------------------------------ */

/** 一次起会话要知道、而 `TerminalSpec` 里没有的东西。 */
export interface AcpStartPlan {
  readonly agentId: string;
  readonly permissionMode?: string | undefined;
  readonly model?: string | undefined;
  /** 接回这个 CLI 会话 id；`null` = 明确新开。 */
  readonly resume?: string | null;
}

/** 终端域交给本域的那几样（装配顺序见文件头）。 */
export interface AcpTerminalWiring {
  readonly manager: TerminalManager;
  readonly hibernator: Hibernator;
  readonly backend: AcpBackend;
  /** 终端域的启动对账：路由先等它。 */
  readonly ready: Promise<void>;
  /**
   * 节点会话的环境：节点令牌、地址变量、凭据条目名。`acp` 时不带画布启动器的
   * `PATH` 与 Hook 等答复的变量——适配器起的 CLI 不该再经启动器挂一套 Hook，
   * 一个节点只有一个状态来源。
   */
  readonly environment: (
    nodeId: string,
    agentId: string,
    options: { readonly acp: boolean },
  ) => EnvPairs;
  /** 在一个刚起的 shell 里敲启动行（切回终端驱动）。 */
  readonly typeLaunchLine: (
    sessionId: string,
    generation: number,
    line: string,
  ) => Promise<void>;
  /** 本机解析到的 CLI 程序路径（`GET /api/agents` 的 `resolvedPath`）。 */
  readonly program: (agentId: string) => { readonly path?: string };
}

let wiring: AcpTerminalWiring | undefined;

export function provideAcpTerminal(next: AcpTerminalWiring | undefined): void {
  wiring = next;
}

export function acpTerminal(): AcpTerminalWiring | undefined {
  return wiring;
}

/** 当前装配的设置（自定义条目每次现读）。 */
export function agentSettings(): AgentSettings {
  return (
    collab()?.settings ?? {
      customAgents: () =>
        parseCustomAgents(settingsDomain()?.settings.snapshot() ?? {}),
    }
  );
}

/* --------------------------------- 运行时 --------------------------------- */

class AcpRuntime {
  private readonly prepared = new Map<string, AcpStartPlan>();
  private readonly memory = new Map<string, Memory>();

  constructor(private readonly context: CoreContext) {}

  prepare(nodeId: string, plan: AcpStartPlan): void {
    this.prepared.set(nodeId, plan);
  }

  /** 节点数据与状态行推出来的计划（休眠唤醒、重启后接回）。 */
  private derive(nodeId: string, agentId: string): AcpStartPlan {
    const node = loadNode(this.context.db.database, nodeId);
    const agent =
      node?.data.agent !== null && typeof node?.data.agent === "object"
        ? (node.data.agent as Record<string, unknown>)
        : {};
    const text = (value: unknown) =>
      typeof value === "string" && value !== "" ? value : undefined;
    return {
      agentId,
      permissionMode: text(agent.permissionMode),
      model: text(agent.model),
      resume:
        getAgentStatus(this.context.db.database, nodeId)?.sessionId ?? null,
    };
  }

  private ingest(): IngestContext {
    const shared = hookService();
    const hooks =
      shared ??
      ({
        withMemory: <T>(nodeId: string, action: (memory: Memory) => T): T => {
          let memory = this.memory.get(nodeId);
          if (memory === undefined) {
            memory = newMemory();
            this.memory.set(nodeId, memory);
          }
          return action(memory);
        },
      } as unknown as HookService);
    return {
      database: this.context.db.database,
      bus: this.context.bus,
      hooks,
      log: {
        warn: (message, detail) =>
          this.context.log.warn(message, { detail: String(detail) }),
        debug: (message, detail) =>
          this.context.log.debug(message, { detail: String(detail) }),
      },
    };
  }

  private sink(
    workspaceId: string,
    nodeId: string,
    agentId: string,
    adapter: AcpAdapter,
    cwd: string,
  ): AcpSessionSink {
    const context = this.context;
    return {
      signal: (signal, raw) => {
        const event = normalizeAs("acp", agentId, nodeId, signal);
        if (event === undefined) return;
        try {
          apply(this.ingest(), workspaceId, agentId, event, raw ?? null);
        } catch (error) {
          context.log.warn("could not apply an ACP state report", {
            nodeId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      publish: (event) => {
        context.bus.emit("workspace.event", { workspaceId, event });
      },
      cancelled: (pendingId) => {
        cancelOpenApproval(
          {
            database: context.db.database,
            publish: (target, event) =>
              context.bus.emit("workspace.event", {
                workspaceId: target,
                event,
              }),
          },
          pendingId,
        );
      },
      // §4.3：ACP 会话 id 就是 CLI 自己的、本地历史又找得到这个会话时，认
      // CLI 的转录（与终端驱动字节相同）；否则认镜像。
      transcriptPath: (acpSessionId, mirror) => {
        if (adapter.sessionId === "same") {
          try {
            const located = historyAdapter(adapter.agentId)?.locate({
              agentId: adapter.agentId,
              sessionId: acpSessionId,
              cwd,
            });
            if (located?.path !== undefined) return located.path;
          } catch {
            // 找不到就是找不到：镜像总在。
          }
        }
        return mirror;
      },
      log: (message, fields) => context.log.warn(message, fields),
    };
  }

  /** `AcpBackend` 的开会话：spec → 起好的会话。 */
  async open(
    spec: TerminalSpec,
    onExit: Parameters<ConstructorParameters<typeof AcpBackend>[0]>[1],
  ): Promise<{
    session: AcpSession;
    program: string;
    agentNames: readonly string[];
  }> {
    const env = new Map(spec.env);
    const nodeId = env.get("ARMADRA_NODE_ID") ?? String(spec.sessionKey);
    const rowId = env.get("ARMADRA_SESSION_ID") ?? "";
    const settings = agentSettings();
    const plan =
      this.prepared.get(nodeId) ??
      this.derive(nodeId, env.get("ARMADRA_AGENT_ID") ?? "");
    this.prepared.delete(nodeId);
    const agentId = plan.agentId;
    const adapter = adapterFor(settings, agentId);
    if (adapter === undefined) {
      throw new AcpError(
        "acp_unsupported",
        `${agentId} has no ACP entry point`,
      );
    }
    const dataDir = this.context.dataDir;
    const injection = acpInjection(
      settings,
      dataDir,
      agentId,
      adapter,
      (message, fields) => this.context.log.warn(message, fields),
    );
    const custom = customAgent(settings, agentId);
    const processEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of spec.env) processEnv[name] = value;
    for (const [name, value] of Object.entries(custom?.env ?? {})) {
      processEnv[name] = value;
    }
    for (const [name, value] of injection.env) processEnv[name] = value;

    const resume =
      typeof plan.resume === "string" && plan.resume !== ""
        ? plan.resume
        : undefined;
    const session = new AcpSession({
      rowId,
      generation: spec.generation,
      nodeId,
      workspaceId: spec.workspaceId,
      agentId,
      sink: this.sink(spec.workspaceId, nodeId, agentId, adapter, spec.cwd),
      mirrorFor: (acpSessionId) =>
        new AcpMirror(mirrorPath(dataDir, nodeId, acpSessionId)),
      resumeSessionId: resume,
      onExit,
    });
    const database = this.context.db.database;
    const mode = plan.permissionMode as
      | "default"
      | "auto-edit"
      | "full-auto"
      | "plan"
      | undefined;
    const host = await startAdapter(adapter, {
      cwd: spec.cwd,
      env: processEnv,
      ...(mode === undefined ? {} : { mode }),
      ...(injection.profilePath === undefined
        ? {}
        : { profilePath: injection.profilePath }),
      ...(injection.args.length === 0 ? {} : { injectionArgs: injection.args }),
      ...(resume === undefined ? {} : { resumeSessionId: resume }),
      canvasMcp: {
        nodeId,
        agentId,
        dataDir,
        ...(() => {
          const name = handleForNode(database, nodeId);
          return name === undefined ? {} : { nodeName: name };
        })(),
        ...(() => {
          const role = nodeRole(database, nodeId);
          return role === undefined ? {} : { nodeRole: role };
        })(),
        ...(rowId === ""
          ? {}
          : { session: { id: rowId, generation: spec.generation } }),
      },
      ...session.callbacks(),
      onStderr: (text) =>
        this.context.log.debug("ACP agent stderr", {
          nodeId,
          bytes: text.length,
        }),
    });
    session.opened(host);
    return {
      session,
      program: adapter.program,
      agentNames: expectedProcesses(baseAgent(settings, agentId)),
    };
  }
}

let runtime: AcpRuntime | undefined;
let backend: AcpBackend | undefined;

/**
 * 终端域装配时调用：本域的终端后端。一个 core 一个（模块级，与终端桥同一种
 * 接缝）。
 */
export function createAcpBackend(context: CoreContext): AcpBackend {
  runtime = new AcpRuntime(context);
  const owner = runtime;
  backend = new AcpBackend((spec, onExit) => owner.open(spec, onExit));
  return backend;
}

/** 下一次为这个节点起 ACP 会话时用这份计划（起会话、切换驱动）。 */
export function prepareAcpStart(nodeId: string, plan: AcpStartPlan): void {
  runtime?.prepare(nodeId, plan);
}

/* --------------------------------- 装配 --------------------------------- */

/** 退出钩子只挂一次：同一进程里起第二个 core 的用例不该叠第二个。 */
let exitHooked = false;

export function install(context: CoreContext): void {
  const database = context.db.database;
  // 上一个进程留下的 ACP 审批：进程早已不在，请求也就不在了（不落库的那半
  // 挂起表随进程没了）。一律记 `cancelled` / `core`，别让节点头一直挂着
  // 两个答不出去的按钮。
  try {
    const open = database
      .prepare(
        'SELECT id FROM agent_approvals WHERE answer IS NULL AND request_json LIKE \'%"protocol":"acp"%\'',
      )
      .all() as { id: string }[];
    for (const row of open) {
      cancelOpenApproval(
        {
          database,
          publish: (workspaceId, event) =>
            context.bus.emit("workspace.event", { workspaceId, event }),
        },
        row.id,
      );
    }
  } catch (error) {
    context.log.warn("could not settle stale ACP approvals", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  setAcpApprovalAnswerer((approval, optionId) => {
    const session = backend
      ?.sessions()
      .find((candidate) => candidate.owns(approval.id));
    return session?.answer(approval.id, optionId) ?? false;
  });

  if (!exitHooked) {
    exitHooked = true;
    // 适配器是自成进程组起的（一棵子树一次收掉），core 退出时它们不会跟着
    // PTY 一起没：同步地各发一个 SIGTERM。
    process.once("exit", () => backend?.killAllSync());
  }

  installRoutes(context, {
    wiring: () => wiring,
    prepare: (nodeId, plan) => prepareAcpStart(nodeId, plan),
    settings: agentSettings,
    adapterFor,
    cwdOf: (path) => resolve(path),
  });
}
