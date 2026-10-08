import type { CoreServer } from "../http/server";
import { answerConfirm } from "../collab/control";
import { cancelQueued, listDeliveries, listQueued } from "../collab/deliveries";
import { nowSeconds, type CollabContext } from "../collab/service";
import { getAgentStatus, markAgentStatusRead } from "./status";
import {
  MAX_TAIL_BYTES,
  MAX_RENDERED_BYTES,
  renderEntries,
} from "../collab/transcript";
import { locateHistory, readHistoryEntries } from "../history/registry";
import {
  commandFromCapture,
  configuredScope,
  ensureIndexed,
  listConversations,
  refresh,
  historyTitle,
  DEFAULT_LIMIT,
} from "../conversations";
import {
  definition,
  baseAgent,
  customAgent,
  stateSourceIsReported,
  validAgentId,
} from "./registry";
import {
  type LaunchVerdict,
  configDirFor,
  launchGate,
  watchLaunch,
} from "./launch-gate";
import { failLaunch } from "../collab/send-queue";
import { collab as assembledCollab } from "./index";
import { writeReceipts } from "../collab/receipts";
import { listAgents } from "./list";
import { historyHint, loadNode, loadSession } from "../collab/nodes";
import { listContextReads } from "../collab/context-reads";
import {
  type ConfirmRequest,
  accept,
  cancel,
  get as getHandoff,
  list as listHandoffs,
  listWorkspace,
  prepare,
  type PrepareRequest,
} from "../handoff/store";
import {
  DomainError,
  badRequest,
  jsonObject,
  notFound,
  optionalString,
  requiredString,
} from "../workspaces/support";
import { answerApproval } from "./approvals";
import { AmaCredentials, installAmaCredentialRoutes } from "./ama-credentials";
import { resolveSecretBackend } from "../secrets";
import { audit } from "../identity/audit";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
import { type DomainHandlers, registerProcedures } from "../http/rpc";

/**
 * The runtime-surface routes the agent, collaboration, handoff and
 * conversation domains own.
 *
 * The hook surface is not here: `POST /control/{verb}`, `/context-link/{verb}`
 * and the automation doors belong to the Hook domain, which authenticates the
 * caller and then hands the already-authenticated verb to the
 * {@link import("../collab/control").ControlDispatcher} this domain publishes.
 * Splitting it that way is what keeps a route from ever being a weaker door
 * than the verb behind it.
 */

/** `GET /api/nodes/{id}/context-reads` 不带 `limit` 时给这么多条。 */
const DEFAULT_CONTEXT_READS = 20;
/** 带了也最多给这么多条：这一栏是节点头上的一个小清单，不是审计导出。 */
const MAX_CONTEXT_READS = 200;

export interface AgentRouteDeps {
  readonly server: CoreServer;
  readonly collab: CollabContext;
  /**
   * ama's model keys. The domain passes the one it published; without it the
   * routes keep their own over the data directory's default backend.
   */
  readonly amaCredentials?: AmaCredentials;
}

