import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  LOCAL_PACKAGE_MARKER,
  configuredEndpoints,
  developmentOverride,
  type SignatureState,
  type UpdaterEnvironment,
} from "../../shell-core/updates/availability";
import { releaseSourceFor, shellTarget } from "../../shell-core/updates/offer";

/**
 * The four questions `shell-core/updates/availability.ts` needs answered about
 * this particular installation. Everything with a rule lives there; this file
 * is the three filesystem reads that answer them.
 */

/**
 * The `armadraUpdates` marker in the packaged `package.json`, injected by the
 * `dist` script through electron-builder's `extraMetadata`. See
 * `availability.ts` for the contract W2.3 has to honour when it writes it;
 * this is the read side, and it only exists in a packaged app.
 */
export function packagedUpdateMode(): unknown {
  if (!app.isPackaged) return undefined;
  try {
    const packaged: unknown = JSON.parse(
      readFileSync(join(app.getAppPath(), "package.json"), "utf8"),
    );
    if (typeof packaged !== "object" || packaged === null) return undefined;
    return (packaged as Record<string, unknown>)[LOCAL_PACKAGE_MARKER];
  } catch (error) {
    // A normal release carries no marker, and a package.json that could not be
    // read is not a statement that updates are disabled. Say so and move on.
    process.stderr.write(
      `Updater could not read the packaged update mode: ${String(error)}\n`,
    );
    return undefined;
  }
}

/**
 * Whether this package carries a platform signature that makes an update
 * trustworthy. See `SignatureState` for why `unknown` is refused.
 *
 * macOS is the only platform that can be answered cheaply and honestly: a
 * signed `.app` carries `Contents/_CodeSignature/CodeResources`, and an
 * unsigned one does not. (This says the bundle was signed, not that Gatekeeper
 * accepts it — `codesign --verify` would, and it is a subprocess on every
 * start. electron-updater performs the real check at install time, which is
 * where a broken signature has to stop things anyway; this read only decides
 * whether the shell may claim it is able to check at all.)
 */
export function signatureState(
  platform: string = process.platform,
  executable: string = process.execPath,
  packaged: boolean = app.isPackaged,
): SignatureState {
  if (!packaged) return "unsigned";
  if (platform === "darwin") {
    // …/Armadra.app/Contents/MacOS/Armadra → …/Armadra.app/Contents
    const contents = dirname(dirname(executable));
    return existsSync(join(contents, "_CodeSignature", "CodeResources"))
      ? "signed"
      : "unsigned";
  }
  // An AppImage, .deb or .rpm carries no code signature; what makes its bytes
  // trustworthy is the feed's own digest plus the sha256 the Host published,
  // and both are checked whether or not anything was signed.
  if (platform === "linux") return "notApplicable";
  // Windows Authenticode is not read here, and `unknown` is refused: the
  // research doc states the order plainly — sign first, then turn on automatic
  // updates, because an unsigned automatic update is a step backwards in
  // trust. W2.3 owns the signing and replaces this line.
  return "unknown";
}

/**
 * Where releases are published. electron-builder writes the `publish` block
 * into the packaged app as `app-update.yml`, which electron-updater reads by
 * itself; `ARMADRA_UPDATER_ENDPOINTS` overrides it with the comma-separated
 * spelling `apps/desktop/scripts/signing.mjs:109-140` defined.
 */
export function publishConfigured(env = process.env): boolean {
  if (configuredEndpoints(env).length > 0) return true;
  if ((env[SOURCE_ENV] ?? "").trim().length > 0) return true;
  if (!app.isPackaged) return false;
  return existsSync(join(process.resourcesPath, "app-update.yml"));
}

export function updaterEnvironment(env = process.env): UpdaterEnvironment {
  return {
    packaged: app.isPackaged,
    marker: packagedUpdateMode(),
    publishConfigured: publishConfigured(env),
    signature: signatureState(),
    developmentOverride: developmentOverride(env),
  };
}

/** An explicit release index, `…/repos/{owner}/{repo}` (GitHub API shape). */
export const SOURCE_ENV = "ARMADRA_UPDATER_SOURCE";

/**
 * The `url` a published build carries in `app-update.yml`, which is where the
 * release workflow's `ARMADRA_UPDATER_ENDPOINTS` ends up. Read with one regular
 * expression: electron-builder writes a two-line document, and this is the
 * only field asked of it.
 */
function packagedEndpoint(): string[] {
  if (!app.isPackaged) return [];
  try {
    const text = readFileSync(
      join(process.resourcesPath, "app-update.yml"),
      "utf8",
    );
    const match = /^url:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text);
    return match?.[1] ? [match[1]] : [];
  } catch {
    return [];
  }
}

/**
 * The release index this shell asks, or `null` when it was given none it can
 * read. A loopback `http:` source is accepted only from a development build
 * with `ARMADRA_UPDATES_DEV=1`, the same exception the manifest fetch makes.
 */
export function releaseSource(env = process.env): string | null {
  return releaseSourceFor(
    env[SOURCE_ENV] ?? "",
    [...configuredEndpoints(env), ...packagedEndpoint()],
    !app.isPackaged && developmentOverride(env),
  );
}

/** This shell's release target, `darwin-aarch64` and so on. */
export function currentTarget(): string | null {
  return shellTarget(process.platform, process.arch);
}
