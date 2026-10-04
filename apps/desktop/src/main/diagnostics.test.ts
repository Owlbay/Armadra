import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  CRASH_REPORT_ENV,
  crashReportMessage,
  scrubContext,
} from "../core/diagnostics/crash";
import { type SentryLike, installDiagnostics } from "./diagnostics";

const DSN = "http://publickey@127.0.0.1:8000/1";
const SECRET = "sk-test-0123456789abcdefXYZ";
const scrub = scrubContext(
  { HOME: "/Users/alice", API_KEY: SECRET },
  "/Users/alice",
);

function fakeSdk() {
  const calls = {
    init: [] as Record<string, unknown>[],
    captured: [] as [unknown, Record<string, unknown> | undefined][],
    closed: 0,
  };
  const sdk: SentryLike = {
    init: (options) => void calls.init.push(options),
    captureException: (error, hint) => void calls.captured.push([error, hint]),
    close: async () => {
      calls.closed += 1;
      return true;
    },
    linkedErrorsIntegration: () => ({ name: "LinkedErrors" }),
    dedupeIntegration: () => ({ name: "Dedupe" }),
    electronContextIntegration: () => ({ name: "ElectronContext" }),
    normalizePathsIntegration: () => ({ name: "NormalizePaths" }),
    electronBreadcrumbsIntegration: () => ({ name: "ElectronBreadcrumbs" }),
  };
  return { sdk, calls };
}

function settings(dsn: string): string {
  return JSON.stringify({ diagnostics: { crashReportDsn: dsn } });
}

function install(document: { text: string }, sdk: SentryLike) {
  const loadSdk = vi.fn(() => sdk);
  const diagnostics = installDiagnostics({
    dataDir: "/nonexistent",
    release: "0.1.0",
    environment: "production",
    loadSdk,
    readSettings: () => document.text,
    scrub,
    watch: false,
    log: () => {},
  });
  return { diagnostics, loadSdk };
}

describe("桌面壳崩溃上报", () => {
  it("关着（缺省）：不加载 SDK、不初始化、core 交来的错误也不发", async () => {
    const { sdk, calls } = fakeSdk();
    const { diagnostics, loadSdk } = install({ text: "{}" }, sdk);
    await diagnostics.refresh();
    expect(diagnostics.active()).toBe(null);
    expect(loadSdk).not.toHaveBeenCalled();
    const child = new EventEmitter();
    diagnostics.attach(child as never);
    child.emit("message", crashReportMessage(new Error("x"), "http", scrub));
    diagnostics.capture(new Error("y"), "uncaught");
    expect(calls.init).toEqual([]);
    expect(calls.captured).toEqual([]);
    // core 照样拿到通道变量：发不发由壳在收到时决定。
    expect(diagnostics.environment()).toEqual({ [CRASH_REPORT_ENV]: "1" });
    await diagnostics.stop();
  });

  it("不合格的 DSN 当作没配置", async () => {
    const { sdk } = fakeSdk();
    const { diagnostics, loadSdk } = install(
      { text: settings("https://no-key-host/1") },
      sdk,
    );
    await diagnostics.refresh();
    expect(diagnostics.active()).toBe(null);
    expect(loadSdk).not.toHaveBeenCalled();
    await diagnostics.stop();
  });

  it("打开：只选进来无 minidump / 会话 / 网络的集成，beforeSend 剥离", async () => {
    const { sdk, calls } = fakeSdk();
    const { diagnostics } = install({ text: settings(DSN) }, sdk);
    await diagnostics.refresh();
    expect(diagnostics.active()).toBe(DSN);
    expect(calls.init).toHaveLength(1);
    const options = calls.init[0]!;
    expect(options).toMatchObject({
      dsn: DSN,
      defaultIntegrations: false,
      ipcMode: 0,
      autoSessionTracking: false,
      sendDefaultPii: false,
      skipOpenTelemetrySetup: true,
    });
    const names = (options.integrations as { name: string }[]).map(
      (integration) => integration.name,
    );
    expect(names).toEqual([
      "LinkedErrors",
      "Dedupe",
      "ElectronContext",
      "NormalizePaths",
      "ElectronBreadcrumbs",
    ]);
    for (const banned of [
      "SentryMinidump",
      "ElectronMinidump",
      "MainProcessSession",
      "ElectronNet",
      "Console",
      "ChildProcess",
    ]) {
      expect(names).not.toContain(banned);
    }
    const beforeSend = options.beforeSend as (event: object) => object | null;
    const sent = beforeSend({
      user: { id: "u" },
      extra: { a: 1 },
      contexts: { process: { env: { API_KEY: SECRET } } },
      exception: { values: [{ value: `bad ${SECRET} /Users/alice/x` }] },
    });
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(JSON.stringify(sent)).not.toContain("alice");
    expect(sent).not.toHaveProperty("user");
    expect(sent).not.toHaveProperty("extra");
    expect((options.beforeSendTransaction as () => unknown)()).toBe(null);
    await diagnostics.stop();
  });

  it("core 交来的错误带上来源发出去；不认识的消息不理", async () => {
    const { sdk, calls } = fakeSdk();
    const { diagnostics } = install({ text: settings(DSN) }, sdk);
    await diagnostics.refresh();
    const child = new EventEmitter();
    diagnostics.attach(child as never);
    child.emit("message", { type: "armadra.secrets", id: 1 });
    child.emit(
      "message",
      crashReportMessage(new RangeError("too far"), "http", scrub),
    );
    expect(calls.captured).toHaveLength(1);
    const [error, hint] = calls.captured[0]!;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("RangeError");
    expect(hint).toEqual({
      tags: { shell: "desktop", process: "core", source: "http" },
    });
    await diagnostics.stop();
  });

  it("关掉立即停发：DSN 清空后 close，beforeSend 也丢掉排队中的事件", async () => {
    const { sdk, calls } = fakeSdk();
    const document = { text: settings(DSN) };
    const { diagnostics } = install(document, sdk);
    await diagnostics.refresh();
    const beforeSend = calls.init[0]!.beforeSend as (e: object) => unknown;
    document.text = settings("");
    await diagnostics.refresh();
    expect(diagnostics.active()).toBe(null);
    expect(calls.closed).toBe(1);
    expect(beforeSend({ message: "late" })).toBe(null);
    diagnostics.capture(new Error("after"), "uncaught");
    expect(calls.captured).toEqual([]);
    // 再打开不用重启。
    document.text = settings(DSN);
    await diagnostics.refresh();
    expect(diagnostics.active()).toBe(DSN);
    expect(calls.init).toHaveLength(2);
    await diagnostics.stop();
  });
});

