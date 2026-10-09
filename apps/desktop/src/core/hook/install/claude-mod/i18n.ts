/**
 * The mod's words (docs/design/claude-mods.md §4.3, package M2): none in M1. What the
 * terminal shows in M1 is a node's name — no word to translate — so there is
 * no table yet. M2 mirrors `apps/web/src/i18n/integration.ts`'s `mod.*` keys
 * here, chosen by the device setting `ui.locale`.
 */
export const MOD_MESSAGES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {};
