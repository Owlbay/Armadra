#!/usr/bin/env node
/**
 * The update path end to end, on a real package (G3-3, external services §2, §3).
 *
 * Two legs, each recorded in `<out>/result.json`:
 *
 *   1. **dev-stack** — the `release` service on 127.0.0.1:8090 (`pnpm dev-stack
 *      up release`): check (and the same check again, answered 304 to its
 *      ETag) → download `latest.json`, `SHA256SUMS`, this target's feed and
 *      bundle → verify every minisign signature with the service's public key
 *      (`tools/dev-stack/.data/release/minisign.pub`) and every digest. That
 *      service publishes placeholder bundles, so this leg stops at "verified".
 *
 *   2. **package** — the packaged app from `dist` (built with
 *      `ARMADRA_DIST_RELEASE=1`, so it carries no disabled-updates marker),
 *      started with a temporary HOME / data directory / profile and
 *      `ARMADRA_UPDATES_DEV=1`, pointed at a release that serves **its own
 *      bytes** under a higher version, signed with a throwaway minisign key
 *      and hosted by the same `mock-release-server.mjs` the dev-stack service
 *      runs. Driven through the page's own bridge (`window.armadra.updates`):
 *      check → available → download (electron-updater's sha512, then the
 *      Host's sha256) → staged; the staged file on disk is the served zip.
 *      Then the restart:
 *        - an **unsigned** package (`signatureState` unsigned / unknown) must
 *          answer `notSigned` and install nothing — nothing stopped, no
 *          pending-restart record, the app still running;
 *        - a **signed** package (or Linux, where there is no code signature)
 *          installs only with `--install --next <release dir>`: the next
 *          release is a second `dist` with `ARMADRA_DIST_VERSION=<higher>`, and
 *          success is the relaunched app reporting that version. Squirrel.Mac
 *          and Windows check the update's signature against the running app's,
 *          so on those two this needs a real certificate (docs/guides/
 *          ci-release.md §3); an ad-hoc or self-signed package cannot pass it.
 *
 * Never touches an installed Armadra, the user's HOME or keychain, or any real
 * release host: every address is loopback.
 *
 *   ARMADRA_DIST_RELEASE=1 pnpm --filter @armadra/desktop dist
 *   pnpm dev-stack up release
 *   node tools/probes/update-e2e.mjs [<out dir>] [--app <Armadra.app | binary>]
 *     [--release-dir apps/desktop/release] [--build] [--require-dev-stack]
 *     [--install --next <release dir of the higher version>]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { desktopAssets, updaterFeedFile } from "../release/artifacts.mjs";
import { writeChecksums } from "../release/checksums.mjs";
import { verifyServedRelease } from "../release/dry-run.mjs";
import { generateKey, signDetached } from "../release/minisign.mjs";
import { startMockReleaseServer } from "../release/mock-release-server.mjs";
import {
  findBundle,
  formatFeed,
  sha512Base64,
} from "../release/stage-desktop.mjs";
import { writeManifest } from "../release/updater-manifest.mjs";
import { withoutModulePath } from "../../apps/desktop/scripts/signing-electron.mjs";
import {
  LAUNCHD_PATH,
  attachToRenderer,
  cdp,
  freePort,
} from "./core-terminal-packaged.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEV_STACK_SOURCE = "http://127.0.0.1:8090/repos/armadra/armadra";
const DEV_STACK_KEY = join(root, "tools/dev-stack/.data/release/minisign.pub");

/* ---------------------------------- args --------------------------------- */

export function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const takes = new Set(["--app", "--release-dir", "--next"]);
  const positional = argv.filter(
    (arg, index) => !arg.startsWith("--") && !takes.has(argv[index - 1]),
  );
  return {
    out: resolve(positional[0] ?? join(root, "target/update-e2e")),
    app: value("app"),
    releaseDir: resolve(
      value("release-dir") ?? join(root, "apps/desktop/release"),
    ),
    next: value("next") ? resolve(value("next")) : undefined,
    build: argv.includes("--build"),
    install: argv.includes("--install"),
    requireDevStack: argv.includes("--require-dev-stack"),
  };
}

/* --------------------------------- target -------------------------------- */

