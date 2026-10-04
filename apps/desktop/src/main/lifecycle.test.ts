import { describe, expect, it } from "vitest";
import {
  DesktopLifecycle,
  quitFailureDialog,
  runQuitSequence,
  sessionHostRelease,
} from "./lifecycle";
import type { RuntimeProcess } from "./runtime-process";

/**
 * 退出这一段：core 确认停了才退出，没确认就不退。
 */

/** 一个 core 的替身：记下别人要求了什么，并按吩咐回答。 */
function fakeRuntime(
  behaviour: "ok" | "fail",
): RuntimeProcess & { stopped: number } {
  let stopped = 0;
  return {
    get stopped() {
      return stopped;
    },
    async stop() {
      stopped += 1;
      if (behaviour === "fail")
        throw new Error("Core failed to stop all managed sessions");
    },
  } as unknown as RuntimeProcess & { stopped: number };
}

describe("退出这一段", () => {
  it("core 停下来之后才允许退出", async () => {
    const lifecycle = new DesktopLifecycle();
    const runtime = fakeRuntime("ok");
    lifecycle.state.beginQuit();
    expect(await runQuitSequence(lifecycle, runtime)).toEqual({ ok: true });
    expect(runtime.stopped).toBe(1);
    expect(lifecycle.state.canExit()).toBe(true);
  });

  it("core 没确认就不退出，窗口回来并说出原因", async () => {
    const lifecycle = new DesktopLifecycle();
    const runtime = fakeRuntime("fail");
    lifecycle.state.beginQuit();
    const outcome = await runQuitSequence(lifecycle, runtime);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/managed sessions/);
    // 应用还开着，还能用。
    expect(lifecycle.state.canExit()).toBe(false);
    expect(lifecycle.state.isQuitting()).toBe(false);
    expect(lifecycle.state.reveal()).toBe(true);
    expect(runtime.stopped).toBe(1);
  });
});

describe("the failure dialog", () => {
  it("says the application has not exited, and why", () => {
    const text = quitFailureDialog("Core is still running");
    expect(text.title).toBe("Armadra 退出未完成");
    expect(text.body).toContain("应用尚未退出");
    expect(text.body).toContain("Core is still running");
  });
});

describe("the session host on quit (Windows)", () => {
  it("asks the host to leave after the core has stopped", async () => {
    const lifecycle = new DesktopLifecycle();
    const runtime = fakeRuntime("ok");
    const order: string[] = [];
    lifecycle.state.beginQuit();
    const outcome = await runQuitSequence(lifecycle, runtime, async () => {
      order.push(`release after ${runtime.stopped} stop`);
    });
    expect(outcome).toEqual({ ok: true });
    expect(order).toEqual(["release after 1 stop"]);
  });

  it("still quits when asking the host fails", async () => {
    const lifecycle = new DesktopLifecycle();
    lifecycle.state.beginQuit();
    const outcome = await runQuitSequence(
      lifecycle,
      fakeRuntime("ok"),
      async () => {
        throw new Error("pipe gone");
      },
    );
    expect(outcome).toEqual({ ok: true });
    expect(lifecycle.state.canExit()).toBe(true);
  });

  it("does not ask when the core did not stop", async () => {
    const lifecycle = new DesktopLifecycle();
    lifecycle.state.beginQuit();
    let asked = 0;
    await runQuitSequence(lifecycle, fakeRuntime("fail"), async () => {
      asked += 1;
    });
    expect(asked).toBe(0);
  });

  it("is a Windows-only step that names this data directory", async () => {
    expect(sessionHostRelease("/data", "darwin")).toBeUndefined();
    expect(sessionHostRelease("/data", "linux")).toBeUndefined();
    const asked: unknown[] = [];
    const release = sessionHostRelease("C:\\data", "win32", async (request) => {
      asked.push(request);
      return { kind: "absent", reason: "no key" };
    });
    await release?.();
    expect(asked).toEqual([
      { dataDir: "C:\\data", client: "armadra-shell", timeoutMs: 3_000 },
    ]);
  });
});
