/**
 * ACP 会话的 HTTP 调用（契约 §14.2–§14.4，形状在 `@armadra/shared` 的
 * `api/acp.ts`）。会话视图只经这里说话，测试替换这一个模块就是一个假 core。
 */
import {
  acpDriverRequestSchema,
  acpDriverResponseSchema,
  acpElicitationAnswerRequestSchema,
  acpLogResponseSchema,
  acpModeRequestSchema,
  acpModelRequestSchema,
  acpPromptRequestSchema,
  acpPromptResponseSchema,
  answerApprovalRequestSchema,
  answerApprovalResponseSchema,
  createAcpSessionRequestSchema,
  exportPngResponseSchema,
  exportTextRequestSchema,
  terminalSessionSchema,
  type AcpElicitationAnswer,
  type AgentDriver,
  type CreateAcpSessionRequest,
} from "@armadra/shared";

import { json, noContentSchema, query, request } from "@/api/request";
import { runtimeApi } from "@/api/client";

export const acpApi = {
  createSession: (input: CreateAcpSessionRequest) =>
    request("/api/acp/sessions", terminalSessionSchema, {
      method: "POST",
      ...json(createAcpSessionRequestSchema.parse(input)),
    }),
  log: (sessionId: string, after = 0) =>
    request(
      `/api/acp/sessions/${query(sessionId)}/log?after=${after}`,
      acpLogResponseSchema,
    ),
  prompt: (sessionId: string, text: string) =>
    request(
      `/api/acp/sessions/${query(sessionId)}/prompt`,
      acpPromptResponseSchema,
      { method: "POST", ...json(acpPromptRequestSchema.parse({ text })) },
    ),
  cancel: (sessionId: string) =>
    request(`/api/acp/sessions/${query(sessionId)}/cancel`, noContentSchema, {
      method: "POST",
    }),
  setMode: (sessionId: string, modeId: string) =>
    request(`/api/acp/sessions/${query(sessionId)}/mode`, noContentSchema, {
      method: "POST",
      ...json(acpModeRequestSchema.parse({ modeId })),
    }),
  /** 契约 §26.2：Agent 给了模型目录时才有这条路。 */
  setModel: (sessionId: string, modelId: string) =>
    request(`/api/acp/sessions/${query(sessionId)}/model`, noContentSchema, {
      method: "PUT",
      ...json(acpModelRequestSchema.parse({ modelId })),
    }),
  switchDriver: (nodeId: string, driver: AgentDriver) =>
    request(`/api/acp/nodes/${query(nodeId)}/driver`, acpDriverResponseSchema, {
      method: "POST",
      ...json(acpDriverRequestSchema.parse({ driver })),
    }),
  /** 卡片上选了一个选项：`decision` 是它的 allow / reject 归属。 */
  answer: (pendingId: string, decision: "allow" | "deny", optionId: string) =>
    request(
      `/api/approvals/${query(pendingId)}/answer`,
      answerApprovalResponseSchema,
      {
        method: "POST",
        ...json(answerApprovalRequestSchema.parse({ decision, optionId })),
      },
    ),
  /** 答一条 elicitation（契约 §26.1）：`decision` 由 action 推出，不发。 */
  answerElicitation: (pendingId: string, elicitation: AcpElicitationAnswer) =>
    request(
      `/api/approvals/${query(pendingId)}/answer`,
      answerApprovalResponseSchema,
      {
        method: "POST",
        ...json(acpElicitationAnswerRequestSchema.parse({ elicitation })),
      },
    ),
  /**
   * 输出到画板的代码块（契约 §14.5）：写到
   * `.armadra/exports/acp/<nodeId>/<name>`，答回工作区相对路径。
   */
  exportText: (
    workspaceId: string,
    nodeId: string,
    name: string,
    content: string,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/exports/${query(nodeId)}/text`,
      exportPngResponseSchema,
      {
        method: "POST",
        ...json(exportTextRequestSchema.parse({ name, content })),
      },
    ),
  /** 输入框聚焦拿人类租约，失焦或提交交还（ACP 设计 §5.6）。 */
  drive: (sessionId: string, action: "takeover" | "release") =>
    runtimeApi.driveTerminal(sessionId, action),
};
