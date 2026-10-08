import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ desktop: true }));
vi.mock("@/platform", () => ({ isDesktop: () => platform.desktop }));

import {
  DEFAULT_SETTINGS_SECTION,
  LEGACY_SECTION_IDS,
  SETTINGS_SECTIONS,
  activeSectionId,
  groupSections,
  isSettingsSectionId,
  visibleSettingsSections,
} from "./nav";
import { SECTION_PAGES } from "./pages";

const ids = (sections: readonly { id: string }[]) =>
  sections.map((section) => section.id);

describe("设置导航（界面第二波 §2.1）", () => {
  it("八组、注册表顺序即导航顺序，「默认」置顶", () => {
    expect(ids(SETTINGS_SECTIONS)).toEqual([
      "defaults",
      "general",
      "notifications",
      "whiteboard",
      "terminalLook",
      "browser",
      "keybindings",
      "agents",
      "customAgents",
      "sessions",
      "credentials",
      "usage",
      "workspace",
      "service",
      "machines",
      "forge",
      "remoteAccess",
      "devices",
      "security",
      "accounts",
      "about",
    ]);
    expect(DEFAULT_SETTINGS_SECTION).toBe("defaults");
    platform.desktop = true;
    expect(
      groupSections(visibleSettingsSections(true)).map(
        (group) => group.groupKey,
      ),
    ).toEqual([
      "settings.group.frequent",
      "settings.group.look",
      "settings.group.agent",
      "settings.group.space",
      "settings.group.host",
      "settings.group.remote",
      "settings.group.account",
      "settings.group.about",
    ]);
  });

  it("每页都有作用范围；ownerOnly 只出现在主机页上", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(["device", "host", "account"], section.id).toContain(
        section.scope,
      );
      if (section.ownerOnly) expect(section.scope, section.id).toBe("host");
    }
  });

  it("每页都挂了组件", () => {
    for (const section of SETTINGS_SECTIONS)
      expect(typeof SECTION_PAGES[section.id], section.id).toBe("function");
  });

  it("本设备的页对成员与远程源一律可见（浏览器页只对本机有意义）", () => {
    platform.desktop = true;
    const device = SETTINGS_SECTIONS.filter(
      (section) => section.scope === "device" && !section.localOnly,
    );
    const visible = ids(visibleSettingsSections(false, true, true));
    for (const section of device) expect(visible).toContain(section.id);
  });

  it("主机 + ownerOnly 的页对成员不见", () => {
    platform.desktop = true;
    const visible = ids(visibleSettingsSections(true, true, false));
    for (const section of SETTINGS_SECTIONS.filter((entry) => entry.ownerOnly))
      expect(visible).not.toContain(section.id);
    // 成员仍进得来：本机服务（只见连接状态）、设备与会话、账号与安全、关于。
    expect(visible).toEqual(
      expect.arrayContaining(["service", "devices", "security", "about"]),
    );
  });

  it("每个旧 id 都映射到一个存在的新 id，且旧 id 不再是分区", () => {
    const current = new Set(ids(SETTINGS_SECTIONS));
    expect(Object.keys(LEGACY_SECTION_IDS).sort()).toEqual(
      [
        "agent",
        "integration",
        "terminal",
        "host",
        "remote",
        "github",
        "ssh",
        "executionHosts",
        "data",
        "account",
        "updates",
      ].sort(),
    );
    for (const [legacy, next] of Object.entries(LEGACY_SECTION_IDS)) {
      expect(current.has(next), `${legacy} → ${next}`).toBe(true);
      expect(current.has(legacy), legacy).toBe(false);
    }
  });

  it("存着旧 id 时先映射再判断，落在内容所在的新页", () => {
    platform.desktop = true;
    expect(isSettingsSectionId("integration")).toBe(true);
    expect(activeSectionId("integration")).toBe("agents");
    expect(activeSectionId("updates")).toBe("about");
    expect(activeSectionId("ssh")).toBe("machines");
    // 成员看不到映射后的那一页：回到第一页。
    expect(activeSectionId("github", true)).toBe(DEFAULT_SETTINGS_SECTION);
    expect(activeSectionId("nope")).toBe(DEFAULT_SETTINGS_SECTION);
    expect(activeSectionId(null)).toBe(DEFAULT_SETTINGS_SECTION);
    // 原型链上的名字不是旧 id。
    expect(activeSectionId("toString")).toBe(DEFAULT_SETTINGS_SECTION);
  });
});

describe("设置导航按访问方式取舍", () => {
  it("只对本机有意义的分区有标记，且都是桌面专属", () => {
    const local = SETTINGS_SECTIONS.filter((section) => section.localOnly);
    expect(ids(local)).toEqual(["browser"]);
    expect(local.every((section) => section.desktopOnly)).toBe(true);
  });

  it("本机：桌面壳里列浏览器；远端（经中继、直连远端源、当前源是远程源）不列", () => {
    platform.desktop = true;
    expect(ids(visibleSettingsSections(false, false, false))).toContain(
      "browser",
    );
    const remote = ids(visibleSettingsSections(false, false, true));
    expect(remote).not.toContain("browser");
    // 作用在那台 core 上的页照常在：远程访问（带自断保护）、本机服务、关于。
    expect(remote).toEqual(
      expect.arrayContaining(["remoteAccess", "service", "about"]),
    );
  });

  it("上次停在只对本机有意义的那一页，远端时不再认它", () => {
    platform.desktop = true;
    expect(isSettingsSectionId("browser", false, false)).toBe(true);
    expect(isSettingsSectionId("browser", false, true)).toBe(false);
    expect(isSettingsSectionId("data", false, true)).toBe(true);
  });

  it("只有远程访问页固定操作本机", () => {
    expect(
      ids(SETTINGS_SECTIONS.filter((section) => section.pinnedLocal)),
    ).toEqual(["remoteAccess"]);
  });
});
