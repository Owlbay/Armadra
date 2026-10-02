/**
 * The integration surface other domains import.
 *
 * Canvas-only (docs/design/canvas-only-integration.md,
 * docs/design/canvas-launcher.md): `inject.ts` owns what a canvas launch
 * carries and writes the launchers `launcher.ts` generates, `migrate.ts` the
 * one-time removal of the old global installs, `integration.ts` what the
 * settings page reads and does. The
 * per-CLI modules only know their CLI's own file shapes — needed now to take
 * an old install back out.
 */
export * from "./events";
export * from "./shared";
export {
  INJECTED_AGENTS,
  type Injection,
  type InjectionRequest,
  type LauncherMarker,
  artifactLayout,
  canvasInjection,
  currentLauncher,
  integrationDir,
  launcherPath,
  prepareInjection,
  readLauncherMarker,
  shimDirectoryOf,
  shimPath,
} from "./inject";
export { LAUNCH_GATE, type LauncherSpec } from "./launcher";
export { migrateGlobalInstalls, readMigration } from "./migrate";
export { modulePath, piExtensionPath, opencodePluginPath } from "./extensions";
export {
  hooksPath as codexHooksPath,
  configPath as codexConfigPath,
} from "./codex";
export { hooksPath as copilotHooksPath } from "./copilot";
export { settingsPath as claudeSettingsPath } from "./claude";