export function installRoutes(deps: AgentRouteDeps): void {
  const { server, collab } = deps;
  const database = collab.database;

  installAmaCredentialRoutes(
    server,
    deps.amaCredentials ??
      new AmaCredentials(
        resolveSecretBackend({ dataDir: collab.dataDir }).backend,
      ),
  );

  /*
   * 契约 §39（`agents.*`）：下面这些路由的实现收成一份，旧路径的 handler 先把
   * 路径参数、查询串与体读出来再调它，`registerProcedures` 登记同一份——旧路径
   * 与 procedure 拒绝的码与原话一样。读体、读查询串的那一层只在 handler 里。
   */
  const operations = agentOperations(collab);
  registerProcedures(server, "agents", {
    list: () => operations.list(),
    markRead: ({ nodeId }: { nodeId: string }) => operations.markRead(nodeId),
    transcript: ({
      nodeId,
      maxBytes,
    }: {
      nodeId: string;
      maxBytes?: number | string;
    }) => operations.transcript(nodeId, maxBytes),
    suggestTitle: ({ nodeId }: { nodeId: string }) =>
      operations.suggestTitle(nodeId),
    answerApproval: ({
      pendingId,
      ...body
    }: { pendingId: string } & Record<string, unknown>) =>
      operations.answerApproval(pendingId, body),
    confirmControl: ({
      requestId,
      approve,
    }: {
      requestId: string;
      approve: boolean;
    }) => operations.confirmControl(requestId, approve),
    deliveries: ({
      workspaceId,
      node,
      limit,
    }: {
      workspaceId: string;
      node?: string;
      limit?: number | string;
    }) => operations.deliveries(workspaceId, node ?? "", limit),
    cancelDelivery: ({
      workspaceId,
      deliveryId,
    }: {
      workspaceId: string;
      deliveryId: string;
    }) => operations.cancelDelivery(workspaceId, deliveryId),
    contextReads: ({
      nodeId,
      limit,
    }: {
      nodeId: string;
      limit?: number | string;
    }) => operations.contextReads(nodeId, limit),
  } as unknown as DomainHandlers<"agents">);

  /*
   * 对话交接（契约 §39.8）：五条路由同一个做法——旧 handler 读出路径参数、查询串
   * 与体再调 `handoffOperations`，procedure 调同一份。
   */
  const handoff = handoffOperations(collab);
  registerProcedures(server, "agents", {
    handoffs: ({
      workspaceId,
      sourceNodeId,
    }: {
      workspaceId: string;
      sourceNodeId?: string;
    }) => handoff.list(workspaceId, sourceNodeId),
    handoff: ({
      workspaceId,
      handoffId,
    }: {
      workspaceId: string;
      handoffId: string;
    }) => handoff.get(workspaceId, handoffId),
    prepareHandoff: ({
      workspaceId,
      ...body
    }: { workspaceId: string } & Record<string, unknown>) =>
      handoff.prepare(workspaceId, body),
    acceptHandoff: ({
      workspaceId,
      handoffId,
      ...body
    }: { workspaceId: string; handoffId: string } & Record<string, unknown>) =>
      handoff.accept(workspaceId, handoffId, body),
    cancelHandoff: ({
      workspaceId,
      handoffId,
      ...body
    }: { workspaceId: string; handoffId: string } & Record<string, unknown>) =>
      handoff.cancel(workspaceId, handoffId, body),
  } as unknown as DomainHandlers<"agents">);

  /* --------------------------------- agents ------------------------------- */

  // The new-node menu, the command palette, the settings pages and the node
  // header all read this one list. Without it the canvas can still open a
  // plain terminal and nothing else: an empty list is not a degraded menu, it
  // is a build with no agents in it.
  server.router.handle(
    "GET",
    "/api/agents",
    answered(() => ({ status: 200, body: operations.list() })),
  );

  /* ------------------------------ launch gate ----------------------------- */

  // 启动闸门（契约 §52）。页面敲启动行之前申请一个位置，敲完之后问这一次起没
  // 起来；两条都是长轮询。往别人起的节点里敲与往别人的终端里写同一档。
  const launch = launchOperations(collab);
  server.router.handle(
    "POST",
    "/api/agents/launch-slot",
    answeredAsync(async (_match, request) => ({
      status: 200,
      body: await launch.slot(jsonObject(request.body)),
    })),
    { scope: "terminal:drive" },
  );
  server.router.handle(
    "POST",
    "/api/agents/launch-result",
    answeredAsync(async (_match, request) => ({
      status: 200,
      body: await launch.result(jsonObject(request.body)),
    })),
    { scope: "terminal:drive" },
  );

  /* ------------------------------ agent status ---------------------------- */

  server.router.handle(
    "POST",
    "/api/agent-status/{nodeId}/read",
    answered((match) => ({
      status: 200,
      body: operations.markRead(param(match, "nodeId")),
    })),
  );

  server.router.handle(
    "GET",
    "/api/agent-status/{nodeId}/transcript",
    answered((match, request) => ({
      status: 200,
      body: operations.transcript(
        param(match, "nodeId"),
        request.query.get("maxBytes") ?? undefined,
      ),
    })),
  );

  server.router.handle(
    "POST",
    "/api/agent-status/{nodeId}/suggest-title",
    answeredAsync(async (match) => ({
      status: 200,
      body: await operations.suggestTitle(param(match, "nodeId")),
    })),
  );

  /* -------------------------------- approvals ----------------------------- */

  server.router.handle(
    "POST",
    "/api/approvals/{pendingId}/answer",
    answeredAsync(async (match, request) => ({
      status: 200,
      body: await operations.answerApproval(
        param(match, "pendingId"),
        jsonObject(request.body),
      ),
    })),
  );

  /* ------------------------------- deliveries ----------------------------- */

  // 两个切片，一条路径（设计 §10 的节点头「排队 N」）：不带 `node=` answers
  // 投递**记录**，带上它答的是那个目标还排着的**队**。页面上这两件事挨在
  // 一起——一条边上发生过什么，和这条边上还压着什么。
  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/deliveries",
    answered((match, request) => ({
      status: 200,
      body: operations.deliveries(
        param(match, "workspaceId"),
        request.query.get("node") ?? "",
        request.query.get("limit") ?? undefined,
      ),
    })),
  );

  // 目标那一侧的人拒收一条还排着的投递（设计 §4.6 的取消一行）。发起者那一侧
  // 的入口是 `canvas cancel --id`，走的是同一张表的同一列。
  server.router.handle(
    "DELETE",
    "/api/workspaces/{workspaceId}/deliveries/{deliveryId}",
    answered((match) => ({
      status: 200,
      body: operations.cancelDelivery(
        param(match, "workspaceId"),
        param(match, "deliveryId"),
      ),
    })),
  );

  /* ---------------------------- control confirm --------------------------- */

  server.router.handle(
    "POST",
    "/api/control/confirm/{requestId}",
    answered((match, request) => ({
      status: 200,
      body: operations.confirmControl(
        param(match, "requestId"),
        jsonObject(request.body).approve,
      ),
    })),
  );

  /* --------------------------------- handoff ------------------------------ */

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/handoffs",
    answeredAsync(async (match, request) => ({
      status: 200,
      body: await handoff.prepare(
        param(match, "workspaceId"),
        jsonObject(request.body),
      ),
    })),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/handoffs",
    answered((match, request) => ({
      status: 200,
      body: handoff.list(
        param(match, "workspaceId"),
        request.query.get("sourceNodeId") ?? undefined,
      ),
    })),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/handoffs/{handoffId}",
    answered((match) => ({
      status: 200,
      body: handoff.get(param(match, "workspaceId"), param(match, "handoffId")),
    })),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/handoffs/{handoffId}/accept",
    answered((match, request) => ({
      status: 200,
      body: handoff.accept(
        param(match, "workspaceId"),
        param(match, "handoffId"),
        jsonObject(request.body),
      ),
    })),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/handoffs/{handoffId}/cancel",
    answered((match, request) => ({
      status: 200,
      body: handoff.cancel(
        param(match, "workspaceId"),
        param(match, "handoffId"),
        jsonObject(request.body),
      ),
    })),
  );

  /* ------------------------------ conversations --------------------------- */

  server.router.handle(
    "GET",
    "/api/conversations",
    answered((_match, request) => {
      // 第一次有人读的时候才建索引；装配时不扫（见 `conversations.ensureIndexed`）。
      ensureIndexed(database);
      const limit = Number.parseInt(request.query.get("limit") ?? "", 10);
      const q = request.query.get("q");
      return {
        status: 200,
        body: listConversations(
          database,
          q === null ? undefined : q,
          Number.isFinite(limit) ? limit : DEFAULT_LIMIT,
        ),
      };
    }),
  );

  server.router.handle(
    "POST",
    "/api/conversations/refresh",
    answered(() => ({
      status: 200,
      body: refresh(database, undefined, configuredScope(database)),
    })),
  );

  /* ------------------------------ context reads --------------------------- */

  // 节点头那一句「被读取 N 次」（设计 §13 第 5 条）。读取本身是 Agent 之间
  // 的事，而「谁在读我」是**人**要知道的事——一个 Agent 静悄悄地把另一个的转
  // 录读走十次，今天在界面上一点痕迹都没有。
  server.router.handle(
    "GET",
    "/api/nodes/{nodeId}/context-reads",
    answered((match, request) => ({
      status: 200,
      body: operations.contextReads(
        param(match, "nodeId"),
        request.query.get("limit") ?? undefined,
      ),
    })),
  );
}

