import { IpBuckets } from "../identity/throttle";
import { type ScrubContext, scrubText } from "./crash";

/**
 * 页面错误上报（G5-19，契约 §30）的 core 一侧：请求体的形状、服务端再剥离一次、
 * 限流。桌面壳主进程（`main/diagnostics.ts`）用同一份，服务器壳 / Gateway 经
 * `routes.ts` 用它。
 *
 * 页面交来的东西一律当不可信：它自己剥离过（`apps/web/src/diagnostics/
 * crash-scrub.ts`），这里照样按本机的家目录与环境变量再剥一遍，栈里的地址与
 * 路径只留文件名，长度先截再剥。
 */

export const CLIENT_ERROR_KINDS = ["error", "rejection"] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

export interface ClientErrorReport {
  readonly kind: ClientErrorKind;
  readonly name: string;
  readonly message: string;
  readonly stack: string;
}

/** 请求体里各字段的上限：超了就 400，不截（截是剥离之后的事）。 */
export const CLIENT_ERROR_LIMITS = {
  name: 128,
  message: 2_000,
  stack: 8_000,
} as const;

const KEYS = new Set(["kind", "name", "message", "stack"]);

export type ParsedClientError =
  | { readonly ok: true; readonly report: ClientErrorReport }
  | { readonly ok: false; readonly message: string };

/** 只认 `{ kind, name, message, stack }`，不认识的键与超长都拒。 */
export function parseClientError(body: unknown): ParsedClientError {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "请求体必须是一个对象" };
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KEYS.has(key)) return { ok: false, message: `不认识的键：${key}` };
  }
  const { kind, name, message, stack } = record;
  if (
    typeof kind !== "string" ||
    !(CLIENT_ERROR_KINDS as readonly string[]).includes(kind)
  ) {
    return { ok: false, message: "kind 只能是 error 或 rejection" };
  }
  for (const [key, value] of [
    ["name", name],
    ["message", message],
    ["stack", stack],
  ] as const) {
    if (typeof value !== "string") {
      return { ok: false, message: `${key} 必须是字符串` };
    }
    if (value.length > CLIENT_ERROR_LIMITS[key]) {
      return { ok: false, message: `${key} 太长` };
    }
  }
  return {
    ok: true,
    report: {
      kind: kind as ClientErrorKind,
      name: name as string,
      message: message as string,
      stack: stack as string,
    },
  };
}

/**
 * 栈里的地址与路径只留文件名：`http://127.0.0.1:5173/assets/index-abc.js:1:2`
 * → `index-abc.js:1:2`，`/Users/x/proj/src/a.ts` → `a.ts`。查询串与片段先去掉
 * （开发态的 `?t=…`）。只动栈帧行（`    at …` 与 `fn@…`）；开头那几行是
 * 消息，交给 {@link scrubText}。
 */
export function stackFileNames(stack: string): string {
  return stack
    .split("\n")
    .map((line) => (FRAME_LINE.test(line) ? frameFileNames(line) : line))
    .join("\n");
}

const FRAME_LINE = /^\s*at\s|@/;

function frameFileNames(line: string): string {
  return line
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s()]*?)[?#][^\s():]*/gi, "$1")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s()]*\//gi, "")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s()\\/]+)*[\\/](?=[^\s()\\/]+)/g, "");
}

/** 剥离：栈先去路径，再与名字、消息一起过同一套规则。 */
export function scrubClientError(
  report: ClientErrorReport,
  context: ScrubContext,
): ClientErrorReport {
  return {
    kind: report.kind,
    name: scrubText(report.name || "Error", context, 64),
    message: scrubText(report.message, context),
    stack: scrubText(stackFileNames(report.stack), context, 4_000),
  };
}

/** 交给 SDK 的 `Error`：名字、消息、栈都是剥离过的那份。 */
export function clientError(report: ClientErrorReport): Error {
  const error = new Error(report.message);
  error.name = report.name;
  error.stack = report.stack;
  return error;
}

/** 每个调用方每分钟几条：与页面自己的上限一致。 */
export const PER_CALLER_PER_MINUTE = 5;
/** 整台 core 每分钟几条：挡很多设备一起刷。 */
export const GLOBAL_PER_MINUTE = 60;

export interface ClientReportsOptions {
  /** 设置开着且壳的上报真的在发。 */
  readonly enabled: () => boolean;
  /** 交出一条已剥离的错误。 */
  readonly report: (error: Error) => void;
  readonly scrub: () => ScrubContext;
  readonly now?: () => number;
}

export type ClientReportOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "disabled" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "limited"; readonly retryAfterMs: number };

export class ClientReports {
  private readonly perCaller = new IpBuckets(PER_CALLER_PER_MINUTE, 60_000);
  private readonly global = new IpBuckets(GLOBAL_PER_MINUTE, 60_000);
  private readonly now: () => number;

  constructor(private readonly options: ClientReportsOptions) {
    this.now = options.now ?? Date.now;
  }

  enabled(): boolean {
    try {
      return this.options.enabled();
    } catch {
      return false;
    }
  }

  /**
   * 收一条。关着时什么都不看、不计数；开着时先校验形状，再扣调用方与全局两只
   * 桶，最后剥离并交出。`caller` 是设备或 principal 的标识，不进事件。
   */
  accept(caller: string, body: unknown): ClientReportOutcome {
    if (!this.enabled()) return { kind: "disabled" };
    const parsed = parseClientError(body);
    if (!parsed.ok) return { kind: "invalid", message: parsed.message };
    const now = this.now();
    const mine = this.perCaller.peek(caller, now);
    if (!mine.ok) return { kind: "limited", retryAfterMs: mine.retryAfterMs };
    const all = this.global.take("*", now);
    if (!all.ok) return { kind: "limited", retryAfterMs: all.retryAfterMs };
    this.perCaller.take(caller, now);
    const scrubbed = scrubClientError(parsed.report, this.options.scrub());
    try {
      this.options.report(clientError(scrubbed));
    } catch {
      // 上报自己失败不能变成这次请求的 500。
    }
    return { kind: "accepted" };
  }
}
