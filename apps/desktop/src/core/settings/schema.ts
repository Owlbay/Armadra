/**
 * Normalising the settings document: known keys are forced to valid values,
 * unknown keys are passed through, and a patch merges rather than replaces.
 *
 * Ported from the pre-merge implementation, plus the defaults, choice lists
 * and language section it declares.
 *
 * The rule the whole file follows: a value outside the offered set **snaps back
 * to the default** rather than being rejected. A settings file is something a
 * person can edit by hand, and one broken key must not make the rest of it
 * unreadable.
 */

import {
  AGENT_DRIVER_CHOICES,
  BREACH_CHECK_CHOICES,
  CLOUD_ORG_ROLE_CHOICES,
  COMPLETION_SETTINGS_DEFAULTS,
  GATEWAY_LISTEN_CHOICES,
  GATEWAY_TLS_SOURCES,
  MAX_OAUTH_PROVIDERS,
  MFA_REQUIRE_CHOICES,
  OAUTH_PROVIDER_KINDS,
  PASSWORD_MIN_LENGTH_RANGE,
  PUSH_TRANSPORT_CHOICES,
} from "./completion-settings";
import { normalizeCustomAgents } from "./custom-agents";
import { clone, isJsonObject, type JsonObject, type JsonValue } from "./local";
import { normalizeHosts } from "./ssh-hosts";

/* --------------------------------- terminal -------------------------------- */

/** `terminal.backend` — the user's choice, not necessarily what is in effect. */
export const BACKEND_CHOICES = [
  "auto",
  "tmux",
  "direct",
  "sessionHost",
] as const;
const DEFAULT_BACKEND = "auto";
const DEFAULT_DETACHED_GRACE_MINUTES = 1_440;
const MAX_DETACHED_GRACE_MINUTES = 525_600;
/**
 * How long a session with nothing attached keeps its interactive delivery
 * cadence before it goes dormant. `0` turns dormancy off entirely.
 */
const DEFAULT_DORMANT_AFTER_SECONDS = 120;
const MAX_DORMANT_AFTER_SECONDS = 86_400;
const MIN_DORMANT_AFTER_SECONDS = 5;
/**
 * `terminal.ecoMode` / `terminal.ecoIdleMinutes`——Eco 休眠（终端宿主设计 §7.2）。
 * 空闲满阈值、而且能用 CLI 自己的 resume 接回来的 Agent 会话被结束以释放内存。
 * 与上面的 `dormantAfterSeconds` 不同，这一条真的结束进程，所以阈值以分钟计。
 * 范围与默认值和 `core/terminal/hibernate.ts` 的读取一致。
 */
const DEFAULT_ECO_MODE = true;
const DEFAULT_ECO_IDLE_MINUTES = 30;
const MIN_ECO_IDLE_MINUTES = 5;
const MAX_ECO_IDLE_MINUTES = 1_440;

/* ----------------------------------- usage --------------------------------- */

/** `usage.enabled` — gates the usage pill's provider fetches. */
const DEFAULT_USAGE_ENABLED = true;
/** `usage.refreshMinutes`; `0` means "manual only". */
export const USAGE_REFRESH_CHOICES = [0, 1, 2, 5, 15];
const DEFAULT_USAGE_REFRESH_MINUTES = 5;
/** A provider that is off is never contacted and reports `unavailable`. */
export const USAGE_PROVIDER_IDS = ["claude", "codex", "copilot"] as const;
const DEFAULT_CODEX_CLI_FALLBACK = false;
/** Provider 状态页徽标默认开：只读三家公开的 status.json，不带任何凭据。 */
const DEFAULT_USAGE_STATUS_PAGE = true;
const DEFAULT_COST_ENABLED = true;

/* ------------------------------ logs / updates ----------------------------- */

