import { z } from "zod";

import { ADAPTER_INSTALL_STATES } from "../api/acp.js";
import { errors } from "./errors.js";
import { jsonObjectSchema, jsonValueSchema } from "./json.js";
import { meta, oc } from "./meta.js";

/**
 * `agents.*`（契约 §39）：Agent 目录与集成、ama 的模型密钥、节点状态、人的答复
 * （审批与关闭确认）、投递与上下文、依赖等待。
 *
 * 形状写线上的样子：标识与时刻只校是字符串，格式由页面自己的 schema 再解析一遍；
 * 页面 schema 是「已知字段 + 透传」的（目录行、集成状态、审批答复、节点状态），
 * 这里同样写成已知字段加透传（{@link loose}），出参校验不会把 core 多答的字段
 * 剥掉——契约不能比旧路径少答东西。出参没有缺省值。
 *
 * 入参只校形状：`answerApproval` 的决定与 elicitation、`confirmControl` 的
 * `approve`、密钥的格式、连线的条数与长度、依赖的节点归属，都还在域里判，旧路径
 * 与 procedure 走同一份实现，拒绝的码与原话一样。旧路径是查询串的数字与布尔
 * （`limit`、`maxBytes`、`all`）以字符串到达，入参两种都收，按旧的解析规则读。
 *
 * **投递门不变**（契约 §22、§23）：
 *
 *   * 审批答复与关闭确认是人替 Agent 回答权限提示与对话框，要 `approval:answer`；
 *     服务器壳上按那条待答请求所在的画布判（自己终端上的 operator 就够），与旧
 *     路径同一道路由门（`identity/route-access.ts`）。这一面只给人用：Agent 在
 *     hook 面上没有对应的动词。
 *   * 「谁读过我」、节点状态按节点所在的画布判；投递、连线、依赖绑在路径里的
 *     工作空间上（`workspaceKey`），不跨工作空间读。
 *   * 投递记录与排队只有元数据（长度，不是正文）；转录是给人看的那一段，不进日志。
 *   * ama 的模型密钥只进不出：答的永远是「哪家设了、存在哪个后端」。
 *
 * 权限与路由表（`core/http/route-scopes.ts`）给旧路径的一致：Agent 目录与集成是
 * 本机管理（`settings:*`，目录与模型菜单对被共享了画布的成员是无害的全局读）；
 * 节点状态与「被读取」是看画布，改名建议是写画布；投递、连线、依赖读写画布。
 *
 * 留在 REST 的：白板导出 PNG、资源上传与按路径导入（字节流与大体积 data URL，
 * 走各自的体积上限），见 §39.6。
 */

/** 已知字段 + 原样透传其余字段（页面 schema 是 `looseObject` 的那些）。 */
function loose<S extends z.ZodRawShape>(shape: S) {
  return z.object(shape).catchall(jsonValueSchema.optional());
}

/** 查询串上来的数字：procedure 给数字，旧路径给字符串。 */
const queryNumber = z.union([z.number(), z.string()]).optional();

const agentRef = z.object({ agentId: z.string() });
const nodeRef = z.object({ nodeId: z.string() });
const workspaceRef = z.object({ workspaceId: z.string() });

/**
 * 写连线时的一条：只校形状，长度、角色与白板引用的取值在域里判（旧路径与
 * procedure 拒绝的原话一样）；白板引用的其余字段原样交给域。
 */
const contextLinkInputSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  role: z.string().optional(),
  content: z
    .looseObject({
      status: z.string().optional(),
      sourceShapeId: z.string().optional(),
      shapeType: z.string().optional(),
      textTruncated: z.boolean().optional(),
      text: z.string().optional(),
      pngPath: z.string().optional(),
    })
    .nullable()
    .optional(),
});

/* --------------------------------- 出参 --------------------------------- */

/** `GET /api/agents` 的一行：注册表条目加本机探测。 */
const agentInfoWireSchema = loose({
  id: z.string(),
  label: z.string(),
  color: z.string(),
  launchCmd: z.string(),
  promptMode: z.string(),
  capabilities: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  baseAgent: z.string().optional(),
  resolvedPath: z.string().nullable().optional(),
  installed: z.boolean(),
  launchTarget: loose({}).optional(),
  clientRevision: z.number().nullable().optional(),
  skillsRevision: z.number().nullable().optional(),
  probe: loose({}).nullable().optional(),
  launcher: z.string().optional(),
  history: loose({}).optional(),
  acp: loose({}).optional(),
});

