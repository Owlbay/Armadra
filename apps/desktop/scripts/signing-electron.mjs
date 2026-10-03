/**
 * What `electron-builder` should do about signing and notarization, decided
 * **before** the build starts. Same problem and the same fix as the
 * shell this one replaced (docs/guides/ci-release.md §2.6,
 * docs/design/updates-and-service-install.md §2.5): electron-builder's own
 * `hardenedRuntime` + `notarize: true` in `electron-builder.yml` sign and
 * notarize unconditionally once the packaging step runs, and notarization in
 * particular is a network round-trip at the very end of a multi-minute
 * build. Deciding here, from the environment, means a build that cannot be
 * signed says so in the first second instead of the last one — and the
 * `signingPlan()` shape below is `sign` / `skip` / `refuse`, each with a
 * `reason` and a `message`, which is what `scripts/dist.mjs` reads.
 *
 * The key material is a different system from the updater's own signature
 * (a minisign key pair over the updater artifacts): electron-builder signs and
 * notarizes with the platform's tools, driven by these environment variables
 * (docs/design/external-services.md §2.1, §2.2) —
 *
 *   macOS
 *     CSC_LINK / CSC_KEY_PASSWORD              base64 (or file path) .p12 + its password
 *     APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER
 *                                              App Store Connect API key (.p8 path) — preferred
 *     APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
 *                                              Apple ID notarization — fallback
 *     ARMADRA_MAC_ADHOC_SIGN=1                 local rehearsal: ad-hoc `codesign -s -`
 *
 *   Windows (exactly one of)
 *     AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
 *       + AZURE_SIGNING_ENDPOINT / AZURE_SIGNING_ACCOUNT / AZURE_SIGNING_PROFILE
 *       + ARMADRA_WIN_PUBLISHER_NAME           Azure Artifact Signing
 *     CSC_LINK / CSC_KEY_PASSWORD              an OV .pfx (or a self-signed rehearsal one)
 *     ARMADRA_WIN_CERT_SHA1                    a certificate in the store of a
 *                                              self-hosted runner (USB token)
 *     ARMADRA_WIN_PUBLISHER_NAME               pins `publisherName`, which electron-updater
 *                                              compares with the installer's certificate
 *
 * Can be run directly for the post-build assertions the release workflow makes:
 *
 *   node apps/desktop/scripts/signing-electron.mjs verify-mac [--dir <release dir>]
 *   node apps/desktop/scripts/signing-electron.mjs verify-windows [--dir <release dir>]
 *   node apps/desktop/scripts/signing-electron.mjs check-publisher --subject <certificate CN>
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The p12 certificate (base64 or a file path) electron-builder signs with. */
export const CERT_ENV = "CSC_LINK";
/** Its password. */
export const CERT_PASSWORD_ENV = "CSC_KEY_PASSWORD";
/** notarytool Apple ID credentials — all three together, the fallback set. */
export const APPLE_ID_ENV = "APPLE_ID";
export const APPLE_PASSWORD_ENV = "APPLE_APP_SPECIFIC_PASSWORD";
export const APPLE_TEAM_ENV = "APPLE_TEAM_ID";
/**
 * notarytool App Store Connect API key credentials — all three together, the
 * preferred set. `APPLE_API_KEY` is a *path* to the `.p8`; the release workflow
 * decodes `APPLE_API_KEY_P8_BASE64` into `$RUNNER_TEMP/AuthKey.p8`.
 */
export const APPLE_API_KEY_ENV = "APPLE_API_KEY";
export const APPLE_API_KEY_ID_ENV = "APPLE_API_KEY_ID";
export const APPLE_API_ISSUER_ENV = "APPLE_API_ISSUER";
/** Local rehearsal only: sign with the ad-hoc identity `-`, never notarize. */
export const ADHOC_ENV = "ARMADRA_MAC_ADHOC_SIGN";
/** Set by CI to turn "skip" into a failure: a release must be signed. */
export const REQUIRE_ENV = "ARMADRA_REQUIRE_SIGNED_BUNDLE";
/** Where a *published* release's updater manifest lives; never baked into a local build. */
export const ENDPOINTS_ENV = "ARMADRA_UPDATER_ENDPOINTS";