/** `logs.retentionDays`; `0` means "keep forever". */
export const LOG_RETENTION_CHOICES = [0, 7, 30, 90];
const DEFAULT_LOG_RETENTION_DAYS = 30;
/**
 * `updates.channel`. `development` is not a choice: it describes a build that
 * never went through CI, and asking for it would not turn a released build into
 * one.
 */
export const UPDATE_CHANNELS = ["stable", "beta"] as const;
const DEFAULT_UPDATE_CHANNEL = "stable";
const DEFAULT_UPDATE_AUTO_CHECK = true;
const DEFAULT_UPDATE_AUTO_DOWNLOAD = false;
const DEFAULT_UPDATE_NOTIFY = true;

/* -------------------------- power / resources / browser -------------------- */

export const POWER_POLICIES = [
  "never",
  "agentSessions",
  "automation",
  "manual",
] as const;
const DEFAULT_POWER_POLICY = "manual";
/**
 * `power.keepAwakeWhileWorking`——有 Agent 在一轮里、或有自动化运行在进行时，
 * core 自己申请一把防休眠租约（终端宿主设计 §9）。默认开：它仍受
 * `power.policy` 约束，策略不放行的来源照样不生效。
 */
const DEFAULT_KEEP_AWAKE_WHILE_WORKING = true;

/**
 * 对话索引扫多大一片。
 *
 * `workspaces` 只索引本应用的工作空间根目录下跑过的那些会话，`all` 是整个
 * `~/.claude/projects`（以及 codex 的那一份）。默认收着：命令面板列出一台开发
 * 机上**所有**项目的会话标题，既慢又把与这块画布无关的工作摊在面前。
 */
export const CONVERSATION_SCOPES = ["workspaces", "all"] as const;
const DEFAULT_CONVERSATION_SCOPE = "workspaces";
const DEFAULT_RESOURCE_INTERVAL_MS = 2_000;
const MIN_RESOURCE_INTERVAL_MS = 500;
const MAX_RESOURCE_INTERVAL_MS = 60_000;
/**
 * 会话内存的提醒阈值（契约 §27.4）：越线时 core 发 `resources.threshold`，推送
 * 据此叫人；页面的徽标变色用同一个数。128 MiB – 128 GiB，低于下限的阈值会让
 * 每个 shell 都在报警。
 */
export const DEFAULT_MEMORY_WARN_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_MEMORY_WARN_BYTES = 128 * 1024 * 1024;
const MAX_MEMORY_WARN_BYTES = 128 * 1024 * 1024 * 1024;
const DEFAULT_BROWSER_KEEP_ALIVE = true;
const DEFAULT_BROWSER_HEADFUL = false;
const MAX_BROWSER_EXECUTABLE_PATH = 4_096;

/* --------------------------------- language -------------------------------- */

export const DEFAULT_IDLE_STOP_SECONDS = 600;
const MAX_IDLE_STOP_SECONDS = 86_400;
export const DEFAULT_MAX_SERVERS = 6;
const MAX_MAX_SERVERS = 24;
export const DEFAULT_MAX_RSS_BYTES = 4 * 1024 * 1024 * 1024;
const MIN_NONZERO_MAX_RSS_BYTES = 128 * 1024 * 1024;
export const DEFAULT_FORMAT_ON_SAVE = false;

/* -------------------------------- primitives ------------------------------- */

function section(document: JsonObject, key: string): JsonObject {
  const existing = document[key];
  return isJsonObject(existing) ? clone(existing) : {};
}

/**
 * `serde_json::Value::as_u64` — a non-negative integer, and nothing else. A
 * float, a negative number or a numeric string is not a `u64` on the Rust side
 * either, and falls through to the default the same way.
 */
