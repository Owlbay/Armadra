/**
 * `/api/acp/*`（契约 §14.2；ACP 会话视图设计 §4.2、§9.2）。
 *
 * 会话就是 `terminal_sessions` 的一行，所以这里的每条路都落到终端管理器的
 * 原语上，不另起一套：起会话 = `spawn`（后端 `acp`），提示 = `writeSubmit`
 * （人类驾驶者，与终端里敲键同一条租约语义），取消 = `ESC`，接回 = 同一行上
 * 起下一代（`revive`）。驱动切换先结束当前驱动、再在同一行上以另一种驱动起
 * 下一代，用 CLI 自己的会话 id 接回，接不回就新开并如实答 `resumed: false`。
 */

import type { DatabaseSync } from "node:sqlite";

import { canvasLaunchLine, nodeDialect } from "../agent/canvas-launch";
import { PERMISSION_MODES, canResume } from "../agent/launch";
import type { AgentSettings } from "../agent/registry";
import { getAgentStatus } from "../agent/status";
import { loadNode, loadSession, workspaceRoot } from "../collab/nodes";
import { humanActor } from "../drive/lease";
import { isAcpMirror } from "../history/acp-mirror";
import { CoreFailure } from "../http/errors";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import type { CoreContext } from "../main";
import { hibernatedSession } from "../terminal/hibernate";
import { resumeLine } from "../terminal/hibernator";
import type { TerminalSession } from "../terminal/manager";
import {
  DomainError,
  badRequest,
  jsonObject,
  optionalString,
} from "../workspaces/support";
import { type AcpAdapter, cliResumeId } from "./adapters";
import { AcpError } from "./client";
import type { AcpStartPlan, AcpTerminalWiring } from "./index";
import { AcpMirror, mirrorPath } from "./mirror";
import { sshHostOf } from "./ssh";

export interface AcpRouteDeps {
  readonly wiring: () => AcpTerminalWiring | undefined;
  readonly prepare: (nodeId: string, plan: AcpStartPlan) => void;
  readonly settings: () => AgentSettings;
  readonly adapterFor: (
    settings: AgentSettings,
    agentId: string,
  ) => AcpAdapter | undefined;
  readonly cwdOf: (path: string) => string;
}

/** 正在切换驱动或接回的节点：这段时间里投递把「没有会话」当「还早」。 */
const busyNodes = new Map<string, Promise<unknown>>();

export function acpSwitching(nodeId: string): boolean {
  return busyNodes.has(nodeId);
}

/** 同一个节点上的起、停、切换一次一个。 */
function exclusive<T>(nodeId: string, job: () => Promise<T>): Promise<T> {
  const previous = busyNodes.get(nodeId) ?? Promise.resolve();
  const next = previous.then(job, job);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  busyNodes.set(nodeId, settled);
  void settled.then(() => {
    if (busyNodes.get(nodeId) === settled) busyNodes.delete(nodeId);
  });
  return next;
}

/**
 * 契约 §39.9：页面给一轮起的 `clientTurnId` → 那一次投递。同一会话同一 id 答同一
 * 个结果、只投递一次；投递失败（拒绝、会话没了）的删掉，好让重发真的再投。只记
 * 最近 {@link PROMPT_IDS} 个，core 重启后从空开始。
 */
const promptsById = new Map<string, Promise<{ turnId: string }>>();
const PROMPT_IDS = 512;

/** 同一会话行上的提示一次一个：记页面回合 id、投递、读回合 id 之间不插队。 */
const promptLocks = new Map<string, Promise<unknown>>();

function promptLocked<T>(rowId: string, job: () => Promise<T>): Promise<T> {
  const previous = promptLocks.get(rowId) ?? Promise.resolve();
  const next = previous.then(job, job);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  promptLocks.set(rowId, settled);
  void settled.then(() => {
    if (promptLocks.get(rowId) === settled) promptLocks.delete(rowId);
  });
  return next;
}

function failure(error: unknown): HandlerResult {
  // `DomainError` 与 `TerminalError` 都是 `CoreFailure`。
  if (error instanceof CoreFailure) {
    const { status, body } = error.response();
    return { status, body };
  }
  if (error instanceof AcpError) {
    return { status: acpStatus(error.code), body: error.toJSON() };
  }
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: { code: "bad_request", message: "Request body is not valid JSON" },
    };
  }
  throw error;
}

