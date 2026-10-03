/**
 * GPG signatures for the Linux packages (external services §2.3, W-SIGN-LINUX).
 *
 *   node tools/release/sign-gpg.mjs sign --dir <dir> [--published <public key file>]
 *   node tools/release/sign-gpg.mjs verify --dir <dir> --public-key <file>
 *   node tools/release/sign-gpg.mjs keygen --out <dir>
 *
 * An AppImage carries no signature its runtime checks, and a `.deb` is trusted
 * through a repository's `InRelease`, not by itself — so what a person or a
 * package manager can check is a detached, armored signature beside each
 * file (`<name>.asc`), plus, for an `.rpm`, the package's own signature
 * (`rpmsign --addsign`) that `rpm -K` reads. `latest.json` and `SHA256SUMS`
 * keep their minisign signatures (§2.4): GPG is for people and package
 * managers, minisign is for the updater and the Host.
 *
 * The private key comes from `ARMADRA_LINUX_GPG_KEY` (armored) and its
 * passphrase from `ARMADRA_LINUX_GPG_PASSPHRASE`, never from an argument. It is
 * imported into a throwaway `GNUPGHOME` that is deleted when signing ends, so
 * nothing is added to the runner's (or a developer's) own keyring. The public
 * key is written beside the packages as `armadra-linux.gpg` and published as a
 * release asset; once committed to `apps/web/public/armadra-linux.gpg`, every
 * later release is checked against it, so a rotated key cannot slip out
 * unannounced.
 *
 * `rpmsign --addsign` rewrites the package, so it runs first and the `.asc` is
 * made over the signed bytes. All of this runs before `assemble.mjs`, which
 * then checksums and minisigns the final files.
 *
 * `keygen` makes a throwaway rehearsal key (one day, RSA, its own passphrase)
 * for walking the whole path locally; it is never a release key.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The armored private key. */
export const KEY_ENV = "ARMADRA_LINUX_GPG_KEY";
/** Its passphrase; may be empty for a key that has none. */
export const PASSPHRASE_ENV = "ARMADRA_LINUX_GPG_PASSPHRASE";
/** The public key's published name: a release asset and a static web file. */
export const PUBLIC_KEY_ASSET = "armadra-linux.gpg";
/** The three Linux package kinds a release builds (`artifacts.mjs`). */
export const LINUX_SUFFIXES = [".AppImage", ".deb", ".rpm"];

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * What this run does: `sign`, `skip` (nothing configured — the release says the
 * Linux packages are unsigned) or `refuse` (half configured).
 */
export function gpgPlan(env = process.env) {
  if (present(env[KEY_ENV]))
    return {
      mode: "sign",
      message: present(env[PASSPHRASE_ENV])
        ? `Signing the Linux packages with ${KEY_ENV}.`
        : `Signing the Linux packages with ${KEY_ENV} (no ${PASSPHRASE_ENV}: the key must have none).`,
    };
  if (present(env[PASSPHRASE_ENV]))
    return {
      mode: "refuse",
      message: `${PASSPHRASE_ENV} is set but ${KEY_ENV} is empty: there is nothing to unlock.`,
    };
  return {
    mode: "skip",
    message: `${KEY_ENV} is not set, so the Linux packages get no .asc and the .rpm is not signed.`,
  };
}

