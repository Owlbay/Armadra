import type { DatabaseSync } from "node:sqlite";
import type { CoreRequest } from "../http/router";
import { type RouteScopeRequirement, selfGuarded } from "../http/route-scopes";
import { type AuthorizationSubject, isOwner } from "./authorize";
import {
  latestNodeSession,
  nodeCreator,
  nodeOwnerPrincipal,
  sessionCreator,
} from "./creators";
import { type RouteGuard, type RouteVerdict, requestIdentity } from "./gate";
import { type Scope, scope } from "./scopes";

/**
 * 服务器壳上的路由门：把路由表声明的 scope 按这次请求的主体判掉。
 *
 * 判定仍然只有一条路径（`permits`，设计 S3）；这里做的是**把一条路由要求的
 * 权限落到一个具体的工作空间上**。路由表对 `/api/workspaces/{id}/…` 已经带着
 * 工作空间，剩下的全局路由逐条归进三类（权限表见设计
 * `docs/design/server-accounts-and-sharing.md` §6）：
 *
 *   * **按对象落到工作空间**：工作空间列表（答案过滤）、终端（创建看请求体，
 *     已有会话看会话行）、Agent 状态与「被读取」（看节点）、审批与关闭确认
 *     （看那条待答的请求）、ACP 会话（看会话行）、工作流（看草案 / 运行 /
 *     画板）。对象属于哪块画布，就按那块画布上的授权判。
 *   * **无害的全局读**：Agent 目录、模型目录、终端后端、公开状态页。新建菜单、
 *     节点头、终端面板都要它们，而它们不带任何人的数据；只要这个成员至少被
 *     共享了一块画布就放行。
 *   * **本机管理**：设置、执行主机、SSH、数据与备份、用量与账号、对话索引、
 *     克隆、电源、浏览器、GitHub 与自动化。要的是全局授权，而共享只发工作空间
 *     上的授权，所以成员在那里一律 403——这正是「共享的最小单位是工作空间」
 *     （设计 S4）。
 *
 * 没有请求身份（桌面壳、core 自己的动作）时整道门放行：那里只有本机 owner。
 *
 * **资源维度**（契约 §60）：只有终端与 ACP 会话的读路径带上会话 id 去问
 * （`terminal:read@ws#session`），所以「只看这一条会话」的授权只在这两处成立；
 * 其余一切判定照旧不带资源，受限授权在那里永远不满足——画布、文件、别的会话、
 * 一切写入对会话查看者都是 403。
 */

/**
 * 路由门要问的几件「这个对象属于哪块画布」。缺省按库回答；测试可以逐条替换。
 * 答不出来一律是空串，而空串对成员就是拒绝。
 */
export interface RouteAccessLookups {
  /** 终端会话 → 工作空间。 */
  sessionWorkspace(sessionId: string): string;
  /** 终端会话 → 开它的 principal；本机 owner 与 core 自己开的是空串。 */
  sessionCreator(sessionId: string): string;
  /** 成员开终端成功之后记下创建者（迁移 0028 的那一列）。 */
  recordCreator(sessionId: string, principalId: string): void;
  /**
   * 节点记下的触发者（迁移 0035）；没记过是 `null`。记过的节点起终端时由库
   * 继承这一个，路由门就不再把「恰好起它的人」写成创建者。
   */
  inheritedCreator(nodeId: string): string | null;
  /** 节点最近一个终端会话；没起过是空串。 */
  nodeSession(nodeId: string): string;
  /** 节点是谁的：最近那个终端的创建者，没起过时是记下的触发者（契约 §23）。 */
  nodeOwner(nodeId: string): string;
  /** 画布节点 → 工作空间。 */
  nodeWorkspace(nodeId: string): string;
  /** 待答的审批 → 工作空间。 */
  approvalWorkspace(pendingId: string): string;
  /** 待答的审批是谁的终端上的：那个终端的创建者（契约 §23）。 */
  approvalCreator(pendingId: string): string;
  /** 画板 → 工作空间。 */
  boardWorkspace(boardId: string): string;
  /** 工作流草案 → 工作空间。 */
  workflowDraftWorkspace(draftId: string): string;
  /** 工作流运行 → 工作空间。 */
  workflowRunWorkspace(runId: string): string;
  /** 协调者任务 → 协调者节点所在画板的工作空间（契约 §15.7）。 */
  workflowTaskWorkspace(taskId: string): string;
  /** 待确认的关闭请求 → 工作空间（只在内存里）。 */
  confirmWorkspace(requestId: string): string;
}

