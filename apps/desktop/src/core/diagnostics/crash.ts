import { homedir } from "node:os";

/**
 * 可选崩溃上报的剥离规则（外部服务 §11.2）。
 *
 * 两种壳都把事件交给 Sentry 协议的 SDK 之前过这里；core 经 IPC 转给桌面壳的那
 * 一份在 core 这一侧也先过一遍。本文件不 import 任何 SDK：它只处理一个普通的
 * JSON 对象，core 用它不违背「core 不依赖壳」。
 *
 * 规则是「宁可少发」：
 *
 *   * 整段删掉：`user`、`request`、`extra`、`server_name`、`modules`、`threads`，
 *     以及任何层级上名为环境变量、命令行、工作目录、请求头 / cookie、局部变量、
 *     源码行的键；
 *   * 面包屑只留类别、级别、时间与一句话，`data` 一律不留；控制台与网络类的面
 *     包屑整条丢掉（前者可能是终端输出，后者的地址可能带令牌）；
 *   * 剩下的每一个字符串：去掉 ANSI 转义与控制字符，环境变量的值、家目录、路径
 *     里的用户名、常见令牌形状、地址里的账号与查询串全部替换，再截断。
 */

/** 剥离要知道的两样东西：这台机器的家目录，以及不能出现在事件里的那些值。 */
export interface ScrubContext {
  readonly homes: readonly string[];
  /** 环境变量的值，按长度从长到短（长的先替换，免得被短的切碎）。 */
  readonly secrets: readonly string[];
}

/** 比这短的环境变量值不替换：`1`、`true` 一类替换了只会把消息弄得没法读。 */
const MIN_SECRET_LENGTH = 8;

export function scrubContext(
  env: NodeJS.ProcessEnv = process.env,
  home: string = safeHome(),
): ScrubContext {
  const homes = new Set<string>();
  for (const candidate of [home, env.HOME, env.USERPROFILE]) {
    if (candidate !== undefined && candidate.length > 1) homes.add(candidate);
  }
  const secrets = new Set<string>();
  for (const value of Object.values(env)) {
    if (value !== undefined && value.length >= MIN_SECRET_LENGTH) {
      secrets.add(value);
    }
  }
  return {
    homes: [...homes].sort((a, b) => b.length - a.length),
    secrets: [...secrets].sort((a, b) => b.length - a.length),
  };
}