/* -------------------------------- operations ------------------------------- */

/** 查询串上来的数（或 procedure 给的数）：读法与旧路径的 `parseInt` 一样。 */
function integer(value: number | string | null | undefined): number {
  return Number.parseInt(String(value ?? ""), 10);
}

/**
 * agent 域在主面上的动作（契约 §39）。旧路径的 handler 与 procedure 调的都是
 * 这一份：入参是已经从路径、查询串或体里读出来的值，拒绝就抛 `DomainError`。
 *
 * 只有元数据出去：投递记录与排队带长度不带正文，「谁读过我」带字节数不带内容；
 * 审批答复里 elicitation 的内容只交给 Agent，不进审计与日志。
 */
function agentOperations(collab: CollabContext) {
  const database = collab.database;
  return {
    list: () =>
      listAgents({ dataDir: collab.dataDir, settings: collab.settings }),

    markRead: (nodeId: string) => {
      const receipt = markAgentStatusRead(database, nodeId);
      if (receipt === undefined) {
        throw notFound("This node has never reported");
      }
      // A read that changed nothing is answered but not broadcast:
      // re-announcing an unchanged row would put one pointless frame on every
      // workspace socket per finished turn.
      if (receipt.cleared) {
        collab.publish(receipt.status.workspaceId, {
          type: "agent.status",
          status: receipt.status as unknown as Record<string, unknown>,
        });
      }
      return receipt.status;
    },

    transcript: (nodeId: string, maxBytes: number | string | undefined) => {
      const status = getAgentStatus(database, nodeId);
      if (status === undefined) throw notFound("This node has never reported");
      const provider = baseAgent(collab.settings, status.agentId);
      const located = locateHistory(
        historyHint(database, nodeId, provider, status),
      );
      // A provider that keeps nothing readable is **501, not an empty body**.
      // An empty excerpt would be indistinguishable from a session that has
      // said nothing yet, and the panel would draw the blank as the truth.
      if (located === undefined) {
        throw unsupported(
          `${provider} keeps no transcript this machine can read`,
        );
      }
      const wanted = integer(maxBytes);
      const budget = Number.isFinite(wanted)
        ? Math.min(MAX_TAIL_BYTES, Math.max(1, wanted))
        : MAX_TAIL_BYTES;
      let entries;
      try {
        entries = readHistoryEntries(provider, located, 0, budget).entries;
      } catch {
        throw notFound("The transcript could not be read");
      }
      const lines = renderEntries(entries).map((record) => record.line);
      if (lines.length === 0) {
        throw unsupported(
          `The file ${provider} reports is not a conversation this reader renders`,
        );
      }
      const rendered = lines.join("\n");
      const truncated =
        Buffer.byteLength(rendered, "utf8") > MAX_RENDERED_BYTES;
      return {
        nodeId,
        text: truncated ? cutBytes(rendered, MAX_RENDERED_BYTES) : rendered,
        truncated,
      };
    },

    suggestTitle: async (
      nodeId: string,
    ): Promise<{
      title: string;
      source: "transcript" | "terminal" | "agent";
    }> => {
      const status = getAgentStatus(database, nodeId);
      if (status === undefined) throw notFound("This node has never reported");

      // Three sources, best first: what the session is *about*, then what was
      // last typed in the pane, then the agent's own label — which is always
      // available and never wrong. No model is called: this is a rename
      // button, and a local read answers it in milliseconds.
      // 经本地历史适配器定位：CLI 报来的路径先认，没有的按会话 id、cwd 加启动
      // 时间找；OpenCode 这种没有文件的来源取库里的会话标题。
      const provider = baseAgent(collab.settings, status.agentId);
      const located = locateHistory(
        historyHint(database, nodeId, provider, status),
      );
      const title =
        located === undefined ? undefined : historyTitle(provider, located);
      if (title !== undefined) return { title, source: "transcript" };
      // The node's terminal keeps its logical key across recycles, so the
      // lookup is by node id rather than by the session id the status row
      // happens to remember.
      const session = loadSession(database, nodeId);
      if (session !== undefined && collab.terminals !== undefined) {
        const capture = await collab.terminals
          .capture(session.sessionId, 40, false)
          .catch(() => undefined);
        const title =
          capture === undefined ? undefined : commandFromCapture(capture.data);
        if (title !== undefined) return { title, source: "terminal" };
      }
      return {
        title: definition(status.agentId)?.label ?? status.agentId,
        source: "agent",
      };
    },

    answerApproval: async (
      pendingId: string,
      body: Record<string, unknown>,
    ) => {
      const decision = optionalString(body, "decision");
      // ACP elicitation 的答复（契约 §26.1）：`{ action, content? }`，此时
      // `decision` 可省，由 action 推出。内容只交给 Agent，不进审计与日志。
      const elicitation = body.elicitation;
      if (
        elicitation !== undefined &&
        (typeof elicitation !== "object" ||
          elicitation === null ||
          Array.isArray(elicitation))
      ) {
        throw badRequest("elicitation must be an object");
      }
      if (decision === undefined && elicitation === undefined) {
        throw badRequest("decision is required");
      }
      const expected = body.expectedRevision;
      if (
        expected !== undefined &&
        expected !== null &&
        typeof expected !== "number"
      ) {
        throw badRequest("expectedRevision must be a number");
      }
      const answeredBy = optionalString(body, "answeredBy");
      const optionId = optionalString(body, "optionId");
      const answer = await answerApproval(collab, pendingId, {
        ...(decision === undefined ? {} : { decision }),
        ...(elicitation === undefined
          ? {}
          : {
              elicitation: elicitation as {
                action: unknown;
                content?: unknown;
              },
            }),
        ...(answeredBy === undefined ? {} : { answeredBy }),
        ...(typeof expected === "number" ? { expectedRevision: expected } : {}),
        // ACP 审批的选项（契约 §14.4）；别的审批带了它答 400。
        ...(optionId === undefined ? {} : { optionId }),
      });
      // 审批答复是设计 §4.5 的五个审计写入点之一：一次「允许」可能让 Agent 动
      // 到磁盘，事后必须查得到是谁在什么时候答的。
      const { approval, route } = answer;
      audit({
        action: "approval.answer",
        target: pendingId,
        detail: {
          decision: approval.answer,
          ...(answer.elicitation === undefined
            ? {}
            : { elicitation: answer.elicitation.action }),
        },
      });
      return {
        ...approval,
        route,
        ...(answer.elicitation === undefined
          ? {}
          : { elicitation: answer.elicitation }),
      };
    },

    deliveries: (
      workspaceId: string,
      node: string,
      limit: number | string | undefined,
    ) => {
      if (node !== "") {
        return listQueued(collab, workspaceId, node, nowSeconds(collab));
      }
      const count = integer(limit);
      return listDeliveries(
        collab,
        workspaceId,
        Number.isFinite(count) ? count : 200,
      );
    },

    cancelDelivery: (workspaceId: string, deliveryId: string) => ({
      cancelled: cancelQueued(collab, workspaceId, deliveryId),
    }),

    confirmControl: (requestId: string, approve: unknown) => {
      if (typeof approve !== "boolean") {
        throw badRequest("approve must be a boolean");
      }
      // `accepted: false` means the verb already gave up; the dialog closes
      // either way, which is why this is not an error.
      return {
        requestId,
        approve,
        accepted: answerConfirm(requestId, approve),
      };
    },

    contextReads: (nodeId: string, limit: number | string | undefined) => {
      const count = integer(limit);
      return listContextReads(
        database,
        nodeId,
        Number.isFinite(count) && count > 0
          ? Math.min(count, MAX_CONTEXT_READS)
          : DEFAULT_CONTEXT_READS,
      );
    },
  };
}