export interface RouteAccessOptions {
  readonly database: DatabaseSync;
  /** 主体 ∪ 编译出来的授予够不够。owner 的恒真在调用方之前就判掉了。 */
  readonly permits: (
    subject: AuthorizationSubject,
    required: readonly Scope[],
  ) => boolean;
  /**
   * 主体今天的全部授权（快照 ∪ 编译出来的授予）。「无害的全局读」要知道他
   * 是不是至少被共享了一块画布；不给时这一类对成员一律不放。
   */
  readonly effectiveScopes?: (
    subject: AuthorizationSubject,
  ) => readonly Scope[];
  readonly lookups?: Partial<RouteAccessLookups>;
}

const ALLOW: RouteVerdict = { allowed: true };
const DENY: RouteVerdict = { allowed: false };

/**
 * 无害的全局读：不带任何人的数据，画布上的日常操作离不开。只有 GET。
 *
 * Agent 目录带的是本机装了哪些 CLI、启动参数与集成版本，没有环境变量也没有
 * 凭据；operator 要按它启动 Agent，viewer 要按它画节点头。集成的安装 / 修复
 * 会改 CLI 的配置目录，那是本机管理，不在这里。
 */
const SHARED_READS: readonly RegExp[] = [
  /^\/api\/agents$/,
  /^\/api\/agents\/[^/]+\/models$/,
  /^\/api\/models\/catalog$/,
  /^\/api\/terminals\/backend$/,
  /^\/api\/usage\/status$/,
];

const TERMINAL_SESSION = /^\/api\/terminals\/([^/]+)(\/[^/]+)?(\/[^/]+)?$/;
const AGENT_STATUS =
  /^\/api\/agent-status\/([^/]+)\/(read|transcript|suggest-title)$/;
const CONTEXT_READS = /^\/api\/nodes\/([^/]+)\/context-reads$/;
const APPROVAL = /^\/api\/approvals\/([^/]+)\/answer$/;
/** ACP 会话（契约 §14.2）：会话行就是终端行，按会话行查画布。 */
const ACP_SESSION = /^\/api\/acp\/sessions\/([^/]+)\/[^/]+$/;
/** 驱动切换：按节点查画布。 */
const ACP_DRIVER = /^\/api\/acp\/nodes\/([^/]+)\/driver$/;
const CONFIRM = /^\/api\/control\/confirm\/([^/]+)$/;
/** 启动闸门（契约 §52）：体里的工作空间与节点。 */
const LAUNCH_GATE = /^\/api\/agents\/launch-(slot|result)$/;
/** 工作流（契约 §15.2–§15.3）：路径里没有工作空间，按草案 / 运行 / 画板查。 */
const WORKFLOW_TEMPLATES = /^\/api\/workflows\/templates(\/[^/]+)?$/;
const WORKFLOW_DRAFTS = /^\/api\/workflows\/drafts$/;
const WORKFLOW_DRAFT =
  /^\/api\/workflows\/drafts\/([^/]+)(\/(confirm|discard))?$/;
const WORKFLOW_RUNS = /^\/api\/workflows\/runs$/;
const WORKFLOW_RUN =
  /^\/api\/workflows\/runs\/([^/]+)(\/cancel|\/gates\/[^/]+)?$/;
/** 协调者任务（契约 §15.7）：列表按画板，重试按任务查。 */
const WORKFLOW_TASKS = /^\/api\/workflows\/tasks$/;
const WORKFLOW_TASK_RETRY = /^\/api\/workflows\/tasks\/([^/]+)\/retry$/;

/** Agent 状态的三条路由各要什么。 */
const AGENT_STATUS_PERMISSION: Readonly<Record<string, string>> = {
  // 标已读只是清掉节点头上的未读点，看得见这块画布的人都会做。
  read: "canvas:read",
  // 转录就是终端画面的文字版：和读终端画面同一档。
  transcript: "terminal:read",
  // 建议标题最终是一次改名，和编辑画布同一档。
  "suggest-title": "canvas:write",
};