function safeHome(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

/** 一条消息最长留多少；终端输出与文件正文多半是长串，截断是最后一道。 */
export const MAX_TEXT = 300;

// eslint-disable-next-line no-control-regex
const ANSI =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** 认得出形状的令牌：整段换掉。 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
/** 带标签的值：标签留下，值换掉。 */
const LABELLED_PATTERNS: readonly RegExp[] = [
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|token|authorization)(\s*[=:]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;&]+/gi,
  /\b(Bearer|Basic|token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** 各平台家目录下的用户名段。 */
const USER_PATHS: readonly [RegExp, string][] = [
  [/\/Users\/[^/\s"'`:]+/g, "/Users/~"],
  [/\/home\/[^/\s"'`:]+/g, "/home/~"],
  [
    /([A-Za-z]:)(\\\\|\\|\/)(Users|Documents and Settings)(\\\\|\\|\/)[^\\/\s"'`:]+/gi,
    "$1$2$3$4~",
  ],
];

/** 地址里的 `user:pass@` 与查询串。 */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'`]+)\?[^\s#"'`]*/gi;

/** 一个字符串的剥离。 */
export function scrubText(
  text: string,
  context: ScrubContext,
  max: number = MAX_TEXT,
): string {
  let out = text.replace(ANSI, "").replace(CONTROL, "");
  // 家目录先于环境变量：`HOME` 本身也是一个环境变量的值，先换成 `~` 路径才读得懂。
  for (const home of context.homes) {
    out = out.split(home).join("~");
  }
  for (const secret of context.secrets) {
    if (out.includes(secret)) out = out.split(secret).join("[env]");
  }
  for (const [pattern, replacement] of USER_PATHS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(URL_USERINFO, "$1[redacted]@");
  out = out.replace(URL_QUERY, "$1?[redacted]");
  for (const pattern of TOKEN_PATTERNS)
    out = out.replace(pattern, "[redacted]");
  for (const pattern of LABELLED_PATTERNS) {
    out = out.replace(pattern, "$1$2[redacted]");
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** 任何层级上出现就整段删掉的键（小写比较）。 */
const DROPPED_KEYS = new Set([
  "env",
  "environ",
  "environment_variables",
  "argv",
  "execargv",
  "cwd",
  "extra",
  "user",
  "request",
  "cookies",
  "headers",
  "vars",
  "pre_context",
  "post_context",
  "context_line",
  "server_name",
  "modules",
  "threads",
]);

/** 整条丢掉的面包屑类别。 */
const DROPPED_BREADCRUMBS =
  /^(console|http|fetch|xhr|net|electron\.net|navigation|ui\.|sentry\.)/;

/** 栈帧路径可以比消息长一些，但仍有上限。 */
const MAX_PATH = 500;
const MAX_BREADCRUMBS = 50;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function walk(value: unknown, context: ScrubContext, depth: number): Json {
  if (depth > 12) return null;
  if (typeof value === "string") return scrubText(value, context, MAX_PATH);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, context, depth + 1));
  }
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (DROPPED_KEYS.has(key.toLowerCase())) continue;
      if (item === undefined || typeof item === "function") continue;
      out[key] = walk(item, context, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * 一条事件的剥离：返回新对象，不改传入的那份。
 *
 * 顶层的 `environment`（发布环境名，如 `production`）不是环境变量，保留。
 */
export function scrubEvent<T extends object>(
  event: T,
  context: ScrubContext,
): T {
  const source = event as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...source };
  const environment = copy.environment;
  delete copy.environment;
  delete copy.breadcrumbs;
  delete copy.sdkProcessingMetadata;
  const out = walk(copy, context, 0) as Record<string, Json>;
  // 不过 `scrubText`：`production` 也可能恰好是某个环境变量的值。只认短的小写名。
  if (
    typeof environment === "string" &&
    /^[a-z][a-z0-9-]{0,31}$/.test(environment)
  ) {
    out.environment = environment;
  }
  // 消息与异常值按短上限：它们最可能夹带终端输出或文件正文。
  const exception = out.exception as { values?: Json[] } | undefined;
  for (const entry of exception?.values ?? []) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      if (typeof entry.value === "string") {
        entry.value = shorten(entry.value);
      }
    }
  }
  if (typeof out.message === "string") out.message = shorten(out.message);
  const message = out.message as { [key: string]: Json } | undefined;
  if (message !== null && typeof message === "object") {
    for (const key of ["formatted", "message"]) {
      if (typeof message[key] === "string") {
        message[key] = shorten(message[key]);
      }
    }
    delete message.params;
  }
  const logentry = out.logentry as { [key: string]: Json } | undefined;
  if (logentry !== null && typeof logentry === "object") {
    for (const key of ["formatted", "message"]) {
      if (typeof logentry[key] === "string") {
        logentry[key] = shorten(logentry[key]);
      }
    }
    delete logentry.params;
  }
  const crumbs = scrubBreadcrumbs(source.breadcrumbs, context);
  if (crumbs !== undefined) out.breadcrumbs = crumbs;
  return out as unknown as T;
}

function shorten(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function scrubBreadcrumbs(
  value: unknown,
  context: ScrubContext,
): Json[] | undefined {
  // 事件里的面包屑可能是数组，也可能是 `{ values: [...] }`。
  const list = Array.isArray(value)
    ? value
    : value !== null &&
        typeof value === "object" &&
        Array.isArray((value as { values?: unknown }).values)
      ? (value as { values: unknown[] }).values
      : undefined;
  if (list === undefined) return undefined;
  const kept: Json[] = [];
  for (const crumb of list) {
    const scrubbed = scrubBreadcrumb(crumb, context);
    if (scrubbed !== null) kept.push(scrubbed);
  }
  return kept.slice(-MAX_BREADCRUMBS);
}

/** 一条面包屑的剥离；整条该丢时返回 `null`。 */
export function scrubBreadcrumb<T>(crumb: T, context: ScrubContext): T | null {
  if (crumb === null || typeof crumb !== "object") return null;
  const source = crumb as Record<string, unknown>;
  const category = typeof source.category === "string" ? source.category : "";
  const type = typeof source.type === "string" ? source.type : "";
  if (DROPPED_BREADCRUMBS.test(category) || type === "http") return null;
  const out: Record<string, Json> = {};
  if (category !== "") out.category = scrubText(category, context, 64);
  if (type !== "") out.type = scrubText(type, context, 32);
  if (typeof source.level === "string") out.level = source.level;
  if (typeof source.timestamp === "number") out.timestamp = source.timestamp;
  if (typeof source.message === "string") {
    out.message = scrubText(source.message, context, 120);
  }
  return out as unknown as T;
}

/* ----------------------------- DSN 与设置文档 ----------------------------- */

/**
 * 一个可用的 Sentry 协议 DSN：`http(s)://<公钥>@<主机>[:端口][/路径]/<项目>`。
 * 不合格返回 `null`——壳就当没配置，什么都不发。
 */
export function parseDsn(text: string | undefined | null): string | null {
  const trimmed = (text ?? "").trim();
  if (trimmed === "" || trimmed.length > 512) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username === "" || url.hostname === "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  const project = url.pathname.split("/").filter(Boolean).pop();
  if (project === undefined || !/^[A-Za-z0-9_-]+$/.test(project)) return null;
  return trimmed;
}

/**
 * 设置文档（`<数据目录>/settings.json` 的正文）里的 `diagnostics.crashReportDsn`，
 * 校验过的；没开、读不出、不合格都是 `null`。
 */
export function dsnFromSettings(
  text: string | Uint8Array | null,
): string | null {
  if (text === null) return null;
  try {
    const document = JSON.parse(
      typeof text === "string" ? text : Buffer.from(text).toString("utf8"),
    ) as { diagnostics?: { crashReportDsn?: unknown } };
    const value = document?.diagnostics?.crashReportDsn;
    return typeof value === "string" ? parseDsn(value) : null;
  } catch {
    return null;
  }
}

/** DSN 的主机，日志里只写它，不写公钥。 */
export function dsnHost(dsn: string): string {
  try {
    return new URL(dsn).host;
  } catch {
    return "";
  }
}

/* --------------------------- core → 桌面壳的消息 --------------------------- */

/** core 子进程经 fork 的 IPC 发给桌面壳的那一种消息。 */
export const CRASH_REPORT_MESSAGE = "armadra.crashReport";
/** 桌面壳 spawn core 时设它为 `1`，core 才往 IPC 上发。 */
export const CRASH_REPORT_ENV = "ARMADRA_CRASH_REPORT_IPC";

/** 错误从哪里来。只有这几个固定值进事件，别的上下文一概不带。 */
export const ERROR_SOURCES = ["http", "uncaught", "domain"] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export interface CrashReportMessage {
  readonly type: typeof CRASH_REPORT_MESSAGE;
  readonly source: ErrorSource;
  readonly name: string;
  readonly message: string;
  readonly stack: string;
}

/** 把一个抛出的值变成一条已剥离的消息。 */
export function crashReportMessage(
  error: unknown,
  source: ErrorSource,
  context: ScrubContext,
): CrashReportMessage {
  const asError =
    error instanceof Error ? error : new Error(String(error ?? "unknown"));
  return {
    type: CRASH_REPORT_MESSAGE,
    source,
    name: scrubText(asError.name || "Error", context, 64),
    message: scrubText(asError.message, context),
    stack: scrubText(asError.stack ?? "", context, 4_000),
  };
}

export function isCrashReportMessage(
  value: unknown,
): value is CrashReportMessage {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<CrashReportMessage>;
  return (
    candidate.type === CRASH_REPORT_MESSAGE &&
    typeof candidate.source === "string" &&
    (ERROR_SOURCES as readonly string[]).includes(candidate.source) &&
    typeof candidate.name === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.stack === "string"
  );
}

/** 从一条消息重建一个 `Error`，交给 SDK 解析栈。 */
export function errorFromMessage(message: CrashReportMessage): Error {
  const error = new Error(message.message);
  error.name = message.name;
  error.stack = message.stack;
  return error;
}
