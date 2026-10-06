import {
  createTerminalRequestSchema,
  driveLeaseSchema,
  terminalDriveRequestSchema,
  type TerminalDriveAction,
  sessionsResponseSchema,
  terminalBackendInfoSchema,
  terminalCaptureResponseSchema,
  terminalPasteRequestSchema,
  terminalSessionSchema,
  terminalTerminateRequestSchema,
  type CreateTerminalRequest,
  type TerminateMode,
} from "@armadra/shared";
import type { ArmadraClient } from "./client";

/**
 * 终端会话的 HTTP 面（契约 §38，`terminals.*`）：经客户端发 procedure，答案过页面
 * 自己的 schema。终端的字节流不在这里：输入输出走 `WS /api/terminals/{id}/ws`，
 * 那条连接由 `api/sockets.ts` 开，不动。
 *
 * 客户端由 `api/client.ts` 交进来（这个模块被它 import，反过来 import 它就是一个
 * 环）；交进来的是「当前源的客户端」，所以换了源，后面的调用就发往新的源。
 */
export const terminalsApiFor = (rpc: () => ArmadraClient) => ({
  /* ----------------------------------- 终端 ----------------------------- */
  createTerminal: async (input: CreateTerminalRequest) =>
    terminalSessionSchema.parse(
      await rpc().terminals.create(createTerminalRequestSchema.parse(input)),
    ),
  getTerminal: async (sessionId: string) =>
    terminalSessionSchema.parse(await rpc().terminals.get({ sessionId })),
  /** 抓屏：`escapes` 为 true 时保留 SGR，供快照；否则是给 Agent 读的纯文本。 */
  captureTerminal: async (
    sessionId: string,
    options: { lines?: number; escapes?: boolean } = {},
  ) =>
    terminalCaptureResponseSchema.parse(
      await rpc().terminals.capture({
        sessionId,
        ...(options.lines === undefined ? {} : { lines: options.lines }),
        ...(options.escapes === undefined ? {} : { escapes: options.escapes }),
      }),
    ),
  /** 括号粘贴；`enter` 为 true 时补一个回车。 */
  pasteTerminal: async (
    sessionId: string,
    text: string,
    enter = false,
  ): Promise<void> => {
    await rpc().terminals.paste({
      sessionId,
      ...terminalPasteRequestSchema.parse({ text, enter }),
    });
  },
  /**
   * 接管 / 交还这块屏幕（设计 `agent-delivery.md` §6.1）。
   *
   * 与「人敲一个键」不是同一件事：那是抢占，十秒后自己过期；这是一句明确的
   * 「现在归我」，Agent 一律被拒直到有人按交还。答回来的就是新的租约，但徽标
   * 不读它——那一帧 `terminal.lease` 会到每一台看着这块画布的设备上。
   */
  driveTerminal: async (sessionId: string, action: TerminalDriveAction) =>
    driveLeaseSchema.parse(
      await rpc().terminals.drive({
        sessionId,
        ...terminalDriveRequestSchema.parse({ action }),
      }),
    ),
  /** 三级终止（§15.5）：中断信号 / 杀进程树 / 连持久会话一起销毁。 */
  terminateTerminal: async (
    sessionId: string,
    mode: TerminateMode = "process",
  ) =>
    terminalSessionSchema.parse(
      await rpc().terminals.terminate({
        sessionId,
        ...terminalTerminateRequestSchema.parse({ mode }),
      }),
    ),
  /** 同一 session_key 起新 generation（旧代次的 WS 帧会被拒绝）。 */
  recycleTerminal: async (sessionId: string) =>
    terminalSessionSchema.parse(await rpc().terminals.recycle({ sessionId })),
  /**
   * 唤醒一个节能休眠的会话（终端宿主设计 §7.2）：core 在同一个会话 id 上起下
   * 一代，敲 CLI 自己的恢复行。已经醒着就答它现在的样子。
   */
  wakeTerminal: async (sessionId: string) =>
    terminalSessionSchema.parse(await rpc().terminals.wake({ sessionId })),
  terminalBackend: async () =>
    terminalBackendInfoSchema.parse(await rpc().terminals.backend()),

  /* ----------------------------------- 会话 ----------------------------- */
  sessions: async (workspaceId: string) =>
    sessionsResponseSchema.parse(
      await rpc().terminals.sessions({ workspaceId }),
    ),
});