export function createRouteGuard(options: RouteAccessOptions): RouteGuard {
  const lookups: RouteAccessLookups = {
    ...databaseLookups(options.database),
    ...options.lookups,
  };

  const allowed = (
    subject: AuthorizationSubject,
    permission: string,
    workspaceId: string,
  ): boolean =>
    workspaceId !== "" &&
    options.permits(subject, [scope(permission, workspaceId)]);

  const onWorkspace = (
    subject: AuthorizationSubject,
    permission: string,
    workspaceId: string,
  ): RouteVerdict => (allowed(subject, permission, workspaceId) ? ALLOW : DENY);

  /** 读一条会话：工作空间上的 `terminal:read`，或只限这一条会话的那份。 */
  const readsSession = (
    subject: AuthorizationSubject,
    workspaceId: string,
    sessionId: string,
  ): RouteVerdict =>
    workspaceId !== "" &&
    sessionId !== "" &&
    options.permits(subject, [
      scope("terminal:read", workspaceId, "", sessionId),
    ])
      ? ALLOW
      : DENY;

  /** 至少在一块画布上有这条权限。 */
  const grantedSomewhere = (
    subject: AuthorizationSubject,
    permission: string,
  ): boolean =>
    (options.effectiveScopes?.(subject) ?? []).some(
      (value) => value.Permission === permission,
    );
  // 会话查看者（契约 §60）没有画布，但看一条终端也要终端后端与模型目录这些无害读。
  const sharedSomewhere = (subject: AuthorizationSubject): boolean =>
    grantedSomewhere(subject, "canvas:read") ||
    grantedSomewhere(subject, "terminal:read");

  /**
   * 「自己的」那一档（契约 §23）：往自己起的终端里写、答自己终端上的审批、
   * 切自己节点的驱动，要的是 `terminal:create`（operator）；别人的要
   * `terminal:drive` / `approval:answer`（driver）。创建者 = 触发者，见
   * `identity/creators.ts`。
   */
  const mine = (subject: AuthorizationSubject, creator: string): boolean =>
    subject.principalId !== "" && creator === subject.principalId;
  const ownOrOthers = (
    subject: AuthorizationSubject,
    creator: string,
    others: string,
    workspaceId: string,
  ): RouteVerdict =>
    onWorkspace(
      subject,
      mine(subject, creator) ? "terminal:create" : others,
      workspaceId,
    );

  /**
   * 工作流（契约 §15、§23）。读草案与运行是看画布（列表必须带 `boardId`：
   * 这一面是 raw 路由，答案过滤不到）；确认 / 丢弃草案、起跑、取消、答关卡
   * 是 operator（`agent:launch`）。模板是本机共用的一份库：在任意一块画布上
   * 能起 Agent 的成员能读，改模板只有 owner。不是工作流路径时答 `undefined`。
   */
  const workflowVerdict = (
    request: CoreRequest,
    path: string,
    method: string,
    subject: AuthorizationSubject,
  ): RouteVerdict | undefined => {
    if (!path.startsWith("/api/workflows/")) return undefined;
    const reading = method === "GET" || method === "HEAD";
    if (WORKFLOW_TEMPLATES.test(path)) {
      return reading && grantedSomewhere(subject, "agent:launch")
        ? ALLOW
        : DENY;
    }
    if (WORKFLOW_DRAFTS.test(path) && reading) {
      return onWorkspace(
        subject,
        "canvas:read",
        lookups.boardWorkspace(request.query.get("boardId") ?? ""),
      );
    }
    const draft = WORKFLOW_DRAFT.exec(path);
    if (draft !== null) {
      return onWorkspace(
        subject,
        reading ? "canvas:read" : "agent:launch",
        lookups.workflowDraftWorkspace(decodeURIComponent(draft[1] as string)),
      );
    }
    if (WORKFLOW_RUNS.test(path)) {
      return reading
        ? onWorkspace(
            subject,
            "canvas:read",
            lookups.boardWorkspace(request.query.get("boardId") ?? ""),
          )
        : onWorkspace(
            subject,
            "agent:launch",
            lookups.boardWorkspace(bodyString(request, "boardId")),
          );
    }
    const run = WORKFLOW_RUN.exec(path);
    if (run !== null) {
      // 关卡答复（`…/gates/{stepId}`）是 operator：放行或拦下一次运行，与起跑
      // 同一档，不是替 Agent 代答（契约 §23）。
      return onWorkspace(
        subject,
        reading ? "canvas:read" : "agent:launch",
        lookups.workflowRunWorkspace(decodeURIComponent(run[1] as string)),
      );
    }
    // 分派抽屉（契约 §15.7）：看任务是看画布；重试是再投一次任务提示词，与
    // 起跑同一档（operator）。
    if (WORKFLOW_TASKS.test(path) && reading) {
      return onWorkspace(
        subject,
        "canvas:read",
        lookups.boardWorkspace(request.query.get("boardId") ?? ""),
      );
    }
    const retry = WORKFLOW_TASK_RETRY.exec(path);
    if (retry !== null && !reading) {
      return onWorkspace(
        subject,
        "agent:launch",
        lookups.workflowTaskWorkspace(decodeURIComponent(retry[1] as string)),
      );
    }
    return DENY;
  };

  /**
   * 请求体里的 `nodeId` 属于另一块画布。授权按体里的 `workspaceId` 判，而终端
   * 与 ACP 会话会给这个节点铸节点 token、接上它的会话与凭据绑定——拿 A 上的
   * operator 去起 B 上的节点就是跨工作空间（安全审查 2026-10 的 H1）。认不出
   * 节点在哪（还没落库的新节点）时不算。
   */
  const foreignNode = (request: CoreRequest, workspaceId: string): boolean => {
    const nodeId = bodyString(request, "nodeId");
    if (nodeId === "") return false;
    const home = lookups.nodeWorkspace(nodeId);
    return home !== "" && home !== workspaceId;
  };

  return (request, requirement) => {
    const identity = requestIdentity();
    if (identity === undefined) return ALLOW;
    const subject = identity.subject;
    if (isOwner(subject)) return ALLOW;
    const path = request.path;
    if (selfGuarded(path)) return ALLOW;
    const method = request.method.toUpperCase();
    const reading = method === "GET" || method === "HEAD";

    if (reading && SHARED_READS.some((pattern) => pattern.test(path))) {
      return sharedSomewhere(subject) ? ALLOW : DENY;
    }

    // 表外的路由对成员一律不放：「没写要求」在单机上意味着「只有 owner 会来」，
    // 到了多账号的服务器上它不能悄悄变成「谁都能来」。
    if (requirement === undefined) return DENY;

    if (path === "/api/workspaces" && reading) {
      return {
        allowed: true,
        filter: (body) =>
          Array.isArray(body)
            ? body.filter(
                (item: unknown) =>
                  typeof (item as { id?: unknown })?.id === "string" &&
                  allowed(subject, "canvas:read", (item as { id: string }).id),
              )
            : body,
      };
    }

    if (path === "/api/terminals" && method === "POST") {
      const workspaceId = bodyWorkspace(request);
      if (!allowed(subject, "terminal:create", workspaceId)) return DENY;
      if (foreignNode(request, workspaceId)) return DENY;
      return {
        allowed: true,
        filter: (body) => {
          const row = body as { id?: unknown; ownerNodeId?: unknown } | null;
          // 节点记过触发者的，库已经按它写好了：起它的人只是「替触发者起」。
          if (
            typeof row?.id === "string" &&
            (typeof row.ownerNodeId !== "string" ||
              lookups.inheritedCreator(row.ownerNodeId) === null)
          ) {
            lookups.recordCreator(row.id, subject.principalId);
          }
          return body;
        },
      };
    }

    // ACP 会话与终端同一套判定：开会话与开终端同一档（并记下创建者），读
    // 镜像是看终端，往别人的会话里发提示要 `terminal:drive`。
    if (path === "/api/acp/sessions" && method === "POST") {
      const workspaceId = bodyWorkspace(request);
      if (!allowed(subject, "terminal:create", workspaceId)) return DENY;
      if (foreignNode(request, workspaceId)) return DENY;
      // 这个接口对已经活着的会话答「就是它」、对结束了的同一行原地接回：那两种
      // 都不是新行，创建者不能被这次请求改写——否则 operator 对着 driver 起的
      // 节点调一次，就把它变成了「自己的」。
      const nodeId = bodyString(request, "nodeId");
      const before = nodeId === "" ? "" : lookups.nodeSession(nodeId);
      return {
        allowed: true,
        filter: (body) => {
          const id = (body as { id?: unknown } | null)?.id;
          if (
            typeof id === "string" &&
            id !== before &&
            (nodeId === "" || lookups.inheritedCreator(nodeId) === null)
          ) {
            lookups.recordCreator(id, subject.principalId);
          }
          return body;
        },
      };
    }
    // 预启动（契约 §51）：路径里没有工作空间，按体里的判；还没有节点。
    if (path === "/api/acp/prestart" && method === "POST") {
      const workspaceId = bodyWorkspace(request);
      if (workspaceId === "") return DENY;
      return onWorkspace(subject, "terminal:drive", workspaceId);
    }
    const acpSession = ACP_SESSION.exec(path);
    if (acpSession !== null) {
      const sessionId = decodeURIComponent(acpSession[1] as string);
      const workspaceId = lookups.sessionWorkspace(sessionId);
      if (workspaceId === "") return DENY;
      if (reading) return readsSession(subject, workspaceId, sessionId);
      return ownOrOthers(
        subject,
        lookups.sessionCreator(sessionId),
        "terminal:drive",
        workspaceId,
      );
    }
    const acpDriver = ACP_DRIVER.exec(path);
    if (acpDriver !== null) {
      // 切换会结束当前进程、起另一个：与往终端里写同一档——自己的节点
      // operator 就够，别人的要 driver。
      const nodeId = decodeURIComponent(acpDriver[1] as string);
      return ownOrOthers(
        subject,
        lookups.nodeOwner(nodeId),
        "terminal:drive",
        lookups.nodeWorkspace(nodeId),
      );
    }

    // 启动闸门（契约 §52）：只是给即将敲进节点终端的那一行排个队。自己的节点
    // operator 就够，别人的与往别人的终端里写同一档（`terminal:drive`）。
    if (LAUNCH_GATE.test(path) && method === "POST") {
      const workspaceId = bodyWorkspace(request);
      if (workspaceId === "" || foreignNode(request, workspaceId)) return DENY;
      return ownOrOthers(
        subject,
        lookups.nodeOwner(bodyString(request, "nodeId")),
        "terminal:drive",
        workspaceId,
      );
    }

    const workflow = workflowVerdict(request, path, method, subject);
    if (workflow !== undefined) return workflow;

    const session = TERMINAL_SESSION.exec(path);
    if (session !== null && path !== "/api/terminals/backend") {
      const sessionId = decodeURIComponent(session[1] as string);
      const workspaceId = lookups.sessionWorkspace(sessionId);
      if (workspaceId === "") return DENY;
      if (requirement.permission === "credential:use") return DENY;
      // 附着到终端的 socket 能写：`…/ws` 虽是 GET，按写入判。
      if (requirement.permission === "terminal:read" && !path.endsWith("/ws")) {
        return readsSession(subject, workspaceId, sessionId);
      }
      // 设计 S5：往自己开的终端里写只要 `terminal:create`，往别人的要
      // `terminal:drive`。「自己的」按会话行上记的创建者判，重启之后照旧。
      return ownOrOthers(
        subject,
        lookups.sessionCreator(sessionId),
        "terminal:drive",
        workspaceId,
      );
    }

    const status = AGENT_STATUS.exec(path);
    if (status !== null) {
      return onWorkspace(
        subject,
        AGENT_STATUS_PERMISSION[status[2] as string] as string,
        lookups.nodeWorkspace(decodeURIComponent(status[1] as string)),
      );
    }
    const reads = CONTEXT_READS.exec(path);
    if (reads !== null) {
      return onWorkspace(
        subject,
        "canvas:read",
        lookups.nodeWorkspace(decodeURIComponent(reads[1] as string)),
      );
    }
    // 审批答复与关闭确认都是替 Agent 代答（设计 S5），和 `terminal:drive`
    // 同一档：别人终端上的只有那块画布上的 driver 答得了；自己终端上的
    // operator 就够（契约 §23）。关闭确认只在内存里、查不到终端，仍只有 driver。
    const approval = APPROVAL.exec(path);
    if (approval !== null) {
      const pendingId = decodeURIComponent(approval[1] as string);
      return ownOrOthers(
        subject,
        lookups.approvalCreator(pendingId),
        "approval:answer",
        lookups.approvalWorkspace(pendingId),
      );
    }
    const confirm = CONFIRM.exec(path);
    if (confirm !== null) {
      return onWorkspace(
        subject,
        "approval:answer",
        lookups.confirmWorkspace(decodeURIComponent(confirm[1] as string)),
      );
    }

    // 「能读身份」是每个登录主体的底线（会话快照里都有，`service.ts` 的
    // `openSession`）：控制面的升级与 `system.hello` / `ping` 要的就是它（契约
    // §34.2、§35.1），成员也得过得去。其余全局要求照旧只有 owner。
    if (
      requirement.workspaceId === "" &&
      requirement.permission === "identity:read"
    ) {
      return options.permits(subject, [scope("identity:read")]) ? ALLOW : DENY;
    }
    return requirement.workspaceId === ""
      ? DENY
      : onWorkspace(subject, requirement.permission, requirement.workspaceId);
  };
}