function asUnsigned(value: JsonValue | undefined): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function asBool(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function choice<T extends string>(
  value: JsonValue | undefined,
  choices: readonly T[],
  fallback: T,
): T {
  const text = asString(value);
  return text !== undefined && (choices as readonly string[]).includes(text)
    ? (text as T)
    : fallback;
}

function numberChoice(
  value: JsonValue | undefined,
  choices: readonly number[],
  fallback: number,
): number {
  const parsed = asUnsigned(value);
  return parsed !== undefined && choices.includes(parsed) ? parsed : fallback;
}

/* --------------------------------- normalize ------------------------------- */

/**
 * The whole settings document, normalized: known keys always present with valid
 * values, unknown keys passed through untouched.
 */
export function normalize(raw: JsonValue): JsonObject {
  const document: JsonObject = isJsonObject(raw) ? clone(raw) : {};

  normalizeTerminal(document);
  normalizeUsage(document);
  normalizeLogs(document);
  normalizeUpdates(document);
  normalizePower(document);
  normalizeConversations(document);
  normalizeResources(document);
  normalizeBrowser(document);
  // Only the scalars are normalised; `servers` and `probes` are the user's map
  // and the probe cache, and both may hold ids this build has never heard of.
  normalizeLanguage(document);
  // Entries that would not survive validation are dropped here, so the document
  // the API hands out is exactly the set of hosts a terminal may be created for.
  normalizeHosts(document);
  // Same contract as the hosts above: what the API hands back is exactly the set
  // of agents that can actually be started.
  normalizeCustomAgents(document);
  // After the custom agents: `agents.defaultDriver` is only written into a
  // section that already exists, for the same reason the custom list is.
  normalizeCompletion(document);

  return document;
}

/* ------------------------- completion plan (G0-3) ------------------------- */

/**
 * The sections the completion plan's packages read, every key present with its
 * default (`completion-settings.ts`, a byte copy of the shared one; the shared
 * zod schema in `packages/shared/src/api/settings.ts` describes the same
 * shapes and the same snapping rules).
 *
 * `gateway`, `push`, `identity`, `collab`, `models` and `diagnostics` are new
 * and always written. `agents` is not created when absent — a file that never
 * had a custom agent does not grow the section — so a reader without one takes
 * `COMPLETION_SETTINGS_DEFAULTS.agents.defaultDriver`; {@link completionSettings}
 * does that for it. `usage` and `updates` live in their own normalisers.
 */
function normalizeCompletion(document: JsonObject): void {
  normalizeGateway(document);
  normalizePush(document);
  normalizeIdentity(document);
  normalizeCloud(document);
  const collab = section(document, "collab");
  collab.realtime =
    asBool(collab.realtime) ?? COMPLETION_SETTINGS_DEFAULTS.collab.realtime;
  document.collab = collab;
  const models = section(document, "models");
  const catalog = section(models, "catalog");
  catalog.autoRefresh =
    asBool(catalog.autoRefresh) ??
    COMPLETION_SETTINGS_DEFAULTS.models.catalog.autoRefresh;
  models.catalog = catalog;
  document.models = models;
  const diagnostics = section(document, "diagnostics");
  diagnostics.crashReportDsn = shortText(diagnostics.crashReportDsn);
  diagnostics.reportPageErrors =
    asBool(diagnostics.reportPageErrors) ??
    COMPLETION_SETTINGS_DEFAULTS.diagnostics.reportPageErrors;
  document.diagnostics = diagnostics;
  const agents = document.agents;
  if (isJsonObject(agents)) {
    agents.defaultDriver = choice(
      agents.defaultDriver,
      AGENT_DRIVER_CHOICES,
      COMPLETION_SETTINGS_DEFAULTS.agents.defaultDriver,
    );
  }
}

const MAX_FILE_SETTING = 4_096;
const MAX_SHORT_SETTING = 512;

function fileText(value: JsonValue | undefined): string {
  const text = asString(value);
  return text !== undefined && text.length <= MAX_FILE_SETTING ? text : "";
}

function shortText(value: JsonValue | undefined): string {
  const text = asString(value);
  return text !== undefined && text.length <= MAX_SHORT_SETTING ? text : "";
}

function normalizeGateway(document: JsonObject): void {
  const defaults = COMPLETION_SETTINGS_DEFAULTS.gateway;
  const gateway = section(document, "gateway");
  gateway.enabled = asBool(gateway.enabled) ?? defaults.enabled;
  gateway.listen = choice(
    gateway.listen,
    GATEWAY_LISTEN_CHOICES,
    defaults.listen,
  );
  const port = asUnsigned(gateway.port);
  gateway.port = port !== undefined && port <= 65_535 ? port : defaults.port;
  gateway.publicOrigin = shortText(gateway.publicOrigin);
  const tls = section(gateway, "tls");
  tls.source = choice(tls.source, GATEWAY_TLS_SOURCES, defaults.tls.source);
  tls.certFile = fileText(tls.certFile);
  tls.keyFile = fileText(tls.keyFile);
  tls.acmeEmail = shortText(tls.acmeEmail);
  gateway.tls = tls;
  document.gateway = gateway;
}

function normalizePush(document: JsonObject): void {
  const defaults = COMPLETION_SETTINGS_DEFAULTS.push;
  const push = section(document, "push");
  push.transport = choice(
    push.transport,
    PUSH_TRANSPORT_CHOICES,
    defaults.transport,
  );
  push.relayUrl = shortText(push.relayUrl);
  const apns = section(push, "apns");
  apns.keyFile = fileText(apns.keyFile);
  apns.keyId = shortText(apns.keyId);
  apns.teamId = shortText(apns.teamId);
  apns.topic = shortText(apns.topic);
  apns.production = asBool(apns.production) ?? defaults.apns.production;
  push.apns = apns;
  const fcm = section(push, "fcm");
  fcm.serviceAccountFile = fileText(fcm.serviceAccountFile);
  fcm.projectId = shortText(fcm.projectId);
  push.fcm = fcm;
  const webpush = section(push, "webpush");
  webpush.enabled = asBool(webpush.enabled) ?? defaults.webpush.enabled;
  webpush.subject = shortText(webpush.subject);
  push.webpush = webpush;
  document.push = push;
}

function normalizeIdentity(document: JsonObject): void {
  const defaults = COMPLETION_SETTINGS_DEFAULTS.identity;
  const identity = section(document, "identity");
  identity.rpId = shortText(identity.rpId);
  const length = asUnsigned(identity.passwordMinLength);
  identity.passwordMinLength =
    length !== undefined &&
    length >= PASSWORD_MIN_LENGTH_RANGE.min &&
    length <= PASSWORD_MIN_LENGTH_RANGE.max
      ? length
      : defaults.passwordMinLength;
  identity.breachCheck = choice(
    identity.breachCheck,
    BREACH_CHECK_CHOICES,
    defaults.breachCheck,
  );
  const mfa = section(identity, "mfa");
  mfa.requireFor = choice(
    mfa.requireFor,
    MFA_REQUIRE_CHOICES,
    defaults.mfa.requireFor,
  );
  identity.mfa = mfa;
  const oauth = section(identity, "oauth");
  oauth.providers = oauthProviders(oauth.providers);
  identity.oauth = oauth;
  document.identity = identity;
}

/**
 * `cloud`（契约 §32，A3-2）：出站隧道的开关与偏好节点、经远程服务新建成员的组织
 * 默认角色。角色不在选项表里（含手写的空串）就退回 `null`——不授予。
 */
function normalizeCloud(document: JsonObject): void {
  const defaults = COMPLETION_SETTINGS_DEFAULTS.cloud;
  const cloud = section(document, "cloud");
  const relay = section(cloud, "relay");
  relay.enabled = asBool(relay.enabled) ?? defaults.relay.enabled;
  relay.preferredNode = shortText(relay.preferredNode);
  cloud.relay = relay;
  const role = asString(cloud.orgDefaultRole);
  cloud.orgDefaultRole =
    role !== undefined &&
    (CLOUD_ORG_ROLE_CHOICES as readonly string[]).includes(role)
      ? role
      : defaults.orgDefaultRole;
  document.cloud = cloud;
}

const OAUTH_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const OAUTH_ISSUER = /^https?:\/\/\S+$/;

/**
 * `identity.oauth.providers[]`: an entry that does not validate is dropped,
 * the first of two with the same id wins, and the list stops at
 * {@link MAX_OAUTH_PROVIDERS} — the rule `agents.custom[]` follows. The
 * client secret is never here; it lives in the SecretStore.
 */
function oauthProviders(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) return [];
  const kept: JsonObject[] = [];
  for (const raw of value) {
    if (kept.length >= MAX_OAUTH_PROVIDERS) break;
    const provider = oauthProvider(raw);
    if (provider === undefined) continue;
    if (kept.some((other) => other.id === provider.id)) continue;
    kept.push(provider);
  }
  return kept;
}

