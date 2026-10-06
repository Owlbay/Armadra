import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ value: true }));
vi.mock("../api/runtime-url", () => ({
  isNativeAppPage: () => native.value,
}));

import { resetNativeStatusBarForTest, syncNativeStatusBar } from "./status-bar";

describe("syncNativeStatusBar", () => {
  const setStyle = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    native.value = true;
    resetNativeStatusBarForTest();
    setStyle.mockClear();
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      Plugins: { SystemBars: { setStyle } },
    };
  });

  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it("深色主题配浅色状态栏文字，浅色主题配深色文字", () => {
    syncNativeStatusBar("dark");
    syncNativeStatusBar("light");
    expect(setStyle.mock.calls).toEqual([
      [{ style: "DARK", bar: "StatusBar" }],
      [{ style: "LIGHT", bar: "StatusBar" }],
    ]);
  });

  it("主题没变不重复调用", () => {
    syncNativeStatusBar("light");
    syncNativeStatusBar("light");
    expect(setStyle).toHaveBeenCalledTimes(1);
  });

  it("不在原生 App 里什么也不做", () => {
    native.value = false;
    syncNativeStatusBar("dark");
    expect(setStyle).not.toHaveBeenCalled();
  });
});
