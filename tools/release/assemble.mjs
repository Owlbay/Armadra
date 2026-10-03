/**
 * Turn a directory of built artifacts into a publishable release.
 *
 *   node tools/release/assemble.mjs --dir <dir> --version X.Y.Z \
 *     --repo owner/name --tag vX.Y.Z [--unnotarized macOS,Windows] \
 *     [--note release-note.md]
 *
 * In order: check that every file is one the updater can place, sign every
 * artifact, write latest.json from the signatures that produced, write
 * SHA256SUMS, then verify what was just produced — including that each
 * target's electron-updater feed (`latest-<target>….yml`) names a published
 * bundle by the same bytes `SHA256SUMS` lists. The last step matters most —
 * it is the only one that can catch a release that each individual step was
 * happy with.
 *
 * Signing comes BEFORE the manifest, and that ordering is the whole of what
 * changed when the desktop packager did. The previous bundler signed each
 * updater bundle during the build, so the manifest could read a `.sig` that
 * was already there; electron-builder signs a bundle with the platform's own
 * code signature and produces no detached signature at all. So the one key
 * system left is this repo's — `ARMADRA_RELEASE_SIGNING_KEY`, which already
 * signed the component packages — and the manifest is written from what
 * `signDirectory` just wrote.
 *
 * Without that key the release is assembled and left visibly unsigned, and the
 * note says so: a release that looks signed and is not is worse than one that
 * admits it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TARGETS,
  assetComponent,
  assetTarget,
  desktopAssets,
  updaterFeedFile,
} from "./artifacts.mjs";
import {
  parseChecksums,
  verifyChecksums,
  writeChecksums,
} from "./checksums.mjs";
import { readCompatibility, releaseNote } from "./compatibility.mjs";
import { keyFromSecret, publicKeyFile } from "./minisign.mjs";
import { SECRET_ENV, signDirectory, verifyDirectory } from "./sign.mjs";
import { writeManifest } from "./updater-manifest.mjs";
import { PUBLIC_KEY_ASSET } from "./sign-gpg.mjs";
import { normalizeSha512, parseFeed, sha512Base64 } from "./stage-desktop.mjs";

/**
 * Every file must be one the updater can place, or it can never be offered.
 *
 * Two kinds of file describe a package rather than being one, and are let
 * through by shape: a detached signature — minisign `.sig`, or the GPG `.asc`
 * `sign-gpg.mjs` writes beside a Linux package, whose own name is checked like
 * any other — and the GPG public key those `.asc` files verify against.
 */
export function checkNames(directory) {
  const problems = [];
  for (const name of readdirSync(directory)) {
    if (
      name.endsWith(".sig") ||
      name === "SHA256SUMS" ||
      name === "latest.json" ||
      name === PUBLIC_KEY_ASSET
    )
      continue;
    const component = assetComponent(name);
    if (component === "") {
      problems.push(`${name} declares no component the updater can read`);
      continue;
    }
    if (component === "web" || component === "manifest") continue;
    if (assetTarget(name) === "")
      problems.push(`${name} declares no target the updater can read`);
  }
  return problems;
}

/**
 * electron-updater 的清单与发布的字节是否是同一回事（外部服务 §3.2 第 2 条）。
 *
 * 对每个发布了更新包的目标：清单必须在（否则 electron-updater 的下载一步是 404），
 * 版本对，`files[].url` 是本目录里真有的文件，清单的 sha512 是这份字节的 sha512，
 * `SHA256SUMS` 给这个文件记的 sha256 也是这份字节的——两份清单说的是同一个文件；
 * latest.json 的 `feed.sha256` 是这份 yml 的。返回问题列表，不抛。
 */
export function verifyFeeds({ directory, version, manifest }) {
  const problems = [];
  let sums = new Map();
  try {
    sums = parseChecksums(readFileSync(join(directory, "SHA256SUMS"), "utf8"));
  } catch (error) {
    problems.push(`SHA256SUMS cannot be read: ${error.message}`);
  }
  for (const target of TARGETS) {
    const updater = desktopAssets(version, target).find((a) => a.updater);
    if (!existsSync(join(directory, updater.name))) continue;
    const feedName = updaterFeedFile(target);
    const feedPath = join(directory, feedName);
    if (!existsSync(feedPath)) {
      problems.push(
        `${feedName} is missing: electron-updater cannot download ${updater.name}`,
      );
      continue;
    }
    const feedBytes = readFileSync(feedPath);
    let feed;
    try {
      feed = parseFeed(feedBytes.toString("utf8"));
    } catch (error) {
      problems.push(`${feedName} is malformed: ${error.message}`);
      continue;
    }
    if (feed.version !== version)
      problems.push(
        `${feedName} names version ${feed.version}, not ${version}`,
      );
    if (feed.files.length === 0) problems.push(`${feedName} lists no file`);
    if (feed.files.length > 0 && feed.path !== feed.files[0].url)
      problems.push(`${feedName} path is not its first file`);
    for (const file of feed.files) {
      const path = join(directory, String(file.url ?? ""));
      if (!file.url || file.url.includes("/") || !existsSync(path)) {
        problems.push(`${feedName} names ${file.url}, which is not published`);
        continue;
      }
      const bytes = readFileSync(path);
      if (normalizeSha512(file.sha512) !== sha512Base64(bytes))
        problems.push(`${feedName} sha512 for ${file.url} is not its bytes`);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(String(file.sha512)))
        problems.push(`${feedName} sha512 for ${file.url} is not base64`);
      if (Number(file.size) !== bytes.length)
        problems.push(`${feedName} size for ${file.url} is not its length`);
      const listed = sums.get(file.url);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (listed !== actual)
        problems.push(
          `${feedName} and SHA256SUMS do not describe the same ${file.url}`,
        );
    }
    const entry = manifest?.platforms?.[target];
    if (entry) {
      const feedDigest = createHash("sha256").update(feedBytes).digest("hex");
      if (!entry.feed) problems.push(`latest.json ${target} names no feed`);
      else if (entry.feed.sha256 !== feedDigest)
        problems.push(`latest.json ${target} feed digest is not ${feedName}`);
    }
  }
  return problems;
}

