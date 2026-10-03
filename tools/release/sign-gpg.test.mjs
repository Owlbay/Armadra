import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkNames } from "./assemble.mjs";
import {
  KEY_ENV,
  PASSPHRASE_ENV,
  PUBLIC_KEY_ASSET,
  available,
  fingerprints,
  gpgPlan,
  linuxPackages,
  rehearsalKey,
  signLinuxPackages,
  verifyLinuxPackages,
} from "./sign-gpg.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "armadra-gpg-test-"));
}

test("nothing configured skips, a passphrase alone is refused", () => {
  assert.equal(gpgPlan({}).mode, "skip");
  assert.equal(gpgPlan({ [KEY_ENV]: "-----BEGIN PGP" }).mode, "sign");
  assert.match(gpgPlan({ [KEY_ENV]: "k" }).message, /must have none/);
  assert.equal(gpgPlan({ [KEY_ENV]: "k", [PASSPHRASE_ENV]: "p" }).mode, "sign");
  const refused = gpgPlan({ [PASSPHRASE_ENV]: "p" });
  assert.equal(refused.mode, "refuse");
  assert.match(refused.message, new RegExp(KEY_ENV));
});

test("only the three Linux package kinds are signed", () => {
  const dir = scratch();
  try {
    for (const name of [
      "Armadra_0.2.0_linux-x86_64.AppImage",
      "Armadra_0.2.0_linux-x86_64.deb",
      "Armadra_0.2.0_linux-x86_64.rpm",
      "Armadra_0.2.0_linux-x86_64.AppImage.asc",
      "Armadra_0.2.0_darwin-aarch64.zip",
      "latest-linux-x86_64-linux.yml",
    ])
      writeFileSync(join(dir, name), "");
    assert.deepEqual(linuxPackages(dir), [
      "Armadra_0.2.0_linux-x86_64.AppImage",
      "Armadra_0.2.0_linux-x86_64.deb",
      "Armadra_0.2.0_linux-x86_64.rpm",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the release name check accepts .asc signatures and the public key", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "Armadra_0.2.0_linux-x86_64.deb"), "");
    writeFileSync(join(dir, "Armadra_0.2.0_linux-x86_64.deb.asc"), "");
    writeFileSync(join(dir, PUBLIC_KEY_ASSET), "");
    assert.deepEqual(checkNames(dir), []);
    // Anything else without a component is still refused.
    writeFileSync(join(dir, "armadra-other.gpg"), "");
    assert.equal(checkNames(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fingerprints are read from a --with-colons listing", () => {
  const listing = [
    "sec:u:3072:1:AAAABBBBCCCCDDDD:1700000000:1700086400::u:::scESC:::+:::23::0:",
    "fpr:::::::::0123456789ABCDEF0123456789ABCDEF01234567:",
    "uid:u::::1700000000::HASH::Armadra rehearsal <r@armadra.invalid>::::::::::0:",
  ].join("\n");
  assert.deepEqual(fingerprints(listing), [
    "0123456789ABCDEF0123456789ABCDEF01234567",
  ]);
});

/**
 * The real thing, with a throwaway key. Runs wherever gpg is installed (the
 * ubuntu CI rows have it); the rpm half also needs rpmbuild and rpmsign.
 */
// Not on Windows: the gpg Git for Windows puts on PATH is an MSYS build that
// reads `--homedir C:\…` its own way, and the release signs on ubuntu anyway.
const skipReason =
  process.platform === "win32"
    ? "Linux packages are signed on ubuntu"
    : available("gpg")
      ? false
      : "gpg is not installed";
test(
  "a throwaway key signs, verifies, and catches a changed package",
  { skip: skipReason },
  () => {
    const root = scratch();
    try {
      const keys = join(root, "keys");
      const { fingerprint, armored, passphrase } = rehearsalKey({ out: keys });
      assert.match(fingerprint, /^[0-9A-F]{40}$/);
      assert.ok(existsSync(join(keys, PUBLIC_KEY_ASSET)));

      const dir = join(root, "artifacts");
      mkdirSync(dir);
      writeFileSync(
        join(dir, "Armadra_0.2.0_linux-x86_64.AppImage"),
        "appimage bytes\n",
      );
      writeFileSync(join(dir, "Armadra_0.2.0_linux-x86_64.deb"), "deb bytes\n");
      const rpm = buildTinyRpm(root);
      if (rpm)
        execFileSync("cp", [rpm, join(dir, "Armadra_0.2.0_linux-x86_64.rpm")]);

      const { written } = signLinuxPackages({
        directory: dir,
        armoredKey: armored,
        passphrase,
        published: join(keys, PUBLIC_KEY_ASSET),
      });
      assert.ok(written.includes("Armadra_0.2.0_linux-x86_64.AppImage.asc"));
      assert.ok(written.includes(PUBLIC_KEY_ASSET));
      if (rpm)
        assert.ok(written.includes("Armadra_0.2.0_linux-x86_64.rpm (rpmsign)"));
      assert.match(
        readFileSync(join(dir, "Armadra_0.2.0_linux-x86_64.deb.asc"), "utf8"),
        /BEGIN PGP SIGNATURE/,
      );
      assert.deepEqual(
        verifyLinuxPackages({
          directory: dir,
          publicKey: join(dir, PUBLIC_KEY_ASSET),
        }),
        [],
      );

      // One changed byte, and the signature no longer covers the package.
      writeFileSync(join(dir, "Armadra_0.2.0_linux-x86_64.deb"), "deb bytez\n");
      const problems = verifyLinuxPackages({
        directory: dir,
        publicKey: join(dir, PUBLIC_KEY_ASSET),
      });
      assert.equal(problems.length, 1);
      assert.match(problems[0], /deb\.asc does not verify/);

      // A release signed by a key other than the published one is refused.
      const other = rehearsalKey({ out: join(root, "other") });
      assert.throws(
        () =>
          signLinuxPackages({
            directory: dir,
            armoredKey: other.armored,
            passphrase: other.passphrase,
            published: join(keys, PUBLIC_KEY_ASSET),
          }),
        /announces/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

/** A no-file noarch rpm, when rpmbuild and rpmsign are both installed. */
function buildTinyRpm(root) {
  if (!available("rpmbuild") || !available("rpmsign")) return null;
  const top = join(root, "rpmbuild");
  mkdirSync(join(top, "SPECS"), { recursive: true });
  writeFileSync(
    join(top, "SPECS", "tiny.spec"),
    [
      "Name: armadra-tiny",
      "Version: 0.2.0",
      "Release: 1",
      "Summary: signing fixture",
      "License: MIT",
      "BuildArch: noarch",
      "%description",
      "signing fixture",
      "%files",
      "",
    ].join("\n"),
  );
  execFileSync(
    "rpmbuild",
    ["--define", `_topdir ${top}`, "-bb", join(top, "SPECS", "tiny.spec")],
    {
      stdio: "ignore",
    },
  );
  return join(top, "RPMS", "noarch", "armadra-tiny-0.2.0-1.noarch.rpm");
}
