import { settingsDomain } from "../../../settings";
import type { JsonValue } from "../../../settings/local";

/**
 * The language of the mod's words (docs/design/claude-mods.md §4.3, contract
 * §57.6): the device setting `ui.locale`, written by the page when the person
 * switches its language, read here when the module is generated.
 *
 * The band, the toast and the status line have no words — names, numbers and
 * glyphs — so nothing the M2 segments generate depends on it. What does is
 * the slash commands' descriptions (M3), whose table mirrors the page's own.
 * A locale that changed makes the generated module differ, and the next
 * prepare rewrites it.
 */

export const MOD_LOCALES = ["zh-CN", "en"] as const;

export type ModLocale = (typeof MOD_LOCALES)[number];

/** No setting yet: the words of a CLI's own help, which are English. */
export const DEFAULT_MOD_LOCALE: ModLocale = "en";

/** `ui.locale` out of a settings document, or the default. */
export function modLocaleOf(document: JsonValue | undefined): ModLocale {
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  ) {
    return DEFAULT_MOD_LOCALE;
  }
  const ui = document.ui;
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
    return DEFAULT_MOD_LOCALE;
  }
  const locale = ui.locale;
  return typeof locale === "string" &&
    (MOD_LOCALES as readonly string[]).includes(locale)
    ? (locale as ModLocale)
    : DEFAULT_MOD_LOCALE;
}

/** This device's `ui.locale`; the default where no settings are assembled. */
export function storedModLocale(): ModLocale {
  return modLocaleOf(settingsDomain()?.settings.snapshot());
}
