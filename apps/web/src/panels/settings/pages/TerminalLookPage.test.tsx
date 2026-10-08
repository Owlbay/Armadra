import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

const fonts = vi.hoisted(() => ({
  value: ["JetBrains Mono", "Menlo"] as string[] | null,
}));
vi.mock("../../../terminal/surface/fonts", () => ({
  useMonospaceFonts: () => fonts.value,
}));

import {
  chooseOption,
  installDomPolyfills,
  optionLabels,
} from "../../../app/test-harness";
import { usePreferencesStore } from "../../../app/preferences-store";
import { translate } from "../../../i18n";
import { TerminalLookPage, fontChoice } from "./TerminalLookPage";

installDomPolyfills();
const zh = (key: string) => translate("zh-CN", key);

function setFont(fontFamily: string) {
  const state = usePreferencesStore.getState();
  usePreferencesStore.setState({
    terminal: { ...state.terminal, fontFamily },
  });
}

const font = () =>
  screen.getByRole("combobox", { name: zh("terminal.settings.font") });

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  fonts.value = ["JetBrains Mono", "Menlo"];
  setFont("");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("设置 → 终端外观（§2.4）", () => {
  it("四组都在：字体与排版、光标、键盘、渲染（原终端页的外观项一项不丢）", () => {
    render(<TerminalLookPage />);
    for (const key of [
      "terminal.settings.group.type",
      "terminal.settings.group.cursor",
      "terminal.settings.group.keyboard",
      "terminal.settings.group.render",
    ])
      expect(screen.getByRole("heading", { name: zh(key) }), key).toBeTruthy();
    for (const key of [
      "terminal.settings.font",
      "terminal.settings.cursor",
      "terminal.settings.renderBudget",
    ])
      expect(screen.getByRole("combobox", { name: zh(key) }), key).toBeTruthy();
    for (const key of [
      "terminal.settings.cursorBlink",
      "terminal.settings.optionAsMeta",
      "terminal.settings.copyOnSelect",
      "terminal.settings.webgl",
    ])
      expect(screen.getByRole("switch", { name: zh(key) }), key).toBeTruthy();
    for (const key of [
      "terminal.settings.fontSize",
      "terminal.settings.lineHeight",
      "terminal.settings.letterSpacing",
    ])
      expect(screen.getByLabelText(zh(key)), key).toBeTruthy();
    expect(
      screen.getByLabelText(zh("terminal.settings.preview")).textContent,
    ).toBe(zh("terminal.settings.previewSample"));
  });

  it("字体是探测到的等宽字体：跟随系统在前、自定义在后", async () => {
    render(<TerminalLookPage />);
    expect(await optionLabels(font())).toEqual([
      zh("terminal.settings.fontSystem"),
      "JetBrains Mono",
      "Menlo",
      zh("terminal.settings.fontCustom"),
    ]);
  });

  it("选一款字体存它的名字；跟随系统存空串", async () => {
    render(<TerminalLookPage />);
    await chooseOption(font(), "Menlo");
    expect(usePreferencesStore.getState().terminal.fontFamily).toBe("Menlo");
    expect(
      screen.queryByLabelText(zh("terminal.settings.fontStack")),
    ).toBeNull();
    await chooseOption(font(), zh("terminal.settings.fontSystem"));
    expect(usePreferencesStore.getState().terminal.fontFamily).toBe("");
  });

  it("自定义：出现字体栈输入框，存自由文本", async () => {
    render(<TerminalLookPage />);
    await chooseOption(font(), zh("terminal.settings.fontCustom"));
    const stack = screen.getByLabelText(zh("terminal.settings.fontStack"));
    fireEvent.change(stack, {
      target: { value: "'Berkeley Mono', monospace" },
    });
    expect(usePreferencesStore.getState().terminal.fontFamily).toBe(
      "'Berkeley Mono', monospace",
    );
  });

  it("读回：存的正好是探测到的名字就落到那一项，否则落「自定义…」", () => {
    expect(fontChoice("", ["Menlo"])).toBe("__system");
    expect(fontChoice("Menlo", ["Menlo"])).toBe("Menlo");
    expect(fontChoice("Fira Code, monospace", ["Menlo"])).toBe("__custom");
    setFont("Fira Code, monospace");
    render(<TerminalLookPage />);
    expect(
      screen.getByLabelText(zh("terminal.settings.fontStack")),
    ).toBeTruthy();
  });

  it("字距可调，越界夹回范围", () => {
    render(<TerminalLookPage />);
    const spacing = screen.getByLabelText(
      zh("terminal.settings.letterSpacing"),
    );
    fireEvent.change(spacing, { target: { value: "1.5" } });
    expect(usePreferencesStore.getState().terminal.letterSpacing).toBe(1.5);
    fireEvent.change(spacing, { target: { value: "9" } });
    expect(usePreferencesStore.getState().terminal.letterSpacing).toBe(4);
  });

  it("探测超过 300ms 才显示骨架", () => {
    vi.useFakeTimers();
    fonts.value = null;
    render(<TerminalLookPage />);
    expect(screen.queryByTestId("terminal-font-loading")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(301);
    });
    expect(screen.getByTestId("terminal-font-loading")).toBeTruthy();
  });
});
