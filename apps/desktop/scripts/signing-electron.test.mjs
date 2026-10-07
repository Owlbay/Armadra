import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ADHOC_ENV,
  APPLE_API_ISSUER_ENV,
  APPLE_API_KEY_ENV,
  APPLE_API_KEY_ID_ENV,
  APPLE_ID_ENV,
  APPLE_PASSWORD_ENV,
  APPLE_TEAM_ENV,
  AZURE_ACCOUNT_ENV,
  AZURE_CREDENTIAL_ENVS,
  AZURE_ENDPOINT_ENV,
  AZURE_PROFILE_ENV,
  AZURE_TIMESTAMP_URL,
  CERT_ENV,
  CERT_PASSWORD_ENV,
  ENDPOINTS_ENV,
  REQUIRE_ENV,
  WIN_CERT_SHA1_ENV,
  WIN_PUBLISHER_ENV,
  builderArgs,
  checkPublisher,
  configOverride,
  macApps,
  signingPlan,
  verifyMacApps,
  verifyWindowsExecutables,
  windowsExecutables,
} from "./signing-electron.mjs";

/** The macOS plan, whichever runner the test happens to be on. */
function mac(env, fileExists = () => true) {
  return signingPlan({ env, platform: "darwin", fileExists });
}

function win(env) {
  return signingPlan({ env, platform: "win32" });
}

function notarizeEnv() {
  return {
    [APPLE_ID_ENV]: "dev@example.com",
    [APPLE_PASSWORD_ENV]: "app-specific-password",
    [APPLE_TEAM_ENV]: "TEAMID1234",
  };
}

function apiKeyEnv() {
  return {
    [APPLE_API_KEY_ENV]: "/runner/temp/AuthKey.p8",
    [APPLE_API_KEY_ID_ENV]: "ABCDE12345",
    [APPLE_API_ISSUER_ENV]: "69a6de7e-0000-47e3-e053-5b8c7c11a4d1",
  };
}

function certEnv() {
  return { [CERT_ENV]: "base64cert", [CERT_PASSWORD_ENV]: "secret" };
}

function azureEnv() {
  return {
    AZURE_TENANT_ID: "tenant",
    AZURE_CLIENT_ID: "client",
    AZURE_CLIENT_SECRET: "client-secret",
    [AZURE_ENDPOINT_ENV]: "https://eus.codesigning.azure.net",
    [AZURE_ACCOUNT_ENV]: "armadra",
    [AZURE_PROFILE_ENV]: "armadra-public",
    [WIN_PUBLISHER_ENV]: "Owlbay",
  };
}

/* --------------------------------- macOS --------------------------------- */

test("a certificate and full Apple ID credentials sign and notarize", () => {
  const plan = mac({ ...certEnv(), ...notarizeEnv() });
  assert.equal(plan.mode, "sign");
  assert.equal(plan.notarize, true);
  assert.equal(plan.notarizeWith, "appleId");
  assert.deepEqual(plan.unsetEnv, []);
  assert.deepEqual(builderArgs(plan), []);
});

test("an App Store Connect API key notarizes on its own", () => {
  const plan = mac({ ...certEnv(), ...apiKeyEnv() });
  assert.equal(plan.mode, "sign");
  assert.equal(plan.notarize, true);
  assert.equal(plan.notarizeWith, "apiKey");
  assert.match(plan.message, /App Store Connect API key/);
  assert.deepEqual(plan.unsetEnv, []);
});

test("with both credential sets the API key wins and the Apple ID leaves the environment", () => {
  // app-builder-lib takes the Apple ID branch whenever APPLE_ID is set, so the
  // only way for the preferred set to be used is to remove the other one.
  const plan = mac({ ...certEnv(), ...apiKeyEnv(), ...notarizeEnv() });
  assert.equal(plan.notarizeWith, "apiKey");
  assert.deepEqual(plan.unsetEnv, [APPLE_ID_ENV, APPLE_PASSWORD_ENV]);
});

test("a complete API key covers for a half-configured Apple ID", () => {
  const plan = mac({
    ...certEnv(),
    ...apiKeyEnv(),
    [APPLE_ID_ENV]: "dev@example.com",
  });
  assert.equal(plan.mode, "sign");
  assert.equal(plan.notarizeWith, "apiKey");
  assert.deepEqual(plan.unsetEnv, [APPLE_ID_ENV]);
});

test("a complete Apple ID covers for a half-configured API key", () => {
  const plan = mac({
    ...certEnv(),
    ...notarizeEnv(),
    [APPLE_API_KEY_ID_ENV]: "ABCDE12345",
  });
  assert.equal(plan.notarizeWith, "appleId");
  assert.deepEqual(plan.unsetEnv, [APPLE_API_KEY_ID_ENV]);
});

test("a half-configured API key with nothing else is refused, naming what is missing", () => {
  const plan = mac({
    ...certEnv(),
    [APPLE_API_KEY_ID_ENV]: "ABCDE12345",
    [APPLE_API_ISSUER_ENV]: "issuer",
  });
  assert.equal(plan.mode, "refuse");
  assert.equal(plan.reason, "apiKeyCredentialsPartial");
  assert.match(plan.message, new RegExp(`missing: ${APPLE_API_KEY_ENV}`));
});

