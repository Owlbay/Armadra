import { describe, expect, it, vi } from "vitest";

import type { PageErrorReport } from "./crash-scrub";
import {
  ENABLED_TTL_MS,
  PAGE_ERRORS_PER_MINUTE,
  createPageErrorReporter,
  reportFrom,
} from "./report";

/** 页面错误上报（契约 §30）：关着不收、开着剥离后发、每分钟 5 条、不自我递归。 */

function harness(enabled = true) {
  const state = { enabled, now: 0, sent: [] as PageErrorReport[], asks: 0 };
  const target = new EventTarget();
  const reporter = createPageErrorReporter({
    now: () => state.now,
    target: target as unknown as Window,
    transport: {
      enabled: async () => {
        state.asks += 1;
        return state.enabled;
      },
      send: async (report) => {
        state.sent.push(report);
      },
    },
  });
  return { state, reporter, target };
}

describe("页面错误上报", () => {
  it("关着：一条也不发", async () => {
    const { state, reporter } = harness(false);
    expect(await reporter.capture("error", new Error("x"))).toBe(false);
    expect(state.sent).toEqual([]);
  });

  it("开着：剥离后发；`enabled` 缓存一分钟，refresh 丢掉缓存", async () => {
    const { state, reporter } = harness();
    const error = new TypeError("open /Users/alice/x failed token=abc123");
    error.stack =
      "TypeError: boom\n    at f (http://127.0.0.1:5173/assets/a.js?t=1:1:2)";
    expect(await reporter.capture("error", error)).toBe(true);
    expect(state.sent[0]).toEqual({
      kind: "error",
      name: "TypeError",
      message: "open /Users/~/x failed token=[redacted]",
      stack: "TypeError: boom\n    at f (a.js:1:2)",
    });
    await reporter.capture("error", new Error("y"));
    expect(state.asks).toBe(1);
    state.now += ENABLED_TTL_MS;
    state.enabled = false;
    expect(await reporter.capture("error", new Error("z"))).toBe(false);
    expect(state.asks).toBe(2);
    state.enabled = true;
    reporter.refresh();
    expect(await reporter.capture("error", new Error("w"))).toBe(true);
  });

  it("每分钟最多 5 条", async () => {
    const { state, reporter } = harness();
    for (let i = 0; i < PAGE_ERRORS_PER_MINUTE + 3; i += 1) {
      await reporter.capture("error", new Error(`e${i}`));
    }
    expect(state.sent).toHaveLength(PAGE_ERRORS_PER_MINUTE);
    state.now += 60_000;
    reporter.refresh();
    expect(await reporter.capture("error", new Error("later"))).toBe(true);
  });

  it("问不到 core 当作关", async () => {
    const send = vi.fn();
    const reporter = createPageErrorReporter({
      target: new EventTarget() as unknown as Window,
      transport: {
        enabled: () => Promise.reject(new Error("401")),
        send,
      },
    });
    expect(await reporter.capture("error", new Error("x"))).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("发送失败不抛、不再报自己", async () => {
    let calls = 0;
    const reporter = createPageErrorReporter({
      target: new EventTarget() as unknown as Window,
      transport: {
        enabled: async () => true,
        send: async () => {
          calls += 1;
          throw new Error("network");
        },
      },
    });
    expect(await reporter.capture("error", new Error("x"))).toBe(false);
    expect(calls).toBe(1);
  });

  it("非 Error 的 reject 只发类型，不发内容", () => {
    expect(reportFrom("rejection", "$ cat ~/.ssh/id_ed25519")).toEqual({
      kind: "rejection",
      name: "NonError",
      message: "non-error string",
      stack: "",
    });
    expect(reportFrom("rejection", undefined)).toBe(null);
  });

  it("挂在 error / unhandledrejection 上；没有 error 对象的不报；stop 后不再收", async () => {
    const { state, reporter, target } = harness();
    const errorEvent = new Event("error") as Event & { error?: unknown };
    errorEvent.error = new Error("from window");
    target.dispatchEvent(errorEvent);
    target.dispatchEvent(new Event("error"));
    const rejection = new Event("unhandledrejection") as Event & {
      reason?: unknown;
    };
    rejection.reason = new Error("from promise");
    target.dispatchEvent(rejection);
    await vi.waitFor(() => expect(state.sent).toHaveLength(2));
    expect(state.sent.map((report) => report.kind).sort()).toEqual([
      "error",
      "rejection",
    ]);
    reporter.stop();
    target.dispatchEvent(errorEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.sent).toHaveLength(2);
  });
});
