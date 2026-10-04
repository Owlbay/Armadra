/**
 * electron-builder `afterPack` hook: puts the `out/` bundles and the migration
 * files into the unpacked app's resources directory ourselves, with a retry.
 *
 * They used to travel as `extraResources`. On the Windows CI runners
 * electron-builder's own copy of them failed with `EBUSY: resource busy or
 * locked` — a different file each run, still after the real-time scanner was
 * switched off, and while a rename probe a moment earlier found nothing
 * holding the file. Whatever holds it does so briefly, and electron-builder
 * copies once and gives up. This copies the same files to the same places, but
 * tries again for a bounded while before it gives up; when it does give up it
 * names the processes that have the file mapped, so the failure says its
 * cause. Nothing of ours is left to `extraResources`, so the one-shot copy has
 * nothing left to trip on.
 *
 * `afterPack` runs before signing on every platform (app-builder-lib's
 * `doPack` emits it, then `doSignAfterPack`), so a file placed here is signed
 * and notarized with the bundle exactly as an `extraResources` entry would
 * have been.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOOK_LAUNCHER_RESOURCE,
  compileHookLauncher,
} from "./hook-launcher.mjs";
import { LAUNCH_EXE_RESOURCE, compileLaunchExe } from "./launch-exe.mjs";

const app = dirname(dirname(fileURLToPath(import.meta.url)));

/** How long one file may keep refusing to copy before the hook fails. */
export const COPY_LIMIT_MS = 120_000;

/** electron-builder's `Arch` numbering → the name `process.arch` uses. */
const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

/** The platform/arch pairs this shell is packaged for. */
const SUPPORTED = {
  darwin: ["arm64", "x64"],
  win32: ["arm64", "x64"],
  linux: ["arm64", "x64"],
};

/** Refuse a platform/arch pair nothing ships, before anything is copied. */
export function platformFor(platformName, archName) {
  if (!SUPPORTED[platformName]?.includes(archName)) {
    throw new Error(
      `after-pack: no bundle target for ${platformName}/${archName}`,
    );
  }
  return platformName;
}

/** The processes with `file` loaded as an image or a module (Windows only). */
export function holders(file) {
  if (process.platform !== "win32") return "";
  const escaped = file.replace(/'/g, "''");
  const script = [
    `$target = '${escaped}'`,
    "Get-Process | ForEach-Object {",
    "  $p = $_",
    "  try {",
    '    if ($p.Path -eq $target) { "$($p.Id) $($p.ProcessName) (image)" }',
    '    elseif ($p.Modules | Where-Object { $_.FileName -eq $target }) { "$($p.Id) $($p.ProcessName) (module)" }',
    "  } catch {}",
    "}",
  ].join("\n");
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  });
  return (result.stdout ?? "").trim();
}

/**
 * Copies `source` to `destination`, retrying a sharing violation (`EBUSY` /
 * `EPERM`) until `limitMs` has passed. Any other error is thrown at once.
 */
export function copyWithRetry(
  source,
  destination,
  {
    limitMs = COPY_LIMIT_MS,
    stepMs = 1_000,
    copy = copyFileSync,
    log = console.log,
    report = holders,
    now = Date.now,
    sleep = (ms) =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  } = {},
) {
  const started = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      copy(source, destination);
      if (attempts > 1)
        log(`after-pack: ${source} copied after ${attempts} attempts`);
      return attempts;
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      if (attempts === 1) {
        const who = report(source) || report(destination);
        log(
          `after-pack: ${source} is busy (${error.code}); holders:\n${who || "  (none with it mapped)"}`,
        );
      }
      if (now() - started > limitMs) {
        throw new Error(
          `after-pack: ${source} stayed busy for ${limitMs / 1000}s (${error.code})`,
        );
      }
      sleep(stepMs);
    }
  }
}

/**
 * The electron-vite bundles a given platform ships, at the paths the launchers
 * name.
 *
 * They are produced by `pnpm --filter @armadra/desktop build` into `out/` and
 * copied from there verbatim, outside the asar: the hook client is named with
 * an absolute path by a generated launcher, and the session host is started as
 * `ELECTRON_RUN_AS_NODE=1 <Electron> <resources>/session-host/host.cjs`, which
 * has to be a real file on disk.
 *
 * `out/session-host/host.cjs` is Windows-only: ConPTY sessions have to outlive
 * the shell there, and tmux already does that job on macOS and Linux (R6d).
 */