function oauthProvider(raw: JsonValue): JsonObject | undefined {
  if (!isJsonObject(raw)) return undefined;
  const id = asString(raw.id);
  if (id === undefined || !OAUTH_PROVIDER_ID.test(id)) return undefined;
  const kind = asString(raw.kind);
  if (
    kind === undefined ||
    !(OAUTH_PROVIDER_KINDS as readonly string[]).includes(kind)
  ) {
    return undefined;
  }
  const clientId = asString(raw.clientId);
  if (
    clientId === undefined ||
    clientId.length === 0 ||
    clientId.length > 512
  ) {
    return undefined;
  }
  const issuer = raw.issuer;
  if (issuer !== undefined && typeof issuer !== "string") return undefined;
  if (kind === "oidc" && (issuer === undefined || !OAUTH_ISSUER.test(issuer))) {
    return undefined;
  }
  const scopes = stringList(raw.scopes, 32, 128);
  const allowedDomains = stringList(raw.allowedDomains, 64, 253);
  if (scopes === undefined || allowedDomains === undefined) return undefined;
  const allowSignup = raw.allowSignup ?? false;
  const enabled = raw.enabled ?? true;
  if (typeof allowSignup !== "boolean" || typeof enabled !== "boolean") {
    return undefined;
  }
  const provider: JsonObject = { id, kind };
  if (issuer !== undefined) provider.issuer = issuer;
  provider.clientId = clientId;
  provider.scopes = scopes;
  provider.allowSignup = allowSignup;
  provider.allowedDomains = allowedDomains;
  provider.enabled = enabled;
  return provider;
}

