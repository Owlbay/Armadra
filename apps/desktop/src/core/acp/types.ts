/**
 * ACP v1 的协议类型（补全架构 §5.1 第 1 条）。
 *
 * 只再导出 `@armadra/agent/acp`，core 里不复制一份：协议栈只维护一处，两份一定
 * 漂。只认 v1 规范字段，`_meta` 一律不解释。
 */
export type {
  AcpAgentCapabilities,
  AcpContentBlock,
  AcpImplementationInfo,
  AcpInitializeResult,
  AcpLoadSessionResult,
  AcpNewSessionResult,
  AcpPermissionOption,
  AcpPermissionOptionKind,
  AcpPermissionOutcome,
  AcpPromptResult,
  AcpPromptUsage,
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
  AcpSessionMode,
  AcpSessionModeState,
  AcpSessionNotification,
  AcpSessionUpdate,
  AcpStopReason,
  AcpToolCall,
  AcpToolCallContent,
  AcpToolCallStatus,
  AcpToolCallUpdate,
  AcpToolKind,
} from "@armadra/agent/acp";
