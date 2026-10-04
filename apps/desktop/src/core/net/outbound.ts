/**
 * core 的全部出站地址（外部服务 §12.3）。
 *
 * core 自己联网的地方都从这张表取地址，不在调用点写 `https://` 字面量；
 * `outbound.test.ts` 扫一遍 core 源码，凡是指向真实主机的 `https://` 字面量都必须
 * 落在这张表（或 {@link NOT_DIALLED}）里，所以新加一处外呼不登记就过不了测试。
 *
 * 每条带用途、频率与关闭开关。开关是设置键（`null` = 不配置即不联网，没有单独的
 * 开关）；`defaultOn` 是那个键缺省时的值。浏览器节点与各 CLI 自己的网络访问不在
 * 这里——它们是用户的程序。
 *
 * 本文件不 import 任何东西：表是数据，读开关的是各域自己。
 */

export interface OutboundEndpoint {
  /** 地址或地址前缀（调用方在后面拼路径）。 */
  readonly url: string;
  readonly purpose: string;
  readonly cadence: string;
  /** 关闭它的设置键；`null` = 不配置就不联网。 */
  readonly switch: string | null;
  readonly defaultOn: boolean;
  /**
   * `false` = 供应商没有公开文档的端点（外部服务 §9.3）：随时可变、可能有条款
   * 风险。设置页按它标「非官方端点」。
   */
  readonly documented: boolean;
}