/** A list of non-empty strings, or `undefined` when it is not one. */
function stringList(
  value: JsonValue | undefined,
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return undefined;
    if (item.length > maxLength) return undefined;
    items.push(item);
  }
  return items;
}

/**
 * The completion-plan keys of a settings document with every default filled
 * in — how another domain reads them:
 * `completionSettings(settingsDomain()?.settings.snapshot() ?? {})`.
 */
export function completionSettings(document: JsonValue): CompletionSettings {
  const normalized = normalize(document);
  const agents = normalized.agents;
  const usage = normalized.usage as JsonObject;
  const updates = normalized.updates as JsonObject;
  return {
    gateway: normalized.gateway as unknown as CompletionSettings["gateway"],
    push: normalized.push as unknown as CompletionSettings["push"],
    updates: { channel: updates.channel as string },
    identity: normalized.identity as unknown as CompletionSettings["identity"],
    agents: {
      defaultDriver: (isJsonObject(agents)
        ? agents.defaultDriver
        : COMPLETION_SETTINGS_DEFAULTS.agents
            .defaultDriver) as CompletionSettings["agents"]["defaultDriver"],
    },
    collab: normalized.collab as unknown as CompletionSettings["collab"],
    usage: {
      claudeUsage: usage.claudeUsage as boolean,
      copilotUsage: usage.copilotUsage as boolean,
      statusBadges: usage.statusBadges as boolean,
      claudeLocalWindow: usage.claudeLocalWindow as boolean,
    },
    models: normalized.models as unknown as CompletionSettings["models"],
    cloud: normalized.cloud as unknown as CompletionSettings["cloud"],
    diagnostics:
      normalized.diagnostics as unknown as CompletionSettings["diagnostics"],
  };
}

