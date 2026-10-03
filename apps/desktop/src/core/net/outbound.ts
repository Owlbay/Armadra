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
} as const satisfies Record<string, OutboundEndpoint>;

export type OutboundId = keyof typeof OUTBOUND;

/**
 * 长得像地址、但 core 从不去连的字面量，各带一句为什么。
 */
export const NOT_DIALLED: Readonly<Record<string, string>> = {
  // Codex `id_token` 里那段 claim 的名字，只用来解 JWT。
  "https://api.openai.com/auth": "JWT claim 名",
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
