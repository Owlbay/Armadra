import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const access = vi.hoisted(() => ({ member: false, remote: false }));
const settings = vi.hoisted(() => ({
  data: { updates: { notify: true } } as Record<string, unknown>,
}));
const save = vi.hoisted(() => ({ mutate: vi.fn() }));
const runtimeSettings = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../../app/use-access", () => ({
  useAccess: () => ({ member: access.member }),
}));
vi.mock("../remote-access", () => ({
  useRemoteAccess: () => ({ remote: access.remote }),
}));
vi.mock("../../../sources/context", () => ({
  useCurrentSource: () => ({ descriptor: { label: "" } }),
}));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => {
    runtimeSettings.calls += 1;
    return { settings, save };
  },
}));

import { usePreferencesStore } from "../../../app/preferences-store";
import { translate } from "../../../i18n";
import { NotificationsPage } from "./NotificationsPage";

const zh = (key: string) => translate("zh-CN", key);

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  access.member = false;
  access.remote = false;
  runtimeSettings.calls = 0;
  save.mutate.mockClear();
});
afterEach(cleanup);

describe("设置 → 通知（§2.2 映射）", () => {
  it("原 4 项加「更新下载完成」；后者是主机项，切换即存", () => {
    render(<NotificationsPage />);
    for (const key of [
      "settings.notifyDone",
      "settings.notifyNeedsYou",
      "settings.sound",
      "updates.notify",
    ])
      expect(screen.getByRole("switch", { name: zh(key) }), key).toBeTruthy();
    expect(screen.getByText(zh("settings.soundVolume"))).toBeTruthy();
    expect(screen.getByText(zh("settings.soundPreview"))).toBeTruthy();
    expect(document.querySelector("[data-settings-scope]")?.textContent).toBe(
      zh("settings.scope.host"),
    );
    fireEvent.click(screen.getByRole("switch", { name: zh("updates.notify") }));
    expect(save.mutate).toHaveBeenCalledWith({ updates: { notify: false } });
  });

  it("成员与远端主机不画这一行，也不读设置文档", () => {
    for (const flags of [
      { member: true, remote: false },
      { member: false, remote: true },
    ]) {
      Object.assign(access, flags);
      runtimeSettings.calls = 0;
      render(<NotificationsPage />);
      expect(
        screen.queryByRole("switch", { name: zh("updates.notify") }),
      ).toBeNull();
      expect(runtimeSettings.calls).toBe(0);
      cleanup();
    }
  });
});
