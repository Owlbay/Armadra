import { describe, expect, it, vi } from "vitest";

vi.mock("../../../api/client", () => ({ runtimeApi: {} }));

import { SETTINGS_SECTIONS } from "../nav";
import { SECTION_PAGES } from "./index";

describe("SECTION_PAGES", () => {
  it("导航里的每一页都挂了组件，没有多余的键", () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id).sort();
    expect(Object.keys(SECTION_PAGES).sort()).toEqual(ids);
  });

  it("一页一个组件：拆出来的页不再共用同一张旧页", () => {
    const pages = Object.values(SECTION_PAGES);
    expect(new Set(pages).size).toBe(pages.length);
  });
});