/** 缺省的查询：都读库，表或列不在（身份域比终端域先装、旧库）时答空串。 */
function databaseLookups(database: DatabaseSync): RouteAccessLookups {
  const text = (sql: string, id: string, column: string): string => {
    try {
      const row = database.prepare(sql).get(id) as
        | Record<string, unknown>
        | undefined;
      const value = row?.[column];
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };
  return {
    sessionWorkspace: (id) =>
      text(
        "SELECT workspace_id FROM terminal_sessions WHERE id = ?",
        id,
        "workspace_id",
      ),
    sessionCreator: (id) =>
      text(
        "SELECT creator_principal_id FROM terminal_sessions WHERE id = ?",
        id,
        "creator_principal_id",
      ),
    recordCreator: (id, principalId) => {
      try {
        database
          .prepare(
            "UPDATE terminal_sessions SET creator_principal_id = ? WHERE id = ?",
          )
          .run(principalId, id);
      } catch {
        // 记不下来的后果是这个终端按「别人的」判：少一份权限，不多一份。
      }
    },
    // 节点在画布文档里，没有一张「节点 → 画布」的总表。按最常见的几处依次
    // 找：报过状态的 Agent 节点、起过终端的节点、有名字的节点（在哪块板上）。
    nodeWorkspace: (id) =>
      text(
        "SELECT workspace_id FROM agent_status WHERE node_id = ?",
        id,
        "workspace_id",
      ) ||
      text(
        "SELECT workspace_id FROM terminal_sessions WHERE owner_node_id = ? " +
          "ORDER BY created_at DESC LIMIT 1",
        id,
        "workspace_id",
      ) ||
      text(
        "SELECT b.workspace_id AS workspace_id FROM node_handles h " +
          "JOIN boards b ON b.id = h.board_id WHERE h.node_id = ?",
        id,
        "workspace_id",
      ),
    approvalWorkspace: (id) =>
      text(
        "SELECT workspace_id FROM agent_approvals WHERE id = ?",
        id,
        "workspace_id",
      ),
    // 审批行记着它来自哪个会话；hook 面写的旧行没有，按节点最近的终端判。
    approvalCreator: (id) => {
      const session = text(
        "SELECT session_id FROM agent_approvals WHERE id = ?",
        id,
        "session_id",
      );
      if (session !== "") return sessionCreator(database, session);
      const node = text(
        "SELECT node_id FROM agent_approvals WHERE id = ?",
        id,
        "node_id",
      );
      return node === "" ? "" : nodeOwnerPrincipal(database, node);
    },
    inheritedCreator: (id) => nodeCreator(database, id),
    nodeSession: (id) => latestNodeSession(database, id),
    nodeOwner: (id) => nodeOwnerPrincipal(database, id),
    boardWorkspace: (id) =>
      text("SELECT workspace_id FROM boards WHERE id = ?", id, "workspace_id"),
    workflowDraftWorkspace: (id) =>
      text(
        "SELECT workspace_id FROM workflow_drafts WHERE id = ?",
        id,
        "workspace_id",
      ),
    workflowRunWorkspace: (id) =>
      text(
        "SELECT workspace_id FROM workflow_runs WHERE id = ?",
        id,
        "workspace_id",
      ),
    workflowTaskWorkspace: (id) =>
      text(
        "SELECT b.workspace_id AS workspace_id FROM workflow_task_runs t " +
          "JOIN nodes n ON n.id = t.coordinator_node_id " +
          "JOIN boards b ON b.id = n.board_id WHERE t.task_id = ?",
        id,
        "workspace_id",
      ),
    confirmWorkspace: () => "",
  };
}

function bodyWorkspace(request: CoreRequest): string {
  return bodyString(request, "workspaceId");
}

function bodyString(request: CoreRequest, field: string): string {
  try {
    const body = request.json<Record<string, unknown>>();
    const value = body?.[field];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
