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
  AcpMcpServer,
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

/* -------------------- 上游尚未带的两块（契约 §26） -------------------- */
//
// `@armadra/agent` 0.6.7 的协议类型里还没有 `elicitation/create` 与会话配置项
// （`configOptions`、`session/set_config_option`）。上游加上之前先在这里按 ACP
// 规范写一份最小子集，只给特性检测之后的那条路用；上游带上后改为再导出。

/** `elicitation/create` 表单里的一个字段（扁平的原始类型，规范只允许这几种）。 */
export type AcpElicitationField =
  | {
      readonly type: "string";
      readonly title?: string;
      readonly description?: string;
      readonly enum?: readonly string[];
      readonly enumNames?: readonly string[];
      readonly format?: string;
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly default?: string;
    }
  | {
      readonly type: "number" | "integer";
      readonly title?: string;
      readonly description?: string;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly default?: number;
    }
  | {
      readonly type: "boolean";
      readonly title?: string;
      readonly description?: string;
      readonly default?: boolean;
    };

export interface AcpElicitationSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, AcpElicitationField>>;
  readonly required?: readonly string[];
}

/** Agent 发来的 `elicitation/create` 参数；未知字段保留。 */
export interface AcpElicitationParams {
  readonly sessionId?: string;
  readonly message: string;
  /** `form`（缺省）或 `url`。 */
  readonly mode?: string;
  readonly requestedSchema?: AcpElicitationSchema;
  readonly url?: string;
  readonly [key: string]: unknown;
}

export const ACP_ELICITATION_ACTIONS = ["accept", "decline", "cancel"] as const;
export type AcpElicitationAction = (typeof ACP_ELICITATION_ACTIONS)[number];

export type AcpElicitationValue = string | number | boolean;

export interface AcpElicitationResult {
  readonly action: AcpElicitationAction;
  /** 只在 `accept` 时有。 */
  readonly content?: Readonly<Record<string, AcpElicitationValue>>;
}

/** 会话配置项里一个可选值。 */
export interface AcpConfigSelectOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string | null;
}

/** 规范允许把可选值分组；读时摊平。 */
export interface AcpConfigSelectGroup {
  readonly group: string;
  readonly name: string;
  readonly options: readonly AcpConfigSelectOption[];
}

/** `session/new|load|resume` 答的 `configOptions[]` 的一项。 */
export interface AcpSessionConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  /** `mode` / `model` / `thought_level`，或 Agent 自己的。 */
  readonly category?: string | null;
  readonly type: string;
  readonly currentValue: string;
  readonly options: readonly (AcpConfigSelectOption | AcpConfigSelectGroup)[];
}