type Choice<T extends readonly string[]> = T[number];

/** The typed view {@link completionSettings} answers. */
export interface CompletionSettings {
  readonly gateway: {
    readonly enabled: boolean;
    readonly listen: Choice<typeof GATEWAY_LISTEN_CHOICES>;
    readonly port: number;
    readonly publicOrigin: string;
    readonly tls: {
      readonly source: Choice<typeof GATEWAY_TLS_SOURCES>;
      readonly certFile: string;
      readonly keyFile: string;
      readonly acmeEmail: string;
    };
  };
  readonly push: {
    readonly transport: Choice<typeof PUSH_TRANSPORT_CHOICES>;
    readonly relayUrl: string;
    readonly apns: {
      readonly keyFile: string;
      readonly keyId: string;
      readonly teamId: string;
      readonly topic: string;
      readonly production: boolean;
    };
    readonly fcm: {
      readonly serviceAccountFile: string;
      readonly projectId: string;
    };
    readonly webpush: { readonly enabled: boolean; readonly subject: string };
  };
  readonly updates: { readonly channel: string };
  readonly identity: {
    readonly rpId: string;
    readonly passwordMinLength: number;
    readonly breachCheck: Choice<typeof BREACH_CHECK_CHOICES>;
    readonly mfa: { readonly requireFor: Choice<typeof MFA_REQUIRE_CHOICES> };
    readonly oauth: { readonly providers: readonly OAuthProvider[] };
  };
  readonly agents: {
    readonly defaultDriver: Choice<typeof AGENT_DRIVER_CHOICES>;
  };
  readonly collab: { readonly realtime: boolean };
  readonly usage: {
    readonly claudeUsage: boolean;
    readonly copilotUsage: boolean;
    readonly statusBadges: boolean;
    readonly claudeLocalWindow: boolean;
  };
  readonly models: { readonly catalog: { readonly autoRefresh: boolean } };
  readonly cloud: {
    readonly relay: {
      readonly enabled: boolean;
      readonly preferredNode: string;
    };
    readonly orgDefaultRole: Choice<typeof CLOUD_ORG_ROLE_CHOICES> | null;
  };
  readonly diagnostics: {
    readonly crashReportDsn: string;
    readonly reportPageErrors: boolean;
  };
}

/** One `identity.oauth.providers[]` entry; the client secret is not here. */
export interface OAuthProvider {
  readonly id: string;
  readonly kind: Choice<typeof OAUTH_PROVIDER_KINDS>;
  readonly issuer?: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly allowSignup: boolean;
  readonly allowedDomains: readonly string[];
  readonly enabled: boolean;
}

function normalizeTerminal(document: JsonObject): void {
  const terminal = section(document, "terminal");
  terminal.backend = choice(terminal.backend, BACKEND_CHOICES, DEFAULT_BACKEND);
  const grace = asUnsigned(terminal.detachedGraceMinutes);
  terminal.detachedGraceMinutes =
    grace !== undefined && grace >= 1 && grace <= MAX_DETACHED_GRACE_MINUTES
      ? grace
      : DEFAULT_DETACHED_GRACE_MINUTES;
  // `0` is a real choice (dormancy off), so it is kept rather than clamped up
  // into the valid range.
  const dormant = asUnsigned(terminal.dormantAfterSeconds);
  terminal.dormantAfterSeconds =
    dormant !== undefined &&
    (dormant === 0 ||
      (dormant >= MIN_DORMANT_AFTER_SECONDS &&
        dormant <= MAX_DORMANT_AFTER_SECONDS))
      ? dormant
      : DEFAULT_DORMANT_AFTER_SECONDS;
  terminal.ecoMode = asBool(terminal.ecoMode) ?? DEFAULT_ECO_MODE;
  const eco = asUnsigned(terminal.ecoIdleMinutes);
  terminal.ecoIdleMinutes =
    eco !== undefined &&
    eco >= MIN_ECO_IDLE_MINUTES &&
    eco <= MAX_ECO_IDLE_MINUTES
      ? eco
      : DEFAULT_ECO_IDLE_MINUTES;
  document.terminal = terminal;
}

