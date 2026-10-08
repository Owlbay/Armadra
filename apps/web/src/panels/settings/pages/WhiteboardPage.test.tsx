import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { usePreferencesStore } from "../../../app/preferences-store";
import { translate } from "../../../i18n";
import { WhiteboardPage } from "./WhiteboardPage";

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
