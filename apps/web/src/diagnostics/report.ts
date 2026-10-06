import { z } from "zod";
import { currentClient } from "../api/client";
import { type PageErrorReport, scrubReport } from "./crash-scrub";

/**
 * 页面错误上报（G5-19，契约 §30）：`window` 的 `error` 与 `unhandledrejection`。
 *
 * 默认关。只有 core 答 `GET /api/diagnostics/client-error` 的 `enabled` 为真
 * （`diagnostics.reportPageErrors` 打开、壳的崩溃上报在发）时才收；这个答案缓存
 * 一分钟，关着的时候一条错误也不留。收下的先在页面剥离（`crash-scrub.ts`），
 * 每分钟最多 5 条；桌面壳经 IPC `diagnostics:report` 交给主进程，浏览器
 * （服务器壳 / Gateway）经 `diagnostics.*` procedure（契约 §43.8）。上报自己出的错一律吞掉，不会再触发
 * 一次上报。
 */

/** 每分钟最多几条。 */
export const PAGE_ERRORS_PER_MINUTE = 5;
/** `enabled` 的答案留多久。 */
export const ENABLED_TTL_MS = 60_000;

const statusSchema = z.object({ enabled: z.boolean() });

export interface PageErrorTransport {
  enabled(): Promise<boolean>;
  send(report: PageErrorReport): Promise<void>;
}

/** 桌面壳有 `window.armadra.diagnostics` 就走 IPC，否则走 HTTP。 */
export function defaultTransport(): PageErrorTransport {
  return {
    enabled: async () =>
      statusSchema.parse(await currentClient().diagnostics.clientErrorStatus())
        .enabled,
    send: async (report) => {
      const bridge =
        typeof window === "undefined" ? undefined : window.armadra?.diagnostics;
      if (bridge !== undefined) {
        await bridge.report(report);
        return;
      }
      await currentClient().diagnostics.reportClientError({ ...report });
    },
  };
}

/** 从一个抛出的值得到要报的那一条；不是 `Error` 的值只留类型名。 */
export function reportFrom(
  kind: PageErrorReport["kind"],
  thrown: unknown,
): PageErrorReport | null {
  if (thrown instanceof Error) {
    return {
      kind,
      name: thrown.name || "Error",
      message: thrown.message,
      stack: typeof thrown.stack === "string" ? thrown.stack : "",
    };
  }
  if (thrown === undefined || thrown === null) return null;
  // 一个被 reject 的普通值可能就是一段文件正文或终端输出：不发内容，只发类型。
  return {
    kind,
    name: "NonError",
    message: `non-error ${typeof thrown}`,
    stack: "",
  };
}

export interface PageErrorReporterOptions {
  readonly transport?: PageErrorTransport;
  readonly now?: () => number;
  readonly target?: Pick<Window, "addEventListener" | "removeEventListener">;
}

export interface PageErrorReporter {
  /** 交一条；返回这条有没有真的发出去（测试用）。 */
  capture(kind: PageErrorReport["kind"], thrown: unknown): Promise<boolean>;
  /** 丢掉 `enabled` 的缓存：设置页刚改了开关。 */
  refresh(): void;
  stop(): void;
}

export function createPageErrorReporter(
  options: PageErrorReporterOptions = {},
): PageErrorReporter {
  const transport = options.transport ?? defaultTransport();
  const now = options.now ?? Date.now;
  let cached: { value: boolean; atMs: number } | undefined;
  let pending: Promise<boolean> | undefined;
  const sent: number[] = [];
  let busy = false;

  const enabled = (): Promise<boolean> => {
    if (cached !== undefined && now() - cached.atMs < ENABLED_TTL_MS) {
      return Promise.resolve(cached.value);
    }
    pending ??= transport
      .enabled()
      .catch(() => false)
      .then((value) => {
        cached = { value, atMs: now() };
        pending = undefined;
        return value;
      });
    return pending;
  };

  const capture = async (
    kind: PageErrorReport["kind"],
    thrown: unknown,
  ): Promise<boolean> => {
    // 上报自己引起的错误不再上报。
    if (busy) return false;
    try {
      const report = reportFrom(kind, thrown);
      if (report === null) return false;
      if (!(await enabled())) return false;
      const at = now();
      while (sent.length > 0 && at - (sent[0] as number) >= 60_000) {
        sent.shift();
      }
      if (sent.length >= PAGE_ERRORS_PER_MINUTE) return false;
      sent.push(at);
      busy = true;
      try {
        await transport.send(scrubReport(report));
      } finally {
        busy = false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const onError = (event: Event): void => {
    const error = (event as ErrorEvent).error;
    // 跨源脚本的 `Script error.` 没有 `error`，资源加载失败也没有：都不报。
    if (error === undefined || error === null) return;
    void capture("error", error);
  };
  const onRejection = (event: Event): void => {
    void capture("rejection", (event as PromiseRejectionEvent).reason);
  };

  const target =
    options.target ?? (typeof window === "undefined" ? undefined : window);
  target?.addEventListener("error", onError);
  target?.addEventListener("unhandledrejection", onRejection);

  return {
    capture,
    refresh: () => {
      cached = undefined;
    },
    stop: () => {
      target?.removeEventListener("error", onError);
      target?.removeEventListener("unhandledrejection", onRejection);
    },
  };
}

let installed: PageErrorReporter | undefined;

/** 页面入口调一次；重复调用不重复挂。 */
export function installPageErrorReporting(): PageErrorReporter {
  installed ??= createPageErrorReporter();
  return installed;
}

/** 设置页改了「包含页面错误」：下一条错误重新问一次 core。 */
export function refreshPageErrorReporting(): void {
  installed?.refresh();
}
