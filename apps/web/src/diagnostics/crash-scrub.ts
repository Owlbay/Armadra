/**
 * 页面错误上报（契约 §30）在页面这一侧的剥离：与 core 的
 * `apps/desktop/src/core/diagnostics/crash.ts::scrubText` 与
 * `client-report.ts::stackFileNames` 同一套规则（桌面测试
 * `client-report.test.ts` 逐条对照两份的输出）。
 *
 * 页面不知道这台机器的家目录与环境变量，那两样由收件的一侧（主进程 / core）
 * 再剥一遍；这里先把路径里的用户名、令牌形状、地址里的账号、查询串与片段换掉，
 * 栈里的地址与路径只留文件名，再截断。
 */

/** 一条消息最长留多少。 */
export const MAX_TEXT = 300;
const MAX_NAME = 64;
const MAX_STACK = 4_000;

// 正则里的引号写成 `\x22\x27\x60`：`i18n.test` 的注释剥离不认正则字面量。
// eslint-disable-next-line no-control-regex
const ANSI =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

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
  /\b[0-9a-f]{32}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
];
const LABELLED_PATTERNS: readonly RegExp[] = [
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|token|authorization)(\s*[=:]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;&]+/gi,
  /\b(Bearer|Basic|token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
];
const USER_PATHS: readonly [RegExp, string][] = [
  [/\/Users\/[^/\s\x22\x27\x60:]+/g, "/Users/~"],
  [/\/home\/[^/\s\x22\x27\x60:]+/g, "/home/~"],
  [
    /([A-Za-z]:)(\\\\|\\|\/)(Users|Documents and Settings)(\\\\|\\|\/)[^\\/\s\x22\x27\x60:]+/gi,
    "$1$2$3$4~",
  ],
];
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const URL_QUERY =
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s?#\x22\x27\x60]+)\?[^\s#\x22\x27\x60]*/gi;
const URL_FRAGMENT =
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s#\x22\x27\x60]+)#[^\s\x22\x27\x60]+/gi;

export function scrubText(text: string, max: number = MAX_TEXT): string {
  let out = text.replace(ANSI, "").replace(CONTROL, "");
  for (const [pattern, replacement] of USER_PATHS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(URL_USERINFO, "$1[redacted]@");
  out = out.replace(URL_QUERY, "$1?[redacted]");
  out = out.replace(URL_FRAGMENT, "$1#[redacted]");
  for (const pattern of TOKEN_PATTERNS)
    out = out.replace(pattern, "[redacted]");
  for (const pattern of LABELLED_PATTERNS) {
    out = out.replace(pattern, "$1$2[redacted]");
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

const FRAME_LINE = /^\s*at\s|@/;

function frameFileNames(line: string): string {
  return line
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s()]*?)[?#][^\s():]*/gi, "$1")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s()]*\//gi, "")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s()\\/]+)*[\\/](?=[^\s()\\/]+)/g, "");
}

/** 栈帧行里的地址与路径只留文件名；消息行不动。 */
export function stackFileNames(stack: string): string {
  return stack
    .split("\n")
    .map((line) => (FRAME_LINE.test(line) ? frameFileNames(line) : line))
    .join("\n");
}

export interface PageErrorReport {
  readonly kind: "error" | "rejection";
  readonly name: string;
  readonly message: string;
  readonly stack: string;
}

export function scrubReport(report: PageErrorReport): PageErrorReport {
  return {
    kind: report.kind,
    name: scrubText(report.name || "Error", MAX_NAME),
    message: scrubText(report.message),
    stack: scrubText(stackFileNames(report.stack), MAX_STACK),
  };
}
