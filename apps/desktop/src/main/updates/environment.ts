import { app } from "electron";
import { execFileSync, spawnSync } from "node:child_process";
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
 * macOS asks `codesign` itself (`macSignatureState`): the bundle must pass
 * `codesign --verify --deep --strict`, and an ad-hoc signature (what a build
 * without a Developer ID gets) is `unknown` — it says the bytes are intact,
 * not who made them. Squirrel.Mac still checks the update against the running
 * app's designated requirement at install time.
 *
 * Windows asks Authenticode itself (`windowsSignatureState`): only `Valid` —
 * a signature that chains to a trusted root and covers these bytes — is
 * `signed`. A self-signed rehearsal certificate is `unknown`, which is
 * refused exactly like no signature at all.
 */
export function signatureState(
  platform: string = process.platform,
  executable: string = process.execPath,
  packaged: boolean = app.isPackaged,
  codesign?: Codesign,
): SignatureState {
  if (!packaged) return "unsigned";
  if (platform === "darwin") {
    // …/Armadra.app/Contents/MacOS/Armadra → …/Armadra.app
    const bundle = dirname(dirname(dirname(executable)));
    return codesign
      ? macSignatureState(bundle, codesign)
      : cachedMacState(bundle);
  }
  // An AppImage, .deb or .rpm carries no code signature; what makes its bytes
  // trustworthy is the feed's own digest plus the sha256 the Host published,
  // and both are checked whether or not anything was signed.
  if (platform === "linux") return "notApplicable";
  if (platform === "win32") return cachedWindowsState(executable);
  return "unknown";
}

/** Runs `codesign` with these arguments; what it printed and how it exited. */
export type Codesign = (args: readonly string[]) => {
  /** `null` when it could not be started or was stopped. */
  status: number | null;
  stdout: string;
  stderr: string;
};

const codesign: Codesign = (args) => {
  const result = spawnSync("/usr/bin/codesign", [...args], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: "pipe",
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

/**
 * `codesign`'s verdict on one bundle, as a `SignatureState`.
 *
 * `--verify --deep --strict` passing and a signature that is not ad-hoc is
 * `signed`; "not signed at all" is `unsigned`; an ad-hoc signature, a failed
 * verification (a tampered or half-signed bundle) or a `codesign` that would
 * not start is `unknown`, and `unknown` is refused (external services §2.2).
 */
export function macSignatureState(
  bundle: string,
  run: Codesign = codesign,
): SignatureState {
  const verify = run(["--verify", "--deep", "--strict", bundle]);
  if (verify.status !== 0) {
    return verify.status !== null &&
      /not signed at all/.test(`${verify.stderr}${verify.stdout}`)
      ? "unsigned"
      : "unknown";
  }
  // `--display` writes its report to standard error.
  const display = run(["--display", "--verbose=2", bundle]);
  if (display.status !== 0) return "unknown";
  return /^Signature=adhoc$/m.test(`${display.stderr}${display.stdout}`)
    ? "unknown"
    : "signed";
}

/**
 * One `codesign` run per process, like the Windows branch: the bundle does not
 * change while it runs (an update replaces it and restarts), and the updater
 * asks on every check. `--deep` reads every nested framework, so it is not
 * something to repeat.
 */
const macStates = new Map<string, SignatureState>();

function cachedMacState(bundle: string): SignatureState {
  let state = macStates.get(bundle);
  if (state === undefined) {
    state = macSignatureState(bundle);
    macStates.set(bundle, state);
  }
  return state;
}

/** Runs one PowerShell command and returns what it printed. */
export type PowerShell = (command: string) => string;

/**
 * The environment Windows PowerShell 5.1 is started with: this one, without
 * `PSModulePath`. A process started from PowerShell 7 inherits a module path
 * that lists 7's modules first, and 5.1 then fails to load
 * `Microsoft.PowerShell.Security` — `Get-AuthenticodeSignature` "not
 * recognised", exit code 0, no status. Without the variable 5.1 builds its
 * own default.
 */
export function windowsPowerShellEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (key.toLowerCase() === "psmodulepath") delete copy[key];
  }
  return copy;
}

const powershell: PowerShell = (command) =>
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      stdio: "pipe",
      env: windowsPowerShellEnv(),
    },
  );

/**
 * `Get-AuthenticodeSignature`'s verdict on one file, as a `SignatureState`.
 *
 * `Valid` is the only `signed`; `NotSigned` is `unsigned`; everything else —
 * `UnknownError` (a self-signed or otherwise untrusted chain), `HashMismatch`,
 * `NotTrusted`, `NotSupportedFileFormat`, a PowerShell that would not start —
 * is `unknown`, and `unknown` is refused (external services §2.2).
 */
export function windowsSignatureState(
  executable: string,
  run: PowerShell = powershell,
): SignatureState {
  const literal = executable.replace(/'/g, "''");
  let status: string;
  try {
    status = run(
      `(Get-AuthenticodeSignature -LiteralPath '${literal}').Status.ToString()`,
    ).trim();
  } catch {
    return "unknown";
  }
  if (status === "Valid") return "signed";
  if (status === "NotSigned") return "unsigned";
  return "unknown";
}

/**
 * One PowerShell start per process: the executable does not change while it
 * runs, and the updater asks on every check.
 */
const windowsStates = new Map<string, SignatureState>();

function cachedWindowsState(executable: string): SignatureState {
  let state = windowsStates.get(executable);
  if (state === undefined) {
    state = windowsSignatureState(executable);
    windowsStates.set(executable, state);
  }
  return state;
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
 * Whether a plain-HTTP release server on loopback may be read.
 *
 * A development build always may for the manifest and the feed (it has no
 * certificate to offer a local server either); the *index* additionally needs
 * `ARMADRA_UPDATES_DEV=1`. A packaged build may only with
 * `ARMADRA_UPDATES_DEV=1`, which is how `tools/probes/update-e2e.mjs` walks a
 * real package against the dev-stack `release` service. Loopback only, never
 * another host, and the platform signature is still what decides whether the
 * staged bytes are ever installed (`installRefusal`).
 */
export function allowInsecureLoopback(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !app.isPackaged || developmentOverride(env);
}

/**
 * The release index this shell asks, or `null` when it was given none it can
 * read. A loopback `http:` source is accepted only with
 * `ARMADRA_UPDATES_DEV=1`, the same exception the manifest fetch makes.
 */
export function releaseSource(env = process.env): string | null {
  return releaseSourceFor(
    env[SOURCE_ENV] ?? "",
    [...configuredEndpoints(env), ...packagedEndpoint()],
    developmentOverride(env),
  );
}

/** This shell's release target, `darwin-aarch64` and so on. */
export function currentTarget(): string | null {
  return shellTarget(process.platform, process.arch);
}
