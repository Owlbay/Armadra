import { Menu, Tray, app, nativeImage } from "electron";
import { join } from "node:path";
import {
  localeFromTag,
  shellText,
  type ShellLocale,
} from "../shell-core/messages";
import { templateGlyph } from "../shell-core/tray-glyph";
import {
  pollIntervalMs,
  refreshMinutes,
  traySummary,
  type TrayStrings,
  type TraySummary,
} from "../shell-core/usage";
import { repoRoot } from "./repo-root";
import { revealWindow } from "./window";

/**
 * The tray icon, its menu, and the usage strip at the top of it.
 *
 * Ported from the Rust shell this one replaced. Two differences,
 * both forced by Electron rather than chosen: a `Menu` is immutable once
 * built, so every refresh REBUILDS it (muda could rewrite a label in place),
 * and the polling loop is a `setTimeout` chain instead of a Tokio task.
 *
 * The rule the strip is built around is unchanged and lives in
 * `shell-core/usage.ts`: **unknown is not zero**, and a fetch that fails keeps
 * the previous reading rather than redrawing the rows as two unknowns.
 */

let tray: Tray | null = null;
let locale: ShellLocale = "zh-CN";
/** The last reading that arrived. Kept across failures on purpose. */
let summary: TraySummary | null = null;
/** Whether an update is staged. W2.2 owns the flow; the item is its door. */
let updateStaged = false;
let onRestart: () => void = () => undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
/** Where the core is; set by `createTray`, read by the gateway item. */
let base: () => Promise<string> = async () => "";
/** How a request reaches the core; set by `createTray`. */
let send: (path: string, init?: RequestInit) => Promise<Response> = async (
  path,
  init,
) => fetch(`${await base()}${path}`, init);
/**
 * The external-access item (completion plan G2-7). `null` until the core has
 * answered `GET /api/gateway` once, and whenever it refuses or is the server
 * shell's (configured on its command line, not here): then there is no item,
 * rather than one that would claim a state it does not know.
 */
let gateway: { enabled: boolean } | null = null;
/** A toggle in flight; a second click while it runs is dropped. */
let toggling = false;

/** What the quit item does. Supplied by the assembly, because the graceful
 * shutdown sequence is `main/index.ts`'s, not the tray's. */
let onQuit: () => void = () => app.quit();

/** The 512 px app icon: in the checkout in development, beside the app when packaged. */
function iconSource(): string {
  return app.isPackaged
    ? // Placed by `scripts/after-pack.mjs`; the checkout is not there once packaged.
      join(process.resourcesPath, "tray.png")
    : join(repoRoot(), "apps/desktop/build/icons/icon.png");
}

/**
 * The menu-bar image. On macOS a *template* glyph cut out of the app icon
 * (`shell-core/tray-glyph.ts`), at 1× and 2×; elsewhere the icon itself,
 * small. Empty when the source could not be read.
 */
function icon(): Electron.NativeImage {
  const source = nativeImage.createFromPath(iconSource());
  if (source.isEmpty()) return source;
  if (process.platform !== "darwin")
    return source.resize({ width: 22, height: 22 });
  const { width, height } = source.getSize();
  const glyph = templateGlyph({ width, height, data: source.toBitmap() });
  const shape = nativeImage.createFromBitmap(glyph.data, {
    width: glyph.width,
    height: glyph.height,
  });
  const image = nativeImage.createEmpty();
  for (const scale of [1, 2]) {
    image.addRepresentation({
      scaleFactor: scale,
      width: 18,
      height: 18,
      buffer: shape.resize({ width: 18 * scale, height: 18 * scale }).toPNG(),
    });
  }
  image.setTemplateImage(true);
  return image;
}

function strings(): TrayStrings {
  return {
    provider: (id) =>
      ({ claude: "Claude", codex: "Codex", copilot: "Copilot" })[id] ?? id,
    reason: (code) => shellText(locale, `tray.usage.reason.${code}`),
    signedOut: shellText(locale, "tray.usage.signedOut"),
    noData: shellText(locale, "tray.usage.noData"),
    costToday: shellText(locale, "tray.usage.costToday"),
  };
}

function buildMenu(): Menu {
  const readout: string[] = summary
    ? [...summary.providers, ...(summary.cost ? [summary.cost] : [])]
    : [shellText(locale, "tray.usage.noData")];
  return Menu.buildFromTemplate([
    // A readout, not an action: the rows are disabled so clicking them does
    // nothing rather than doing something unstated.
    ...readout.map(
      (label) =>
        ({
          label,
          enabled: false,
        }) satisfies Electron.MenuItemConstructorOptions,
    ),
    { type: "separator" },
    ...(gateway
      ? [
          {
            label: shellText(locale, "tray.gateway"),
            type: "checkbox",
            checked: gateway.enabled,
            enabled: !toggling,
            click: () => void toggleGateway(),
          } satisfies Electron.MenuItemConstructorOptions,
          { type: "separator" } satisfies Electron.MenuItemConstructorOptions,
        ]
      : []),
    // Present exactly while an update is staged. An item that is always there
    // but disabled would say the feature exists and is unavailable, when the
    // truth is that there is nothing to restart into (`main.rs:255-262`).
    ...(updateStaged
      ? [
          {
            label: shellText(locale, "tray.updateRestart"),
            click: () => onRestart(),
          } satisfies Electron.MenuItemConstructorOptions,
        ]
      : []),
    {
      label: shellText(locale, "tray.showWindow"),
      click: () => revealWindow(),
    },
    { label: shellText(locale, "tray.quit"), click: () => onQuit() },
  ]);
}