/** Which targets published nothing the updater could offer. */
export function missingUpdaterPlatforms(manifest) {
  return TARGETS.filter((target) => !manifest.platforms[target]);
}

export async function assemble({
  directory,
  version,
  repo,
  tag,
  unnotarized = [],
  notes = "",
  secret = process.env[SECRET_ENV],
  rollout,
}) {
  const problems = checkNames(directory);
  const download = (name) =>
    `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;

  // Sign the bundles first: latest.json quotes the detached signature of each
  // updater bundle, and nothing else in this pipeline produces one.
  const key = secret ? keyFromSecret(secret) : null;
  let signed = key ? signDirectory({ directory, key, version }) : [];

  const { manifest, skipped } = writeManifest({
    directory,
    version,
    notes,
    targets: TARGETS,
    downloadUrl: download,
    rollout,
  });
  // A build without ARMADRA_RELEASE_SIGNING_KEY signs nothing, and that is a
  // release that admits it cannot update itself, not a broken one: every
  // bundle is still shipped for a manual install and the note says so below.
  // A hole — some bundles signed, one not, or a bundle missing outright — is
  // still a problem, because the manifest would then quietly offer less than
  // the release claims.
  const updaterUnsigned =
    Object.keys(manifest.platforms).length === 0 &&
    skipped.length > 0 &&
    skipped.every((skip) => skip.reason === "signatureMissing");
  for (const skip of skipped) {
    if (updaterUnsigned) continue;
    problems.push(
      `latest.json has no entry for ${skip.target}: ${skip.reason}`,
    );
  }

  // SHA256SUMS last of the three, so it covers latest.json too. Then one more
  // signing pass for the two files that did not exist during the first, and a
  // verification over everything.
  await writeChecksums(directory);
  if (key) {
    signed = [
      ...signed,
      ...signDirectory({ directory, key, version, onlyMissing: true }),
    ];
    const { problems: signatureProblems } = verifyDirectory({
      directory,
      publicKeyText: publicKeyFile(key),
    });
    problems.push(...signatureProblems);
  }
  problems.push(...(await verifyChecksums(directory)));
  problems.push(...verifyFeeds({ directory, version, manifest }));

  const compatibility = readCompatibility();
  const unsigned = secret ? [] : ["component packages (no signing key)"];
  if (updaterUnsigned) {
    unsigned.push("desktop updater packages (no release signing key)");
  }
  const note = releaseNote({
    version,
    notes,
    compatibility,
    unnotarized: [...unnotarized, ...unsigned],
  });
  return {
    problems,
    note,
    manifest,
    signed,
    missing: missingUpdaterPlatforms(manifest),
  };
}

function flag(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

async function main(argv) {
  const directory = flag(argv, "dir");
  const version = flag(argv, "version");
  const repo = flag(argv, "repo");
  const tag = flag(argv, "tag") || `v${version}`;
  if (!directory || !version || !repo) {
    console.error(
      "usage: node tools/release/assemble.mjs --dir <dir> --version X.Y.Z --repo owner/name [--tag vX.Y.Z] [--unnotarized a,b] [--note file] [--rollout <percent>]",
    );
    return 2;
  }
  const notesFile = flag(argv, "notes-from");
  const result = await assemble({
    directory: resolve(directory),
    version,
    repo,
    tag,
    unnotarized: flag(argv, "unnotarized")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    notes: notesFile ? readFileSync(notesFile, "utf8") : `Armadra ${version}.`,
    rollout: flag(argv, "rollout")
      ? { percent: Number(flag(argv, "rollout")) }
      : undefined,
  });
  const notePath = flag(argv, "note");
  if (notePath) writeFileSync(notePath, result.note);
  console.log(`Assembled ${version}:`);
  console.log(`  ${result.signed.length} signature(s)`);
  console.log(
    `  ${Object.keys(result.manifest.platforms).length} updater platform(s)`,
  );
  console.log(`  ${readdirSync(directory).length} file(s) in ${directory}`);
  for (const problem of result.problems) console.error(`✗ ${problem}`);
  if (result.problems.length > 0) {
    console.error(
      `\nRelease assembly failed: ${result.problems.length} problem(s)`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