export function bundleResources(platformName) {
  const resources = [
    { from: "out/cli/armadra-hook.js", to: "cli/armadra-hook.js" },
    // The app icon the tray cuts its menu-bar glyph from. `main/tray.ts`
    // reads it from the checkout in development and from
    // `process.resourcesPath` in a packaged app; without this entry the
    // packaged tray logged "could not be loaded" and stayed off.
    { from: "build/icons/icon.png", to: "tray.png" },
    // The bundled `ama` (the pinned `@armadra/agent`'s single-file runtime and
    // the sandbox helper it loads from beside itself) and Armadra's host
    // adapter for it (docs/design/coordinator-agent.md §2.5). Real files: the
    // `<data>/bin/ama` launcher names the first, the profile's `host` the
    // last, and neither reader can open an asar. On Windows the launcher is a
    // copy of `cli/armadra-hook.exe`, so no second program is built.
    { from: "out/agent/ama.cjs", to: "agent/ama.cjs" },
    { from: "out/agent/ama-sandbox.cjs", to: "agent/ama-sandbox.cjs" },
    {
      from: "out/agent-host/ama-armadra.cjs",
      to: "agent-host/ama-armadra.cjs",
    },
  ];
  if (platformName === "win32")
    resources.push(
      {
        from: "out/session-host/host.cjs",
        to: "session-host/host.cjs",
      },
      // What build/installer.nsh runs before it replaces or removes the
      // executable a leftover host is running on.
      {
        from: "out/session-host/shutdown-if-idle.cjs",
        to: "session-host/shutdown-if-idle.cjs",
      },
    );
  return resources;
}

/** Where the `.sql` files are in the checkout, and where they go in a bundle. */
export const MIGRATIONS_FROM = "src/core/db/migrations";
export const MIGRATIONS_TO = "migrations";

/**
 * The migration files, as `{from, to}` pairs.
 *
 * A packaged core has no checkout to walk up into, so `core/db/migrations.ts`'s
 * `resolveMigrationsDir` looks for exactly `<resources>/migrations`. They are
 * copied file by file rather than as a directory so that every placement goes
 * through the same retry as everything else here.
 */
export function migrationResources(from = join(app, MIGRATIONS_FROM)) {
  return readdirSync(from)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      from: `${MIGRATIONS_FROM}/${name}`,
      to: `${MIGRATIONS_TO}/${name}`,
    }));
}

/**
 * The third-party notices that ship inside every bundle (external-services
 * §11.3), as `{from, to}` pairs under the resources directory:
 *
 * - the repository's generated `THIRD_PARTY_NOTICES.md` (`tools/notices.mjs`),
 *   which Settings → About also shows;
 * - the bundled ama's own `LICENSE` and `THIRD_PARTY_NOTICES.md`, beside the
 *   `agent/ama.cjs` they describe — `@armadra/agent` is bundled into that one
 *   file, so its notices would otherwise not travel at all.
 */
export function noticeResources() {
  return [
    { from: "../../THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" },
    { from: "node_modules/@armadra/agent/LICENSE", to: "agent/LICENSE" },
    {
      from: "node_modules/@armadra/agent/THIRD_PARTY_NOTICES.md",
      to: "agent/THIRD_PARTY_NOTICES.md",
    },
  ];
}

/**
 * Electron's own two notice files, which its license and Chromium's require to
 * accompany the binaries: `LICENSE` (published as `LICENSE.electron.txt`) and
 * `LICENSES.chromium.html`.
 *
 * electron-builder copies them next to the executable on Windows and Linux but
 * drops them on macOS (electron/electron#34236), so on macOS they are put back
 * into `Contents/Resources/`; on the other two they are put where they belong
 * only if the packager left them out. `{from, to}` with `from` relative to the
 * Electron distribution and `to` an absolute path.
 */
