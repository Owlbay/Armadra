/**
 * The two places a staged update is announced outside the settings page
 * (design §4.1, last rule): the tray's "restart to finish updating" item and
 * one system notification, ported from the Rust shell this one replaced.
 *
 * The design is explicit that these are the *only* two entry points — no
 * permanent banner, nothing modal. Both say the same thing, both are optional
 * in the sense that ignoring them changes nothing, and neither installs
 * anything: pressing the tray item still runs the same confirmed restart the
 * settings page runs.
 *
 * The strings live here rather than in the web app's catalogue because a tray
 * menu and an OS notification are drawn by the system, not by the page. The
 * shell has the two languages the product ships and picks between them from
 * the environment.
 */

/** The two languages the product ships. */
export type Locale = "zhCn" | "en";

/**
 * The UI language, from the environment. Electron's `app.getLocale()` is the
 * better source and W2.1 owns the tray that would use it; this is the same
 * fallback the Rust shell's `usage::Locale::from_environment` used, so a
 * notification is never drawn in the wrong language just because the tray has
 * not been wired yet.
 */
export function localeFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): Locale {
  const tag = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return /^zh/i.test(tag) ? "zhCn" : "en";
}

/**
 * Emitted whenever the staged-update announcement changes. The tray listens
 * for it; so does the settings page, which uses it to re-read the state
 * without polling.
 */
export const STAGED_EVENT = "updates://staged";

/** What the shell announces about a staged update. */
export interface Staged {
  /**
   * Whether bytes are on disk waiting for a restart. `false` retracts a
   * previous announcement — an install that failed leaves nothing staged.
   */
  ready: boolean;
  /** The version those bytes install. Empty when `ready` is false. */
  version: string;
  /**
   * Whether a restart would install them. `false` is a package without a
   * platform signature (`availability.ts::installRefusal`): the bytes are
   * staged and verified, and the tray must not offer a restart that is going
   * to be refused.
   */
  installable: boolean;
}

export function stagedReady(version: string, installable = true): Staged {
  return { ready: true, version, installable };
}

export function stagedCleared(): Staged {
  return { ready: false, version: "", installable: false };
}

/**
 * Whether the settings document asks for the notification (`updates.notify`).
 *
 * Defaults to on, and stays on for a document that could not be read: the
 * switch's default is on, and a Runtime that did not answer is not a person
 * asking for silence. Being told twice is recoverable; never being told that a
 * restart is waiting is the failure this notification exists to prevent.
 */
export function wantsNotification(settings: Uint8Array | string): boolean {
  let document: unknown;
  try {
    document = JSON.parse(
      typeof settings === "string"
        ? settings
        : Buffer.from(settings).toString("utf8"),
    );
  } catch {
    return true;
  }
  if (typeof document !== "object" || document === null) return true;
  const updates = (document as Record<string, unknown>).updates;
  if (typeof updates !== "object" || updates === null) return true;
  const notify = (updates as Record<string, unknown>).notify;
  return typeof notify === "boolean" ? notify : true;
}

/** The tray item shown only while an update is staged. */
export function restartMenuLabel(locale: Locale): string {
  return locale === "zhCn" ? "重启以完成更新" : "Restart to finish updating";
}

/**
 * The notification's title. It says a restart is waiting, not that anything
 * happened to the machine: nothing was installed yet.
 */
export function notificationTitle(locale: Locale): string {
  return locale === "zhCn" ? "更新已下载" : "Update downloaded";
}

/**
 * The notification's body. The version is the one thing worth carrying: it is
 * what tells a person whether this is the release they were waiting for.
 */
export function notificationBody(locale: Locale, version: string): string {
  const named = version.trim();
  if (locale === "zhCn") {
    return named.length === 0
      ? "重启 Armadra 即可完成更新。"
      : `重启 Armadra 即可更新到 ${named}。`;
  }
  return named.length === 0
    ? "Restart Armadra to finish updating."
    : `Restart Armadra to update to ${named}.`;
}

/**
 * The notification's body when the update is staged but this installation is
 * unsigned: the download worked and was verified, and nothing will install it.
 * Saying "restart to update" here would be a promise the restart cannot keep.
 */
export function unsignedNotificationBody(
  locale: Locale,
  version: string,
): string {
  const named = version.trim();
  if (locale === "zhCn") {
    return named.length === 0
      ? "更新已下载并通过校验，但当前安装未签名，不会自动安装。请从发布页手动安装。"
      : `${named} 已下载并通过校验，但当前安装未签名，不会自动安装。请从发布页手动安装。`;
  }
  return named.length === 0
    ? "The update was downloaded and verified, but this installation is unsigned, so it will not be installed automatically. Install it from the release page."
    : `${named} was downloaded and verified, but this installation is unsigned, so it will not be installed automatically. Install it from the release page.`;
}