test("an API key path that does not exist is refused before packaging", () => {
  const plan = mac({ ...certEnv(), ...apiKeyEnv() }, () => false);
  assert.equal(plan.mode, "refuse");
  assert.equal(plan.reason, "apiKeyFileMissing");
});

test("a certificate with no notarize credentials signs without notarizing", () => {
  const plan = mac(certEnv());
  assert.equal(plan.mode, "sign");
  assert.equal(plan.notarize, false);
  assert.deepEqual(builderArgs(plan), [
    "-c",
    JSON.stringify({ mac: { notarize: false } }),
  ]);
});

test("a certificate with no password is refused before packaging", () => {
  const plan = mac({ [CERT_ENV]: "base64cert" });
  assert.equal(plan.mode, "refuse");
  assert.equal(plan.reason, "certPasswordMissing");
  assert.match(plan.message, new RegExp(CERT_PASSWORD_ENV));
});

test("partial Apple ID credentials are refused rather than silently skipped", () => {
  const plan = mac({ ...certEnv(), [APPLE_ID_ENV]: "dev@example.com" });
  assert.equal(plan.mode, "refuse");
  assert.equal(plan.reason, "notarizeCredentialsPartial");
});

test("no certificate skips signing and turns notarization off", () => {
  const plan = mac({});
  assert.equal(plan.mode, "skip");
  assert.equal(plan.reason, "certMissing");
  assert.deepEqual(builderArgs(plan), [
    "-c",
    JSON.stringify({ mac: { notarize: false } }),
  ]);
  assert.match(plan.message, /Gatekeeper will warn/);
});

test("a release build refuses to be unsigned", () => {
  const plan = mac({ [REQUIRE_ENV]: "1" });
  assert.equal(plan.mode, "refuse");
  assert.equal(plan.reason, "certRequired");
});

test("ARMADRA_REQUIRE_SIGNED_BUNDLE=0 does not count as required", () => {
  assert.equal(mac({ [REQUIRE_ENV]: "0" }).mode, "skip");
});

test("the ad-hoc rehearsal signs with identity '-' and never notarizes", () => {
  const plan = mac({ [ADHOC_ENV]: "1", ...notarizeEnv() });
  assert.equal(plan.mode, "sign");
  assert.equal(plan.reason, "adHoc");
  assert.equal(plan.notarize, false);
  assert.deepEqual(plan.configOverride, {
    mac: { identity: "-", notarize: false },
  });
  // A rehearsal is never a release, and never sits beside a real certificate.
  assert.equal(
    mac({ [ADHOC_ENV]: "1", [REQUIRE_ENV]: "1" }).reason,
    "adHocNotRelease",
  );
  assert.equal(
    mac({ [ADHOC_ENV]: "1", ...certEnv() }).reason,
    "adHocWithCertificate",
  );
  assert.equal(mac({ [ADHOC_ENV]: "0" }).mode, "skip");
});

/* -------------------------------- Windows -------------------------------- */

test("complete Azure Artifact Signing merges azureSignOptions with an explicit timestamp", () => {
  const plan = win(azureEnv());
  assert.equal(plan.mode, "sign");
  assert.equal(plan.reason, "azureSigning");
  assert.deepEqual(plan.configOverride.win, {
    azureSignOptions: {
      publisherName: "Owlbay",
      endpoint: "https://eus.codesigning.azure.net",
      codeSigningAccountName: "armadra",
      certificateProfileName: "armadra-public",
      fileDigest: "SHA256",
      timestampRfc3161: AZURE_TIMESTAMP_URL,
      timestampDigest: "SHA256",
    },
  });
  // The credentials themselves stay in the environment, never in the config
  // that electron-builder logs.
  assert.doesNotMatch(JSON.stringify(plan.configOverride), /client-secret/);
});

test("any missing Azure field is refused, and the block is never merged half-filled", () => {
  for (const name of [
    ...AZURE_CREDENTIAL_ENVS,
    AZURE_ENDPOINT_ENV,
    AZURE_ACCOUNT_ENV,
    AZURE_PROFILE_ENV,
    WIN_PUBLISHER_ENV,
  ]) {
    const env = azureEnv();
    delete env[name];
    const plan = win(env);
    assert.equal(plan.mode, "refuse", name);
    assert.equal(plan.reason, "azureCredentialsPartial", name);
    assert.match(plan.message, new RegExp(name), name);
    assert.equal(plan.configOverride, null, name);
  }
});

test("Azure and a certificate file together are ambiguous", () => {
  const plan = win({ ...azureEnv(), ...certEnv() });
  assert.equal(plan.reason, "windowsSigningAmbiguous");
  assert.equal(
    win({ ...certEnv(), [WIN_CERT_SHA1_ENV]: "ab".repeat(20) }).reason,
    "windowsSigningAmbiguous",
  );
});