export function electronNoticePlacements(
  platformName,
  { appOutDir, resourcesDir },
) {
  const into = platformName === "darwin" ? resourcesDir : appOutDir;
  return [
    { from: "LICENSE", to: join(into, "LICENSE.electron.txt") },
    {
      from: "LICENSES.chromium.html",
      to: join(into, "LICENSES.chromium.html"),
    },
  ];
}

/**
 * The unpacked Electron distribution this checkout installed, unpacking it
 * first when it is not there.
 *
 * electron-builder packs from its own download cache, so `node_modules/electron`
 * can be a package with no `dist/` at all — pnpm runs electron's postinstall
 * only for an install made after `allowBuilds.electron` (see
 * `ensure-electron.mjs`), and the release runners hit exactly that. The two
 * notice files exist only in that distribution, so this runs electron's own
 * `install.js` (the same download, through the same cache) when they are
 * missing. Called only when a notice actually has to be copied.
 */
export function electronDist({ run = spawnSync, log = console.log } = {}) {
  const require = createRequire(join(app, "package.json"));
  const packageDir = dirname(require.resolve("electron/package.json"));
  const dist = join(packageDir, "dist");
  if (!existsSync(join(dist, "LICENSES.chromium.html"))) {
    log(
      "after-pack: Electron's distribution is not unpacked; running electron's install.js for its notices",
    );
    const result = run(process.execPath, [join(packageDir, "install.js")], {
      cwd: packageDir,
      stdio: "inherit",
    });
    if (result.status !== 0)
      throw new Error(
        `after-pack: electron's install.js exited with ${result.status}; its notices cannot be shipped`,
      );
  }
  return dist;
}

/** Places Electron's notices; returns the destinations written. */
export function placeElectronNotices(
  platformName,
  dirs,
  { dist = electronDist, copy = copyWithRetry, exists = existsSync } = {},
) {
  const written = [];
  let from;
  for (const placement of electronNoticePlacements(platformName, dirs)) {
    if (platformName !== "darwin" && exists(placement.to)) continue;
    from ??= dist();
    const source = join(from, placement.from);
    if (!exists(source))
      throw new Error(
        `after-pack: ${source} is missing; Electron's notices must ship with the bundle`,
      );
    mkdirSync(dirname(placement.to), { recursive: true });
    copy(source, placement.to);
    written.push(placement.to);
  }
  return written;
}

/**
 * Everything this hook places for a platform: the `out/` bundles, the
 * third-party notices, then the migrations the core reads at start-up.
 *
 * There are no sidecar binaries any more. The core is one of those `out/`
 * bundles and runs on the Electron the app already ships, so nothing here is
 * marked executable.
 */
export function placements(platformName) {
  return [
    ...bundleResources(platformName),
    ...noticeResources(),
    ...migrationResources(),
  ].map((resource) => ({ ...resource, executable: false }));
}

/**
 * The directory electron-updater caches downloads in, under the OS cache
 * directory, and where the NSIS installer leaves its copy for the next
 * differential download.
 *
 * electron-builder derives it from the package name (`AppInfo`'s
 * `updaterCacheDirName` getter); a scoped name gives `@armadradesktop-updater`.
 * The configuration has no key for it — a `publish.updaterCacheDirName` is
 * overwritten — and renaming the package would also rename the Linux
 * packages. So this hook does two things: it pins the getter on this build's
 * `AppInfo`, which every later reader goes through (the deb / rpm targets
 * write `app-update.yml` again after this hook, NSIS defines its store path
 * from it), and it rewrites the `app-update.yml` electron-builder's own
 * afterPack handler already wrote (system handlers run before user hooks).
 */
export const UPDATER_CACHE_DIR_NAME = "armadra-updater";

/** Pins `appInfo.updaterCacheDirName` for the rest of this build. */
export function pinUpdaterCacheDir(appInfo, name = UPDATER_CACHE_DIR_NAME) {
  if (!appInfo || appInfo.updaterCacheDirName === name) return false;
  Object.defineProperty(appInfo, "updaterCacheDirName", {
    value: name,
    configurable: true,
  });
  if (appInfo.updaterCacheDirName !== name)
    throw new Error("after-pack: could not pin updaterCacheDirName");
  return true;
}

