/**
 * 补全计划（`docs/design/completion-plan.md` §2 G0-3）与 G5 计划
 * （`docs/design/g5-remaining-plan.md` §2.2 G5-00）各工作包要读的设置键的
 * 选项表与缺省值。
 *
 * **这个文件有两份，逐字节相同**：`packages/shared/src/completion-settings.ts`
 * 给页面与 zod schema（`api/settings.ts`），
 * `apps/desktop/src/core/settings/completion-settings.ts` 给 core——core 不依赖
 * `@armadra/shared`。`core/settings/completion-settings.test.ts` 比对两份字节，改一份
 * 必须同时改另一份。不 import 任何东西，也不写 zod。
 *
 * 后面的包只读不改这里与 `core/settings/schema.ts`；规矩与设置文档其它段相同：
 * 手改坏的值退回缺省。
 */

/** `gateway.listen`：仅本机回环 / 本机的私网接口 / 全部接口。 */
export const GATEWAY_LISTEN_CHOICES = ["loopback", "private", "all"] as const;
/** `gateway.tls.source`：本地 CA 签的叶证书 / 指定文件 / ACME。 */
export const GATEWAY_TLS_SOURCES = ["localCa", "file", "acme"] as const;
/**
 * `push.transport`：原生 App 的推送走哪条路（Web Push 走 `push.webpush`，与它
 * 无关）。`log` = 没配置，只写 debug 日志、接口照常答 `queued`。
 */
export const PUSH_TRANSPORT_CHOICES = ["log", "direct", "relay"] as const;
/**
 * `identity.breachCheck`。`auto` = 服务器壳与开了 Gateway 的桌面按 `warn`，
 * 其余按 `off`（架构 §8.3）；具体判定在身份域。
 */
export const BREACH_CHECK_CHOICES = ["auto", "off", "warn", "block"] as const;
/** `identity.mfa.requireFor`。 */
export const MFA_REQUIRE_CHOICES = ["none", "members", "all"] as const;
/** `identity.oauth.providers[].kind`：GitHub 是唯一的非 OIDC 特例。 */
export const OAUTH_PROVIDER_KINDS = ["github", "oidc"] as const;
/** `agents.defaultDriver`：新建 Agent 节点缺省走 ACP 会话视图还是终端。 */
export const AGENT_DRIVER_CHOICES = ["acp", "terminal"] as const;
/**
 * `canvas.layoutDirection`（契约 §50）：派发树往哪个方向长。纵向 = 从排在主
 * 下面一行，横向 = 从排在主右侧一列；整理与 core 的放置都按它。
 */
export const LAYOUT_DIRECTION_CHOICES = ["vertical", "horizontal"] as const;
/** `updates.channel`（已有键，这里补一份共享的选项表）。 */
export const UPDATE_CHANNEL_CHOICES = ["stable", "beta"] as const;

/**
 * `cloud.orgDefaultRole`：经远程服务新建的成员带组织声明时，逐块画布授予的角色；
 * `null` = 不授予（缺省）。与 core `identity/roles.ts` 的 `SHARE_ROLES` 同一组。
 */
export const CLOUD_ORG_ROLE_CHOICES = [
  "viewer",
  "editor",
  "operator",
  "driver",
] as const;

export const PASSWORD_MIN_LENGTH_RANGE = { min: 10, max: 64 } as const;
export const MAX_OAUTH_PROVIDERS = 16;

export const COMPLETION_SETTINGS_DEFAULTS = {
  gateway: {
    enabled: false,
    listen: "loopback",
    /** `0` = 首次开启时由内核分配，之后写回固定。 */
    port: 0,
    /** 空串 = 没有公网来源（反向代理时才填）。 */
    publicOrigin: "",
    tls: { source: "localCa", certFile: "", keyFile: "", acmeEmail: "" },
  },
  push: {
    transport: "log",
    /** `relay` 传输的中继地址；空串 = 没配置。 */
    relayUrl: "",
    /** APNs 直连：只存 `.p8` 的文件路径，不存内容。 */
    apns: {
      keyFile: "",
      keyId: "",
      teamId: "",
      topic: "",
      production: false,
    },
    /** FCM v1：只存服务账号 JSON 的文件路径。 */
    fcm: { serviceAccountFile: "", projectId: "" },
    /** Web Push：VAPID 密钥对在数据目录里生成；`subject` 是 `mailto:` 或 https。 */
    webpush: { enabled: true, subject: "" },
  },
  updates: { channel: "stable" },
  identity: {
    /** 空串 = 取公网来源的主机名。 */
    rpId: "",
    passwordMinLength: 12,
    breachCheck: "auto",
    mfa: { requireFor: "none" },
    oauth: { providers: [] },
  },
  agents: { defaultDriver: "acp" },
  canvas: { layoutDirection: "vertical" },
  collab: { realtime: true },
  usage: {
    /** `api.anthropic.com/api/oauth/usage`，默认关（外部服务 §12.3）。 */
    claudeUsage: false,
    /** `copilot_internal/user`，默认关。 */
    copilotUsage: false,
    /** 三家公开 status.json 的徽标；缺席时沿用旧键 `usage.statusPage`。 */
    statusBadges: true,
    /**
     * `claudeUsage` 关着时按本机 Claude 转录估算 5 小时 / 7 天窗口（G5-25）。
     * 只读本机文件、不外呼，默认开。
     */
    claudeLocalWindow: true,
  },
  models: { catalog: { autoRefresh: true } },
  cloud: {
    relay: {
      /** 关 = 不开任何出站隧道（契约 §32）。 */
      enabled: true,
      /** 节点地址或区域名；空串 = 按远程服务给的权重。 */
      preferredNode: "",
    },
    /** 见 {@link CLOUD_ORG_ROLE_CHOICES}；缺省不授予。 */
    orgDefaultRole: null,
  },
  diagnostics: {
    crashReportDsn: "",
    /** 页面的 JS 错误也经同一个 DSN 上报（G5-19），默认关。 */
    reportPageErrors: false,
  },
} as const;
