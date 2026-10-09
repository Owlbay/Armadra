import {
  ManualRunResponseSchema,
  adapterInstallJobSchema,
  type AdapterInstallTarget,
  agentListSchema,
  amaCredentialRequestSchema,
  amaCredentialStatusSchema,
  agentModelListSchema,
  agentStatusSchema,
  answerApprovalResponseSchema,
  contextLinksRequestSchema,
  contextLinksResponseSchema,
  contextReadsResponseSchema,
  controlConfirmRequestSchema,
  controlConfirmResponseSchema,
  deliveriesResponseSchema,
  deliveryCancelResponseSchema,
  deliveryQueueResponseSchema,
  dependenciesResponseSchema,
  dependencyCancelResponseSchema,
  legacyDependencyRequestSchema,
  legacyDependencyResponseSchema,
  exportPngRequestSchema,
  exportPngResponseSchema,
  importAssetRequestSchema,
  integrationRepairReportSchema,
  integrationStateSchema,
  launchResultRequestSchema,
  launchResultResponseSchema,
  launchSlotRequestSchema,
  launchSlotResponseSchema,
  type LaunchResultRequest,
  type LaunchSlotRequest,
  suggestTitleResponseSchema,
  agentTranscriptSchema,
  agentUploadResponseSchema,
  uploadAssetRequestSchema,
  uploadAssetResponseSchema,
  type ContextLink,
} from "@armadra/shared";
import type { ArmadraClient } from "./client";
import { json, query, request } from "./request";
import { type Source, currentSource } from "./source";

/** 交给请求的中止信号：没有就不带第二个参数。 */
const options = (signal?: AbortSignal) => (signal ? { signal } : undefined);

/**
 * Agent 与协作的调用面（契约 §39，`agents.*`）：经客户端发 procedure，答案过页面
 * 自己的 schema，调用点的签名与迁移前一样。
 *
 * 客户端由 `api/client.ts` 交进来（这个模块被它 import，反过来就是一个环）；
 * `rpc()` 缺省是当前源的客户端，带 `source` 的几处（依赖等待按源分组）发往那个源。
 *
 * 白板导出、资源上传与按路径导入留在 REST（字节流与大体积 data URL，§39.6）。
 */
