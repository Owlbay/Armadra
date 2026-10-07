/**
 * ACP 会话的调用面（契约 §14.2–§14.4、§43.1，形状在 `@armadra/shared` 的
 * `api/acp.ts`）。会话视图只经这里说话，测试替换这一个模块就是一个假 core。
 *
 * 起会话、发提示、打断、切模式与模型、读镜像、切换驱动经 `acp.*` procedure；审批与
 * elicitation 的答复经 `agents.answerApproval`（§39.3，人替 Agent 回答，Agent 没有
 * 这条路）；输出到画板的代码块经 `files.exportText`（§37.3），输入框的租约经
 * `terminals.drive`（§38）。都发往当前源。答案照旧过页面自己的 schema，调用点的
 * 签名不变。
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
  driveLeaseSchema,
  exportPngResponseSchema,
  exportTextRequestSchema,
  terminalDriveRequestSchema,
  terminalSessionSchema,
  type AcpElicitationAnswer,
  type AgentDriver,
  type CreateAcpSessionRequest,
} from "@armadra/shared";

import { currentClient } from "@/api/client";

export const acpApi = {
  createSession: async (input: CreateAcpSessionRequest) =>
    terminalSessionSchema.parse(
      await currentClient().acp.createSession(
        createAcpSessionRequestSchema.parse(input),
      ),
    ),
  log: async (sessionId: string, after = 0) =>
    acpLogResponseSchema.parse(
      await currentClient().acp.log({ sessionId, after }),
    ),
  /** `clientTurnId`（契约 §39.9）：同一个 id 重发，core 只投递一次。 */
  prompt: async (sessionId: string, text: string, clientTurnId?: string) =>
    acpPromptResponseSchema.parse(
      await currentClient().acp.prompt({
        sessionId,
        ...acpPromptRequestSchema.parse(
          clientTurnId === undefined ? { text } : { text, clientTurnId },
        ),
      }),
    ),
  cancel: async (sessionId: string) => {
    await currentClient().acp.cancel({ sessionId });
  },
  setMode: async (sessionId: string, modeId: string) => {
    await currentClient().acp.setMode({
      sessionId,
      ...acpModeRequestSchema.parse({ modeId }),
    });
  },
  /** 契约 §26.2：Agent 给了模型目录时才有这条路。 */
  setModel: async (sessionId: string, modelId: string) => {
    await currentClient().acp.setModel({
      sessionId,
      ...acpModelRequestSchema.parse({ modelId }),
    });
  },
  switchDriver: async (nodeId: string, driver: AgentDriver) =>
    acpDriverResponseSchema.parse(
      await currentClient().acp.switchDriver({
        nodeId,
        ...acpDriverRequestSchema.parse({ driver }),
      }),
    ),
  /** 卡片上选了一个选项：`decision` 是它的 allow / reject 归属。 */
  answer: async (
    pendingId: string,
    decision: "allow" | "deny",
    optionId: string,
  ) =>
    answerApprovalResponseSchema.parse(
      await currentClient().agents.answerApproval({
        pendingId,
        ...answerApprovalRequestSchema.parse({ decision, optionId }),
      }),
    ),
  /** 答一条 elicitation（契约 §26.1）：`decision` 由 action 推出，不发。 */
  answerElicitation: async (
    pendingId: string,
    elicitation: AcpElicitationAnswer,
  ) =>
    answerApprovalResponseSchema.parse(
      await currentClient().agents.answerApproval({
        pendingId,
        ...acpElicitationAnswerRequestSchema.parse({ elicitation }),
      }),
    ),
  /**
   * 输出到画板的代码块（契约 §14.5）：写到
   * `.armadra/exports/acp/<nodeId>/<name>`，答回工作区相对路径。
   */
  exportText: async (
    workspaceId: string,
    nodeId: string,
    name: string,
    content: string,
  ) =>
    exportPngResponseSchema.parse(
      await currentClient().files.exportText({
        workspaceId,
        exportId: nodeId,
        ...exportTextRequestSchema.parse({ name, content }),
      }),
    ),
  /** 输入框聚焦拿人类租约，失焦或提交交还（ACP 设计 §5.6）。 */
  drive: async (sessionId: string, action: "takeover" | "release") =>
    driveLeaseSchema.parse(
      await currentClient().terminals.drive({
        sessionId,
        ...terminalDriveRequestSchema.parse({ action }),
      }),
    ),
};