/** Azure Artifact Signing: the Entra credentials electron-builder's module reads. */
export const AZURE_CREDENTIAL_ENVS = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
];
/** Azure Artifact Signing: the account the certificate profile lives in. */
export const AZURE_ENDPOINT_ENV = "AZURE_SIGNING_ENDPOINT";
export const AZURE_ACCOUNT_ENV = "AZURE_SIGNING_ACCOUNT";
export const AZURE_PROFILE_ENV = "AZURE_SIGNING_PROFILE";
/**
 * The certificate subject's common name, exactly. electron-updater on Windows
 * refuses an update whose installer is signed by anyone else, so this name is
 * what has to survive a certificate rotation.
 */
export const WIN_PUBLISHER_ENV = "ARMADRA_WIN_PUBLISHER_NAME";
/** A certificate already in the store of a self-hosted signing runner. */
export const WIN_CERT_SHA1_ENV = "ARMADRA_WIN_CERT_SHA1";
/** Azure Artifact Signing's own RFC 3161 service (external services §2.2). */
export const AZURE_TIMESTAMP_URL = "http://timestamp.acs.microsoft.com";

const AZURE_ENVS = [
  ...AZURE_CREDENTIAL_ENVS,
  AZURE_ENDPOINT_ENV,
  AZURE_ACCOUNT_ENV,
  AZURE_PROFILE_ENV,
];

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

function refuse(reason, message) {
  return {
    mode: "refuse",
    reason,
    message,
    notarize: false,
    notarizeWith: null,
    configOverride: null,
    unsetEnv: [],
  };
}

/**
 * Decides what this build does about code signing and notarization.
 *
 * "refuse" is for every configuration that is *half* there: a certificate
 * without its password, a notarization credential set missing a field, an
 * Azure profile without its credentials. electron-builder in any of those
 * states fails at the very last step with an error that names none of the
 * variables involved, or — worse — silently produces an unnotarized build.
 * `ARMADRA_REQUIRE_SIGNED_BUNDLE=1` without anything to sign with is refused
 * too. Nothing configured at all is "skip": an honest unsigned build.
 *
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {string} [input.platform] `process.platform` of the build.
 * @param {(path: string) => boolean} [input.fileExists]
 * @returns {{ mode: "sign" | "skip" | "refuse", reason: string, message: string,
 *   notarize: boolean, notarizeWith: "apiKey" | "appleId" | null,
 *   configOverride: object | null, unsetEnv: string[] }}
 */
export function signingPlan({
  env = {},
  platform = process.platform,
  fileExists = existsSync,
} = {}) {
  return platform === "win32" ? windowsPlan(env) : macPlan(env, fileExists);
}

/** Which of `names` are set, and which are not. */
function fields(env, names) {
  const set = names.filter((name) => present(env[name]));
  return {
    set,
    missing: names.filter((name) => !present(env[name])),
    complete: set.length === names.length,
    partial: set.length > 0 && set.length < names.length,
  };
}

function required(env) {
  return present(env[REQUIRE_ENV]) && env[REQUIRE_ENV] !== "0";
}