export function hostTarget(platform = process.platform, arch = process.arch) {
  const system = { darwin: "darwin", win32: "windows", linux: "linux" }[
    platform
  ];
  const cpu = { arm64: "aarch64", x64: "x86_64" }[arch];
  return system && cpu ? `${system}-${cpu}` : null;
}

/** The `.app` / unpacked directory / AppImage `dist` left for this target. */
export function packagedApp(
  releaseDir,
  platform = process.platform,
  arch = process.arch,
) {
  if (platform === "darwin") {
    for (const name of [
      arch === "arm64" ? "mac-arm64" : "mac",
      "mac",
      "mac-arm64",
    ]) {
      const candidate = join(releaseDir, name, "Armadra.app");
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
  if (platform === "win32") {
    for (const name of [
      arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked",
    ]) {
      const candidate = join(releaseDir, name, "armadra.exe");
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
  // electron-updater on Linux only updates an AppImage (it reads $APPIMAGE).
  return (
    findBundle({
      bundle: releaseDir,
      kind: "AppImage",
      target: hostTarget(platform, arch),
    }) ?? undefined
  );
}

/** The executable inside what `packagedApp` found. */
export function executableOf(app) {
  if (app.endsWith(".app")) return join(app, "Contents", "MacOS", "armadra");
  return app;
}

/**
 * What the probe expects the package's own `signatureState` to be — the same
 * reads `apps/desktop/src/main/updates/environment.ts` makes.
 */
export function expectedSignature(app, platform = process.platform) {
  if (platform === "linux") return "notApplicable";
  if (platform === "darwin")
    return existsSync(join(app, "Contents", "_CodeSignature", "CodeResources"))
      ? "signed"
      : "unsigned";
  if (platform === "win32") {
    try {
      const status = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-AuthenticodeSignature -LiteralPath '${app.replace(/'/g, "''")}').Status.ToString()`,
        ],
        // Windows PowerShell 5.1 under a PowerShell 7 parent: see signing-electron.mjs.
        { encoding: "utf8", env: withoutModulePath(process.env) },
      ).trim();
      return status === "Valid"
        ? "signed"
        : status === "NotSigned"
          ? "unsigned"
          : "unknown";
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

/** A version strictly above `version` that the stable channel still offers. */
export function nextVersion(version) {
  const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/* ------------------------------ the release ------------------------------ */

/**
 * A release of `version` that carries `bundle` as this target's updater
 * package: the published name, a per-target feed, a minisign signature by
 * `key`, `latest.json` and `SHA256SUMS` (both signed) — the shape
 * `assemble.mjs` produces, with download URLs on `base`.
 */
export async function buildRelease({
  directory,
  version,
  target,
  bundle,
  base,
  key,
}) {
  mkdirSync(directory, { recursive: true });
  const tag = `v${version}`;
  const updater = desktopAssets(version, target).find((asset) => asset.updater);
  const published = join(directory, updater.name);
  cpSync(bundle, published);
  const bytes = readFileSync(published);
  writeFileSync(
    `${published}.sig`,
    signDetached(key, bytes, `file:${updater.name} version:${version}`),
  );
  writeFileSync(
    join(directory, updaterFeedFile(target)),
    formatFeed({
      version,
      files: [
        { url: updater.name, sha512: sha512Base64(bytes), size: bytes.length },
      ],
      releaseDate: new Date().toISOString(),
    }),
  );
  writeManifest({
    directory,
    version,
    notes: `Armadra ${version} (update-e2e)`,
    targets: [target],
    downloadUrl: (name) =>
      `${base}/download/${tag}/${encodeURIComponent(name)}`,
  });
  await writeChecksums(directory);
  for (const name of ["latest.json", "SHA256SUMS"]) {
    writeFileSync(
      join(directory, `${name}.sig`),
      signDetached(key, readFileSync(join(directory, name)), `file:${name}`),
    );
  }
  return {
    tag,
    name: updater.name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

/** The electron-builder updater bundle for this target in a release directory. */
export function updaterBundle(releaseDir, target) {
  const kind = desktopAssets("0.0.0", target).find(
    (asset) => asset.updater,
  ).kind;
  return findBundle({ bundle: releaseDir, kind, target });
}

/* ------------------------------- the app --------------------------------- */

/** Evaluated in the renderer: the page's own updater bridge, step by step. */
const IN_PAGE_CHECK = `(async () => {
  const u = globalThis.window?.armadra?.updates;
  if (!u) return { ok: false, reason: "no window.armadra.updates bridge" };
  const before = await u.state();
  const checked = await u.check();
  const downloaded = checked?.state === "available" ? await u.download() : null;
  return { ok: true, before, checked, downloaded };
})()`;

const IN_PAGE_INSTALL = `(async () => {
  const u = globalThis.window?.armadra?.updates;
  return await u.install();
})()`;

const IN_PAGE_REPORT = `(async () => {
  const u = globalThis.window?.armadra?.updates;
  return { report: await u.restartReport(), state: await u.state() };
})()`;

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails !== undefined)
    throw new Error(
      `the page threw: ${JSON.stringify(result.exceptionDetails)}`,
    );
  return result.result.value;
}

/**
 * Waits until the page has settled on the shell's bridge. The renderer
 * navigates once while it starts (a loopback address the core hands it), and
 * an evaluation that straddles that navigation dies with "Execution context
 * was destroyed".
 */
async function waitForBridge(client) {
  let last = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const ready = await evaluate(
        client,
        `document.readyState === "complete" && typeof globalThis.window?.armadra?.updates?.state === "function"`,
      );
      if (ready === true) {
        await delay(1500);
        const again = await evaluate(
          client,
          `typeof globalThis.window?.armadra?.updates?.state === "function"`,
        );
        if (again === true) return;
      }
    } catch (error) {
      last = String(error?.message ?? error);
    }
    await delay(500);
  }
  throw new Error(`the page never exposed window.armadra.updates (${last})`);
}

/** Starts the packaged app against `source`, isolated in `sandbox`. */
async function launch({ executable, sandbox, source, extraEnv = {} }) {
  const port = await freePort();
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${join(sandbox, "electron")}`,
    "--use-mock-keychain",
  ];
  if (process.platform === "linux") args.push("--no-sandbox");
  const env = {
    ...process.env,
    ARMADRA_DATA_DIR: join(sandbox, "data"),
    HOME: join(sandbox, "home"),
    USERPROFILE: join(sandbox, "home"),
    LOCALAPPDATA: join(sandbox, "home", "AppData", "Local"),
    ARMADRA_UPDATES_DEV: "1",
    ARMADRA_UPDATER_SOURCE: source,
    ...(process.platform === "darwin" ? { PATH: LAUNCHD_PATH } : {}),
    ...(process.platform === "linux" ? { APPIMAGE_EXTRACT_AND_RUN: "1" } : {}),
    ...extraEnv,
  };
  for (const dir of [env.ARMADRA_DATA_DIR, env.HOME, env.LOCALAPPDATA])
    mkdirSync(dir, { recursive: true });
  const child = spawn(executable, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so `stop` can end the whole tree: Electron's
    // helpers, the core it owns and (on Linux) the AppImage runtime's child
    // outlive the main process and keep writing into the sandbox — the rm
    // after the leg then met ENOTEMPTY.
    detached: process.platform !== "win32",
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  const client = cdp(await attachToRenderer(port));
  await client.ready;
  await waitForBridge(client);
  return { child, client, exited, log: () => log };
}

async function stop(running) {
  if (!running) return;
  try {
    running.client.close();
  } catch {
    // Already gone.
  }
  const group =
    process.platform !== "win32" && running.child.pid
      ? -running.child.pid
      : null;
  const signal = (name) => {
    try {
      if (group !== null) process.kill(group, name);
      else running.child.kill(name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  const settled = await Promise.race([
    running.exited,
    delay(5000).then(() => null),
  ]);
  if (settled === null) signal("SIGKILL");
  if (group === null) return;
  // The main process going is not the tree going: wait for the last helper,
  // and stop waiting politely after two seconds.
  for (let waited = 0; waited < 100 && groupAlive(group); waited += 1) {
    if (waited === 20) signal("SIGKILL");
    await delay(100);
  }
}

function groupAlive(group) {
  try {
    process.kill(group, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a leg's sandbox. A Chromium helper of a process that has already
 * exited can still be flushing its profile for a moment, so ENOTEMPTY is
 * retried for a few seconds before it counts.
 */
async function removeSandbox(sandbox) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10 });
      return;
    } catch (error) {
      if (attempt >= 20 || error?.code !== "ENOTEMPTY") throw error;
      await delay(500);
    }
  }
}

/** Every file under `directory` whose bytes have this sha256. */
export function filesWithDigest(directory, sha256, size) {
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && statSync(path).size === size) {
        const digest = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
        if (digest === sha256) found.push(path);
      }
    }
  };
  walk(directory);
  return found;
}

/* --------------------------------- legs ---------------------------------- */

async function devStackLeg({ target, required }) {
  let healthy = false;
  try {
    healthy = (await fetch(`${DEV_STACK_SOURCE}/releases`)).ok;
  } catch {
    healthy = false;
  }
  if (!healthy || !existsSync(DEV_STACK_KEY)) {
    return {
      id: "dev-stack",
      status: required ? "failed" : "skipped",
      reason:
        "the dev-stack release service is not up (pnpm dev-stack up release)",
    };
  }
  const { problems, checked, version } = await verifyServedRelease({
    source: DEV_STACK_SOURCE,
    publicKeyText: readFileSync(DEV_STACK_KEY, "utf8"),
    targets: [target],
  });
  return {
    id: "dev-stack",
    status: problems.length === 0 ? "passed" : "failed",
    version,
    checked,
    problems,
  };
}

async function packageLeg({ options, target, report }) {
  const app = options.app
    ? resolve(options.app)
    : packagedApp(options.releaseDir);
  if (!app || !existsSync(app))
    return {
      id: "package",
      status: "failed",
      reason: `no packaged app (looked in ${options.releaseDir}); build with ARMADRA_DIST_RELEASE=1 pnpm --filter @armadra/desktop dist, or pass --build`,
    };
  const marker = readPackagedMarker(app);
  if (marker === "disabled")
    return {
      id: "package",
      status: "failed",
      reason: `${app} is a local build (armadraUpdates: "disabled"); rebuild with ARMADRA_DIST_RELEASE=1`,
    };
  const bundle = updaterBundle(options.releaseDir, target);
  if (!bundle)
    return {
      id: "package",
      status: "failed",
      reason: `no updater bundle for ${target} in ${options.releaseDir}`,
    };
  const signature = expectedSignature(app);
  const installs = signature === "signed" || signature === "notApplicable";
  const current = packagedVersion(app);
  const version = nextVersion(current);

  const sandbox = mkdtempSync(join(tmpdir(), "armadra-update-e2e-"));
  const key = generateKey();
  const leg = {
    id: "package",
    app,
    signature,
    current,
    offered: version,
    steps: [],
  };
  let running = null;
  let log = () => "";
  try {
    // The port is chosen first: the release's download URLs name it, and the
    // server builds its index from the release when it starts.
    const releaseDir = join(sandbox, "release");
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const published = await buildRelease({
      directory: releaseDir,
      version,
      target,
      bundle,
      base,
      key,
    });
    const served = await startMockReleaseServer({
      releases: [
        {
          directory: releaseDir,
          tag: published.tag,
          body: `Armadra ${version}`,
        },
      ],
      port,
    });
    leg.source = served.source;
    try {
      running = await launch({
        executable: executableOf(app),
        sandbox,
        source: served.source,
      });
      log = running.log;
      const walked = await evaluate(running.client, IN_PAGE_CHECK);
      leg.steps.push({
        step: "check",
        state: walked.checked?.state,
        before: walked.before?.state,
      });
      const offer = walked.checked?.offer;
      const fail = (reason) => {
        leg.status = "failed";
        leg.reason = reason;
        return leg;
      };
      if (!walked.ok) return fail(walked.reason);
      if (walked.before?.state !== "idle")
        return fail(
          `the package started in ${JSON.stringify(walked.before)}, not idle`,
        );
      if (walked.checked?.state !== "available" || offer?.version !== version)
        return fail(`check answered ${JSON.stringify(walked.checked)}`);
      if (offer.sha256 !== published.sha256)
        return fail(
          `the offer names sha256 ${offer.sha256}, the release ${published.sha256}`,
        );
      leg.steps.push({
        step: "download",
        state: walked.downloaded?.state,
        phase: walked.downloaded?.phase,
      });
      if (
        walked.downloaded?.state !== "downloaded" ||
        walked.downloaded.phase !== "ready"
      )
        return fail(`download answered ${JSON.stringify(walked.downloaded)}`);
      const staged = filesWithDigest(
        join(sandbox, "home"),
        published.sha256,
        published.size,
      );
      leg.steps.push({ step: "staged", files: staged });
      if (staged.length === 0)
        return fail(
          "nothing under the temporary HOME has the served bytes: the update was not staged",
        );
      const fetched = served.requests.filter((url) =>
        url.includes("/download/"),
      );
      leg.steps.push({ step: "requests", fetched });

      if (!installs) {
        const answer = await evaluate(running.client, IN_PAGE_INSTALL);
        leg.steps.push({
          step: "install",
          state: answer?.state,
          problem: answer?.problem,
        });
        if (answer?.state !== "downloaded" || answer.problem !== "notSigned")
          return fail(
            `an unsigned package's install answered ${JSON.stringify(answer)}, not notSigned`,
          );
        if (
          existsSync(join(sandbox, "data", "updates", "pending-restart.json"))
        )
          return fail("an unsigned package wrote a pending-restart record");
        // Still running: nothing quit for an install that never started.
        const alive = await Promise.race([
          running.exited.then(() => false),
          delay(1500).then(() => true),
        ]);
        if (!alive) return fail("the app exited after a refused install");
        leg.status = "passed";
        leg.verified =
          "check → download → verify → staged; install refused (notSigned)";
        return leg;
      }

      if (!options.install) {
        leg.status = "passed";
        leg.verified = "check → download → verify → staged";
        leg.note =
          "the install leg runs with --install --next <release dir of a higher version>";
        return leg;
      }
      return await installLeg({
        options,
        leg,
        running,
        sandbox,
        target,
        key,
        app,
        report,
      });
    } finally {
      await stop(running);
      running = null;
      await served.close();
    }
  } catch (error) {
    leg.status = "failed";
    leg.reason = String(error?.stack ?? error);
    return leg;
  } finally {
    if (leg.status !== "passed") report.logTail = log().slice(-4000);
    await removeSandbox(sandbox);
  }
}

