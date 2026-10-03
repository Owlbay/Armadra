/**
 * ACP 会话的 HTTP 调用（契约 §14.2–§14.4，形状在 `@armadra/shared` 的
 * `api/acp.ts`）。会话视图只经这里说话，测试替换这一个模块就是一个假 core。
 */
import {
  acpDriverRequestSchema,
  acpDriverResponseSchema,
  acpLogResponseSchema,
  acpModeRequestSchema,
  acpPromptRequestSchema,
  acpPromptResponseSchema,
  answerApprovalRequestSchema,
  answerApprovalResponseSchema,
  createAcpSessionRequestSchema,
  terminalSessionSchema,
  type AgentDriver,
  type CreateAcpSessionRequest,
} from "@armadra/shared";

import { json, noContentSchema, query, request } from "@/api/request";
import { terminalsApi } from "@/api/terminals";

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
  /** 输入框聚焦拿人类租约，失焦或提交交还（ACP 设计 §5.6）。 */
  drive: (sessionId: string, action: "takeover" | "release") =>
    terminalsApi.driveTerminal(sessionId, action),
};
