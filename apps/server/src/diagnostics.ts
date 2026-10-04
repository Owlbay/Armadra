import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import {
  type ScrubContext,
  dsnFromSettings,
  dsnHost,
  parseDsn,
  scrubBreadcrumb,
  scrubContext,
  scrubEvent,
} from "../../desktop/src/core/diagnostics/crash";
import {
  type CoreLog,
  type ErrorContext,
  logError,
} from "../../desktop/src/core/platform";

/**
 * 服务器壳的可选崩溃上报（外部服务 §11.2）。
 *
 * DSN 的来源：`ARMADRA_CRASH_REPORT_DSN`（服务器壳的配置键；设了就以它为准），
 * 否则设置文档的 `diagnostics.crashReportDsn`（管理员在「设置 → 通用」里填的）。
 * 两处都没有就不加载 `@sentry/node`、什么都不发。
 *
 * 只报 JS 错误：core 经 `platform.reportError` 交来的（请求处理里没人接住的、
 * 进程级没人接住的，以及页面经 `POST /api/diagnostics/client-error` 交来、
 * core 已剥离过的那些——来源标签 `page`，契约 §30）。不开性能追踪、不开 OpenTelemetry、不开会话、不带请求数据；
 * 每条事件发出前过 `beforeSend` 剥离。进程级的异常在照旧退出之前等最多两秒把
 * 事件送走。
 */

export const CRASH_REPORT_DSN_ENV = "ARMADRA_CRASH_REPORT_DSN";

/** 用到的那一小块 `@sentry/node`，测试注入假的。 */
export interface NodeSentryLike {
  init(options: Record<string, unknown>): void;
  captureException(error: unknown, hint?: Record<string, unknown>): unknown;
  flush(timeout?: number): PromiseLike<boolean>;
  close(timeout?: number): PromiseLike<boolean>;
  linkedErrorsIntegration(): unknown;
  dedupeIntegration(): unknown;
}

/** 编译期核对：真 SDK 满足上面这块形状（只取类型，运行时不加载）。 */
const sdkMatches: typeof import("@sentry/node") extends NodeSentryLike
  ? true
  : false = true;
void sdkMatches;

export interface ServerDiagnosticsOptions {
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly release: string;
  readonly log: CoreLog;
  readonly loadSdk?: () => NodeSentryLike;
  readonly readSettings?: () => string | null;
  readonly scrub?: ScrubContext;
  readonly watch?: boolean;
  /** 进程级异常送完事件之后怎么退出；测试替换。 */
  readonly exit?: (code: number) => void;
}

export interface ServerDiagnostics {
  active(): string | null;
  refresh(): Promise<void>;
  /** 给 `CorePlatform.reportError` 的那个函数。 */
  reportError(error: unknown, context: ErrorContext): void;
  stop(): Promise<void>;
}

/**
 * 这次该发往哪个 DSN。环境变量设了（非空）就只看它——不合格也不退回设置文档，
 * 免得运维以为关掉了其实还在发。
 */
export function crashReportDsn(
  env: NodeJS.ProcessEnv,
  settings: string | null,
): string | null {
  const fromEnv = env[CRASH_REPORT_DSN_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return parseDsn(fromEnv);
  return dsnFromSettings(settings);
}

export function nodeSentryOptions(
  sdk: NodeSentryLike,
  dsn: string,
  release: string,
  scrub: ScrubContext,
  stillActive: (dsn: string) => boolean,
): Record<string, unknown> {
  return {
    dsn,
    release: `armadra-server@${release}`,
    environment: "production",
    defaultIntegrations: false,
    integrations: [sdk.linkedErrorsIntegration(), sdk.dedupeIntegration()],
    skipOpenTelemetrySetup: true,
    autoSessionTracking: false,
    sendDefaultPii: false,
    sendClientReports: false,
    attachStacktrace: false,
    includeLocalVariables: false,
    includeServerName: false,
    maxBreadcrumbs: 50,
    beforeSend: (event: object) =>
      stillActive(dsn) ? scrubEvent(event, scrub) : null,
    beforeSendTransaction: () => null,
    beforeBreadcrumb: (crumb: object) => scrubBreadcrumb(crumb, scrub),
  };
}

const POLL_MS = 5_000;
const FLUSH_MS = 2_000;

export function installServerDiagnostics(
  options: ServerDiagnosticsOptions,
): ServerDiagnostics {
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
  const scrub = options.scrub ?? scrubContext(options.env);
  const loadSdk =
    options.loadSdk ??
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (() => require("@sentry/node") as NodeSentryLike);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const { log } = options;

  let sdk: NodeSentryLike | undefined;
  let active: string | null = null;
  let configured: string | null = null;
  let applying: Promise<void> = Promise.resolve();

  /**
   * 只在打开时挂：core 的 `uncaughtExceptionMonitor` 已经把错误交进 SDK，这里
   * 等它送出去，再照 Node 的缺省行为打印并以 1 退出。
   */
  const onFatal = (error: unknown): void => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    const done = (): void => exit(1);
    if (sdk === undefined) return done();
    Promise.resolve(sdk.flush(FLUSH_MS)).then(done, done);
  };

  const apply = async (wanted: string | null): Promise<void> => {
    configured = wanted;
    if (wanted === active) return;
    if (active !== null && sdk !== undefined) {
      const previous = active;
      active = null;
      process.off("uncaughtException", onFatal);
      await sdk.close(FLUSH_MS);
      log.info("崩溃上报已关闭", { host: dsnHost(previous) });
    }
    if (wanted === null) return;
    try {
      sdk ??= loadSdk();
      sdk.init(
        nodeSentryOptions(
          sdk,
          wanted,
          options.release,
          scrub,
          (dsn) => configured === dsn,
        ),
      );
      active = wanted;
      process.on("uncaughtException", onFatal);
      log.info("崩溃上报已打开", { host: dsnHost(wanted) });
    } catch (error) {
      log.warn("崩溃上报不可用", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const refresh = (): Promise<void> => {
    applying = applying.then(() =>
      apply(crashReportDsn(options.env, readSettings())),
    );
    return applying;
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
    reportError(error, context) {
      logError(log, error, context);
      if (active === null || sdk === undefined) return;
      try {
        sdk.captureException(error, {
          tags: { shell: "server", source: context.source },
        });
      } catch {
        // 上报自己失败不能再抛。
      }
    },
    async stop() {
      if (watching) unwatchFile(settingsPath);
      await applying;
      await apply(null);
    },
  };
}
