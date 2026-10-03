import { describe, expect, it, vi } from "vitest";

import { scrubContext } from "../../desktop/src/core/diagnostics/crash";
import { createLog } from "../../desktop/src/core/platform";
import {
  CRASH_REPORT_DSN_ENV,
  type NodeSentryLike,
  crashReportDsn,
  installServerDiagnostics,
} from "./diagnostics";

const DSN = "http://publickey@127.0.0.1:8000/1";
const settings = (dsn: string) =>
  JSON.stringify({ diagnostics: { crashReportDsn: dsn } });

function fakeSdk() {
  const calls = {
    init: [] as Record<string, unknown>[],
    captured: [] as [unknown, Record<string, unknown> | undefined][],
    closed: 0,
  };
  const sdk: NodeSentryLike = {
    init: (options) => void calls.init.push(options),
    captureException: (error, hint) => void calls.captured.push([error, hint]),
    flush: async () => true,
    close: async () => {
      calls.closed += 1;
      return true;
    },
    linkedErrorsIntegration: () => ({ name: "LinkedErrors" }),
    dedupeIntegration: () => ({ name: "Dedupe" }),
  };
  return { sdk, calls };
}

function install(
  env: NodeJS.ProcessEnv,
  document: { text: string | null },
  sdk: NodeSentryLike,
) {
  const lines: string[] = [];
  const loadSdk = vi.fn(() => sdk);
  const diagnostics = installServerDiagnostics({
    dataDir: "/nonexistent",
    env,
    release: "0.1.0",
    log: createLog("debug", (line) => lines.push(line)),
    loadSdk,
    readSettings: () => document.text,
    scrub: scrubContext(env, "/Users/alice"),
    watch: false,
    exit: () => {},
  });
  return { diagnostics, loadSdk, lines };
}

describe("服务器壳的 DSN 来源", () => {
  it("环境变量优先，设了就只看它；没设时读设置文档", () => {
    expect(crashReportDsn({ [CRASH_REPORT_DSN_ENV]: DSN }, null)).toBe(DSN);
    expect(
      crashReportDsn({ [CRASH_REPORT_DSN_ENV]: "bad" }, settings(DSN)),
    ).toBe(null);
    expect(crashReportDsn({ [CRASH_REPORT_DSN_ENV]: " " }, settings(DSN))).toBe(
      DSN,
    );
    expect(crashReportDsn({}, settings(""))).toBe(null);
    expect(crashReportDsn({}, null)).toBe(null);
  });
});

describe("服务器壳崩溃上报", () => {
  it("关着：不加载 SDK，错误只进本地日志", async () => {
    const { sdk, calls } = fakeSdk();
    const { diagnostics, loadSdk, lines } = install({}, { text: null }, sdk);
    await diagnostics.refresh();
    diagnostics.reportError(new Error("boom /Users/alice/x"), {
      source: "http",
    });
    expect(loadSdk).not.toHaveBeenCalled();
    expect(calls.captured).toEqual([]);
    expect(lines.join("")).toContain("unhandled error");
    expect(lines.join("")).not.toContain("/Users/alice");
    await diagnostics.stop();
  });

  it("打开：最小集成、不开 OTel / 会话，带来源标签发出", async () => {
    const { sdk, calls } = fakeSdk();
    const { diagnostics } = install(
      { [CRASH_REPORT_DSN_ENV]: DSN },
      { text: null },
      sdk,
    );
    await diagnostics.refresh();
    expect(diagnostics.active()).toBe(DSN);
    expect(calls.init[0]).toMatchObject({
      dsn: DSN,
      defaultIntegrations: false,
      skipOpenTelemetrySetup: true,
      autoSessionTracking: false,
      sendDefaultPii: false,
      includeLocalVariables: false,
    });
    expect(
      (calls.init[0]!.integrations as { name: string }[]).map((i) => i.name),
    ).toEqual(["LinkedErrors", "Dedupe"]);
    const error = new Error("x");
    diagnostics.reportError(error, { source: "uncaught" });
    expect(calls.captured).toEqual([
      [error, { tags: { shell: "server", source: "uncaught" } }],
    ]);
    // 进程级异常的等待退出只在打开时挂着。
    expect(process.listenerCount("uncaughtException")).toBeGreaterThan(0);
    await diagnostics.stop();
    expect(calls.closed).toBe(1);
  });

  it("设置文档改成空即关，beforeSend 丢掉之后的事件", async () => {
    const { sdk, calls } = fakeSdk();
    const document = { text: settings(DSN) as string | null };
    const before = process.listenerCount("uncaughtException");
    const { diagnostics } = install({}, document, sdk);
    await diagnostics.refresh();
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
    const beforeSend = calls.init[0]!.beforeSend as (e: object) => unknown;
    expect(beforeSend({ user: { id: "1" }, message: "m" })).toEqual({
      message: "m",
    });
    document.text = settings("");
    await diagnostics.refresh();
    expect(diagnostics.active()).toBe(null);
    expect(process.listenerCount("uncaughtException")).toBe(before);
    expect(beforeSend({ message: "late" })).toBe(null);
    diagnostics.reportError(new Error("after"), { source: "http" });
    expect(calls.captured).toEqual([]);
    await diagnostics.stop();
  });
});