const agentModelWireSchema = loose({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  releaseDate: z.string().optional(),
});

const integrationHalfWireSchema = loose({
  installed: z.boolean(),
  path: z.string().optional(),
  revision: z.number().optional(),
});

const integrationFindingWireSchema = loose({
  kind: z.string(),
  path: z.string(),
  detail: z.string(),
});

/** 集成状态（Hook 与技能是一个安装单元）；装、卸也答它。 */
const integrationStateWireSchema = loose({
  agentId: z.string(),
  mode: z.string(),
  hook: integrationHalfWireSchema,
  skill: integrationHalfWireSchema,
  legacy: loose({ found: z.array(integrationFindingWireSchema).optional() }),
  revision: z.number(),
  installedRevision: z.number().optional(),
  stale: z.boolean().optional(),
  launchArgs: z.array(z.string()).optional(),
  launchEnv: z.array(z.string()).optional(),
  globalWrites: z.array(z.string()).optional(),
});

/** 清掉旧产品名留下的条目：做了什么，认不出的原样留下了什么。 */
const integrationRepairWireSchema = loose({
  agentId: z.string(),
  found: z.array(integrationFindingWireSchema),
  removed: z.array(z.string()),
  kept: z.array(z.string()),
  backup: z.string().optional(),
  backups: z.array(z.string()),
});

/** ama 的模型密钥：只说哪家设了、存在哪个后端，从不带值。 */
const amaCredentialStatusWireSchema = z.object({
  backend: z.string(),
  providers: z.array(z.object({ id: z.string(), isSet: z.boolean() })),
});

/** 节点状态行（标已读答的就是它）。 */
const agentStatusWireSchema = loose({
  nodeId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  unread: z.boolean().optional(),
  updatedAt: z.string(),
});

const suggestTitleWireSchema = z.object({
  title: z.string(),
  source: z.enum(["transcript", "terminal", "agent"]),
});

const agentTranscriptWireSchema = z.object({
  nodeId: z.string(),
  text: z.string(),
  truncated: z.boolean(),
});

/** 审批行加上答复是怎么交到 CLI 手里的（`route`）。 */
const answerApprovalWireSchema = loose({
  id: z.string(),
  nodeId: z.string(),
  answer: z.string(),
  answeredAt: z.string(),
  revision: z.number(),
  route: z.enum(["file", "keys", "none", "acp"]),
  elicitation: loose({}).optional(),
});

const controlConfirmWireSchema = z.object({
  requestId: z.string(),
  approve: z.boolean(),
  /** 那边已经等超时了就是 `false`；对话框照样关。 */
  accepted: z.boolean(),
});

/** 投递记录的一行：只有元数据，正文从来不落盘。 */
const agentDeliveryWireSchema = loose({
  traceId: z.string(),
  workspaceId: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  outcome: z.string(),
  targetState: z.string().optional(),
  receipt: z.string().nullable().optional(),
  bodyChars: z.number().optional(),
  createdAt: z.string(),
});

/** 排在一个目标前面的一条：同样只有长度，没有正文。 */
const deliveryQueueItemWireSchema = loose({
  id: z.string(),
  workspaceId: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  position: z.number().optional(),
  bodyChars: z.number().optional(),
  reason: z.string().optional(),
});

/**
 * 「谁读过我」：总次数、总字节数与最近几条（谁、什么动词、多少字节、什么时候）。
 * 只有元数据，没有正文。
 */
const contextReadsWireSchema = z.object({
  total: z.number(),
  bytes: z.number(),
  reads: z.array(
    z.object({
      id: z.string(),
      readerNodeId: z.string(),
      readerHandle: z.string().optional(),
      readerTitle: z.string().optional(),
      verb: z.string(),
      bytes: z.number(),
      atMs: z.number(),
    }),
  ),
});

/** 一条连线（上下文链接）。`content` 是白板内容的引用，只有 `shape` 才有。 */
const contextLinkWireSchema = loose({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  role: z.string().optional(),
  content: jsonObjectSchema.optional(),
});

const contextLinksWireSchema = loose({
  nodeId: z.string(),
  links: z.array(contextLinkWireSchema),
  updatedAt: z.string(),
});

const dependencyWireSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  downstreamNodeId: z.string(),
  upstreamNodeId: z.string(),
  upstreamTitle: z.string().nullable(),
  condition: z.string(),
  state: z.string(),
  reason: z.string().nullable(),
  baseline: z.object({
    state: z.string().nullable(),
    eventAt: z.string().nullable(),
  }),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});

const dependencyLaunchWireSchema = z.object({
  nodeId: z.string(),
  workspaceId: z.string(),
  boardId: z.string(),
  state: z.string(),
  reason: z.string().nullable(),
  attempts: z.number(),
  hasTask: z.boolean(),
  sessionId: z.string().nullable(),
  createdAt: z.string().nullable(),
  launchedAt: z.string().nullable(),
  dependencies: z.array(dependencyWireSchema),
});

/** ACP 适配器的安装任务：开始、输出尾部、结束与退出码、重新探测的结果。 */
const adapterInstallJobWireSchema = loose({
  agentId: z.string(),
  state: z.enum(ADAPTER_INSTALL_STATES),
  package: z.string(),
  reinstall: z.boolean().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  output: z.array(z.string()),
  installed: z.boolean().optional(),
  failure: loose({ code: z.string(), message: z.string() }).optional(),
});

/* ------------------------------- procedure ------------------------------- */

const since = "1.9";
const CATALOG = { since, contract: "§39.1" } as const;
const STATUS = { since, contract: "§39.2" } as const;
const ANSWERS = { since, contract: "§39.3" } as const;
const DELIVERY = { since, contract: "§39.4" } as const;
const DEPENDENCIES = { since, contract: "§39.5" } as const;
const ADAPTER_INSTALL = { since: "1.15", contract: "§39.7" } as const;

const INTEGRATION = "/api/agents/{agentId}/integration";
const AMA_KEY = "/api/agents/ama/credentials/{provider}";
const AGENT_STATUS = "/api/agent-status/{nodeId}";
const DELIVERIES = "/api/workspaces/{workspaceId}/deliveries";
const DEPENDENCY_LIST = "/api/workspaces/{workspaceId}/dependencies";

