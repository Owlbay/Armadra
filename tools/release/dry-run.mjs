/**
 * Produce a whole release into a temporary directory and check it.
 *
 *   pnpm release:dry-run [--keep] [--out <dir>]
 *   pnpm release:dry-run --against <source> --pubkey <minisign.pub> [--target <os>-<arch>]
 *
 * The second form checks a release someone else is serving — the dev-stack
 * `release` service at `http://127.0.0.1:8090/repos/armadra/armadra`, say —
 * the way a client would: check the index (and again with its ETag, expecting
 * 304), download the manifests, then verify every statement about the bytes.
 *
 * Nothing here builds real binaries or touches GitHub: the point is to
 * exercise the parts of the pipeline that decide what a release *is* — the
 * names, the checksum list, the signatures, the updater manifest and the
 * compatibility fence — on a machine with no signing key and no network. Those
 * are the parts that, when they are wrong, produce a release that looks
 * complete and cannot be installed.
 *
 * The signing key is generated for this run and discarded with it. On a
 * machine with the `minisign` binary installed the signatures are checked with
 * it as well, so the format claim is not only asserted against our own reader.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_ASSETS,
  TARGETS,
  UPDATER_FEEDS,
  assetComponent,
  assetTarget,
  desktopAssets,
  updaterFeedFile,
  webAsset,
} from "./artifacts.mjs";
import { verifyFeeds } from "./assemble.mjs";
import { readCompatibility, releaseNote } from "./compatibility.mjs";
import {
  parseChecksums,
  verifyChecksums,
  writeChecksums,
} from "./checksums.mjs";
import { generateKey, publicKeyFile, verifyDetached } from "./minisign.mjs";
import { formatFeed, parseFeed, sha512Base64 } from "./stage-desktop.mjs";
import { signDirectory, verifyDirectory } from "./sign.mjs";
import { startMockReleaseServer } from "./mock-release-server.mjs";
import { writeManifest } from "./updater-manifest.mjs";
import { checkVersions, workspaceVersion } from "./version.mjs";

/**
 * Stand-in bytes for a built artifact. They are not empty and not identical,
 * so a checksum list that mixed two files up would be caught.
 */
function placeholder(name) {
  return Buffer.from(`armadra release dry run placeholder for ${name}\n`);
}

/** Write the full asset matrix of a release into `directory`. */
export function stageAssets({ directory, version }) {
  mkdirSync(directory, { recursive: true });
  const staged = [];
  for (const target of TARGETS) {
    for (const bundle of desktopAssets(version, target)) {
      writeFileSync(join(directory, bundle.name), placeholder(bundle.name));
      staged.push(bundle.name);
      // No `.sig` is staged beside a bundle any more: the packager writes none
      // and `assemble.mjs` signs the directory itself before it builds the
      // manifest. Staging one here would hide whether that ordering holds.
    }
    // The feed `stage-desktop.mjs` would have written for this target, over
    // the same placeholder bytes.
    const updater = desktopAssets(version, target).find((a) => a.updater);
    const bytes = placeholder(updater.name);
    writeFileSync(
      join(directory, updaterFeedFile(target)),
      formatFeed({
        version,
        files: [
          {
            url: updater.name,
            sha512: sha512Base64(bytes),
            size: bytes.length,
          },
        ],
      }),
    );
    staged.push(updaterFeedFile(target));
  }
  writeFileSync(
    join(directory, webAsset(version)),
    placeholder(webAsset(version)),
  );
  staged.push(webAsset(version));
  return staged;
}

