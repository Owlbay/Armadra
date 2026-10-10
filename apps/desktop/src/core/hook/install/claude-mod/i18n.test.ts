import { describe, expect, it } from "vitest";
import { DEFAULT_MOD_LOCALE, MOD_LOCALES, modLocaleOf } from "./i18n";
import { UI_LOCALES } from "../../../settings/schema";

/** `ui.locale` as the mod's generator reads it (contract §57.6, §58.3). */
describe("the mod's language", () => {
  it("has the settings schema's languages, the page's two", () => {
    expect([...MOD_LOCALES]).toEqual(["zh-CN", "en"]);
    expect([...MOD_LOCALES]).toEqual([...UI_LOCALES]);
  });

  it("reads ui.locale, and the default for anything else", () => {
    expect(modLocaleOf({ ui: { locale: "zh-CN" } })).toBe("zh-CN");
    expect(modLocaleOf({ ui: { locale: "en" } })).toBe("en");
    expect(DEFAULT_MOD_LOCALE).toBe("en");
    for (const document of [
      undefined,
      null,
      [],
      {},
      { ui: [] },
      { ui: { locale: "fr" } },
      { ui: { locale: 1 } },
    ]) {
      expect(modLocaleOf(document as never)).toBe(DEFAULT_MOD_LOCALE);
    }
  });
});