function macPlan(env, fileExists) {
  const cert = present(env[CERT_ENV]);
  const certPassword = present(env[CERT_PASSWORD_ENV]);
  const adHoc = present(env[ADHOC_ENV]) && env[ADHOC_ENV] !== "0";
  const appleId = fields(env, [
    APPLE_ID_ENV,
    APPLE_PASSWORD_ENV,
    APPLE_TEAM_ENV,
  ]);
  const apiKey = fields(env, [
    APPLE_API_KEY_ENV,
    APPLE_API_KEY_ID_ENV,
    APPLE_API_ISSUER_ENV,
  ]);

  if (adHoc) {
    if (cert)
      return refuse(
        "adHocWithCertificate",
        `${ADHOC_ENV} and ${CERT_ENV} are both set. Ad-hoc signing is the local rehearsal ` +
          "for a build that has no certificate; pick one.",
      );
    if (required(env))
      return refuse(
        "adHocNotRelease",
        `${REQUIRE_ENV} is set, and an ad-hoc signature is not a release signature: ` +
          "Gatekeeper rejects it and an update signed that way cannot replace the installed app.",
      );
    return {
      mode: "sign",
      reason: "adHoc",
      message:
        'Signing ad-hoc (identity "-") for a local rehearsal. The bundle passes ' +
        "`codesign --verify`, but Gatekeeper and Squirrel.Mac only accept a Developer ID signature.",
      notarize: false,
      notarizeWith: null,
      configOverride: { mac: { identity: "-", notarize: false } },
      unsetEnv: [],
    };
  }

  if (cert && !certPassword) {
    return refuse(
      "certPasswordMissing",
      `${CERT_ENV} is set but ${CERT_PASSWORD_ENV} is empty.\n` +
        "electron-builder cannot import a password-protected .p12 without its password, " +
        "and fails at the signing step with a keychain error that names neither variable.",
    );
  }
  if (cert && !apiKey.complete && !appleId.complete) {
    if (apiKey.partial)
      return refuse(
        "apiKeyCredentialsPartial",
        `${APPLE_API_KEY_ENV} / ${APPLE_API_KEY_ID_ENV} / ${APPLE_API_ISSUER_ENV} must be set ` +
          `together (missing: ${apiKey.missing.join(", ")}). A signed-but-not-notarized build ` +
          "is a Gatekeeper warning on every first launch, which is worse than an honest failure here.",
      );
    if (appleId.partial)
      return refuse(
        "notarizeCredentialsPartial",
        `${APPLE_ID_ENV} / ${APPLE_PASSWORD_ENV} / ${APPLE_TEAM_ENV} must be set together or not at all ` +
          `(got ${appleId.set.length} of 3). A signed-but-not-notarized build ` +
          "is a Gatekeeper warning on every first launch, which is worse than an honest failure here.",
      );
  }
  if (cert && apiKey.complete && !fileExists(env[APPLE_API_KEY_ENV])) {
    return refuse(
      "apiKeyFileMissing",
      `${APPLE_API_KEY_ENV} names ${env[APPLE_API_KEY_ENV]}, which does not exist. ` +
        "It is the path of the App Store Connect .p8, not its contents.",
    );
  }
  if (cert) {
    // app-builder-lib takes the Apple ID branch as soon as it sees APPLE_ID
    // (MacTargetHelper.getNotarizeOptions), so when both sets are present the
    // API key only wins if the Apple ID half is taken out of the environment.
    const notarizeWith = apiKey.complete
      ? "apiKey"
      : appleId.complete
        ? "appleId"
        : null;
    const unsetEnv =
      notarizeWith === "apiKey"
        ? [APPLE_ID_ENV, APPLE_PASSWORD_ENV].filter((name) => name in env)
        : notarizeWith === "appleId"
          ? [
              APPLE_API_KEY_ENV,
              APPLE_API_KEY_ID_ENV,
              APPLE_API_ISSUER_ENV,
            ].filter((name) => name in env)
          : [];
    return {
      mode: "sign",
      reason: "certificatePresent",
      message:
        notarizeWith === "apiKey"
          ? `Signing with ${CERT_ENV} and notarizing with the App Store Connect API key ${APPLE_API_KEY_ID_ENV}.`
          : notarizeWith === "appleId"
            ? `Signing with ${CERT_ENV} and notarizing with ${APPLE_ID_ENV}.`
            : `Signing with ${CERT_ENV}; neither ${APPLE_API_KEY_ENV}/${APPLE_API_KEY_ID_ENV}/${APPLE_API_ISSUER_ENV} ` +
              `nor ${APPLE_ID_ENV}/${APPLE_PASSWORD_ENV}/${APPLE_TEAM_ENV} is set, so the build will not be notarized.`,
      notarize: notarizeWith !== null,
      notarizeWith,
      configOverride:
        notarizeWith !== null ? null : { mac: { notarize: false } },
      unsetEnv,
    };
  }
  if (required(env)) {
    return refuse(
      "certRequired",
      `${REQUIRE_ENV} is set, so this build must be signed, but ${CERT_ENV} is empty.\n` +
        `Provide the certificate (base64 .p12) and ${CERT_PASSWORD_ENV}, or unset ${REQUIRE_ENV}.`,
    );
  }
  return {
    mode: "skip",
    reason: "certMissing",
    message:
      `${CERT_ENV} is not set, so this build produces an unsigned, unnotarized bundle. ` +
      "Gatekeeper will warn on first launch. To make a signed build, set " +
      `${CERT_ENV}/${CERT_PASSWORD_ENV} (and ${APPLE_API_KEY_ENV}/${APPLE_API_KEY_ID_ENV}/${APPLE_API_ISSUER_ENV}, ` +
      `or ${APPLE_ID_ENV}/${APPLE_PASSWORD_ENV}/${APPLE_TEAM_ENV}, to notarize).`,
    notarize: false,
    notarizeWith: null,
    // hardenedRuntime + notarize: true in electron-builder.yml both require a
    // signing identity to be meaningful; turning notarize off is what keeps an
    // unsigned local build from failing inside electron-builder's own
    // signing step instead of never reaching it.
    configOverride: { mac: { notarize: false } },
    unsetEnv: [],
  };
}