/** `app-update.yml` with `updaterCacheDirName` set to ours. */
export function withUpdaterCacheDir(text, name = UPDATER_CACHE_DIR_NAME) {
  const line = `updaterCacheDirName: ${name}`;
  if (/^updaterCacheDirName:.*$/m.test(text))
    return text.replace(/^updaterCacheDirName:.*$/m, line);
  return `${text.replace(/\n*$/, "\n")}${line}\n`;
}

/**
 * Rewrites `<resources>/app-update.yml` when the packager wrote one (every
 * target that can update). Returns whether a file was there.
 */
export function placeUpdaterCacheDir(resourcesDir) {
  const path = join(resourcesDir, "app-update.yml");
  if (!existsSync(path)) return false;
  writeFileSync(path, withUpdaterCacheDir(readFileSync(path, "utf8")));
  return true;
}

export default async function afterPack(context) {
  const platformName = context.electronPlatformName;
  const archName = ARCH_NAMES[context.arch] ?? process.arch;
  platformFor(platformName, archName);
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  for (const placement of placements(platformName)) {
    const source = join(app, placement.from);
    if (!existsSync(source)) {
      throw new Error(
        `after-pack: ${source} is missing; the electron-vite build runs before packaging`,
      );
    }
    const destination = join(resourcesDir, placement.to);
    mkdirSync(dirname(destination), { recursive: true });
    copyWithRetry(source, destination);
    if (placement.executable && platformName !== "win32")
      chmodSync(destination, 0o755);
    console.log(`after-pack: placed ${placement.to}`);
  }
  for (const placed of placeElectronNotices(platformName, {
    appOutDir: context.appOutDir,
    resourcesDir,
  }))
    console.log(`after-pack: placed ${placed}`);
  pinUpdaterCacheDir(context.packager.appInfo);
  if (placeUpdaterCacheDir(resourcesDir))
    console.log(
      `after-pack: app-update.yml caches in ${UPDATER_CACHE_DIR_NAME}`,
    );
  placeHookLauncher(platformName, resourcesDir);
  placeLaunchExe(platformName, resourcesDir);
}

/**
 * Builds `cli/armadra-hook.exe` for a Windows target (see hook-launcher.mjs).
 *
 * Only a Windows host has the compiler. A Windows target packaged elsewhere
 * gets no `.exe`, and its core falls back to the `.cmd` launcher — the one
 * that breaks on `&` and `%` in a message body — so that is said out loud
 * rather than left for someone to discover on a user's machine. On a Windows
 * host a failed compile fails the build.
 */
export function placeHookLauncher(
  platformName,
  resourcesDir,
  {
    host = process.platform,
    compile = compileHookLauncher,
    log = console.log,
  } = {},
) {
  if (platformName !== "win32") return undefined;
  if (host !== "win32") {
    log(
      `after-pack: WARNING ${HOOK_LAUNCHER_RESOURCE} not built (needs a Windows host); this build falls back to armadra-hook.cmd`,
    );
    return undefined;
  }
  const output = compile(join(resourcesDir, HOOK_LAUNCHER_RESOURCE));
  log(`after-pack: built ${HOOK_LAUNCHER_RESOURCE}`);
  return output;
}

/**
 * Builds `cli/armadra-launch.exe`, the canvas launcher, for a Windows target
 * (see launch-exe.mjs). Same rule as {@link placeHookLauncher}: only a Windows
 * host can compile it, a Windows target packaged elsewhere says so, and a
 * failed compile on a Windows host fails the build. Without it that build's
 * core starts canvas agents on a bare line, without injection.
 */
export function placeLaunchExe(
  platformName,
  resourcesDir,
  {
    host = process.platform,
    compile = compileLaunchExe,
    log = console.log,
  } = {},
) {
  if (platformName !== "win32") return undefined;
  if (host !== "win32") {
    log(
      `after-pack: WARNING ${LAUNCH_EXE_RESOURCE} not built (needs a Windows host); canvas agents on this build start without injection`,
    );
    return undefined;
  }
  const output = compile(join(resourcesDir, LAUNCH_EXE_RESOURCE));
  log(`after-pack: built ${LAUNCH_EXE_RESOURCE}`);
  return output;
}
