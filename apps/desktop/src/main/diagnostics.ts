import type { ChildProcess } from "node:child_process";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import {
  ClientReports,
  type ClientReportOutcome,
} from "../core/diagnostics/client-report";
import {
  CRASH_REPORT_ENV,
  type ErrorSource,
  type ScrubContext,
  dsnFromSettings,
  dsnHost,
  errorFromMessage,
  isCrashReportMessage,
  pageErrorsFromSettings,
  scrubBreadcrumb,
  scrubContext,
  scrubEvent,
} from "../core/diagnostics/crash";

/**
 * 桌面壳的可选崩溃上报（外部服务 §11.2）。
 *
 * 只在「设置 → 通用 → 诊断」里打开并填了 DSN（`diagnostics.crashReportDsn`）时
 * 初始化 `@sentry/electron/main`；DSN 为空、不合格或读不出来就什么都不加载、什么
 * 都不发。设置文档由 core 写，这里每 5 秒看一眼它有没有变：关掉立刻停发，打开
 * 不必重启。
 *
 * 发的只有 JS 错误：主进程自己没人接住的异常，加上 core 子进程经 fork 的 IPC
 * 交来的那些（core 那边已剥离一遍）。**不启用 minidump**——Crashpad 的转储含进
 * 程环境，可能带各 CLI 的 API key；不开会话追踪、不开性能追踪、不注入渲染进程、
 * 不开 Sentry 的渲染进程 IPC；每条事件与面包屑发出前再过一遍 `beforeSend` 剥离。
 *
 * 页面的 JS 错误（G5-19，契约 §30）不靠 SDK 的渲染进程集成：页面在
 * `diagnostics.reportPageErrors` 打开时自己收、自己剥离，经 IPC
 * `diagnostics:report` 交到 {@link Diagnostics.reportPage}；这里按设置再判一次、
 * 限流、用本机的家目录与环境变量再剥一遍，才交给 SDK。
 */

/** 用到的那一小块 SDK，测试注入假的。 */
export interface SentryLike {
  init(options: Record<string, unknown>): void;
  captureException(error: unknown, hint?: Record<string, unknown>): unknown;
  close(timeout?: number): PromiseLike<boolean>;
  linkedErrorsIntegration(): unknown;
  dedupeIntegration(): unknown;
  electronContextIntegration(): unknown;
  normalizePathsIntegration(): unknown;
  electronBreadcrumbsIntegration(): unknown;
}

/** 编译期核对：真 SDK 满足上面这块形状（只取类型，运行时不加载）。 */
const sdkMatches: typeof import("@sentry/electron/main") extends SentryLike
  ? true
  : false = true;
void sdkMatches;

export interface DiagnosticsOptions {
  readonly dataDir: string;
  readonly release: string;
  readonly environment: "production" | "development";
  /** 缺省按需 `require("@sentry/electron/main")`：关着时 SDK 一行都不加载。 */
  readonly loadSdk?: () => SentryLike;
  /** 缺省读 `<数据目录>/settings.json`。 */
  readonly readSettings?: () => string | null;
  readonly scrub?: ScrubContext;
  /** 缺省 `watchFile`；测试传 `false` 关掉轮询。 */
  readonly watch?: boolean;
  readonly log?: (line: string) => void;
}

export interface Diagnostics {
  /** 现在发往哪个 DSN；关着是 `null`。 */
  active(): string | null;
  /** 重读设置，按需初始化或关掉。 */
  refresh(): Promise<void>;
  /** spawn core 时加进它环境里的变量。 */
  environment(): Record<string, string>;
  /** 在刚 spawn 的 core 上接它交来的错误。 */
  attach(child: Pick<ChildProcess, "on">): void;
  /** 报一个主进程里的错误；关着时什么都不做。 */
  capture(error: unknown, source: ErrorSource): void;
  /**
   * 页面经 `diagnostics:report` 交来的一条（契约 §30）。没打开页面错误上报或
   * 崩溃上报关着答 `{ accepted: false }`；形状不对、超限也只答 `false`。
   */
  reportPage(report: unknown): { accepted: boolean };
  stop(): Promise<void>;
}

/** 选进来的集成：没有 minidump、会话、网络、控制台、子进程、截图、渲染进程注入。 */
export function integrations(sdk: SentryLike): unknown[] {
  return [
    sdk.linkedErrorsIntegration(),
    sdk.dedupeIntegration(),
    sdk.electronContextIntegration(),
    sdk.normalizePathsIntegration(),
    sdk.electronBreadcrumbsIntegration(),
  ];
}