export const agents = {
  /* ------------------------------ §39.1 目录与集成 ------------------------------ */

  /** 本机认得的 Agent：注册表条目、是否装了、启动器与集成修订。 */
  list: oc
    .input(z.object({}).optional())
    .output(z.array(agentInfoWireSchema))
    .errors(errors.pick("forbidden"))
    .meta(
      meta({
        ...CATALOG,
        scope: "settings:read",
        legacy: { method: "GET", path: "/api/agents" },
      }),
    ),
  /** 节点头「模型」菜单的候选：CLI 自己说的、目录里的、离线兜底。 */
  models: oc
    .input(agentRef)
    .output(z.array(agentModelWireSchema))
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...CATALOG,
        scope: "settings:read",
        legacy: { method: "GET", path: "/api/agents/{agentId}/models" },
      }),
    ),
  /** 集成状态：注入方式、两半各自的路径与修订、旧产品名留下的残留。 */
  integration: oc
    .input(agentRef)
    .output(integrationStateWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...CATALOG,
        scope: "settings:read",
        legacy: { method: "GET", path: INTEGRATION },
      }),
    ),
  /** 一次装好 Hook 与技能（只写在数据目录里）。幂等。 */
  installIntegration: oc
    .input(agentRef)
    .output(integrationStateWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...CATALOG,
        scope: "settings:write",
        legacy: { method: "POST", path: `${INTEGRATION}/install` },
      }),
    ),
  uninstallIntegration: oc
    .input(agentRef)
    .output(integrationStateWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...CATALOG,
        scope: "settings:write",
        legacy: { method: "POST", path: `${INTEGRATION}/uninstall` },
      }),
    ),
  /** 清掉旧产品名留下的条目：只动认得出是我们写的，重写前先备份。 */
  repairIntegration: oc
    .input(agentRef)
    .output(integrationRepairWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...CATALOG,
        scope: "settings:write",
        legacy: { method: "POST", path: `${INTEGRATION}/repair` },
      }),
    ),
  /** ama 的模型密钥：哪家设了、存在哪个后端。 */
  amaCredentials: oc
    .input(z.object({}).optional())
    .output(amaCredentialStatusWireSchema)
    .errors(errors.pick("forbidden"))
    .meta(
      meta({
        ...CATALOG,
        scope: "settings:read",
        legacy: { method: "GET", path: "/api/agents/ama/credentials" },
      }),
    ),
  /** 设一家的密钥；答的仍是状态，不回显值。 */
  setAmaCredential: oc
    .input(z.object({ provider: z.string(), apiKey: z.string() }))
    .output(amaCredentialStatusWireSchema)
    .errors(errors.pick("bad_request", "forbidden"))
    .meta(
      meta({
        ...CATALOG,
        scope: "settings:write",
        legacy: { method: "PUT", path: AMA_KEY },
      }),
    ),
  clearAmaCredential: oc
    .input(z.object({ provider: z.string() }))
    .output(amaCredentialStatusWireSchema)
    .errors(errors.pick("bad_request", "forbidden"))
    .meta(
      meta({
        ...CATALOG,
        scope: "settings:write",
        legacy: { method: "DELETE", path: AMA_KEY },
      }),
    ),

  /* ------------------------------ §39.2 节点状态 ------------------------------ */

  /** 清掉节点的未读标记；真的清掉了才广播 `agent.status`。 */
  markRead: oc
    .input(nodeRef)
    .output(agentStatusWireSchema)
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...STATUS,
        scope: "canvas:read",
        legacy: { method: "POST", path: `${AGENT_STATUS}/read` },
      }),
    ),
  /** 节点头的 AI 命名：转录首条用户消息 → 终端最后一条命令 → Agent 名称。 */
  suggestTitle: oc
    .input(nodeRef)
    .output(suggestTitleWireSchema)
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...STATUS,
        scope: "canvas:write",
        legacy: { method: "POST", path: `${AGENT_STATUS}/suggest-title` },
      }),
    ),
  /** 节点自己的对话尾部；没有可读转录的 CLI 答 501 `unsupported`。 */
  transcript: oc
    .input(nodeRef.extend({ maxBytes: queryNumber }))
    .output(agentTranscriptWireSchema)
    .errors(errors.pick("forbidden", "not_found", "unsupported"))
    .meta(
      meta({
        ...STATUS,
        scope: "canvas:read",
        legacy: { method: "GET", path: `${AGENT_STATUS}/transcript` },
      }),
    ),

  /* ------------------------------ §39.3 人的答复 ------------------------------ */

  /**
   * 人回答一条待答的审批（权限提示）：`decision` 是 `allow` / `deny`；ACP 的审批带
   * `optionId`，elicitation 带 `{ action, content? }`。要 `approval:answer`
   * （自己终端上的 operator 就够），按那条请求所在的画布判。答过的再答是 409。
   */
  answerApproval: oc
    .input(
      z.object({
        pendingId: z.string(),
        decision: z.string().optional(),
        optionId: z.string().optional(),
        answeredBy: z.string().optional(),
        expectedRevision: z.number().nullable().optional(),
        elicitation: jsonObjectSchema.optional(),
      }),
    )
    .output(answerApprovalWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...ANSWERS,
        scope: "approval:answer",
        legacy: { method: "POST", path: "/api/approvals/{pendingId}/answer" },
      }),
    ),
  /** 关闭确认的人工答复；那边已经等超时了答 `accepted: false`，不是错误。 */
  confirmControl: oc
    .input(z.object({ requestId: z.string(), approve: z.boolean() }))
    .output(controlConfirmWireSchema)
    .errors(errors.pick("bad_request", "forbidden"))
    .meta(
      meta({
        ...ANSWERS,
        scope: "approval:answer",
        legacy: { method: "POST", path: "/api/control/confirm/{requestId}" },
      }),
    ),

  /* ---------------------------- §39.4 投递与上下文 ---------------------------- */

  /**
   * 同一条路径的两个切片：不带 `node` 答投递**记录**（`limit` 缺省 200），带上它
   * 答那个目标还排着的**队**。两种都只有元数据。
   */
  deliveries: oc
    .input(
      workspaceRef.extend({ limit: queryNumber, node: z.string().optional() }),
    )
    .output(
      z.union([
        z.array(agentDeliveryWireSchema),
        z.array(deliveryQueueItemWireSchema),
      ]),
    )
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...DELIVERY,
        scope: "canvas:read",
        workspaceKey: "workspaceId",
        legacy: { method: "GET", path: DELIVERIES },
      }),
    ),
  /** 人拒收一条还排着的；已经在投的那条收不回来，答 `cancelled: false`。 */
  cancelDelivery: oc
    .input(workspaceRef.extend({ deliveryId: z.string() }))
    .output(z.object({ cancelled: z.boolean() }))
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...DELIVERY,
        scope: "canvas:write",
        workspaceKey: "workspaceId",
        legacy: { method: "DELETE", path: `${DELIVERIES}/{deliveryId}` },
      }),
    ),
  /** 谁读过这个节点的转录：总次数与最近几条（`limit` 缺省 20、上限 200）。 */
  contextReads: oc
    .input(nodeRef.extend({ limit: queryNumber }))
    .output(contextReadsWireSchema)
    .errors(errors.pick("forbidden"))
    .meta(
      meta({
        ...DELIVERY,
        scope: "canvas:read",
        legacy: { method: "GET", path: "/api/nodes/{nodeId}/context-reads" },
      }),
    ),
  /**
   * 写一个节点的连线文档（上下文按连线读取的那份授权）。至多 64 条；节点 id、
   * 标题与类型的长度、角色与白板引用的检查在域里。
   */
  putContextLinks: oc
    .input(
      workspaceRef.extend({
        nodeId: z.string(),
        links: z.array(contextLinkInputSchema).nullable().optional(),
      }),
    )
    .output(contextLinksWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...DELIVERY,
        scope: "canvas:write",
        workspaceKey: "workspaceId",
        legacy: {
          method: "PUT",
          path: "/api/workspaces/{workspaceId}/context-links/{nodeId}",
        },
      }),
    ),

  /* ------------------------------ §39.5 依赖等待 ------------------------------ */

  /** 还没了结的依赖等待，按下游分组；`all` 连已了结的一起答。 */
  dependencies: oc
    .input(
      workspaceRef.extend({
        nodeId: z.string().optional(),
        all: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
      }),
    )
    .output(z.object({ launches: z.array(dependencyLaunchWireSchema) }))
    .errors(errors.pick("forbidden"))
    .meta(
      meta({
        ...DEPENDENCIES,
        scope: "canvas:read",
        workspaceKey: "workspaceId",
        legacy: { method: "GET", path: DEPENDENCY_LIST },
      }),
    ),
  /** 旧节点数据里带依赖的 `pendingLaunch` 迁进依赖表；重复调用不重复建。 */
  importLegacyDependencies: oc
    .input(
      workspaceRef.extend({
        nodeId: z.string(),
        after: z.array(z.string()),
      }),
    )
    .output(z.object({ launch: dependencyLaunchWireSchema }))
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...DEPENDENCIES,
        scope: "canvas:write",
        workspaceKey: "workspaceId",
        legacy: { method: "POST", path: DEPENDENCY_LIST },
      }),
    ),
  /** 不等这条边了；其余的边都已满足时，下游就在这一次取消里启动。 */
  cancelDependency: oc
    .input(workspaceRef.extend({ dependencyId: z.string() }))
    .output(z.object({ dependency: dependencyWireSchema }))
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...DEPENDENCIES,
        scope: "canvas:write",
        workspaceKey: "workspaceId",
        legacy: { method: "DELETE", path: `${DEPENDENCY_LIST}/{dependencyId}` },
      }),
    ),

  /* --------------------------- §39.7 ACP 适配器的安装 --------------------------- */

  /**
   * 起一次适配器安装（只认 `ACP_ADAPTER_PACKAGES` 里的那几家，跑固定的
   * `npm install --global <包>`），立刻答任务；进度用 {@link adapterInstall} 读。
   * 同一家已经在装时答那一个任务。只有 owner。
   */
  installAdapter: oc
    .input(z.object({ agentId: z.string(), reinstall: z.boolean().optional() }))
    .output(adapterInstallJobWireSchema)
    .errors(
      errors.pick(
        "bad_request",
        "forbidden",
        "adapter_not_installable",
        "adapter_already_installed",
        "npm_not_found",
      ),
    )
    .meta(meta({ ...ADAPTER_INSTALL, scope: "settings:write" })),
  /** 这家最近一次安装任务；没装过答 `state: "idle"`。只有 owner。 */
  adapterInstall: oc
    .input(agentRef)
    .output(adapterInstallJobWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "adapter_not_installable"))
    .meta(meta({ ...ADAPTER_INSTALL, scope: "settings:read" })),
};