/** The packages in a release directory that get a GPG signature. */
export function linuxPackages(directory) {
  return readdirSync(directory)
    .filter((name) => LINUX_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .sort();
}

/** A command runner; tests and the CLI use the real one. */
function defaultRun(file, args, { input, env } = {}) {
  return execFileSync(file, args, {
    input,
    env: env ?? process.env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Whether a program can be started at all. */
export function available(program, run = defaultRun) {
  try {
    run(program, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `use(home)` with a fresh, private `GNUPGHOME` and removes it after.
 * The agent gpg starts for that home is stopped too, so nothing outlives it.
 */
export function withKeyring(use, run = defaultRun) {
  const home = mkdtempSync(join(tmpdir(), "armadra-gpg-"));
  chmodSync(home, 0o700);
  try {
    return use(home);
  } finally {
    try {
      run("gpgconf", ["--homedir", home, "--kill", "all"]);
    } catch {
      // No agent was started, or gpgconf is not there; the directory goes anyway.
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function gpg(home, args, run, options = {}) {
  return run(
    "gpg",
    ["--homedir", home, "--batch", "--no-tty", ...args],
    options,
  );
}

/** The fingerprints a `--with-colons` listing names, primary keys first. */
export function fingerprints(listing) {
  return String(listing)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("fpr:"))
    .map((line) => line.split(":")[9])
    .filter(Boolean);
}

/** Imports a key into `home` and returns its primary fingerprint. */
export function importKey(home, armored, run = defaultRun) {
  gpg(home, ["--import"], run, { input: armored });
  const secret = fingerprints(
    gpg(home, ["--with-colons", "--list-secret-keys"], run),
  );
  const listed =
    secret.length > 0
      ? secret
      : fingerprints(gpg(home, ["--with-colons", "--list-keys"], run));
  if (listed.length === 0) throw new Error("the key imported no key at all");
  return listed[0];
}

function passphraseArgs(passphrase) {
  return present(passphrase)
    ? ["--pinentry-mode", "loopback", "--passphrase-fd", "0"]
    : ["--pinentry-mode", "loopback", "--passphrase", ""];
}

/**
 * Signs every Linux package in `directory`. Returns what was written and the
 * key's fingerprint. Throws on the first failure: a half-signed release is not
 * one to continue with.
 */
export function signLinuxPackages({
  directory,
  armoredKey,
  passphrase = "",
  published,
  run = defaultRun,
  rpmsign = available("rpmsign", run),
}) {
  const packages = linuxPackages(directory);
  return withKeyring((home) => {
    const fingerprint = importKey(home, armoredKey, run);
    if (published && existsSync(published)) {
      const announced = withKeyring(
        (other) => importKey(other, readFileSync(published), run),
        run,
      );
      if (announced !== fingerprint)
        throw new Error(
          `${KEY_ENV} is ${fingerprint}, but ${published} announces ${announced}. ` +
            "Publish the new public key (and say so) before signing a release with another key.",
        );
    }
    const written = [];
    for (const name of packages) {
      const file = join(directory, name);
      if (name.endsWith(".rpm")) {
        if (!rpmsign)
          throw new Error(
            `${name} needs rpmsign --addsign, and rpmsign is not installed (apt-get install rpm).`,
          );
        rpmAddSign({ home, fingerprint, passphrase, file, run });
        written.push(`${name} (rpmsign)`);
      }
      gpg(
        home,
        [
          ...passphraseArgs(passphrase),
          "--yes",
          "--local-user",
          fingerprint,
          "--armor",
          "--detach-sign",
          "--output",
          `${file}.asc`,
          file,
        ],
        run,
        { input: present(passphrase) ? `${passphrase}\n` : undefined },
      );
      written.push(`${name}.asc`);
    }
    exportPublicKey(home, fingerprint, join(directory, PUBLIC_KEY_ASSET), run);
    written.push(PUBLIC_KEY_ASSET);
    return { fingerprint, written };
  }, run);
}

/**
 * `rpmsign --addsign` against the throwaway keyring. The passphrase goes
 * through a file inside that keyring's directory (removed with it), because
 * rpm runs gpg itself and offers no stdin for it.
 */
function rpmAddSign({ home, fingerprint, passphrase, file, run }) {
  const passphraseFile = join(home, "passphrase");
  writeFileSync(passphraseFile, present(passphrase) ? passphrase : "", {
    mode: 0o600,
  });
  // rpm execs `%{__gpg}` itself, and on Debian/Ubuntu its default names a
  // path that is not where apt put gpg; name the one this run uses.
  const gpgPath = run("sh", ["-c", "command -v gpg"]).trim();
  run(
    "rpmsign",
    [
      "--define",
      `__gpg ${gpgPath}`,
      "--define",
      `_gpg_name ${fingerprint}`,
      "--define",
      `_gpg_path ${home}`,
      "--define",
      `_gpg_sign_cmd_extra_args --batch --pinentry-mode loopback --passphrase-file ${passphraseFile}`,
      "--addsign",
      file,
    ],
    { env: { ...process.env, GNUPGHOME: home } },
  );
}

/** Verifies every Linux package's `.asc` (and an `.rpm`'s own signature). */
export function verifyLinuxPackages({
  directory,
  publicKey,
  run = defaultRun,
  rpmkeys = available("rpmkeys", run),
}) {
  const problems = [];
  const packages = linuxPackages(directory);
  if (packages.length === 0) problems.push(`no Linux package in ${directory}`);
  withKeyring((home) => {
    importKey(home, readFileSync(publicKey), run);
    for (const name of packages) {
      const file = join(directory, name);
      if (!existsSync(`${file}.asc`)) {
        problems.push(`${name}.asc is missing`);
        continue;
      }
      try {
        gpg(home, ["--verify", `${file}.asc`, file], run);
      } catch (error) {
        problems.push(`${name}.asc does not verify: ${firstLine(error)}`);
      }
      if (name.endsWith(".rpm") && rpmkeys) {
        const dbpath = join(home, "rpmdb");
        mkdirSync(dbpath, { recursive: true });
        try {
          const armored = join(home, "public.asc");
          writeFileSync(armored, gpg(home, ["--armor", "--export"], run));
          run("rpmkeys", ["--dbpath", dbpath, "--import", armored]);
          const output = run("rpmkeys", [
            "--dbpath",
            dbpath,
            "--checksig",
            file,
          ]);
          if (
            !/signatures OK|pgp.*OK/i.test(output) ||
            /NOT OK|NOKEY/.test(output)
          )
            problems.push(`${name} rpm signature: ${output.trim()}`);
        } catch (error) {
          problems.push(`${name} rpm signature: ${firstLine(error)}`);
        }
      }
    }
  }, run);
  return problems;
}

/**
 * A throwaway rehearsal key: RSA (rpm on 22.04 verifies it), one day, with a
 * random passphrase. Writes `private.asc`, `passphrase` and the public
 * `armadra-linux.gpg` into `out`.
 */
export function rehearsalKey({ out, run = defaultRun }) {
  mkdirSync(out, { recursive: true });
  const passphrase = randomBytes(18).toString("base64url");
  return withKeyring((home) => {
    gpg(
      home,
      [
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        passphrase,
        "--quick-gen-key",
        "Armadra rehearsal signing <rehearsal@armadra.invalid>",
        "rsa3072",
        "sign",
        "1d",
      ],
      run,
    );
    const [fingerprint] = fingerprints(
      gpg(home, ["--with-colons", "--list-secret-keys"], run),
    );
    const armored = gpg(
      home,
      [
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        passphrase,
        "--armor",
        "--export-secret-keys",
        fingerprint,
      ],
      run,
    );
    writeFileSync(join(out, "private.asc"), armored, { mode: 0o600 });
    writeFileSync(join(out, "passphrase"), passphrase, { mode: 0o600 });
    exportPublicKey(home, fingerprint, join(out, PUBLIC_KEY_ASSET), run);
    return { fingerprint, armored, passphrase };
  }, run);
}

/** The public key as a binary keyring file (what `apt`'s `signed-by` reads). */
function exportPublicKey(home, fingerprint, path, run) {
  rmSync(path, { force: true });
  gpg(home, ["--output", path, "--export", fingerprint], run);
}

function firstLine(error) {
  return String(error?.stderr || error?.message || error)
    .trim()
    .split(/\r?\n/)
    .slice(-1)[0];
}

function flag(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function main(argv) {
  const command = argv[0];
  if (command === "sign") {
    const directory = resolve(flag(argv, "dir"));
    const plan = gpgPlan();
    if (plan.mode === "refuse") {
      console.error(`✗ ${plan.message}`);
      return 1;
    }
    if (plan.mode === "skip") {
      console.warn(`! ${plan.message}`);
      return 0;
    }
    console.log(`→ ${plan.message}`);
    const { fingerprint, written } = signLinuxPackages({
      directory,
      armoredKey: process.env[KEY_ENV],
      passphrase: process.env[PASSPHRASE_ENV] ?? "",
      published: flag(argv, "published") || undefined,
    });
    console.log(`Signed with ${fingerprint}:`);
    for (const name of written) console.log(`  ${name}`);
    return 0;
  }
  if (command === "verify") {
    const problems = verifyLinuxPackages({
      directory: resolve(flag(argv, "dir")),
      publicKey: resolve(flag(argv, "public-key")),
    });
    for (const problem of problems) console.error(`✗ ${problem}`);
    if (problems.length === 0) console.log("Every Linux package verifies.");
    return problems.length === 0 ? 0 : 1;
  }
  if (command === "keygen") {
    const out = resolve(flag(argv, "out"));
    const { fingerprint } = rehearsalKey({ out });
    console.log(
      `Rehearsal key ${fingerprint} written to ${out} (expires in one day).`,
    );
    return 0;
  }
  console.error(
    "usage: node tools/release/sign-gpg.mjs <sign --dir D [--published F] | verify --dir D --public-key F | keygen --out D>",
  );
  return 2;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`✗ ${firstLine(error)}`);
    process.exit(1);
  }
}