test("a certificate file signs, with the publisher pinned when one is named", () => {
  const plain = win(certEnv());
  assert.equal(plain.mode, "sign");
  assert.equal(plain.reason, "certificatePresent");
  assert.equal(plain.configOverride.win, undefined);
  assert.match(plain.message, new RegExp(`${WIN_PUBLISHER_ENV} is not set`));

  const pinned = win({ ...certEnv(), [WIN_PUBLISHER_ENV]: "Owlbay" });
  assert.deepEqual(pinned.configOverride.win, {
    signtoolOptions: { publisherName: "Owlbay" },
  });
  assert.equal(win({ [CERT_ENV]: "x" }).reason, "certPasswordMissing");
});

test("a self-hosted runner signs from its certificate store by thumbprint", () => {
  const plan = win({
    [WIN_CERT_SHA1_ENV]: "AB".repeat(20),
    [WIN_PUBLISHER_ENV]: "Owlbay",
  });
  assert.equal(plan.reason, "certificateStore");
  assert.deepEqual(plan.configOverride.win, {
    signtoolOptions: {
      certificateSha1: "AB".repeat(20),
      publisherName: "Owlbay",
    },
  });
});

test("an unconfigured Windows build is an honest skip; a required one is refused", () => {
  const plan = win({});
  assert.equal(plan.mode, "skip");
  assert.match(plan.message, /never installs automatically/);
  // A Windows build keeps the macOS notarize switch off like every unsigned one.
  assert.deepEqual(plan.configOverride, { mac: { notarize: false } });
  assert.equal(win({ [REQUIRE_ENV]: "1" }).reason, "certRequired");
  // Apple credentials mean nothing on Windows.
  assert.equal(win({ ...notarizeEnv() }).mode, "skip");
});

test("the publisher check is exact, and passes when nothing is pinned", () => {
  assert.equal(
    checkPublisher({ subject: "Owlbay", publisherName: "Owlbay" }).ok,
    true,
  );
  assert.equal(
    checkPublisher({ subject: "Owlbay Ltd", publisherName: "Owlbay" }).ok,
    false,
  );
  assert.equal(
    checkPublisher({ subject: "owlbay", publisherName: "Owlbay" }).ok,
    false,
  );
  assert.equal(
    checkPublisher({ subject: "Anyone", publisherName: "" }).ok,
    true,
  );
});

/* ------------------------------ endpoints ------------------------------- */

test("ARMADRA_UPDATER_ENDPOINTS overrides publish.url, merged with the signing override", () => {
  const plan = mac({});
  const override = configOverride(plan, {
    [ENDPOINTS_ENV]:
      "https://updates.armadra.dev/stable, https://updates.armadra.dev/mirror",
  });
  assert.deepEqual(override, {
    mac: { notarize: false },
    publish: { provider: "generic", url: "https://updates.armadra.dev/stable" },
  });
});

test("no ARMADRA_UPDATER_ENDPOINTS leaves the plan's own override untouched", () => {
  const plan = mac({ ...certEnv(), ...notarizeEnv() });
  assert.equal(configOverride(plan, {}), null);
  assert.deepEqual(builderArgs(plan, {}), []);
});

/* --------------------------- post-build checks --------------------------- */

function releaseTree() {
  const root = mkdtempSync(join(tmpdir(), "armadra-signing-"));
  mkdirSync(join(root, "mac-arm64", "Armadra.app"), { recursive: true });
  mkdirSync(join(root, "win-arm64-unpacked"), { recursive: true });
  writeFileSync(join(root, "win-arm64-unpacked", "armadra.exe"), "");
  writeFileSync(join(root, "Armadra-Setup-0.1.0-arm64.exe"), "");
  writeFileSync(join(root, "latest.yml"), "");
  return root;
}

test("codesign --verify --deep --strict runs over every built .app", () => {
  const root = releaseTree();
  try {
    assert.deepEqual(macApps(root), [join(root, "mac-arm64", "Armadra.app")]);
    const calls = [];
    const ok = verifyMacApps(root, (file, args) => calls.push([file, ...args]));
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(calls[0].slice(0, 4), [
      "codesign",
      "--verify",
      "--deep",
      "--strict",
    ]);
    const failed = verifyMacApps(root, () => {
      const error = new Error("exit 1");
      error.stderr = "a sealed resource is missing or invalid";
      throw error;
    });
    assert.match(failed.problems[0], /sealed resource/);
    assert.match(verifyMacApps(join(root, "none")).problems[0], /no \.app/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every installer and the unpacked app must report Authenticode Valid", () => {
  const root = releaseTree();
  try {
    assert.deepEqual(windowsExecutables(root), [
      join(root, "Armadra-Setup-0.1.0-arm64.exe"),
      join(root, "win-arm64-unpacked", "armadra.exe"),
    ]);
    assert.deepEqual(
      verifyWindowsExecutables(root, () => "Valid").problems,
      [],
    );
    const self = verifyWindowsExecutables(root, () => "UnknownError");
    assert.equal(self.problems.length, 2);
    assert.match(self.problems[0], /UnknownError/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