/**
 * The `win.azureSignOptions` block, from the environment. Merged into the
 * configuration only when every field is present: electron-builder takes the
 * Azure path as soon as the block exists and does not check its credentials
 * first (external services §2.2, electron-builder #8626 / #8828).
 */
export function azureSignOptions(env) {
  return {
    publisherName: env[WIN_PUBLISHER_ENV].trim(),
    endpoint: env[AZURE_ENDPOINT_ENV].trim(),
    codeSigningAccountName: env[AZURE_ACCOUNT_ENV].trim(),
    certificateProfileName: env[AZURE_PROFILE_ENV].trim(),
    fileDigest: "SHA256",
    timestampRfc3161: AZURE_TIMESTAMP_URL,
    timestampDigest: "SHA256",
  };
}

function windowsPlan(env) {
  // A Windows build never packages for macOS; keeping its notarize switch off
  // means the merged configuration reads the same on every runner.
  const macOff = { mac: { notarize: false } };
  const azure = fields(env, AZURE_ENVS);
  const publisher = present(env[WIN_PUBLISHER_ENV])
    ? env[WIN_PUBLISHER_ENV].trim()
    : null;
  const cert = present(env[CERT_ENV]);
  const certPassword = present(env[CERT_PASSWORD_ENV]);
  const storeCert = present(env[WIN_CERT_SHA1_ENV]);
  const paths = [azure.set.length > 0, cert, storeCert].filter(Boolean).length;

  if (paths > 1) {
    return refuse(
      "windowsSigningAmbiguous",
      "More than one Windows signing path is configured: Azure Artifact Signing " +
        `(${AZURE_ENVS.join(" / ")}), a certificate file (${CERT_ENV}) and a certificate ` +
        `in the runner's store (${WIN_CERT_SHA1_ENV}) exclude each other. Configure exactly one.`,
    );
  }
  if (azure.set.length > 0) {
    const missing = [
      ...azure.missing,
      ...(publisher ? [] : [WIN_PUBLISHER_ENV]),
    ];
    if (missing.length > 0)
      return refuse(
        "azureCredentialsPartial",
        `Azure Artifact Signing is half configured (missing: ${missing.join(", ")}). ` +
          "electron-builder takes the Azure path as soon as azureSignOptions exists and only " +
          "fails when it tries to sign, so this build stops here instead.",
      );
    return {
      mode: "sign",
      reason: "azureSigning",
      message: `Signing with Azure Artifact Signing (${env[AZURE_ACCOUNT_ENV].trim()} / ${env[AZURE_PROFILE_ENV].trim()}) as ${publisher}.`,
      notarize: false,
      notarizeWith: null,
      configOverride: {
        ...macOff,
        win: { azureSignOptions: azureSignOptions(env) },
      },
      unsetEnv: [],
    };
  }
  if (cert && !certPassword) {
    return refuse(
      "certPasswordMissing",
      `${CERT_ENV} is set but ${CERT_PASSWORD_ENV} is empty.\n` +
        "electron-builder cannot open a password-protected .pfx without its password.",
    );
  }
  if (cert || storeCert) {
    const signtoolOptions = {
      ...(storeCert ? { certificateSha1: env[WIN_CERT_SHA1_ENV].trim() } : {}),
      ...(publisher ? { publisherName: publisher } : {}),
    };
    return {
      mode: "sign",
      reason: storeCert ? "certificateStore" : "certificatePresent",
      message:
        (storeCert
          ? `Signing with the certificate ${env[WIN_CERT_SHA1_ENV].trim()} in this runner's store`
          : `Signing with ${CERT_ENV}`) +
        (publisher
          ? `, publisher pinned to ${publisher}.`
          : `; ${WIN_PUBLISHER_ENV} is not set, so the updater trusts whatever common name this certificate has.`),
      notarize: false,
      notarizeWith: null,
      configOverride:
        Object.keys(signtoolOptions).length > 0
          ? { ...macOff, win: { signtoolOptions } }
          : macOff,
      unsetEnv: [],
    };
  }
  if (required(env)) {
    return refuse(
      "certRequired",
      `${REQUIRE_ENV} is set, so this build must be signed, but no Windows signing path is configured.\n` +
        `Provide Azure Artifact Signing (${AZURE_ENVS.join(", ")}, ${WIN_PUBLISHER_ENV}), ` +
        `a certificate (${CERT_ENV} / ${CERT_PASSWORD_ENV}), or ${WIN_CERT_SHA1_ENV} on a self-hosted runner.`,
    );
  }
  return {
    mode: "skip",
    reason: "certMissing",
    message:
      "No Windows signing path is configured, so the installer is unsigned: SmartScreen warns, " +
      "Smart App Control blocks it, and the updater reports `unsigned` and never installs automatically.",
    notarize: false,
    notarizeWith: null,
    configOverride: macOff,
    unsetEnv: [],
  };
}