/* ------------------------------- launch gate ------------------------------ */

/** 节点在体里写的工作空间上（还没落库的新节点认不出在哪，不算越界）。 */
function launchTarget(
  collab: CollabContext,
  body: Record<string, unknown>,
): { nodeId: string; agentId: string } {
  const workspaceId = requiredString(body, "workspaceId");
  const nodeId = requiredString(body, "nodeId");
  const agentId = requiredString(body, "agentId");
  if (!validAgentId(agentId)) throw badRequest("agentId is not an agent");
  const node = loadNode(collab.database, nodeId);
  if (node !== undefined && node.workspaceId !== workspaceId) {
    throw notFound("This node is not in that workspace");
  }
  return { nodeId, agentId };
}

/**
 * `launch-slot` 与 `launch-result`（界面第二波 §8.2–§8.3）。
 *
 * 结果只看两样：shell 下面还有没有进程、节点报没报过状态。屏幕正文不读，答复里
 * 也没有任何终端输出。
 */
export function launchOperations(
  collab: CollabContext,
  options: {
    readonly watch?: Partial<Parameters<typeof watchLaunch>[0]>;
    /**
     * 终端桥：装配时还没有（终端域后装），每次现取。缺省读运行中的协作上下文，
     * 再退回 `collab` 自己带的那个。
     */
    readonly terminals?: () => CollabContext["terminals"];
  } = {},
) {
  const terminalsNow =
    options.terminals ??
    (() => assembledCollab()?.terminals ?? collab.terminals);
  const database = collab.database;
  const keyOf = (agentId: string) => {
    const base = baseAgent(collab.settings, agentId);
    const env = customAgent(collab.settings, agentId)?.env ?? {};
    return {
      agentId: base,
      configDir: configDirFor(base, { ...process.env, ...env }),
    };
  };
  return {
    slot: async (body: Record<string, unknown>) => {
      const { nodeId, agentId } = launchTarget(collab, body);
      return launchGate().acquire({ ...keyOf(agentId), nodeId });
    },

    result: async (
      body: Record<string, unknown>,
    ): Promise<{ verdict: LaunchVerdict; settled: number }> => {
      const { nodeId } = launchTarget(collab, body);
      const attempt = body.attempt === undefined ? 1 : Number(body.attempt);
      if (!Number.isInteger(attempt) || attempt < 1 || attempt > 9) {
        throw badRequest("attempt must be a small positive integer");
      }
      const since = Date.now();
      const reported = () => {
        const status = getAgentStatus(database, nodeId);
        if (status === undefined || status.restored === true) return false;
        if (!stateSourceIsReported(status.stateSource)) return false;
        const at = Date.parse(status.lastEventAt ?? "");
        return Number.isFinite(at) && at >= since - 1_000;
      };
      const verdict = await watchLaunch({
        probe: async () => {
          const terminals = terminalsNow();
          const session = loadSession(database, nodeId);
          if (terminals === undefined || session === undefined)
            return undefined;
          const foreground = await terminals.foreground(session.sessionId);
          // 答不出前台命令的后端（会话宿主）也答不出子进程：不猜。
          if (foreground?.command === undefined) return undefined;
          return (foreground.children ?? []).length > 0 ? "busy" : "idle";
        },
        reported,
        ...options.watch,
      });
      let settled = 0;
      if (verdict === "failed") {
        launchGate().release(nodeId);
        // 自动重试过一次还是没起来：排在它前面的不再等满五分钟。
        if (attempt >= 2) {
          settled = failLaunch(database, nodeId);
          if (settled > 0) writeReceipts(collab, nowSeconds(collab));
        }
      }
      return { verdict, settled };
    },
  };
}