export const OUTBOUND = {
  modelsCatalog: {
    url: "https://models.dev/api.json",
    purpose: "模型目录",
    cadence: "每日 1 次；用户手动刷新 60 秒冷却",
    switch: "models.catalog.autoRefresh",
    defaultOn: true,
    documented: true,
  },
  statusAnthropic: {
    // `status.anthropic.com` 302 到这里；直接用新地址，`status.test.ts` 钉住重定向跟随。
    url: "https://status.claude.com",
    purpose: "状态徽标（Anthropic）",
    cadence: "≥ 60 秒（缓存 5 分钟）",
    switch: "usage.statusBadges",
    defaultOn: true,
    documented: true,
  },
  statusOpenai: {
    url: "https://status.openai.com",
    purpose: "状态徽标（OpenAI）",
    cadence: "≥ 60 秒（缓存 5 分钟）",
    switch: "usage.statusBadges",
    defaultOn: true,
    documented: true,
  },
  statusGithub: {
    url: "https://www.githubstatus.com",
    purpose: "状态徽标（GitHub）",
    cadence: "≥ 60 秒（缓存 5 分钟）",
    switch: "usage.statusBadges",
    defaultOn: true,
    documented: true,
  },
  claudeUsage: {
    url: "https://api.anthropic.com/api/oauth/usage",
    purpose: "Claude 额度（借用 Claude Code 的登录令牌）",
    cadence: "用量刷新节奏（usage.refreshMinutes）",
    switch: "usage.claudeUsage",
    defaultOn: false,
    documented: false,
  },
  codexUsage: {
    url: "https://chatgpt.com/backend-api/wham/usage",
    purpose: "Codex 额度",
    cadence: "用量刷新节奏（usage.refreshMinutes）",
    switch: "usage.providers.codex",
    defaultOn: true,
    documented: false,
  },
  copilotDeviceFlow: {
    url: "https://github.com",
    purpose:
      "Copilot 设备流登录（/login/device/code、/login/oauth/access_token）",
    cadence: "登录时",
    switch: "usage.copilotUsage",
    defaultOn: false,
    documented: true,
  },
  copilotUsage: {
    // 实际拼在 GitHub API 根后面：`${githubApiBase()}${COPILOT_USER_PATH}`。
    url: "https://api.github.com/copilot_internal/user",
    purpose: "Copilot 额度",
    cadence: "用量刷新节奏（usage.refreshMinutes）",
    switch: "usage.copilotUsage",
    defaultOn: false,
    documented: false,
  },
  githubApi: {
    url: "https://api.github.com",
    purpose: "Git 窗口（或配置的 GHES 根）",
    cadence: "用户动作 + 轮询",
    switch: null,
    defaultOn: false,
    documented: true,
  },
  // 推送直连（契约 §19.5）：只在 `push.transport = "direct"` 且配了 APNs `.p8` /
  // FCM 服务账号时才连；Web Push 的端点是浏览器给的订阅地址、中继地址是用户
  // 配的，都不在这张表里。测试用 `ARMADRA_PUSH_APNS_ENDPOINT` /
  // `ARMADRA_PUSH_FCM_ENDPOINT` 换成 dev-stack 的 push-sink。
  apnsProduction: {
    url: "https://api.push.apple.com",
    purpose: "APNs 推送（生产，push.apns.production = true）",
    cadence: "每条通知 1 次，失败最多再试 2 次",
    switch: "push.transport",
    defaultOn: false,
    documented: true,
  },
  apnsSandbox: {
    url: "https://api.sandbox.push.apple.com",
    purpose: "APNs 推送（sandbox）",
    cadence: "每条通知 1 次，失败最多再试 2 次",
    switch: "push.transport",
    defaultOn: false,
    documented: true,
  },
  fcmSend: {
    url: "https://fcm.googleapis.com",
    purpose: "FCM v1 推送（/v1/projects/<id>/messages:send）",
    cadence: "每条通知 1 次，失败最多再试 2 次",
    switch: "push.transport",
    defaultOn: false,
    documented: true,
  },
  fcmToken: {
    // 服务账号 JSON 里的 `token_uri` 优先；这是它缺席时的缺省。
    url: "https://oauth2.googleapis.com/token",
    purpose: "FCM 服务账号断言换 access token",
    cadence: "约每小时 1 次（令牌到期前一分钟）",
    switch: "push.transport",
    defaultOn: false,
    documented: true,
  },
  unifiedPush: {
    // 地址是 Android App 登记时报上来的、用户自己的 UnifiedPush 分发器端点
    // （自托管 ntfy 等，契约 §27.2），这里只是占位主机。正文一律是对设备公钥
    // 封好的信封；不跟随重定向。设备没有端点就不连。
    url: "https://<UnifiedPush 分发端点>",
    purpose: "UnifiedPush 推送（用户自己的 ntfy / 分发器，设备登记时给出）",
    cadence: "每条通知 1 次，失败最多再试 2 次",
    switch: null,
    defaultOn: false,
    documented: true,
  },
  acmeLetsEncrypt: {
    // `ARMADRA_ACME_DIRECTORY` 可换成别的 CA（step-ca、ZeroSSL…）。
    url: "https://acme-v02.api.letsencrypt.org/directory",
    purpose: "Gateway 的 ACME 证书（签发与续期）",
    cadence: "首签 + 证书寿命过去三分之二时续；失败按小时退避",
    switch: null,
    defaultOn: false,
    documented: true,
  },
  hibpRange: {
    // k-匿名范围接口：只发 SHA-1 前 5 位，带 `Add-Padding`（外部服务 §7.4）。
    // `ARMADRA_HIBP_BASE` 换成 dev-stack 的 hibp fixture。
    url: "https://api.pwnedpasswords.com",
    purpose: "泄露口令检查（设口令与持邀请注册时）",
    cadence: "每次设口令 1 次，4 秒超时",
    switch: "identity.breachCheck",
    defaultOn: false,
    documented: true,
  },
  crashReport: {
    // 地址是用户填的 DSN（自托管 GlitchTip / Sentry 协议），这里只是占位主机。
    // 发的是壳（`main/diagnostics.ts`、`apps/server/src/diagnostics.ts`），core
    // 只经 `platform.reportError` 交出剥离过的错误。DSN 为空即关（缺省）。
    url: "https://<DSN 主机>",
    purpose: "可选崩溃上报（只有 JS 错误，剥离后发往自托管 DSN）",
    cadence: "事件驱动：只在出错时",
    switch: "diagnostics.crashReportDsn",
    defaultOn: false,
    documented: true,
  },
  smtp: {
    // 地址是用户配置的 `ARMADRA_SMTP_URL` / `--smtp-url`（契约 §28），这里只是
    // 占位主机；不是 HTTPS，所以不会出现在源码扫描里。只有服务器壳会配，桌面壳
    // 没有这个设置。
    url: "smtp://<ARMADRA_SMTP_URL 的主机>",
    purpose: "可选邮件通道（只发邀请与口令重置链接）",
    cadence: "事件驱动：管理员点「发送邮件」时，每来源每分钟至多 5 封",
    switch: null,
    defaultOn: false,
    documented: true,
  },
  forgeApi: {
    // 地址是用户在 `/api/forge/configs` 配的 API 根（契约 §29，Gitea / Forgejo；
    // G5-15 起含 GitLab），这里只是占位主机。HTTPS，回环主机也收明文 HTTP。
    // GitHub 仓库仍走上面的 `githubApi`。
    url: "https://<用户配置的托管平台 API 根>",
    purpose: "Git 窗口的托管区（自托管 Gitea / Forgejo、GitLab）",
    cadence: "用户动作 + 轮询；配置令牌时核验 1 次",
    switch: null,
    defaultOn: false,
    documented: true,
  },
} as const satisfies Record<string, OutboundEndpoint>;

export type OutboundId = keyof typeof OUTBOUND;

/** FCM 服务账号断言的 OAuth scope：长得像地址，但不是要连的地方。 */
export const FCM_MESSAGING_SCOPE =
  "https://www.googleapis.com/auth/firebase.messaging";

/**
 * 长得像地址、但 core 从不去连的字面量，各带一句为什么。
 */
export const NOT_DIALLED: Readonly<Record<string, string>> = {
  // Codex `id_token` 里那段 claim 的名字，只用来解 JWT。
  "https://api.openai.com/auth": "JWT claim 名",
  [FCM_MESSAGING_SCOPE]: "OAuth scope 名（FCM 服务账号断言）",
};

/** Copilot 额度在 GitHub API 根（或 `ARMADRA_GITHUB_API_BASE`）下的路径。 */
export const COPILOT_USER_PATH = "/copilot_internal/user";

/** 一个 `https://` 字面量是否已登记（按地址前缀匹配）。 */
export function isRegistered(literal: string): boolean {
  if (Object.prototype.hasOwnProperty.call(NOT_DIALLED, literal)) return true;
  return Object.values(OUTBOUND).some(
    (entry) =>
      literal === entry.url ||
      literal.startsWith(`${entry.url}/`) ||
      literal.startsWith(`${entry.url}?`),
  );
}
