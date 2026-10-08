import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const access = vi.hoisted(() => ({ member: false, remote: false }));
const settings = vi.hoisted(() => ({
  data: { agents: { defaultDriver: "acp" } } as Record<string, unknown>,
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
  useCurrentSource: () => ({ descriptor: { label: "家里的 Mac mini" } }),
}));
vi.mock("../../../app/use-agents", () => ({
  useAgentsQuery: () => ({
    data: [
      { id: "claude", label: "Claude Code" },
      { id: "codex", label: "Codex" },
    ],
  }),
}));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => {
    runtimeSettings.calls += 1;
    return { settings, save };
  },
}));

import { installDomPolyfills, optionLabels } from "../../../app/test-harness";
import { usePreferencesStore } from "../../../app/preferences-store";
import { translate } from "../../../i18n";
import { DefaultsPage } from "./DefaultsPage";

installDomPolyfills();
const zh = (key: string, values?: Record<string, string>) =>
  translate("zh-CN", key, values);

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  access.member = false;
  access.remote = false;
  runtimeSettings.calls = 0;
});
afterEach(cleanup);

describe("设置 → 默认（§2.2 映射）", () => {
  it("首行是 Agent 默认视图（主机项，行尾徽标），其后默认 Agent、权限、简洁模式、主题、语言", () => {
    render(<DefaultsPage />);
    const rows = screen
      .getAllByRole("combobox")
      .map((element) => element.getAttribute("aria-label"));
    expect(rows).toEqual([
      zh("acp.settings.defaultDriver"),
      zh("settings.defaultAgent"),
      zh("settings.defaultPermission"),
      zh("settings.theme"),
      zh("settings.locale"),
    ]);
    expect(
      screen.getByRole("switch", { name: zh("acp.settings.simpleMode") }),
    ).toBeTruthy();
    const badges = document.querySelectorAll("[data-settings-scope]");
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toBe(zh("settings.scope.host"));
  });

  it("远程源上，那一行的徽标带着主机名", () => {
    access.remote = true;
    render(<DefaultsPage />);
    expect(document.querySelector("[data-settings-scope]")?.textContent).toBe(
      zh("settings.scope.hostNamed", { name: "家里的 Mac mini" }),
    );
  });

  it("成员不画主机那一行，也不去读设置文档", () => {
    access.member = true;
    render(<DefaultsPage />);
    expect(
      screen.queryByRole("combobox", {
        name: zh("acp.settings.defaultDriver"),
      }),
    ).toBeNull();
    expect(runtimeSettings.calls).toBe(0);
    expect(
      screen.getByRole("combobox", { name: zh("settings.defaultAgent") }),
    ).toBeTruthy();
  });

  it("默认视图两档：会话视图在前", async () => {
    render(<DefaultsPage />);
    const labels = await optionLabels(
      screen.getByRole("combobox", { name: zh("acp.settings.defaultDriver") }),
    );
    expect(labels).toEqual([zh("acp.view.session"), zh("acp.view.terminal")]);
  });
});