function normalizeUsage(document: JsonObject): void {
  const usage = section(document, "usage");
  usage.enabled = asBool(usage.enabled) ?? DEFAULT_USAGE_ENABLED;
  // A cadence outside the offered set snaps back to the default rather than
  // being rejected, same rule as `logs.retentionDays`.
  usage.refreshMinutes = numberChoice(
    usage.refreshMinutes,
    USAGE_REFRESH_CHOICES,
    DEFAULT_USAGE_REFRESH_MINUTES,
  );
  const providers = section(usage, "providers");
  for (const id of USAGE_PROVIDER_IDS) {
    providers[id] = asBool(providers[id]) ?? true;
  }
  // An id nobody knows about would make the settings page render a switch for a
  // provider the core cannot query, so drop it.
  for (const key of Object.keys(providers)) {
    if (!(USAGE_PROVIDER_IDS as readonly string[]).includes(key)) {
      delete providers[key];
    }
  }
  usage.providers = providers;
  usage.codexCliFallback =
    asBool(usage.codexCliFallback) ?? DEFAULT_CODEX_CLI_FALLBACK;
  usage.statusPage = asBool(usage.statusPage) ?? DEFAULT_USAGE_STATUS_PAGE;
  // `statusBadges` is the name the outbound table uses (external services
  // §12.3). Until its reader moves over, a document that only has the old key
  // keeps the user's choice rather than snapping to the default.
  usage.statusBadges = asBool(usage.statusBadges) ?? usage.statusPage;
  // Both reach a provider with the user's own credential: off until asked.
  usage.claudeUsage =
    asBool(usage.claudeUsage) ?? COMPLETION_SETTINGS_DEFAULTS.usage.claudeUsage;
  usage.copilotUsage =
    asBool(usage.copilotUsage) ??
    COMPLETION_SETTINGS_DEFAULTS.usage.copilotUsage;
  // 本机转录估算只读本机文件、不外呼，所以默认开（G5-25）。
  usage.claudeLocalWindow =
    asBool(usage.claudeLocalWindow) ??
    COMPLETION_SETTINGS_DEFAULTS.usage.claudeLocalWindow;
  const cost = section(usage, "cost");
  cost.enabled = asBool(cost.enabled) ?? DEFAULT_COST_ENABLED;
  usage.cost = cost;
  document.usage = usage;
}

function normalizeLogs(document: JsonObject): void {
  const logs = section(document, "logs");
  logs.retentionDays = numberChoice(
    logs.retentionDays,
    LOG_RETENTION_CHOICES,
    DEFAULT_LOG_RETENTION_DAYS,
  );
  document.logs = logs;
}

function normalizeUpdates(document: JsonObject): void {
  const updates = section(document, "updates");
  // An unknown channel snaps back to stable rather than being rejected: the
  // conservative reading of a broken value is the conservative channel.
  updates.channel = choice(
    updates.channel,
    UPDATE_CHANNELS,
    DEFAULT_UPDATE_CHANNEL,
  );
  updates.autoCheck = asBool(updates.autoCheck) ?? DEFAULT_UPDATE_AUTO_CHECK;
  updates.autoDownload =
    asBool(updates.autoDownload) ?? DEFAULT_UPDATE_AUTO_DOWNLOAD;
  updates.notify = asBool(updates.notify) ?? DEFAULT_UPDATE_NOTIFY;
  document.updates = updates;
}

