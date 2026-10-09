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
import {
  usePreferencesStore,
  type TerminalPreferences,
} from "../../../app/preferences-store";
import { translate } from "../../../i18n";
import { TerminalLookPage, fontChoice } from "./TerminalLookPage";

installDomPolyfills();
const zh = (key: string) => translate("zh-CN", key);

function setTerminal(patch: Partial<TerminalPreferences>) {
  const state = usePreferencesStore.getState();
  usePreferencesStore.setState({ terminal: { ...state.terminal, ...patch } });
}

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
  setTerminal({ renderer: "dom", repaintThrottle: "off", releaseAfter: "10m" });
  localStorage.clear();
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
      "terminal.settings.renderer",
      "terminal.settings.releaseAfter",
    ])
      expect(screen.getByRole("combobox", { name: zh(key) }), key).toBeTruthy();
    for (const key of [
      "terminal.settings.cursorBlink",
      "terminal.settings.optionAsMeta",
      "terminal.settings.copyOnSelect",
      "terminal.settings.repaintThrottle",
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

  it("渲染器三档，选了就存枚举；名额只在 WebGL 档出现", async () => {
    render(<TerminalLookPage />);
    const renderer = () =>
      screen.getByRole("combobox", { name: zh("terminal.settings.renderer") });
    expect(await optionLabels(renderer())).toEqual([
      zh("terminal.settings.renderer.dom"),
      zh("terminal.settings.renderer.webgl"),
      zh("terminal.settings.renderer.auto"),
    ]);
    const budget = () =>
      screen.queryByRole("combobox", {
        name: zh("terminal.settings.renderBudget"),
      });
    expect(budget()).toBeNull();
    await chooseOption(renderer(), zh("terminal.settings.renderer.webgl"));
    expect(usePreferencesStore.getState().terminal.renderer).toBe("webgl");
    expect(localStorage.getItem("armadra.terminal.renderer")).toBe("webgl");
    expect(budget()).toBeTruthy();
    await chooseOption(renderer(), zh("terminal.settings.renderer.auto"));
    expect(localStorage.getItem("armadra.terminal.renderer")).toBe("auto");
    expect(budget()).toBeNull();
    expect(localStorage.getItem("armadra.terminal.webgl")).toBeNull();
  });

  it("缩小时限帧：开关对应 lowZoom / off", () => {
    render(<TerminalLookPage />);
    const toggle = screen.getByRole("switch", {
      name: zh("terminal.settings.repaintThrottle"),
    });
    fireEvent.click(toggle);
    expect(usePreferencesStore.getState().terminal.repaintThrottle).toBe(
      "lowZoom",
    );
    expect(localStorage.getItem("armadra.terminal.repaintThrottle")).toBe(
      "lowZoom",
    );
    fireEvent.click(toggle);
    expect(localStorage.getItem("armadra.terminal.repaintThrottle")).toBe(
      "off",
    );
  });

  it("离屏释放：四档，存枚举", async () => {
    render(<TerminalLookPage />);
    const release = screen.getByRole("combobox", {
      name: zh("terminal.settings.releaseAfter"),
    });
    expect(await optionLabels(release)).toEqual(
      ["5m", "10m", "30m", "never"].map((v) =>
        zh(`terminal.settings.releaseAfter.${v}`),
      ),
    );
    await chooseOption(release, zh("terminal.settings.releaseAfter.never"));
    expect(usePreferencesStore.getState().terminal.releaseAfter).toBe("never");
    expect(localStorage.getItem("armadra.terminal.releaseAfter")).toBe("never");
  });
});