export const agentsApiFor = (rpc: (source?: Source) => ArmadraClient) => ({
  startManualRun: (
    workspaceId: string,
    boardId: string,
    nodeId: string,
    body: { prompt: string; expectedUpdatedAt: string; key: string },
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/boards/${query(boardId)}/nodes/${query(nodeId)}/run`,
      ManualRunResponseSchema,
      { method: "POST", ...json(body) },
    ),
  /* --------------------------------- 启动闸门 ---------------------------- */
  /**
   * 敲启动行之前排队（契约 §52）。长轮询 ≤ 30 s；`granted: false` 或请求失败时
   * 页面照常敲。
   */
  launchSlot: (body: LaunchSlotRequest, signal?: AbortSignal) =>
    request("/api/agents/launch-slot", launchSlotResponseSchema, {
      method: "POST",
      ...json(launchSlotRequestSchema.parse(body)),
      ...(signal ? { signal } : {}),
    }),
  /** 敲完之后问这一次起没起来（契约 §52）。长轮询 ≤ 30 s。 */
  launchResult: (body: LaunchResultRequest, signal?: AbortSignal) =>
    request("/api/agents/launch-result", launchResultResponseSchema, {
      method: "POST",
      ...json(launchResultRequestSchema.parse(body)),
      ...(signal ? { signal } : {}),
    }),

  /* --------------------------------- Agent 协作 -------------------------- */
  /** 投递记录（§5.7 第 10 条）。只有元数据，正文从来不落盘。 */
  deliveries: async (workspaceId: string, limit = 200) =>
    deliveriesResponseSchema.parse(
      await rpc().agents.deliveries({ workspaceId, limit }),
    ),
  /**
   * 排在一个终端节点前面的那些（设计 `agent-delivery.md` §4.6、§10）。
   *
   * 与上面那条是同一条路径的两个切片：记录说「发生过什么」，这一条说「还压着
   * 什么」。节点头的「排队 N」数的就是它，所以计数不由页面自己按事件加减——
   * core 才是那张表的唯一来源。
   */
  deliveryQueue: async (
    workspaceId: string,
    nodeId: string,
    signal?: AbortSignal,
  ) =>
    deliveryQueueResponseSchema.parse(
      await rpc().agents.deliveries(
        { workspaceId, node: nodeId },
        options(signal),
      ),
    ),
  /**
   * 谁读过这个节点的转录（设计 §10）。
   *
   * 读是一件发生过的事，读的人知道，被读的人今天不知道；节点头的「被读取 N
   * 次」数的就是它。只有元数据：谁、什么动词、多少字节、什么时候。
   */
  contextReads: async (nodeId: string, signal?: AbortSignal) =>
    contextReadsResponseSchema.parse(
      await rpc().agents.contextReads({ nodeId }, options(signal)),
    ),
  /** 人拒收一条还排着的。已经在投的那条收不回来，答 `cancelled:false`。 */
  cancelDelivery: async (workspaceId: string, deliveryId: string) =>
    deliveryCancelResponseSchema.parse(
      await rpc().agents.cancelDelivery({ workspaceId, deliveryId }),
    ),
  /**
   * 还没了结的依赖等待，按下游分组（Agent 自动化设计 §6）。等待关系由 core
   * 持有，节点头的「等待 X」与 rope 边都从这里读。
   */
  dependencies: async (
    workspaceId: string,
    signal?: AbortSignal,
    source?: Source,
  ) =>
    dependenciesResponseSchema.parse(
      await rpc(source).agents.dependencies({ workspaceId }, options(signal)),
    ),
  /** 不等这条边了；其余的边都已满足时，core 当场启动下游。 */
  cancelDependency: async (
    workspaceId: string,
    dependencyId: string,
    source?: Source,
  ) =>
    dependencyCancelResponseSchema.parse(
      await rpc(source).agents.cancelDependency({ workspaceId, dependencyId }),
    ),
  /** 旧节点数据里带依赖的 `pendingLaunch` 迁进依赖表。重复调用不重复建。 */
  importLegacyDependencies: async (
    workspaceId: string,
    nodeId: string,
    after: readonly string[],
    source?: Source,
  ) =>
    legacyDependencyResponseSchema.parse(
      await rpc(source).agents.importLegacyDependencies({
        workspaceId,
        ...legacyDependencyRequestSchema.parse({ nodeId, after }),
      }),
    ),
  /** 关闭确认的人工答复（§5.8）。`accepted:false` = 那边已经等超时了。 */
  confirmControl: async (requestId: string, approve: boolean) =>
    controlConfirmResponseSchema.parse(
      await rpc().agents.confirmControl({
        requestId,
        ...controlConfirmRequestSchema.parse({ approve }),
      }),
    ),

  /* ----------------------------------- Agent ---------------------------- */
  agents: async () => agentListSchema.parse(await rpc().agents.list()),
  /**
   * 节点头部「模型」菜单的候选（F7）。按发布日期倒序，每条注明来自 CLI 自己、
   * models.dev 目录，还是离线兜底表。Runtime 侧缓存 10 分钟，所以开菜单时
   * 反复请求不会反复起进程。
   */
  agentModels: async (agentId: string) =>
    agentModelListSchema.parse(await rpc().agents.models({ agentId })),
  /**
   * 集成状态（设计 agent-integration §5）：Hook 与技能是**一个**安装单元，
   * 一次读出注入方式、两半各自的路径与修订、以及旧产品名留下的残留。
   */
  agentIntegration: async (agentId: string, signal?: AbortSignal) =>
    integrationStateSchema.parse(
      await rpc().agents.integration({ agentId }, options(signal)),
    ),
  /** 一次装好 Hook 与技能。幂等：内容没变的技能文件连 mtime 都不动。 */
  installAgentIntegration: async (agentId: string) =>
    integrationStateSchema.parse(
      await rpc().agents.installIntegration({ agentId }),
    ),
  uninstallAgentIntegration: async (agentId: string) =>
    integrationStateSchema.parse(
      await rpc().agents.uninstallIntegration({ agentId }),
    ),
  /**
   * 清掉旧产品名留下的条目（设计 §4）。只动认得出是我们写的那些，
   * 重写前先备份成 `<file>.armadra-backup-<时间戳>`，其余原样写回。
   */
  repairAgentIntegration: async (agentId: string) =>
    integrationRepairReportSchema.parse(
      await rpc().agents.repairIntegration({ agentId }),
    ),
  /** Armadra Agent 的模型密钥（契约 §12.4）：只答是否已设与后端，从不答值。 */
  amaCredentials: async () =>
    amaCredentialStatusSchema.parse(await rpc().agents.amaCredentials()),
  setAmaCredential: async (provider: string, apiKey: string) =>
    amaCredentialStatusSchema.parse(
      await rpc().agents.setAmaCredential({
        provider,
        ...amaCredentialRequestSchema.parse({ apiKey }),
      }),
    ),
  clearAmaCredential: async (provider: string) =>
    amaCredentialStatusSchema.parse(
      await rpc().agents.clearAmaCredential({ provider }),
    ),
  /**
   * 装 / 重装 / 恢复一家的 ACP 适配器或 CLI（契约 §39.7、§47）：立刻答任务，进度
   * 用 {@link acpAdapterInstall} 读。只认两张白名单里的包，只有 owner。缺省的
   * `adapter` 不写进入参：1.22 之前的 core 不认 `target`。
   */
  installAcpAdapter: async (
    agentId: string,
    reinstall: boolean,
    target: AdapterInstallTarget = "adapter",
    rollback = false,
  ) =>
    adapterInstallJobSchema.parse(
      await rpc().agents.installAdapter({
        agentId,
        reinstall,
        ...(target === "adapter" ? {} : { target }),
        ...(rollback ? { rollback } : {}),
      }),
    ),
  acpAdapterInstall: async (
    agentId: string,
    target: AdapterInstallTarget = "adapter",
  ) =>
    adapterInstallJobSchema.parse(
      await rpc().agents.adapterInstall({
        agentId,
        ...(target === "adapter" ? {} : { target }),
      }),
    ),
  /** 清掉某个节点的未读标记；其它窗口通过 workspace 事件流同步。 */
  markAgentRead: async (nodeId: string) =>
    agentStatusSchema.parse(await rpc().agents.markRead({ nodeId })),
  /**
   * 节点头部的 ✦ AI 命名（§17）。Runtime 依次尝试：转录首条用户消息 →
   * 终端最后一条命令 → Agent 名称，截到 40 字。不调模型，所以是毫秒级；
   * `source` 说明这句话是从哪儿来的，调用方据此决定要不要提示用户。
   */
  suggestTitle: async (nodeId: string) =>
    suggestTitleResponseSchema.parse(
      await rpc().agents.suggestTitle({ nodeId }),
    ),
  /**
   * 一个节点自己的对话尾部（每条消息一行散文）。
   *
   * 是读，所以两种归属下都答：转录本来就是这台机器上的文件，Worker 通道的
   * `ReadTranscript` 读的是同一份。没有可读转录的 CLI 回 501 并说明原因，
   * 不回空正文——空正文和「这一轮还没说话」分不开。
   */
  agentTranscript: async (nodeId: string, maxBytes?: number) =>
    agentTranscriptSchema.parse(
      await rpc().agents.transcript({
        nodeId,
        ...(maxBytes ? { maxBytes } : {}),
      }),
    ),
  /** 人回答一条待答的审批（权限提示）。只有人会调它：Agent 没有这条路。 */
  answerApproval: async (pendingId: string, decision: "allow" | "deny") =>
    answerApprovalResponseSchema.parse(
      await rpc().agents.answerApproval({ pendingId, decision }),
    ),

  putContextLinks: async (
    workspaceId: string,
    nodeId: string,
    links: ContextLink[],
  ) =>
    contextLinksResponseSchema.parse(
      await rpc().agents.putContextLinks({
        workspaceId,
        nodeId,
        ...contextLinksRequestSchema.parse({ links }),
      }),
    ),

  /* --------------------------- 留在 REST 的字节流 ------------------------- */

  /**
   * 白板导出（旧画布契约 §6.3）。导出的可以是任意 白板对象——墨迹、几何
   * 图形、整个 frame——它们只在浏览器的 store 里存在，所以由前端栅格化后上传，
   * Runtime 落盘到 `.armadra/exports/<uuid>.png`。`uuid` 不必对应任何节点。
   * 返回的 `relativePath` 就是 `ContextLink.content.pngPath` 要填的值。
   */
  exportPng: (workspaceId: string, exportId: string, dataUrl: string) =>
    request(
      `/api/workspaces/${workspaceId}/exports/${query(exportId)}/png`,
      exportPngResponseSchema,
      {
        method: "POST",
        ...json(exportPngRequestSchema.parse({ dataUrl })),
      },
    ),

  /**
   * 白板资产上传（旧画布契约 §6.2），白板图片上传的后端。
   *
   * 两种来源两种发法：`Blob` / `File` 直接以自身 MIME 原样 POST，已解码的
   * data URL 以 `{ dataUrl }` JSON POST。文件名是内容哈希，同一张图重复上传
   * 只落一份。返回的 `url` 是 Runtime 相对路径，用 `assetUrl` 或直接拼
   * 当前源的 `httpBase` 得到可加载的地址。
   */
  uploadAsset: (workspaceId: string, source: Blob | string) =>
    typeof source === "string"
      ? request(
          `/api/workspaces/${workspaceId}/assets`,
          uploadAssetResponseSchema,
          {
            method: "POST",
            ...json(uploadAssetRequestSchema.parse({ dataUrl: source })),
          },
        )
      : request(
          `/api/workspaces/${workspaceId}/assets`,
          uploadAssetResponseSchema,
          {
            method: "POST",
            body: source,
            // 覆盖 request() 默认的 application/json：Runtime 用它判断扩展名。
            headers: { "Content-Type": source.type },
          },
        ),

  /**
   * 粘贴或拖进 Agent 节点的文件（契约 §55）：原样 POST 到当前源，落在会话所在
   * 那台 core 的数据目录里（经中继的远程源就在远端）。答复的 `path` 是那台机器上
   * 的绝对路径，`id` 给 ACP prompt 的 `attachments` 用。
   */
  uploadAgentFile: (
    workspaceId: string,
    file: Blob,
    name: string,
    source?: Source,
  ) =>
    request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/agent-uploads?name=${query(name)}`,
      agentUploadResponseSchema,
      {
        method: "POST",
        body: file,
        headers: {
          "Content-Type": file.type || "application/octet-stream",
        },
      },
      source,
    ),

  /**
   * 按路径导入资产（旧画布契约 §8 Phase 3）。
   *
   * 桌面版的 OS 拖放只给得到真实路径（webview 收不到 `DataTransfer`，壳里也没
   * 装 fs 插件），所以由 Runtime 去读盘，落进和 `uploadAsset` 同一个内容寻址
   * 目录，响应也同形。绝对路径可以在工作区外（Finder 拖进来的多半在
   * `~/Downloads`），相对路径按工作区根解析。
   */
  importAsset: (workspaceId: string, path: string) =>
    request(
      `/api/workspaces/${workspaceId}/assets/import`,
      uploadAssetResponseSchema,
      {
        method: "POST",
        ...json(importAssetRequestSchema.parse({ path })),
      },
    ),

  /** `TLAssetStore.resolve` 用的绝对地址；`assetId` 是 `uploadAsset` 返回的 `id`。 */
  assetUrl: (workspaceId: string, assetId: string) =>
    `${currentSource().httpBase}/api/workspaces/${workspaceId}/assets/${query(assetId)}`,
});
