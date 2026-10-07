import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ desktop: true }));
vi.mock("@/platform", () => ({ isDesktop: () => platform.desktop }));

import {
  SETTINGS_SECTIONS,
  isSettingsSectionId,
  visibleSettingsSections,
} from "./nav";

const ids = (sections: readonly { id: string }[]) =>
  sections.map((section) => section.id);

describe("设置导航按访问方式取舍", () => {
  it("只对本机有意义的分区有标记，且都是桌面专属", () => {
    const local = SETTINGS_SECTIONS.filter((section) => section.localOnly);
    expect(ids(local)).toEqual(["browser"]);
  });

  it("本机：桌面壳里列浏览器；远端（经中继、直连远端源、当前源是远程源）不列", () => {
    platform.desktop = true;
    expect(ids(visibleSettingsSections(false, false, false))).toContain(
      "browser",
    );
    const remote = ids(visibleSettingsSections(false, false, true));
    expect(remote).not.toContain("browser");
    // 作用在那台 core 上的页照常在：远程服务（带自断保护）、数据、更新（只读）。
    expect(remote).toEqual(
      expect.arrayContaining(["remote", "data", "updates", "host"]),
    );
  });

  it("上次停在只对本机有意义的那一页，远端时不再认它", () => {
    platform.desktop = true;
    expect(isSettingsSectionId("browser", false, false)).toBe(true);
    expect(isSettingsSectionId("browser", false, true)).toBe(false);
    expect(isSettingsSectionId("data", false, true)).toBe(true);
  });
});