function redraw(): void {
  tray?.setContextMenu(buildMenu());
}

/** Shows the restart item exactly while an update is staged. W2.2 calls this. */
export function setUpdateStaged(staged: boolean, restart: () => void): void {
  onRestart = restart;
  if (updateStaged === staged) return;
  updateStaged = staged;
  redraw();
}

export interface TrayOptions {
  /** Where the Runtime is, resolved at poll time: the address is published
   * after startup and can change when the Runtime restarts. */
  readonly runtimeBase: () => Promise<string>;
  /**
   * 带会话发一个请求（契约 §3.2：core 不再放行回环上没带凭据的请求）。
   * `main/index.ts` 给的是 `shell-core/core-session.ts` 那一份；不给时直接打
   * `runtimeBase`，只有测试这么用。
   */
  readonly request?: (path: string, init?: RequestInit) => Promise<Response>;
  /** The graceful quit sequence. */
  readonly quit: () => void;
}

export function createTray(options: TrayOptions): void {
  if (tray) return;
  locale = localeFromTag(app.getLocale());
  onQuit = options.quit;
  const image = icon();
  if (image.isEmpty()) {
    // A tray with no image is an invisible click target. Say so instead of
    // leaving the user wondering where the icon went.
    process.stderr.write("Tray icon could not be loaded; tray disabled\n");
    return;
  }
  base = options.runtimeBase;
  send =
    options.request ??
    (async (path, init) => fetch(`${await base()}${path}`, init));
  tray = new Tray(image);
  tray.setToolTip("Armadra");
  redraw();
  // 左键留给「点一下把窗口叫回来」，菜单只从右键出。
  tray.on("click", () => revealWindow());
  void poll();
}

export function destroyTray(): void {
  stopped = true;
  gateway = null;
  if (timer) clearTimeout(timer);
  timer = null;
  tray?.destroy();
  tray = null;
}

async function fetchText(
  path: string,
  init?: RequestInit,
): Promise<string | null> {
  try {
    const response = await send(path, {
      ...init,
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

/**
 * The item's state out of a `GET` / `PUT /api/gateway` answer (contract
 * §17.1). Only a gateway the settings own gets an item; anything unreadable
 * is "unknown", which draws no item.
 */
export function gatewayItemState(
  text: string | null,
): { enabled: boolean } | null {
  if (text === null) return null;
  try {
    const status = JSON.parse(text) as {
      enabled?: unknown;
      managedBy?: unknown;
    };
    if (status.managedBy !== "settings" || typeof status.enabled !== "boolean")
      return null;
    return { enabled: status.enabled };
  } catch {
    return null;
  }
}

function setGateway(next: { enabled: boolean } | null): void {
  const same =
    next === null ? gateway === null : gateway?.enabled === next.enabled;
  if (same) return;
  gateway = next;
  redraw();
}

/**
 * Re-read the gateway now. The page calls this (IPC `app:gateway-refresh`) after
 * it changed the setting, so the check mark does not wait for the next poll.
 */
export async function refreshGateway(): Promise<void> {
  if (stopped) return;
  setGateway(gatewayItemState(await fetchText("/api/gateway")));
}

/**
 * The item's click: flip `gateway.enabled` through the same route the page
 * uses (`PUT /api/gateway`), then draw what the core answered — not what was
 * asked for, since "on" can come back as "on, but failed to listen".
 */
async function toggleGateway(): Promise<void> {
  if (!gateway || toggling) return;
  toggling = true;
  redraw();
  try {
    const answer = await fetchText("/api/gateway", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !gateway.enabled }),
    });
    const next = gatewayItemState(answer);
    if (next) gateway = next;
  } finally {
    toggling = false;
    redraw();
  }
}

/**
 * One poll, then schedule the next.
 *
 * A failure leaves `usage` alone: the Runtime restarting, or being a second
 * slow, must not blank a strip the user is looking at. The interval follows
 * `usage.refreshMinutes` within the bounds `shell-core/usage.ts` sets, and is
 * re-read every round so a settings change takes effect without a restart.
 */
async function poll(): Promise<void> {
  if (stopped) return;
  let interval = pollIntervalMs(null);
  try {
    const [usage, cost] = await Promise.all([
      fetchText("/api/usage"),
      fetchText("/api/usage/cost"),
    ]);
    const next = traySummary(summary, { usage, cost }, strings());
    if (next !== summary) {
      summary = next;
      redraw();
    }
    setGateway(gatewayItemState(await fetchText("/api/gateway")));
    const settings = await fetchText("/api/settings");
    interval = pollIntervalMs(
      settings === null ? null : refreshMinutes(settings),
    );
  } catch {
    // Same rule as a failed fetch: keep the last reading and try again.
  }
  if (stopped) return;
  timer = setTimeout(() => void poll(), interval);
  // The poll must never be the reason the process stays alive at quit.
  timer.unref?.();
}