function acpStatus(code: string): number {
  switch (code) {
    case "acp_not_installed":
    case "acp_unsupported":
    case "acp_mode_unsupported":
    case "acp_no_raw_write":
      return 400;
    case "acp_mode_unavailable":
    case "acp_model_unavailable":
    case "acp_model_unsupported":
    case "acp_auth_required":
    case "acp_session":
    case "awaiting_approval":
      return 409;
    default:
      return 502;
  }
}

const domain = (status: number, code: string, message: string) =>
  new DomainError(status, code, message);

function param(match: RouteMatch, name: string): string {
  const value = match.params[name];
  if (value === undefined) throw badRequest(`${name} is missing`);
  return value;
}

/** 人在会话视图里发的：与终端里敲键同一个人类驾驶者（`/drive` 同一条规矩）。 */
function humanOf(wiring: AcpTerminalWiring, sessionId: string) {
  const held = wiring.manager.driveLease(sessionId).holder;
  return held?.kind === "human"
    ? humanActor(held.id, held.displayName)
    : humanActor("local", "");
}

function agentOf(node: { readonly data: Record<string, unknown> }) {
  const agent = node.data.agent;
  return agent !== null && typeof agent === "object"
    ? (agent as Record<string, unknown>)
    : {};
}

/** 这个节点是不是 SSH 节点（节点还没落盘时不是）。 */
function sshOf(database: DatabaseSync, nodeId: string): string | undefined {
  return sshHostOf(loadNode(database, nodeId)?.data);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function installRoutes(context: CoreContext, deps: AcpRouteDeps): void {
  const database: DatabaseSync = context.db.database;

  const need = async (): Promise<AcpTerminalWiring> => {
    const wiring = deps.wiring();
    if (wiring === undefined) {
      throw domain(
        503,
        "unavailable",
        "The terminal domain is not assembled in this core",
      );
    }
    await wiring.ready;
    return wiring;
  };

  const route = (
    method: string,
    path: string,
    handler: (
      match: RouteMatch,
      request: CoreRequest,
    ) => Promise<HandlerResult>,
  ) => {
    context.server.router.handle(method, path, async (match, request) => {
      try {
        return await handler(match, request);
      } catch (error) {
        return failure(error);
      }
    });
  };

  /**
   * 契约 §43.1（`acp.*`）：旧路径的 handler 先把路径参数、查询串与体读出来，再调
   * 下面同一份操作；procedure 的入参已由门面按契约解析。拒绝一律抛 `CoreFailure`，
   * ACP 自己的错误（`AcpError`）在这里换成同码同状态的 `CoreFailure`。
   */
  const guarded =
    <A extends unknown[], R>(operation: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await operation(...args);
      } catch (error) {
        if (error instanceof AcpError) {
          throw new CoreFailure(
            acpStatus(error.code),
            error.code,
            error.message,
          );
        }
        throw error;
      }
    };

  /** 节点上这一行的下一代（接回）。休眠着的走休眠执行者，好让它的状态机对得上。 */
  const relaunch = (
    wiring: AcpTerminalWiring,
    nodeId: string,
    rowId: string,
    agentId: string,
  ): Promise<TerminalSession> =>
    exclusive(nodeId, async () => {
      if (wiring.manager.isAlive(rowId)) return wiring.manager.session(rowId);
      if (hibernatedSession(database, nodeId)?.sessionId === rowId) {
        await wiring.hibernator.wake(nodeId, "focus");
        return wiring.manager.session(rowId);
      }
      return wiring.manager.revive(
        rowId,
        wiring.environment(nodeId, agentId, {
          acp: true,
          ssh: sshOf(database, nodeId) !== undefined,
        }),
        { ended: true },
      );
    });

  /** 一个活着的 ACP 会话行；结束了的（休眠、重启、适配器退出）先接回。 */
  const live = async (
    wiring: AcpTerminalWiring,
    rowId: string,
  ): Promise<TerminalSession> => {
    const row = wiring.manager.session(rowId);
    if (row.backend !== "acp") {
      throw domain(409, "acp_session", "This session is not driven over ACP");
    }
    if (wiring.manager.isAlive(rowId)) return row;
    const nodeId = row.ownerNodeId;
    if (nodeId === null || row.agentId === null) {
      throw domain(409, "acp_exited", "The ACP session has ended");
    }
    if (loadSession(database, nodeId)?.sessionId !== rowId) {
      throw domain(
        409,
        "conflict",
        "This node has moved on to another session",
      );
    }
    return relaunch(wiring, nodeId, rowId, row.agentId);
  };

  /* -------------------------------- 起会话 -------------------------------- */

  const createSession = guarded(async (body: Record<string, unknown>) => {
    const wiring = await need();
    const workspaceId = optionalString(body, "workspaceId");
    const nodeId = optionalString(body, "nodeId");
    const cwd = optionalString(body, "cwd");
    const agentId = optionalString(body, "agentId");
    if (!workspaceId || !nodeId || !cwd || !agentId) {
      throw badRequest("workspaceId, nodeId, cwd and agentId are required");
    }
    const permissionMode = optionalString(body, "permissionMode");
    if (
      permissionMode !== undefined &&
      !(PERMISSION_MODES as readonly string[]).includes(permissionMode)
    ) {
      throw badRequest("permissionMode is not a known mode");
    }
    const model = optionalString(body, "model");
    const resume = optionalString(body, "resume");
    const prompt = optionalString(body, "prompt");
    const settings = deps.settings();
    if (deps.adapterFor(settings, agentId) === undefined) {
      throw new AcpError(
        "acp_unsupported",
        `${agentId} has no ACP entry point`,
      );
    }

    // SSH 节点：适配器起在执行主机上，`cwd` 是那边的路径，不按本机规则解析。
    const ssh = sshOf(database, nodeId) !== undefined;
    const row = await exclusive(nodeId, async () => {
      const latest = loadSession(database, nodeId);
      if (latest !== undefined) {
        const existing = wiring.manager.session(latest.sessionId);
        if (wiring.manager.isAlive(latest.sessionId)) {
          // 两台设备同时挂载、或者重试：同一个节点只有一个活会话。
          if (existing.backend === "acp") return existing;
          throw domain(
            409,
            "conflict",
            "A terminal is running for this node; switch its driver instead",
          );
        }
        if (existing.backend === "acp") {
          deps.prepare(nodeId, {
            agentId,
            permissionMode,
            model,
            resume:
              resume ?? getAgentStatus(database, nodeId)?.sessionId ?? null,
          });
          return wiring.manager.revive(
            latest.sessionId,
            wiring.environment(nodeId, agentId, { acp: true, ssh }),
            { ended: true },
          );
        }
      }
      deps.prepare(nodeId, {
        agentId,
        permissionMode,
        model,
        resume: resume ?? null,
      });
      const adapter = deps.adapterFor(settings, agentId) as AcpAdapter;
      return wiring.manager.spawn({
        workspaceId,
        cwd: ssh ? cwd : deps.cwdOf(cwd),
        command: adapter.program,
        kind: "terminal",
        ownerNodeId: nodeId,
        agentId,
        backend: "acp",
        env: wiring.environment(nodeId, agentId, { acp: true, ssh }),
      });
    });
    if (prompt !== undefined && prompt.trim() !== "") {
      await wiring.manager.writeSubmit(
        row.id,
        row.generation,
        prompt,
        humanOf(wiring, row.id),
      );
    }
    return wiring.manager.session(row.id);
  });

  /* --------------------------------- 回合 --------------------------------- */

  const deliverPrompt = (
    sessionId: string,
    prompt: string,
    clientTurnId: string | undefined,
  ) =>
    promptLocked(sessionId, async () => {
      const wiring = await need();
      const row = await live(wiring, sessionId);
      wiring.backend.expectClientTurn(row.sessionKey, clientTurnId);
      try {
        await wiring.manager.writeSubmit(
          row.id,
          row.generation,
          prompt,
          humanOf(wiring, row.id),
        );
      } finally {
        wiring.backend.expectClientTurn(row.sessionKey, undefined);
      }
      const turnId = wiring.backend.lastTurn(row.sessionKey) ?? "";
      return { turnId };
    });

  const sendPrompt = guarded(
    async (sessionId: string, text: unknown, clientTurn?: unknown) => {
      const prompt = optionalString({ text }, "text");
      if (prompt === undefined || prompt.trim() === "") {
        throw badRequest("text is required");
      }
      if (
        clientTurn !== undefined &&
        clientTurn !== null &&
        (typeof clientTurn !== "string" ||
          clientTurn === "" ||
          clientTurn.length > 128)
      ) {
        throw badRequest("clientTurnId must be a string of 1 to 128 chars");
      }
      const clientTurnId =
        typeof clientTurn === "string" ? clientTurn : undefined;
      if (clientTurnId === undefined) {
        return deliverPrompt(sessionId, prompt, undefined);
      }
      const key = `${sessionId}\n${clientTurnId}`;
      const seen = promptsById.get(key);
      if (seen !== undefined) return seen;
      const delivery = deliverPrompt(sessionId, prompt, clientTurnId);
      promptsById.set(key, delivery);
      if (promptsById.size > PROMPT_IDS) {
        const oldest = promptsById.keys().next().value;
        if (oldest !== undefined) promptsById.delete(oldest);
      }
      delivery.catch(() => {
        if (promptsById.get(key) === delivery) promptsById.delete(key);
      });
      return delivery;
    },
  );

  const cancel = guarded(async (rowId: string) => {
    const wiring = await need();
    const row = wiring.manager.session(rowId);
    if (row.backend !== "acp") {
      throw domain(409, "acp_session", "This session is not driven over ACP");
    }
    // 与节点头「打断这一轮」、`interrupt` 动词同一个原语：一个 ESC。
    await wiring.backend.sessionByRow(rowId)?.cancel();
  });

  const setMode = guarded(async (sessionId: string, value: unknown) => {
    const wiring = await need();
    const modeId = optionalString({ modeId: value }, "modeId");
    if (modeId === undefined || modeId === "") {
      throw badRequest("modeId is required");
    }
    const row = await live(wiring, sessionId);
    const session = wiring.backend.sessionByRow(row.id);
    if (session === undefined) {
      throw domain(409, "acp_exited", "The ACP session has ended");
    }
    await session.setMode(modeId);
  });

  // 契约 §26.2：`session/set_config_option` 落模型。目录里没有、或客户端没有
  // 这个能力时 409；节点数据里的 `agent.model` 由页面写回。
  const setModel = guarded(async (sessionId: string, value: unknown) => {
    const wiring = await need();
    const modelId = optionalString({ modelId: value }, "modelId");
    if (modelId === undefined || modelId === "") {
      throw badRequest("modelId is required");
    }
    const row = await live(wiring, sessionId);
    const session = wiring.backend.sessionByRow(row.id);
    if (session === undefined) {
      throw domain(409, "acp_exited", "The ACP session has ended");
    }
    await session.setModel(modelId);
  });

  /* --------------------------------- 镜像 --------------------------------- */

  const readLog = guarded(async (rowId: string, afterValue: unknown) => {
    const wiring = await need();
    const row = wiring.manager.session(rowId);
    const afterRaw = Number(afterValue ?? "0");
    const after =
      Number.isFinite(afterRaw) && afterRaw > 0 ? Math.floor(afterRaw) : 0;
    const session = wiring.backend.sessionByRow(rowId);
    let path = session?.mirrorPath;
    if (path === undefined && row.ownerNodeId !== null) {
      const status = getAgentStatus(database, row.ownerNodeId);
      if (isAcpMirror(status?.transcriptPath)) {
        path = status?.transcriptPath;
      } else if (status?.sessionId !== undefined) {
        path = mirrorPath(context.dataDir, row.ownerNodeId, status.sessionId);
      }
    }
    const read =
      path === undefined
        ? { entries: [], endOffset: 0 }
        : new AcpMirror(path).read(after);
    return {
      entries: read.entries,
      endOffset: read.endOffset,
      modes: session?.modes ?? null,
      models: session?.models ?? null,
      ...(session === undefined
        ? {}
        : {
            pending: session.pending(),
            elicitations: session.pendingElicitations(),
            turns: session.recentTurns(),
            snapshot: session.snapshot(),
          }),
    };
  });

  /* ------------------------------- 驱动切换 ------------------------------- */

  const changeDriver = guarded(async (nodeId: string, value: unknown) => {
    const wiring = await need();
    const driver = optionalString({ driver: value }, "driver");
    if (driver !== "acp" && driver !== "terminal") {
      throw badRequest("driver must be acp or terminal");
    }
    const result = await switchDriver(wiring, nodeId, driver);
    context.bus.emit("workspace.event", {
      workspaceId: result.workspaceId,
      event: {
        type: "acp.driver",
        nodeId,
        driver,
        sessionId: result.sessionId,
        resumed: result.resumed,
      },
    });
    return { sessionId: result.sessionId, resumed: result.resumed };
  });

  /* ------------------------ 契约 §43.1 与旧路径的登记 ----------------------- */

  const procedures = {
    createSession: (input: Record<string, unknown>) => createSession(input),
    prompt: ({
      sessionId,
      text,
      clientTurnId,
    }: {
      sessionId: string;
      text?: unknown;
      clientTurnId?: unknown;
    }) => sendPrompt(sessionId, text, clientTurnId),
    cancel: ({ sessionId }: { sessionId: string }) => cancel(sessionId),
    setMode: ({ sessionId, modeId }: { sessionId: string; modeId?: unknown }) =>
      setMode(sessionId, modeId),
    setModel: ({
      sessionId,
      modelId,
    }: {
      sessionId: string;
      modelId?: unknown;
    }) => setModel(sessionId, modelId),
    log: ({ sessionId, after }: { sessionId: string; after?: unknown }) =>
      readLog(sessionId, after),
    switchDriver: ({ nodeId, driver }: { nodeId: string; driver?: unknown }) =>
      changeDriver(nodeId, driver),
  };
  registerProcedures(
    context.server,
    "acp",
    procedures as unknown as DomainHandlers<"acp">,
  );

  route("POST", "/api/acp/sessions", async (_match, request) => ({
    status: 200,
    body: await createSession(jsonObject(request.body)),
  }));
  route(
    "POST",
    "/api/acp/sessions/{sessionId}/prompt",
    async (match, request) => ({
      status: 200,
      body: await sendPrompt(
        param(match, "sessionId"),
        jsonObject(request.body).text,
        jsonObject(request.body).clientTurnId,
      ),
    }),
  );
  route("POST", "/api/acp/sessions/{sessionId}/cancel", async (match) => {
    await cancel(param(match, "sessionId"));
    return { status: 204 };
  });
  route(
    "POST",
    "/api/acp/sessions/{sessionId}/mode",
    async (match, request) => {
      await setMode(param(match, "sessionId"), jsonObject(request.body).modeId);
      return { status: 204 };
    },
  );
  route(
    "PUT",
    "/api/acp/sessions/{sessionId}/model",
    async (match, request) => {
      await setModel(
        param(match, "sessionId"),
        jsonObject(request.body).modelId,
      );
      return { status: 204 };
    },
  );
  route("GET", "/api/acp/sessions/{sessionId}/log", async (match, request) => ({
    status: 200,
    body: await readLog(
      param(match, "sessionId"),
      request.query.get("after") ?? "0",
    ),
  }));
  route("POST", "/api/acp/nodes/{nodeId}/driver", async (match, request) => ({
    status: 200,
    body: await changeDriver(
      param(match, "nodeId"),
      jsonObject(request.body).driver,
    ),
  }));

  /**
   * 设计 §4.2 的五步：审批挂着就拒；结束当前驱动（行记 `switch`）；读 CLI 的
   * 会话 id；在**同一行**上以另一种驱动起下一代（能接回就接回）；投递队列不
   * 动，出队门链在新驱动下重跑。第二步做完之前第四步不开始，这段时间里节点
   * 「睡着」（`acpSwitching`），`send` 排队。
   */
  const switchDriver = (
    wiring: AcpTerminalWiring,
    nodeId: string,
    driver: "acp" | "terminal",
  ) =>
    exclusive(nodeId, async () => {
      const node = loadNode(database, nodeId);
      if (node === undefined) {
        throw domain(404, "not_found", "Node not found");
      }
      const agentId = node.agentId ?? undefined;
      if (agentId === undefined) {
        throw badRequest("This node does not run an agent");
      }
      const settings = deps.settings();
      const adapter = deps.adapterFor(settings, agentId);
      if (adapter === undefined) {
        throw new AcpError(
          "acp_unsupported",
          `${agentId} has no ACP entry point`,
        );
      }
      const status = getAgentStatus(database, nodeId);
      if (status?.state === "blocked" || status?.state === "waiting") {
        throw new AcpError(
          "awaiting_approval",
          "Answer the pending approval before switching",
        );
      }
      const agent = agentOf(node);
      // SSH 节点（契约 §26 的 SSH 小节）：ACP 侧的适配器、终端侧的 shell 都经
      // `ssh` 起在执行主机上；工作目录是那边的路径。
      const sshHostId = sshHostOf(node.data);
      const ssh = sshHostId !== undefined;
      const cwdFor = (path: string) => (ssh ? path : deps.cwdOf(path));

      // 1. 结束当前驱动。
      const latest = loadSession(database, nodeId);
      let current: TerminalSession | undefined =
        latest === undefined
          ? undefined
          : wiring.manager.session(latest.sessionId);
      const wanted = driver === "acp" ? "acp" : "terminal";
      const currentDriver =
        current === undefined
          ? undefined
          : current.backend === "acp"
            ? "acp"
            : "terminal";
      if (
        current !== undefined &&
        currentDriver === wanted &&
        wiring.manager.isAlive(current.id)
      ) {
        return {
          workspaceId: node.workspaceId,
          sessionId: current.id,
          resumed: true,
        };
      }
      if (current !== undefined && wiring.manager.isAlive(current.id)) {
        if (current.backend !== "acp") {
          // 终端 → ACP：先礼后兵，敲 CLI 自己的退出命令等它把会话写完。
          await wiring.hibernator.quitForSwitch(current.id);
        }
        try {
          await wiring.manager.terminate(current.id, "session");
        } catch (error) {
          if (wiring.manager.isAlive(current.id)) throw error;
        }
        database
          .prepare(
            "UPDATE terminal_sessions SET termination_intent = 'switch' WHERE id = ?",
          )
          .run(current.id);
        current = wiring.manager.session(current.id);
      }

      // 2. CLI 自己的会话 id。`mapFile` 的适配器（pi-acp）：切回终端时把 ACP
      // 会话 id 经映射文件对回 CLI 的（契约 §26.3），对不上就不接回。
      const reported = getAgentStatus(database, nodeId)?.sessionId;
      const provider =
        driver === "terminal" && reported !== undefined && reported !== ""
          ? cliResumeId(adapter, reported)
          : reported;
      const cwd =
        text(node.data.cwd) ?? workspaceRoot(database, node.workspaceId);
      if (cwd === undefined) {
        throw badRequest("The node has no working directory");
      }

      // 3. 起下一代。
      if (driver === "acp") {
        deps.prepare(nodeId, {
          agentId,
          permissionMode: text(agent.permissionMode),
          model: text(agent.model),
          resume: adapter.resume === "none" ? null : (provider ?? null),
        });
        const env = wiring.environment(nodeId, agentId, { acp: true, ssh });
        const row =
          current === undefined
            ? await wiring.manager.spawn({
                workspaceId: node.workspaceId,
                cwd: cwdFor(cwd),
                command: adapter.program,
                kind: "terminal",
                ownerNodeId: nodeId,
                agentId,
                backend: "acp",
                env,
              })
            : await wiring.manager.revive(current.id, env, {
                ended: true,
                backend: "acp",
                command: adapter.program,
              });
        const session = wiring.backend.sessionByRow(row.id);
        return {
          workspaceId: node.workspaceId,
          sessionId: row.id,
          resumed: provider !== undefined && session?.resumed === true,
        };
      }

      const env = wiring.environment(nodeId, agentId, { acp: false, ssh });
      const row =
        current === undefined
          ? await wiring.manager.spawn({
              workspaceId: node.workspaceId,
              // 终端侧本机跑的是 `ssh`：从本机能进的目录起。
              cwd: ssh ? context.dataDir : deps.cwdOf(cwd),
              shell: text(node.data.shell),
              kind: "terminal",
              ownerNodeId: nodeId,
              agentId,
              ...(sshHostId === undefined ? {} : { sshHostId }),
              env,
            })
          : await wiring.manager.revive(current.id, env, {
              ended: true,
              backend: wiring.manager.effectiveKind(),
              command: null,
              ...(sshHostId === undefined
                ? {}
                : { sshHostId, cwd: context.dataDir }),
            });
      const resumable =
        provider !== undefined &&
        provider !== "" &&
        canResume(settings, agentId);
      // 本机解析到的程序路径在执行主机上不存在：SSH 节点只敲程序名。
      const program = ssh ? undefined : wiring.program(agentId).path;
      const dialect = nodeDialect(text(node.data.shell), ssh);
      const line = resumable
        ? resumeLine(settings, agentId, node.data, provider, {
            ...(program === undefined ? {} : { path: program }),
            dataDir: context.dataDir,
            nodeId,
            dialect,
          })
        : canvasLaunchLine({
            settings,
            agentId,
            dataDir: context.dataDir,
            nodeId,
            dialect,
            ...(ssh ? { ssh: true } : {}),
            ...(program === undefined ? {} : { program }),
            ...(text(agent.permissionMode) === undefined
              ? {}
              : { permissionMode: text(agent.permissionMode) as string }),
            ...(text(agent.model) === undefined
              ? {}
              : { model: text(agent.model) as string }),
          });
      void wiring
        .typeLaunchLine(row.id, row.generation, line)
        .catch((error: unknown) => {
          context.log.warn("could not type the launch line after a switch", {
            nodeId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return {
        workspaceId: node.workspaceId,
        sessionId: row.id,
        resumed: resumable,
      };
    });
}