/**
 * Whether a certificate's subject is the publisher the build pins. The
 * comparison is exact, because electron-updater's is.
 */
export function checkPublisher({ subject, publisherName }) {
  const name = String(subject ?? "").trim();
  const wanted = String(publisherName ?? "").trim();
  if (wanted === "")
    return {
      ok: true,
      message: `${WIN_PUBLISHER_ENV} is not set; the certificate's common name ${name} becomes the publisher.`,
    };
  if (name === wanted)
    return { ok: true, message: `Certificate subject matches ${wanted}.` };
  return {
    ok: false,
    message:
      `The certificate's common name is "${name}", but ${WIN_PUBLISHER_ENV} is "${wanted}". ` +
      "An installed copy compares the two on every update and refuses the installer when they differ.",
  };
}

/**
 * The `--config` object electron-builder's CLI accepts for this plan, merged
 * with the updater endpoints a *published* release injects.
 *
 * `ARMADRA_UPDATER_ENDPOINTS` is comma-separated, and the rule is the one the
 * previous shell had: the address a real release polls must arrive from the
 * workflow that publishes to it, never from `electron-builder.yml`, whose
 * `publish.url` is the placeholder every build — signed or not — otherwise
 * shares.
 */
export function configOverride(plan, env = {}) {
  const endpoints = (env[ENDPOINTS_ENV] ?? "")
    .split(",")
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);
  if (endpoints.length === 0) return plan.configOverride;
  return {
    ...(plan.configOverride ?? {}),
    publish: { provider: "generic", url: endpoints[0] },
  };
}

/** The extra `electron-builder` CLI arguments a plan implies. */
export function builderArgs(plan, env = {}) {
  const override = configOverride(plan, env);
  return override ? ["-c", JSON.stringify(override)] : [];
}

/* --------------------------- post-build checks --------------------------- */

/** Every `.app` electron-builder left under `release/mac*`. */
export function macApps(releaseDir) {
  if (!existsSync(releaseDir)) return [];
  const apps = [];
  for (const entry of readdirSync(releaseDir)) {
    if (!entry.startsWith("mac")) continue;
    const folder = join(releaseDir, entry);
    if (!statSync(folder).isDirectory()) continue;
    for (const name of readdirSync(folder)) {
      if (name.endsWith(".app")) apps.push(join(folder, name));
    }
  }
  return apps.sort();
}

