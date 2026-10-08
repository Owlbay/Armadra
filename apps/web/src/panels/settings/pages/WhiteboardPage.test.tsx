import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const runtime = vi.hoisted(() => ({
  data: { canvas: { layoutDirection: "vertical" } } as Record<string, unknown>,
  mutate: vi.fn(),
}));
vi.mock("@/panels/settings/use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: runtime.data },
    save: { mutate: runtime.mutate, isPending: false },
  }),
}));

import { usePreferencesStore } from "../../../app/preferences-store";
import { translate } from "../../../i18n";
import { installDomPolyfills } from "../../../app/test-harness";
import { WhiteboardPage } from "./WhiteboardPage";

installDomPolyfills();

const zh = (key: string) => translate("zh-CN", key);

beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(cleanup);

describe("设置 → 画布（§2.2 映射）", () => {
  it("白板各项都在；实时协同移到了工作空间页", () => {
    render(<WhiteboardPage />);
    for (const key of [
      "settings.whiteboard.background",
      "settings.whiteboard.gridSize",
      "settings.whiteboard.inputMode",
      "settings.whiteboard.defaultSize",
    ])
      expect(screen.getByRole("combobox", { name: zh(key) }), key).toBeTruthy();
    for (const key of [
      "settings.whiteboard.grid",
      "settings.whiteboard.snap",
      "settings.whiteboard.toolLock",
      "settings.whiteboard.wrap",
      "settings.whiteboard.dynamicSize",
      "settings.whiteboard.pasteAtCursor",
      "settings.whiteboard.edgeScroll",
      "settings.whiteboard.focus",
      "settings.whiteboard.animation",
    ])
      expect(screen.getByRole("switch", { name: zh(key) }), key).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", {
        name: zh("settings.whiteboard.defaultColor"),
      }),
    ).toBeTruthy();
    expect(screen.queryByText(zh("realtime.setting"))).toBeNull();
  });
});

describe("布局方向（契约 §50）", () => {
  it("一行 Select，缺省纵向；改横向写进主机设置的 canvas.layoutDirection", async () => {
    runtime.mutate.mockClear();
    render(<WhiteboardPage />);
    const select = screen.getByRole("combobox", {
      name: zh("canvas.layoutDirection"),
    });
    expect(select.textContent).toContain(zh("canvas.layoutDirection.vertical"));
    fireEvent.keyDown(select, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("option", {
        name: zh("canvas.layoutDirection.horizontal"),
      }),
    );
    expect(runtime.mutate).toHaveBeenCalledWith({
      canvas: { layoutDirection: "horizontal" },
    });
  });
});
