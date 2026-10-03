import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const store = vi.hoisted(() => ({
  panels: { sidebar: "open" },
  setPanel: vi.fn(),
}));

const settings = vi.hoisted(() => ({
  data: { diagnostics: { crashReportDsn: "" } } as Record<string, unknown>,
}));
const save = vi.hoisted(() => ({ mutate: vi.fn() }));
const access = vi.hoisted(() => ({ member: false }));
const runtimeSettings = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../../app/use-access", () => ({
  useAccess: () => ({ member: access.member }),
}));

vi.mock("../../../store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => {
    runtimeSettings.calls += 1;
    return { settings, save };
  },
}));

import { GeneralPage, isCrashReportDsn } from "./GeneralPage";
import { usePreferencesStore } from "../../../app/preferences-store";

const DSN = "https://key@glitchtip.example.com/1";

function switchFor() {
  return screen.getByRole("switch", { name: "崩溃上报" });
}

describe("通用页的崩溃上报", () => {
  beforeEach(() => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    save.mutate.mockClear();
    settings.data = { diagnostics: { crashReportDsn: "" } };
    access.member = false;
    runtimeSettings.calls = 0;
  });
  afterEach(cleanup);

  it("缺省关：没有 DSN 输入框", () => {
    render(<GeneralPage />);
    expect(switchFor().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("textbox", { name: "DSN" })).toBeNull();
  });

  it("打开后填合格的 DSN 才保存；不合格的不存并标出", () => {
    render(<GeneralPage />);
    fireEvent.click(switchFor());
    expect(save.mutate).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox", { name: "DSN" });
    fireEvent.change(input, { target: { value: "not a dsn" } });
    fireEvent.blur(input);
    expect(save.mutate).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("DSN 无效")).toBeTruthy();
    fireEvent.change(input, { target: { value: ` ${DSN} ` } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(save.mutate).toHaveBeenCalledWith({
      diagnostics: { crashReportDsn: DSN },
    });
  });

  it("关掉即清空 DSN", () => {
    settings.data = { diagnostics: { crashReportDsn: DSN } };
    render(<GeneralPage />);
    expect(switchFor().getAttribute("aria-checked")).toBe("true");
    expect(
      (screen.getByRole("textbox", { name: "DSN" }) as HTMLInputElement).value,
    ).toBe(DSN);
    fireEvent.click(switchFor());
    expect(save.mutate).toHaveBeenCalledWith({
      diagnostics: { crashReportDsn: "" },
    });
  });

  it("成员看不到这一组，也不去读设置文档（否则是一次 403）", () => {
    access.member = true;
    render(<GeneralPage />);
    expect(screen.queryByRole("switch", { name: "崩溃上报" })).toBeNull();
    expect(runtimeSettings.calls).toBe(0);
  });

  it("DSN 规则与壳一致", () => {
    expect(isCrashReportDsn("http://k@127.0.0.1:8000/1")).toBe(true);
    expect(isCrashReportDsn("https://host/1")).toBe(false);
    expect(isCrashReportDsn("https://k@host/")).toBe(false);
    expect(isCrashReportDsn("ftp://k@host/1")).toBe(false);
  });
});