/**
 * `codesign --verify --deep --strict` over every built `.app`. A bundle that
 * carries `_CodeSignature` but does not verify is exactly the package that
 * reads as "signed" to the updater and is rejected by Gatekeeper.
 */
export function verifyMacApps(
  releaseDir,
  run = (file, args) =>
    execFileSync(file, args, { encoding: "utf8", stdio: "pipe" }),
) {
  const apps = macApps(releaseDir);
  if (apps.length === 0)
    return { checked: [], problems: [`no .app under ${releaseDir}`] };
  const problems = [];
  for (const app of apps) {
    try {
      run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    } catch (error) {
      const detail = String(error.stderr ?? error.message ?? error).trim();
      problems.push(`${app}: ${detail}`);
    }
  }
  return { checked: apps, problems };
}

/** The installers and portable executables electron-builder left in `release/`. */
export function windowsExecutables(releaseDir) {
  if (!existsSync(releaseDir)) return [];
  const found = readdirSync(releaseDir)
    .filter((name) => name.toLowerCase().endsWith(".exe"))
    .map((name) => join(releaseDir, name));
  // The app itself, inside `win-unpacked` / `win-arm64-unpacked`: the
  // installer being signed says nothing about the executable it installs.
  for (const folder of readdirSync(releaseDir)) {
    const candidate = join(releaseDir, folder, "armadra.exe");
    if (folder.endsWith("-unpacked") && existsSync(candidate))
      found.push(candidate);
  }
  return found.sort();
}

/** `Get-AuthenticodeSignature`'s status of one file, as PowerShell spells it. */
export function authenticodeStatus(
  path,
  run = (file, args) =>
    execFileSync(file, args, { encoding: "utf8", stdio: "pipe" }),
) {
  const literal = path.replace(/'/g, "''");
  const output = run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-AuthenticodeSignature -LiteralPath '${literal}').Status.ToString()`,
  ]);
  return String(output).trim();
}

/** Every built executable must carry a signature Windows calls `Valid`. */
export function verifyWindowsExecutables(
  releaseDir,
  status = authenticodeStatus,
) {
  const files = windowsExecutables(releaseDir);
  if (files.length === 0)
    return { checked: [], problems: [`no .exe under ${releaseDir}`] };
  const problems = [];
  for (const file of files) {
    let state;
    try {
      state = status(file);
    } catch (error) {
      state = `unreadable (${error.message})`;
    }
    if (state !== "Valid") problems.push(`${file}: ${state}`);
  }
  return { checked: files, problems };
}

function flag(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

const here = dirname(fileURLToPath(import.meta.url));

function main(argv) {
  const command = argv[0];
  const releaseDir = resolve(flag(argv, "dir") || join(here, "..", "release"));
  if (command === "verify-mac" || command === "verify-windows") {
    const { checked, problems } =
      command === "verify-mac"
        ? verifyMacApps(releaseDir)
        : verifyWindowsExecutables(releaseDir);
    for (const file of checked) console.log(`checked ${file}`);
    for (const problem of problems) console.error(`✗ ${problem}`);
    return problems.length === 0 ? 0 : 1;
  }
  if (command === "check-publisher") {
    const result = checkPublisher({
      subject: flag(argv, "subject"),
      publisherName: process.env[WIN_PUBLISHER_ENV],
    });
    (result.ok ? console.log : console.error)(
      `${result.ok ? "→" : "✗"} ${result.message}`,
    );
    return result.ok ? 0 : 1;
  }
  if (command === "plan") {
    const plan = signingPlan({ env: process.env });
    console.log(
      JSON.stringify(
        { ...plan, configOverride: configOverride(plan, process.env) },
        null,
        2,
      ),
    );
    return plan.mode === "refuse" ? 1 : 0;
  }
  console.error(
    "usage: node apps/desktop/scripts/signing-electron.mjs <verify-mac | verify-windows | check-publisher --subject CN | plan> [--dir <release dir>]",
  );
  return 2;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv.slice(2)));
}
