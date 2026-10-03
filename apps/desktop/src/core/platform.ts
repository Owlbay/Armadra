import { execFile } from "node:child_process";

import {
  CRASH_REPORT_ENV,
  type ErrorSource,
  crashReportMessage,
  scrubContext,
  scrubText,
} from "./diagnostics/crash";
import type { SecretBackend } from "./secrets/backend";

/**
 * The one seam between the core and whichever shell assembled it.
 *
 * The core is a service: everything a caller wants from it goes over HTTP or
 * WebSocket. What is left is the handful of things only a shell knows — where
 * its user data lives, whether it is packaged, where its resources are, how to
 * hand a URL to the desktop, how to raise a notification — and those arrive
 * here rather than through an `import "electron"`, which the core is forbidden
 * to write at all (`shell-core/no-electron.test.ts` scans `src/core/**`).
 *
 * Keeping it this narrow is what lets the same core run under a windowless
 * server shell later.
 */
export interface CorePlatform {
  /** The data directory this core was told to use. Already resolved. */
  readonly dataDir: string;
  /** The product version reported on `/health`. */
  readonly appVersion: string;
  /** Whether the assembling shell is a packaged application. */
  readonly isPackaged: boolean;
  /** Where a packaged shell staged read-only files. Absent in development. */
  readonly resourcesPath?: string | undefined;
  /** Three levels, filtered by `ARMADRA_LOG`. */
  readonly log: CoreLog;
  /**
   * 壳给的密钥后端（服务器壳：master key 封装的 `file-encrypted`）。不给时 core
   * 按 `core/secrets` 的表自己挑：桌面壳的 `safeStorage` 经 fork 的 IPC 通道、
   * macOS 钥匙串、或 0600 文件。
   */
  readonly secrets?: SecretBackend | undefined;
  /**
   * 哪一种壳装配了这个 core。缺省是桌面壳。服务器壳的 Gateway 由命令行参数
   * 打开（`apps/server` 的 `serve`），设置 `gateway.*` 不驱动它。
   */
  readonly shell?: "desktop" | "server";
  /** Hands a URL to the desktop. A server shell has nowhere to open one. */
  openExternal(url: string): Promise<void>;
  /**
   * One-way to the shell: tray notifications and update prompts. Never a
   * request — the core does not wait for a shell to answer.
   */
  notify(channel: string, payload: unknown): void;
  /**
   * 一个没人接住的错误（外部服务 §11.2）。壳注入：打开了崩溃上报的壳把它交给
   * Sentry 协议的 SDK（剥离之后）；没打开、或者壳没给，就只写本地日志——见
   * {@link reportError}。core 自己不 import 任何 SDK。
   */
  reportError?(error: unknown, context: ErrorContext): void;
}

/** 报错时带的上下文：只有来源，别的一概不带（路径、请求体都可能含用户数据）。 */
export interface ErrorContext {
  readonly source: ErrorSource;
}

/**
 * 报一个错误。壳给了 `reportError` 就交给它，否则写一行本地日志。日志里只有
 * 剥离过的错误名与消息。
 */
export function reportError(
  platform: Pick<CorePlatform, "log" | "reportError">,
  error: unknown,
  context: ErrorContext,
): void {
  try {
    if (platform.reportError !== undefined) {
      platform.reportError(error, context);
      return;
    }
    logError(platform.log, error, context);
  } catch {
    // 报错本身不能再抛：调用点多半在 catch 里或进程退出的路上。
  }
}

export function logError(
  log: CoreLog,
  error: unknown,
  context: ErrorContext,
): void {
  const scrub = scrubContext();
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  log.error("unhandled error", {
    source: context.source,
    error: `${name}: ${scrubText(message, scrub)}`,
  });
}

export interface CoreLog {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

/**
 * `ARMADRA_LOG` names the lowest level that is printed. The Rust `RUST_LOG`
 * grammar is deliberately not reproduced: one level is what anybody ever set.
 * An unrecognised value falls back to `info` rather than silencing the log.
 */
export function logLevel(configured: string | undefined): LogLevel {
  const wanted = configured?.trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(wanted ?? "")
    ? (wanted as LogLevel)
    : "info";
}

/**
 * Lines on stderr, so stdout stays the announcement channel the shell parses.
 */
export function createLog(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(line),
): CoreLog {
  const threshold = LEVELS.indexOf(level);
  const emit = (
    at: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    if (LEVELS.indexOf(at) < threshold) return;
    const suffix = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
    write(
      `${new Date().toISOString()} ${at.toUpperCase()} ${message}${suffix}\n`,
    );
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

/**
 * The platform a core running as its own process assembles for itself: no
 * shell to ask, so `openExternal` shells out and `notify` only logs.
 *
 * An Electron shell replaces both with the real thing when it hosts the core
 * in-process; the fields above are the whole contract it has to satisfy.
 */
export function nodePlatform(options: {
  dataDir: string;
  appVersion: string;
  isPackaged?: boolean;
  resourcesPath?: string | undefined;
  log?: CoreLog;
}): CorePlatform {
  const log = options.log ?? createLog(logLevel(process.env.ARMADRA_LOG));
  return {
    dataDir: options.dataDir,
    appVersion: options.appVersion,
    isPackaged: options.isPackaged ?? false,
    resourcesPath: options.resourcesPath,
    log,
    openExternal: (url) => openExternal(url),
    notify: (channel, payload) => log.debug("notify", { channel, payload }),
    reportError: (error, context) => {
      logError(log, error, context);
      forwardToShell(error, context);
    },
  };
}

/**
 * 桌面壳 spawn 的 core：壳设了 {@link CRASH_REPORT_ENV}，错误剥离后经 fork 的
 * IPC 交给壳（壳决定发不发——开关与 DSN 只在壳那边读）。不是被这样起的 core
 * 什么都不发。
 */
function forwardToShell(error: unknown, context: ErrorContext): void {
  if (process.env[CRASH_REPORT_ENV] !== "1") return;
  if (typeof process.send !== "function" || !process.connected) return;
  process.send(crashReportMessage(error, context.source, scrubContext()));
}

/**
 * Only `http(s)` and `mailto`, and only through the platform opener with the
 * URL as a separate argument — a string handed to a shell would let a crafted
 * link run a command.
 */
function openExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new Error(`not a URL: ${url}`));
  }
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
    return Promise.reject(new Error(`refusing to open ${parsed.protocol}`));
  }
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", ""]
        : ["xdg-open"];
  return new Promise((resolve, reject) => {
    execFile(command as string, [...args, parsed.toString()], (error) =>
      error ? reject(error) : resolve(),
    );
  });
}