describe("页面错误（契约 §30）", () => {
  const page = {
    kind: "error",
    name: "TypeError",
    message: `boom ${SECRET} at /Users/alice/proj`,
    stack:
      "TypeError: boom\n    at render (http://127.0.0.1:5173/assets/index-abc.js?v=1:1:2)",
  };
  const withPages = (on: boolean) =>
    JSON.stringify({
      diagnostics: { crashReportDsn: DSN, reportPageErrors: on },
    });

  it("没打开页面错误：不发", async () => {
    const { sdk, calls } = fakeSdk();
    const { diagnostics } = install({ text: withPages(false) }, sdk);
    await diagnostics.refresh();
    expect(diagnostics.reportPage(page)).toEqual({ accepted: false });
    expect(calls.captured).toEqual([]);
    await diagnostics.stop();
  });

  it("打开了但 DSN 没配：不发、不加载 SDK", async () => {
    const { sdk, calls } = fakeSdk();
    const { diagnostics, loadSdk } = install(
      { text: JSON.stringify({ diagnostics: { reportPageErrors: true } }) },
      sdk,
    );
    await diagnostics.refresh();
    expect(diagnostics.reportPage(page)).toEqual({ accepted: false });
    expect(loadSdk).not.toHaveBeenCalled();
    expect(calls.captured).toEqual([]);
    await diagnostics.stop();
  });

  it("打开：再剥离一次、栈只留文件名、标签 renderer / page、每分钟 5 条", async () => {
    const { sdk, calls } = fakeSdk();
    const document = { text: withPages(true) };
    const { diagnostics } = install(document, sdk);
    await diagnostics.refresh();
    expect(diagnostics.reportPage(page)).toEqual({ accepted: true });
    const [error, hint] = calls.captured[0] as [Error, Record<string, unknown>];
    expect(error.message).toBe("boom [env] at ~/proj");
    expect(error.stack).toContain("at render (index-abc.js:1:2)");
    expect(error.stack).not.toContain("127.0.0.1");
    expect(hint).toEqual({
      tags: { shell: "desktop", process: "renderer", source: "page" },
    });
    for (let i = 0; i < 4; i += 1) diagnostics.reportPage(page);
    expect(diagnostics.reportPage(page)).toEqual({ accepted: false });
    expect(calls.captured).toHaveLength(5);
    // 不认识的形状只答 false，不抛。
    expect(diagnostics.reportPage({ kind: "x" })).toEqual({ accepted: false });
    // 关掉立即停收。
    document.text = withPages(false);
    await diagnostics.refresh();
    expect(diagnostics.reportPage(page)).toEqual({ accepted: false });
    await diagnostics.stop();
  });
});