/**
 * `init` 的选项。导出给单测：开关、剥离钩子与「不开」的那几样都钉在这里。
 */
export function sentryOptions(
  sdk: SentryLike,
  dsn: string,
  options: Pick<DiagnosticsOptions, "release" | "environment">,
  scrub: ScrubContext,
  stillActive: (dsn: string) => boolean,
): Record<string, unknown> {
  return {
    dsn,
    release: `armadra@${options.release}`,
    environment: options.environment,
    defaultIntegrations: false,
    integrations: integrations(sdk),
    // 0 = 既不注册 IPC 通道也不注册 `sentry-ipc://` 协议：页面不装 SDK，
    // 别的 webContents（浏览器节点）也就没有一条能往这里塞事件的路。
    ipcMode: 0,
    autoSessionTracking: false,
    sendDefaultPii: false,
    sendClientReports: false,
    attachStacktrace: false,
    includeServerName: false,
    maxBreadcrumbs: 50,
    skipOpenTelemetrySetup: true,
    beforeSend: (event: object) =>
      stillActive(dsn) ? scrubEvent(event, scrub) : null,
    beforeSendTransaction: () => null,
    beforeBreadcrumb: (crumb: object) => scrubBreadcrumb(crumb, scrub),
  };
}

const POLL_MS = 5_000;

export function installDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const settingsPath = join(options.dataDir, "settings.json");
  const readSettings =
    options.readSettings ??
    (() => {
      try {
        return readFileSync(settingsPath, "utf8");
      } catch {
        return null;
      }
    });
  const log =
    options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const scrub = options.scrub ?? scrubContext();
  const loadSdk =
    options.loadSdk ??
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (() => require("@sentry/electron/main") as SentryLike);

  let sdk: SentryLike | undefined;
  let active: string | null = null;
  let configured: string | null = null;
  let pageErrors = false;
  let applying: Promise<void> = Promise.resolve();

  const read = (): string | null => {
    const text = readSettings();
    pageErrors = pageErrorsFromSettings(text);
    return dsnFromSettings(text);
  };

  const pages = new ClientReports({
    enabled: () => pageErrors && active !== null && sdk !== undefined,
    report: (error) => {
      sdk?.captureException(error, {
        tags: { shell: "desktop", process: "renderer", source: "page" },
      });
    },
    scrub: () => scrub,
  });

  const apply = async (wanted: string | null): Promise<void> => {
    configured = wanted;
    if (wanted === active) return;
    if (active !== null && sdk !== undefined) {
      const previous = active;
      active = null;
      await sdk.close(2_000);
      log(`crash reporting off (${dsnHost(previous)})`);
    }
    if (wanted === null) return;
    try {
      sdk ??= loadSdk();
      sdk.init(
        sentryOptions(sdk, wanted, options, scrub, (dsn) => configured === dsn),
      );
      active = wanted;
      log(`crash reporting on (${dsnHost(wanted)})`);
    } catch (error) {
      log(
        `crash reporting unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const refresh = (): Promise<void> => {
    applying = applying.then(() => apply(read()));
    return applying;
  };

  // 主进程自己没人接住的异常。monitor 不改变 Electron 的缺省处理（弹框、照旧
  // 运行），只是看一眼。
  const onUncaught = (error: unknown): void => capture(error, "uncaught");
  process.on("uncaughtExceptionMonitor", onUncaught);

  const capture = (error: unknown, source: ErrorSource): void => {
    if (active === null || sdk === undefined) return;
    try {
      sdk.captureException(error, {
        tags: { shell: "desktop", process: "main", source },
      });
    } catch {
      // 上报自己失败不能再抛。
    }
  };

  void refresh();
  const watching = options.watch !== false;
  if (watching) {
    watchFile(settingsPath, { interval: POLL_MS, persistent: false }, () => {
      void refresh();
    });
  }

  return {
    active: () => active,
    refresh,
    environment: () => ({ [CRASH_REPORT_ENV]: "1" }),
    attach(child) {
      child.on("message", (message: unknown) => {
        if (!isCrashReportMessage(message)) return;
        if (active === null || sdk === undefined) return;
        try {
          sdk.captureException(errorFromMessage(message), {
            tags: { shell: "desktop", process: "core", source: message.source },
          });
        } catch {
          // 同上。
        }
      });
    },
    capture,
    reportPage(report) {
      const outcome: ClientReportOutcome = pages.accept("renderer", report);
      return { accepted: outcome.kind === "accepted" };
    },
    async stop() {
      process.off("uncaughtExceptionMonitor", onUncaught);
      if (watching) unwatchFile(settingsPath);
      await applying;
      await apply(null);
    },
  };
}
