/**
 * 推送域里几个模块共用的形状（契约 §19）。
 */

export const PUSH_PLATFORMS = ["web", "ios", "android"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/** 一台设备收通知走哪条路。`webpush` 只给浏览器，另外两条只给原生 App。 */
export const DEVICE_TRANSPORTS = ["webpush", "direct", "relay"] as const;
export type DeviceTransport = (typeof DEVICE_TRANSPORTS)[number];

/** 通知的种类。页面与 App 按它分组、选图标；正文已经是成句的。 */
export const PUSH_KINDS = [
  "approval",
  "agentDone",
  "agentError",
  "deliveryFailed",
  "schedule",
  "resources",
  "comment",
  "workflowGate",
  "test",
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/**
 * 设备能按种类关掉的那些（契约 §27.1）。`test` 不在里面：人点「发一条测试」
 * 就是要看到那一条。
 */
export const PREFERENCE_KINDS = PUSH_KINDS.filter(
  (kind): kind is Exclude<PushKind, "test"> => kind !== "test",
);
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];

/**
 * 一条通知的全部内容：标题、短正文、深链，加上分组用的 `kind` 与折叠用的
 * `tag`。**没有别的字段**——不带终端原文、文件内容、命令行、提示词（AGENTS.md
 * 的 P0），所以它可以落库、可以进日志，经中继时还要再加密一层。
 */
export interface PushPayload {
  readonly v: 1;
  readonly kind: PushKind;
  readonly title: string;
  readonly body: string;
  /** `armadra://w/<workspaceId>/n/<nodeId>?s=<hostId>`（`triggers.ts::deepLink`）；与节点无关的通知只到工作空间。 */
  readonly url: string;
  /** 同一个 tag 的新通知替换旧的（同一次审批、同一个节点的完成）。 */
  readonly tag: string;
}

/** 一台登记过的设备，连同它属于谁。 */
export interface PushDevice {
  readonly deviceId: string;
  readonly principalId: string;
  readonly platform: PushPlatform;
  readonly transport: DeviceTransport;
  readonly token: string;
  readonly publicKey: string;
  readonly authSecret: string;
  readonly appVersion: string;
  readonly locale: string;
  /** 这台设备要收的种类；`null` = 全部（没设过偏好）。 */
  readonly kinds: readonly PreferenceKind[] | null;
  /** UnifiedPush 端点；空串 = 没有。非空时通知走它而不是 `transport`。 */
  readonly unifiedpushEndpoint: string;
  readonly createdAtMs: number;
  readonly revokedAtMs: number;
}

/**
 * 一次发送的结果。`gone` = 平台说这个令牌作废了（410、`Unregistered`、
 * `BadDeviceToken`），设备随之撤销；`retry` = 值得再试（网络、429、5xx）。
 */
export type SendResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly retry: boolean;
      readonly gone: boolean;
      readonly reason: string;
    };

export interface PushSender {
  send(device: PushDevice, payload: PushPayload): Promise<SendResult>;
}

export const SENT: SendResult = { ok: true };

export function failed(
  reason: string,
  options: { retry?: boolean; gone?: boolean } = {},
): SendResult {
  return {
    ok: false,
    retry: options.retry ?? false,
    gone: options.gone ?? false,
    reason: reason.slice(0, 256),
  };
}

/** HTTP 状态码 → 要不要再试。429 与 5xx 再试，其余 4xx 不试。 */
export function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export function encodePayload(payload: PushPayload): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf8");
}