/**
 * Install → restart → version changed. The release served here is the
 * `--next` build (a real higher version); the app being updated is a copy
 * in the sandbox, so the release directory is never replaced.
 */
async function installLeg({ options, leg, sandbox, target, key, app }) {
  if (!options.next) {
    leg.status = "failed";
    leg.reason =
      "--install needs --next <release dir built with ARMADRA_DIST_VERSION>";
    return leg;
  }
  const nextApp = packagedApp(options.next);
  const nextVersionValue = nextApp ? packagedVersion(nextApp) : null;
  const nextBundle = updaterBundle(options.next, target);
  if (!nextBundle || !nextVersionValue) {
    leg.status = "failed";
    leg.reason = `no packaged app and updater bundle in ${options.next}`;
    return leg;
  }
  const installed = join(sandbox, "installed");
  mkdirSync(installed, { recursive: true });
  const copy = join(installed, app.split(/[\\/]/).pop());
  cpSync(app, copy, { recursive: true, verbatimSymlinks: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const releaseDir = join(sandbox, "release-next");
  const published = await buildRelease({
    directory: releaseDir,
    version: nextVersionValue,
    target,
    bundle: nextBundle,
    base,
    key,
  });
  const served = await startMockReleaseServer({
    releases: [
      {
        directory: releaseDir,
        tag: published.tag,
        body: `Armadra ${nextVersionValue}`,
      },
    ],
    port,
  });
  let running = null;
  try {
    const extraEnv = process.platform === "linux" ? { APPIMAGE: copy } : {};
    running = await launch({
      executable: executableOf(copy),
      sandbox,
      source: served.source,
      extraEnv,
    });
    const walked = await evaluate(running.client, IN_PAGE_CHECK);
    if (walked.downloaded?.state !== "downloaded") {
      leg.status = "failed";
      leg.reason = `the next release did not stage: ${JSON.stringify(walked)}`;
      return leg;
    }
    void evaluate(running.client, IN_PAGE_INSTALL).catch(() => undefined);
    const exit = await Promise.race([
      running.exited,
      delay(120_000).then(() => null),
    ]);
    leg.steps.push({ step: "install", exit });
    if (exit === null) {
      leg.status = "failed";
      leg.reason = "the app did not quit to install within two minutes";
      return leg;
    }
    // Give the installer (ShipIt / NSIS / the AppImage swap) time to finish.
    await delay(15_000);
    running = await launch({
      executable: executableOf(copy),
      sandbox,
      source: served.source,
      extraEnv,
    });
    const after = await evaluate(running.client, IN_PAGE_REPORT);
    leg.steps.push({ step: "restart", report: after.report });
    if (
      after.report?.outcome !== "completed" ||
      after.report.version !== nextVersionValue
    ) {
      leg.status = "failed";
      leg.reason = `after the restart: ${JSON.stringify(after)}`;
      return leg;
    }
    leg.status = "passed";
    leg.verified = `check → download → verify → staged → installed → restarted on ${nextVersionValue}`;
    return leg;
  } finally {
    await stop(running);
    await served.close();
  }
}

function packagedResources(app) {
  if (app.endsWith(".app")) return join(app, "Contents", "Resources");
  if (app.endsWith(".exe")) return join(dirname(app), "resources");
  return null;
}

/** The `armadraUpdates` marker in the packaged package.json (asar), if any. */
function readPackagedMarker(app) {
  return readPackagedJson(app)?.armadraUpdates;
}

function packagedVersion(app) {
  return readPackagedJson(app)?.version ?? "0.0.0";
}

/**
 * `package.json` out of `app.asar` without extracting it: the asar header is
 * a JSON index of offsets, so one read finds the file.
 */
export function readPackagedJson(app) {
  const resources = packagedResources(app);
  if (!resources) {
    // An AppImage: the version is in its name, and the marker is not readable
    // without mounting it. Assume a release build was handed in.
    const match = /(\d+\.\d+\.\d+)/.exec(app.split(/[\\/]/).pop());
    return match ? { version: match[1] } : null;
  }
  const asar = join(resources, "app.asar");
  if (!existsSync(asar)) return null;
  const bytes = readFileSync(asar);
  const headerSize = bytes.readUInt32LE(4);
  const jsonSize = bytes.readUInt32LE(12);
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString("utf8"));
  const entry = header.files?.["package.json"];
  if (!entry) return null;
  const start = 8 + headerSize + Number(entry.offset);
  return JSON.parse(bytes.subarray(start, start + entry.size).toString("utf8"));
}

/* ---------------------------------- main --------------------------------- */

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  mkdirSync(options.out, { recursive: true });
  const target = hostTarget();
  const report = {
    status: "failed",
    target,
    legs: [],
    startedAt: new Date().toISOString(),
  };
  if (target === null) {
    report.reason = `no release target for ${process.platform}-${process.arch}`;
  } else {
    if (options.build && !packagedApp(options.releaseDir)) {
      execFileSync("pnpm", ["--filter", "@armadra/desktop", "dist"], {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, ARMADRA_DIST_RELEASE: "1" },
        shell: process.platform === "win32",
      });
    }
    report.legs.push(
      await devStackLeg({ target, required: options.requireDevStack }),
    );
    report.legs.push(await packageLeg({ options, target, report }));
    report.status = report.legs.every((leg) => leg.status !== "failed")
      ? "passed"
      : "failed";
  }
  writeFileSync(
    join(options.out, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  for (const leg of report.legs)
    console.log(
      `${leg.status === "passed" ? "✓" : leg.status === "skipped" ? "-" : "✗"} ${leg.id}: ${leg.verified ?? leg.reason ?? [...(leg.checked ?? []), ...(leg.problems ?? [])].join("; ")}`,
    );
  if (report.status !== "passed" && report.logTail)
    console.error(report.logTail);
  return report.status === "passed" ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(await main());
}