function normalizePower(document: JsonObject): void {
  const power = section(document, "power");
  // The safest reading of a broken value is the conservative default, not a
  // machine that refuses to sleep.
  power.policy = choice(power.policy, POWER_POLICIES, DEFAULT_POWER_POLICY);
  power.keepAwakeWhileWorking =
    asBool(power.keepAwakeWhileWorking) ?? DEFAULT_KEEP_AWAKE_WHILE_WORKING;
  document.power = power;
}

function normalizeConversations(document: JsonObject): void {
  const conversations = section(document, "conversations");
  conversations.scope = choice(
    conversations.scope,
    CONVERSATION_SCOPES,
    DEFAULT_CONVERSATION_SCOPE,
  );
  document.conversations = conversations;
}

function normalizeResources(document: JsonObject): void {
  const resources = section(document, "resources");
  const interval = asUnsigned(resources.intervalMs);
  resources.intervalMs =
    interval === undefined
      ? DEFAULT_RESOURCE_INTERVAL_MS
      : Math.min(
          Math.max(interval, MIN_RESOURCE_INTERVAL_MS),
          MAX_RESOURCE_INTERVAL_MS,
        );
  const warn = asUnsigned(resources.memoryWarnBytes);
  resources.memoryWarnBytes =
    warn === undefined
      ? DEFAULT_MEMORY_WARN_BYTES
      : Math.min(Math.max(warn, MIN_MEMORY_WARN_BYTES), MAX_MEMORY_WARN_BYTES);
  document.resources = resources;
}

function normalizeBrowser(document: JsonObject): void {
  const browser = section(document, "browser");
  // `executablePath` is stored exactly as written — an empty string means
  // "detect", and a path that does not exist is reported as unavailable rather
  // than silently replaced by a detected browser.
  const executable = asString(browser.executablePath)?.trim();
  browser.executablePath =
    executable !== undefined &&
    executable.length > 0 &&
    executable.length <= MAX_BROWSER_EXECUTABLE_PATH
      ? executable
      : "";
  browser.keepAlive = asBool(browser.keepAlive) ?? DEFAULT_BROWSER_KEEP_ALIVE;
  browser.headful = asBool(browser.headful) ?? DEFAULT_BROWSER_HEADFUL;
  document.browser = browser;
}

function normalizeLanguage(document: JsonObject): void {
  const language = section(document, "language");
  const idle = asUnsigned(language.idleStopSeconds);
  language.idleStopSeconds =
    idle !== undefined && idle <= MAX_IDLE_STOP_SECONDS
      ? idle
      : DEFAULT_IDLE_STOP_SECONDS;
  const servers = asUnsigned(language.maxServers);
  language.maxServers =
    servers === undefined
      ? DEFAULT_MAX_SERVERS
      : Math.min(Math.max(servers, 1), MAX_MAX_SERVERS);
  // `0` is "no ceiling"; a value too small to hold any real server is clamped
  // up rather than turning into an instant kill loop.
  const rss = asUnsigned(language.maxRssBytes);
  language.maxRssBytes =
    rss === undefined
      ? DEFAULT_MAX_RSS_BYTES
      : rss === 0
        ? 0
        : Math.max(rss, MIN_NONZERO_MAX_RSS_BYTES);
  language.formatOnSave =
    asBool(language.formatOnSave) ?? DEFAULT_FORMAT_ON_SAVE;
  document.language = language;
}

/* ----------------------------------- merge --------------------------------- */

/**
 * Recursive object merge: `null` deletes a key, objects merge, everything else
 * replaces. Keys the core does not know about are merged the same way.
 */
export function merge(base: JsonValue, patch: JsonValue): JsonValue {
  if (!isJsonObject(base) || !isJsonObject(patch)) return clone(patch);
  const result: JsonObject = base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    const existing = result[key];
    result[key] = merge(existing === undefined ? null : existing, value);
  }
  return result;
}
