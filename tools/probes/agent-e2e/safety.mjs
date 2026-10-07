// agent-e2e 的操作员配置守门：跑前跑后的字节指纹、`~/.claude.json` 的键摘要、
// Claude 的缺省权限模式。由 lib.mjs 再导出；收尾（`finalize`）据此判探针有没有
// 改到操作员的机器。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* -------------------------- 操作员配置的字节快照 -------------------------- */

const guarded = [
  join(homedir(), ".claude/settings.json"),
  join(homedir(), ".codex/config.toml"),
  join(homedir(), ".codex/hooks.json"),
  join(homedir(), ".codex/auth.json"),
  // 旧版装进各 CLI 全局目录的东西：迁移只该在真实应用里发生，探针一个都不碰。
  join(homedir(), ".claude/skills/armadra/SKILL.md"),
  join(homedir(), ".codex/skills/armadra/SKILL.md"),
  join(homedir(), ".copilot/hooks/armadra.json"),
  join(homedir(), ".config/opencode/plugins/armadra-status.js"),
  join(homedir(), ".pi/agent/extensions/armadra-status.ts"),
  join(homedir(), ".omp/agent/extensions/armadra-status.ts"),
  // 场景 6 的四个 CLI：凭据只复制出去，配置一个字节都不该变。
  join(homedir(), ".config/opencode/opencode.json"),
  join(homedir(), ".local/share/opencode/auth.json"),
  join(homedir(), ".pi/agent/auth.json"),
  join(homedir(), ".pi/agent/settings.json"),
  join(homedir(), ".omp/agent/config.yml"),
  join(homedir(), ".omp/agent/models.yml"),
  join(homedir(), ".copilot/config.json"),
  // 场景 12（设计 acp-session-view §11）：Claude 用真实配置目录，这几份字节不许变。
  join(homedir(), ".claude/settings.local.json"),
  join(homedir(), ".claude/.credentials.json"),
];

/**
 * `~/.claude.json` 每次起 Claude 都会被它自己改（启动计数、缓存、这次工作目录的
 * 项目条目），字节比对没有意义；比的是每个顶层键的摘要：
 *   * 顶层键除了下面这些计数与缓存，一个都不许变（对话框被替人答掉时改的正
 *     是这一类键，比如「已接受 bypass 模式」）；
 *   * `projects` 只记不判：操作员同时开着的 Claude 会改它自己项目的条目，本次
 *     临时目录下的条目是这次跑出来的（信任过的临时目录、会话计数）。
 * 只记摘要，不记内容（文件里有账号信息）。
 */
const CLAUDE_STATE = join(homedir(), ".claude.json");
const CLAUDE_STATE_VOLATILE = new Set([
  "numStartups",
  "tipsHistory",
  "promptQueueUseCount",
  "memoryUsageCount",
  "cachedStatsigGates",
  "cachedDynamicConfigs",
  "cachedGrowthBookFeatures",
  "cachedChangelog",
  "changelogLastFetched",
  "lastReleaseNotesSeen",
  "lastOnboardingVersion",
  "subscriptionNoticeCount",
  "hasAvailableSubscription",
  "s1mAccessCache",
  "s1mNonSubscriberAccessCache",
  "feedbackSurveyState",
  "fallbackAvailableWarningThreshold",
  "isQualifiedForDataSharing",
  "lastPlanModeUse",
  "recommendedSubscription",
  "statsigModel",
  "clientDataCache",
  "groveConfigCache",
  "passesEligibilityCache",
  "skillUsage",
  "toolUsage",
  "pluginUsage",
  "tipLifetimeShownCounts",
  "tipsHistoryByCommand",
  "ideHintShownCount",
  "fullscreenUpsellSeenCount",
  "autoPermissionsNotificationCount",
  "seenNotifications",
  "githubRepoPaths",
  "metricsStatusCache",
  "cachedChromeExtensionInstalled",
  "cachedExtraUsageDisabledReason",
  "closedIssuesLastChecked",
  "lastClawdEntranceVersion",
  "companion",
  // 令牌刷新时由操作员自己的 Claude 改写；不是对话框的答案。
  "oauthAccount",
]);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function claudeStateDigest() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CLAUDE_STATE, "utf8"));
  } catch {
    return null;
  }
  const keys = {};
  for (const [key, value] of Object.entries(parsed ?? {}))
    if (key !== "projects") keys[key] = digest(value);
  const projects = {};
  for (const [path, value] of Object.entries(parsed?.projects ?? {}))
    projects[path] = digest(value);
  return { keys, projects };
}

/**
 * 两份摘要之间的变化：`blamed` 算探针的（非计数 / 缓存类顶层键），`changed`
 * 只记（`projects` 里的条目，`ours` 标出本次临时目录下的那些）。
 */
export function claudeStateBlame(before, after, scratchRoots = []) {
  if (before === null || after === null)
    return {
      blamed: before === after ? [] : [`${CLAUDE_STATE} 出现或消失`],
      changed: [],
    };
  const blamed = [];
  const changed = [];
  const allKeys = new Set([
    ...Object.keys(before.keys),
    ...Object.keys(after.keys),
  ]);
  for (const key of allKeys) {
    if (CLAUDE_STATE_VOLATILE.has(key)) continue;
    if (before.keys[key] !== after.keys[key])
      blamed.push(`${CLAUDE_STATE} 顶层键 ${key}`);
  }
  const ours = (path) =>
    scratchRoots.some(
      (root) => root && (path === root || path.startsWith(`${root}/`)),
    );
  const paths = new Set([
    ...Object.keys(before.projects),
    ...Object.keys(after.projects),
  ]);
  for (const path of paths) {
    if (before.projects[path] !== after.projects[path])
      changed.push(ours(path) ? "projects:<本次临时目录>" : "projects:<其他>");
  }
  return { blamed, changed: [...new Set(changed)] };
}

export function fingerprint() {
  const answer = {};
  for (const file of guarded) {
    try {
      answer[file] = createHash("sha256")
        .update(readFileSync(file))
        .digest("hex");
    } catch {
      answer[file] = null;
    }
  }
  return answer;
}

/**
 * 操作员 Claude 的缺省权限模式。字节比对只在新内容提到临时目录时才怪探针，可
 * Claude 自己的启动对话框（「把 auto 设成缺省？」）被一次投递答掉时，改的正是
 * 这一项、内容里没有临时目录——场景 10 首跑就这样漏过去了。单独盯住它。
 */
export function claudeDefaultMode() {
  try {
    return (
      JSON.parse(readFileSync(join(homedir(), ".claude/settings.json"), "utf8"))
        ?.permissions?.defaultMode ?? null
    );
  } catch {
    return undefined;
  }
}

/**
 * 画面进报告之前：去掉控制序列与不可见字符、遮掉像令牌的长串，只留最后 40 行。
 * 画面里是 CLI 自己的界面（对话框、页脚），不是终端原始输出流。
 */
export function sanitizeScreen(text) {
  return String(text ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>")
    .split("\n")
    .map((line) => line.trimEnd())
    .slice(-40)
    .join("\n");
}