/* --------------------------------- plumbing -------------------------------- */

function param(match: RouteMatch, name: string): string {
  const value = match.params[name];
  if (value === undefined) {
    throw new DomainError(500, "internal_error", `${name} is not in the path`);
  }
  return value;
}

/** 501 with a sentence — a provider whose transcript nothing here can read. */
function unsupported(message: string): DomainError {
  return new DomainError(501, "unsupported", message);
}

function answered(
  handle: (match: RouteMatch, request: CoreRequest) => HandlerResult,
): (match: RouteMatch, request: CoreRequest) => HandlerResult {
  return (match, request) => {
    try {
      return handle(match, request);
    } catch (error) {
      return failure(error);
    }
  };
}

function answeredAsync(
  handle: (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult>,
): (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult> {
  return async (match, request) => {
    try {
      return await handle(match, request);
    } catch (error) {
      return failure(error);
    }
  };
}

function failure(error: unknown): HandlerResult {
  if (error instanceof DomainError) {
    const { status, body } = error.response();
    return { status, body };
  }
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: { code: "bad_request", message: "Request body is not valid JSON" },
    };
  }
  throw error;
}

function cutBytes(text: string, limit: number): string {
  const buffer = Buffer.from(text, "utf8");
  let end = limit;
  // Back off to a character boundary: a cut UTF-8 sequence renders as a
  // replacement character in the agent's own transcript.
  while (end > 0 && ((buffer[end] as number) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * 交接的动作（契约 §39.8）。旧路径与 procedure 都把入参归成「体」的样子交进来，
 * 解析与拒绝在这里，码与原话因此一样。
 */
export function handoffOperations(collab: CollabContext) {
  return {
    /** `sourceNodeId` 缺席或为空串答整个工作空间的历史。 */
    list(workspaceId: string, sourceNodeId: string | undefined) {
      return sourceNodeId === undefined || sourceNodeId === ""
        ? listWorkspace(collab, workspaceId)
        : listHandoffs(collab, workspaceId, sourceNodeId);
    },
    get(workspaceId: string, handoffId: string) {
      return getHandoff(collab, workspaceId, handoffId);
    },
    prepare(workspaceId: string, body: Record<string, unknown>) {
      return prepare(collab, workspaceId, parsePrepare(body));
    },
    accept(
      workspaceId: string,
      handoffId: string,
      body: Record<string, unknown>,
    ) {
      return accept(collab, workspaceId, handoffId, parseConfirm(body));
    },
    cancel(
      workspaceId: string,
      handoffId: string,
      body: Record<string, unknown>,
    ) {
      return cancel(collab, workspaceId, handoffId, parseConfirm(body));
    },
  };
}

function parsePrepare(body: Record<string, unknown>): PrepareRequest {
  const sections = body.sections;
  if (sections === null || typeof sections !== "object") {
    throw badRequest("sections is required");
  }
  const filePaths = body.filePaths ?? [];
  if (
    !Array.isArray(filePaths) ||
    filePaths.some((p) => typeof p !== "string")
  ) {
    throw badRequest("filePaths must be an array of strings");
  }
  const byteBudget = body.byteBudget;
  if (typeof byteBudget !== "number")
    throw badRequest("byteBudget is required");
  return {
    sourceNodeId: required(body, "sourceNodeId"),
    sourceSessionId: required(body, "sourceSessionId"),
    sourceGeneration: requiredNumber(body, "sourceGeneration"),
    targetNodeId: required(body, "targetNodeId"),
    targetSessionId: required(body, "targetSessionId"),
    targetGeneration: requiredNumber(body, "targetGeneration"),
    sections: sectionsOf(sections as Record<string, unknown>),
    filePaths: filePaths as string[],
    byteBudget,
    includeTranscript: body.includeTranscript !== false,
  };
}

function sectionsOf(
  source: Record<string, unknown>,
): PrepareRequest["sections"] {
  const read = (key: string): string => {
    const value = source[key];
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw badRequest(`${key} must be a string`);
    return value;
  };
  return {
    goal: read("goal"),
    constraints: read("constraints"),
    completed: read("completed"),
    pending: read("pending"),
    decisions: read("decisions"),
    toolSummary: read("toolSummary"),
  };
}

function parseConfirm(body: Record<string, unknown>): ConfirmRequest {
  return { expectedDigest: required(body, "expectedDigest") };
}

function required(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== "string" || value === "") {
    throw badRequest(`${name} is required`);
  }
  return value;
}

function requiredNumber(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest(`${name} is required`);
  }
  return value;
}