/** Every check the assemble job runs over a finished release directory. */
export async function auditRelease({ directory, version, publicKeyText }) {
  const problems = [];
  const staged = new Set(
    (await import("node:fs"))
      .readdirSync(directory)
      .filter((name) => !name.endsWith(".sig")),
  );
  // Every published file must be one the updater can place. An asset it reads
  // no component from is one it will never offer, however correct its bytes are.
  for (const name of staged) {
    const component = assetComponent(name);
    if (component === "") {
      problems.push(`${name} declares no component the updater can read`);
      continue;
    }
    if (component === "manifest" || component === "web") continue;
    if (assetTarget(name) === "")
      problems.push(`${name} declares no target the updater can read`);
  }
  for (const required of [...MANIFEST_ASSETS, ...UPDATER_FEEDS]) {
    if (!staged.has(required)) problems.push(`${required} is missing`);
  }
  problems.push(...(await verifyChecksums(directory)));
  const { problems: signatureProblems } = verifyDirectory({
    directory,
    publicKeyText,
  });
  problems.push(...signatureProblems);
  const manifest = JSON.parse(
    readFileSync(join(directory, "latest.json"), "utf8"),
  );
  if (manifest.version !== version)
    problems.push(
      `latest.json names version ${manifest.version}, not ${version}`,
    );
  for (const target of TARGETS) {
    const key = target;
    if (!manifest.platforms[key])
      problems.push(`latest.json has no entry for ${key}`);
  }
  problems.push(...verifyFeeds({ directory, version, manifest }));
  return problems;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Check → download the manifests → verify, against a served release.
 *
 * What a client does, in that order, and every statement about the bytes it
 * would rely on: the index answers 304 to its own ETag; `SHA256SUMS` and
 * `latest.json` carry minisign signatures by `publicKeyText`; each target's
 * electron-updater feed is the one `latest.json` names (by sha256) and the one
 * `SHA256SUMS` lists; the bundle the feed names has the feed's sha512, the
 * index's sha256, the list's sha256 and a valid minisign signature. Returns
 * the problems and what was checked.
 */
export async function verifyServedRelease({
  source,
  publicKeyText,
  targets = TARGETS,
}) {
  const problems = [];
  const checked = [];
  const get = async (url, headers = {}) => {
    const response = await fetch(url, { headers });
    return response;
  };
  const bytesOf = async (url) => {
    const response = await get(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };

  // 1. The check, and the same check made conditional.
  const first = await get(`${source}/releases`);
  if (!first.ok)
    return { problems: [`index answered ${first.status}`], checked };
  const etag = first.headers.get("etag");
  const index = await first.json();
  if (!etag) problems.push("the index carries no ETag");
  else {
    const again = await get(`${source}/releases`, { "if-none-match": etag });
    if (again.status !== 304)
      problems.push(
        `a matching If-None-Match answered ${again.status}, not 304`,
      );
    else checked.push("index 304 on If-None-Match");
  }
  const release = index.find((entry) => !entry.draft);
  if (!release)
    return { problems: [...problems, "no published release"], checked };
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  const version = release.tag_name.replace(/^v/, "");

  // 2. The manifests, each with its signature.
  const signed = async (name) => {
    const asset = assets.get(name);
    const signature = assets.get(`${name}.sig`);
    if (!asset || !signature) {
      problems.push(`the release does not publish ${name} with its .sig`);
      return null;
    }
    const bytes = await bytesOf(asset.browser_download_url);
    const verdict = verifyDetached(
      publicKeyText,
      (await bytesOf(signature.browser_download_url)).toString("utf8"),
      bytes,
    );
    if (!verdict.ok) problems.push(`${name} signature: ${verdict.reason}`);
    else checked.push(`${name} minisign`);
    return bytes;
  };
  const sumsBytes = await signed("SHA256SUMS");
  const latestBytes = await signed("latest.json");
  if (!sumsBytes || !latestBytes) return { problems, checked };
  const sums = parseChecksums(sumsBytes.toString("utf8"));
  const latest = JSON.parse(latestBytes.toString("utf8"));
  if (latest.version !== version)
    problems.push(`latest.json names ${latest.version}, the tag ${version}`);

  // 3. Per target: the feed, then the bundle it names.
  for (const target of targets) {
    const entry = latest.platforms?.[target];
    if (!entry) {
      problems.push(`latest.json has no entry for ${target}`);
      continue;
    }
    const feedName = updaterFeedFile(target);
    if (!entry.feed) {
      problems.push(`latest.json ${target} names no feed`);
      continue;
    }
    const feedBytes = await bytesOf(entry.feed.url);
    const feedDigest = sha256Hex(feedBytes);
    if (feedDigest !== entry.feed.sha256)
      problems.push(`${feedName} is not the feed latest.json names`);
    if (sums.get(feedName) !== feedDigest)
      problems.push(`${feedName} is not the feed SHA256SUMS lists`);
    const feed = parseFeed(feedBytes.toString("utf8"));
    if (feed.version !== version)
      problems.push(`${feedName} names ${feed.version}, not ${version}`);
    const file = feed.files[0];
    if (!file) {
      problems.push(`${feedName} lists no file`);
      continue;
    }
    // electron-updater resolves a feed's file against the feed's own URL.
    const bundleUrl = new URL(file.url, entry.feed.url).toString();
    if (bundleUrl !== entry.url)
      problems.push(`${feedName} names ${file.url}, latest.json ${entry.url}`);
    const bundle = await bytesOf(bundleUrl);
    const digest = sha256Hex(bundle);
    if (sha512Base64(bundle) !== file.sha512)
      problems.push(`${file.url} does not match the feed's sha512`);
    if (Number(file.size) !== bundle.length)
      problems.push(`${file.url} does not match the feed's size`);
    if (sums.get(file.url) !== digest)
      problems.push(`${file.url} does not match SHA256SUMS`);
    if (assets.get(file.url)?.digest !== `sha256:${digest}`)
      problems.push(`${file.url} does not match the index digest`);
    const verdict = verifyDetached(publicKeyText, entry.signature, bundle);
    if (!verdict.ok) problems.push(`${file.url} signature: ${verdict.reason}`);
    if (problems.length === 0) checked.push(`${target} feed and bundle`);
  }
  return { problems, checked, version };
}

/** `--against`: check a release someone else serves. */
async function against(argv) {
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const source = flag("against");
  const pubkey = flag("pubkey");
  if (!source || !pubkey) {
    console.error(
      "usage: pnpm release:dry-run --against <source> --pubkey <minisign.pub> [--target <os>-<arch>]",
    );
    return 2;
  }
  const target = flag("target");
  const { problems, checked, version } = await verifyServedRelease({
    source,
    publicKeyText: readFileSync(pubkey, "utf8"),
    targets: target ? [target] : TARGETS,
  });
  console.log(`Release ${version ?? "?"} at ${source}`);
  for (const line of checked) console.log(`  ✓ ${line}`);
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) return 1;
  console.log("Served release verified.");
  return 0;
}

/** Check the signatures again with the real minisign, when it is installed. */
export function crossCheckWithMinisign({ directory, publicKeyPath, sample }) {
  try {
    execFileSync("minisign", ["-v"], { stdio: "ignore" });
  } catch {
    return { available: false };
  }
  execFileSync(
    "minisign",
    ["-V", "-p", publicKeyPath, "-m", join(directory, sample)],
    {
      stdio: "inherit",
    },
  );
  return { available: true };
}

async function main(argv) {
  if (argv.includes("--against")) return against(argv);
  const keep = argv.includes("--keep");
  const outFlag = argv.indexOf("--out");
  const directory =
    outFlag >= 0
      ? argv[outFlag + 1]
      : mkdtempSync(join(tmpdir(), "armadra-release-"));
  const version = workspaceVersion();
  const problems = [];
  try {
    const versionCheck = checkVersions({});
    problems.push(...versionCheck.problems);

    stageAssets({ directory, version });
    const compatibility = readCompatibility();
    const note = releaseNote({
      version,
      notes: `Armadra ${version} dry run.`,
      compatibility,
    });

    // Neither the release note nor the public key is a release asset. The note
    // is the release's own body, and a key served from the same place as the
    // artifacts proves nothing: it ships inside the binaries that verify with
    // it. Keeping both out of the asset directory also keeps the audit's
    // "every published file must be placeable" rule honest.
    const key = generateKey();
    const sideDirectory = join(directory, "..", `${basename(directory)}-side`);
    mkdirSync(sideDirectory, { recursive: true });
    writeFileSync(join(sideDirectory, "RELEASE_NOTE.md"), note);
    const publicKeyPath = join(sideDirectory, "armadra-release.pub");
    writeFileSync(publicKeyPath, publicKeyFile(key));

    // The same order `assemble.mjs` runs in, and for the same reason: the
    // packager writes no detached signature, so `latest.json` can only quote
    // one this step just produced.
    signDirectory({ directory, key, version });

    // The manifest's links have to reach the server that serves it below, so
    // its port is taken first and the server is started on that port later.
    const probe = await startMockReleaseServer({ releases: [] });
    const port = Number(new URL(probe.base).port);
    await probe.close();
    const publicBase = `http://127.0.0.1:${port}`;
    const manifest = writeManifest({
      directory,
      version,
      notes: `Armadra ${version} dry run.`,
      targets: TARGETS,
      downloadUrl: (name) =>
        `${publicBase}/download/v${version}/${encodeURIComponent(name)}`,
    });
    for (const skip of manifest.skipped)
      problems.push(`latest.json skipped ${skip.asset}: ${skip.reason}`);

    const checksums = await writeChecksums(directory);
    // latest.json and SHA256SUMS did not exist during the first pass.
    signDirectory({ directory, key, version, onlyMissing: true });
    problems.push(
      ...(await auditRelease({
        directory,
        version,
        publicKeyText: publicKeyFile(key),
      })),
    );

    // A release is read through the API shape, not through a directory, so the
    // dry run serves it and reads it back the way a client would: check (with
    // its ETag), download the manifests, verify every statement about the bytes.
    const server = await startMockReleaseServer({
      releases: [{ directory, tag: `v${version}`, body: note }],
      port,
    });
    try {
      const index = await (await fetch(`${server.source}/releases`)).json();
      const names = new Set(index[0].assets.map((asset) => asset.name));
      for (const required of [
        ...MANIFEST_ASSETS,
        `SHA256SUMS.sig`,
        ...UPDATER_FEEDS,
      ]) {
        if (!names.has(required))
          problems.push(`the served release omits ${required}`);
      }
      const fetched = await (
        await fetch(
          index[0].assets.find((asset) => asset.name === "SHA256SUMS")
            .browser_download_url,
        )
      ).text();
      if (fetched !== checksums.content)
        problems.push("the served SHA256SUMS is not the one written");
      const served = await verifyServedRelease({
        source: server.source,
        publicKeyText: publicKeyFile(key),
      });
      problems.push(...served.problems.map((p) => `served: ${p}`));
    } finally {
      await server.close();
    }

    const cross = crossCheckWithMinisign({
      directory,
      publicKeyPath,
      sample: "SHA256SUMS",
    });

    console.log(`Release ${version} staged in ${directory}`);
    console.log(
      `  ${checksums.entries} files checksummed, ${Object.keys(manifest.manifest.platforms).length} updater platforms`,
    );
    console.log(
      cross.available
        ? "  signatures cross-checked with the installed minisign"
        : "  minisign is not installed; signatures were checked with the Node implementation only",
    );
    for (const problem of problems) console.error(`✗ ${problem}`);
    if (problems.length > 0) {
      console.error(`\nRelease dry run failed: ${problems.length} problem(s)`);
      return 1;
    }
    console.log("Release dry run passed.");
    return 0;
  } finally {
    const sideDirectory = join(directory, "..", `${basename(directory)}-side`);
    if (!keep && outFlag < 0) {
      rmSync(directory, { recursive: true, force: true });
      rmSync(sideDirectory, { recursive: true, force: true });
    } else {
      console.log(
        `Kept ${directory} (note and public key in ${sideDirectory})`,
      );
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
