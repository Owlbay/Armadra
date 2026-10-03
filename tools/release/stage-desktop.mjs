/**
 * Rename electron-builder's output to the names a release publishes.
 *
 *   node tools/release/stage-desktop.mjs --target <os>-<arch> \
 *     --from <release dir> --out <dir> [--version X.Y.Z] [--require-updater]
 *
 * electron-builder names files after each platform's own conventions —
 * `Armadra-0.1.0-arm64.dmg`, `Armadra-Setup-0.1.0-arm64.exe`,
 * `armadra_0.1.0_amd64.deb` — and none of those spellings contains a target
 * the Host can read: `assetTarget` finds nothing in `arm64` or `amd64`.
 * (The installer's own name has no space any more — `nsis.artifactName` in
 * `electron-builder.yml` — because Azure Artifact Signing cannot sign a file
 * whose name has one; older builds' `Armadra Setup …` is still recognised.) Uploading them as they come off the packager
 * produces a release whose desktop assets the Host will never offer, which is
 * a failure that only shows up in a client weeks later. So every bundle is
 * looked up by kind and copied to the one name `artifacts.mjs` declares, and
 * anything expected but absent stops the job here instead.
 *
 * Unlike the packager this replaced, everything lands in ONE flat directory
 * (`electron-builder.yml`'s `directories.output`), beside files that are not
 * release assets at all: `latest*.yml`, `*.blockmap`, `builder-*.yml` and the
 * `*-unpacked` directories. Matching is therefore by extension AND an explicit
 * ignore list, not by "the only file in its own folder".
 *
 * Nothing here handles signatures. electron-builder signs the bundle itself
 * with the platform's own code signature; the detached minisign signature the
 * updater manifest carries is produced later, over the whole staged directory,
 * by `assemble.mjs` (`sign.mjs`) — one key system for the release rather than
 * two.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopAssets, updaterFeedFile } from "./artifacts.mjs";
import { workspaceVersion } from "./version.mjs";

/**
 * How each electron-builder target's file is recognised in the output
 * directory. The keys are the `kind` values `desktopAssets()` declares, which
 * are themselves the `target` values in `electron-builder.yml`.
 *
 * Matching on an extension rather than a full name is deliberate: the
 * packager's names carry a product name cased its own way, an architecture
 * spelling of its own and sometimes a space, and pinning any of those would
 * break the release the next time electron-builder changes one.
 *
 * `zip` is ambiguous by extension alone only across platforms, and a release
 * job builds one platform, so the target being staged settles it.
 */
export const BUNDLE_KINDS = {
  zip: { suffix: ".zip" },
  dmg: { suffix: ".dmg" },
  nsis: { suffix: ".exe" },
  AppImage: { suffix: ".AppImage" },
  deb: { suffix: ".deb" },
  rpm: { suffix: ".rpm" },
};

/**
 * Files in the output directory that are not release assets.
 *
 * `latest*.yml` is electron-updater's own manifest. It is not a *bundle*, so
 * it is never matched here; `stageFeed` below reads it, renames what it
 * describes and writes it again under the per-target name the release
 * publishes. `.blockmap` is its differential-download index, which the shell
 * turns off (`disableDifferentialDownload`); `builder-*.yml` and
 * `builder-debug.yml` are packaging debris.
 */
export function isReleaseAsset(name) {
  if (name.endsWith(".blockmap")) return false;
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return false;
  if (name.endsWith(".unpacked") || name.includes("-unpacked")) return false;
  return true;
}

/**
 * Whether a packager name belongs to the given target's architecture.
 *
 * electron-builder names the 64-bit Intel build with NO architecture token at
 * all (`Armadra-0.1.0.dmg`, `armadra_0.1.0_amd64.deb`) and the ARM one with an
 * explicit one (`Armadra-0.1.0-arm64.dmg`, `armadra-0.1.0.aarch64.rpm`). So the
 * check is one-sided: ARM demands the token, Intel demands its absence.
 *
 * In CI a runner builds one architecture and the directory holds one file of
 * each kind, so this changes nothing there. It matters locally, where one
 * `dist` produces both: sorted by name, `Armadra-0.1.0-arm64.dmg` comes before
 * `Armadra-0.1.0.dmg`, so without this the x64 target would be published with
 * the arm64 bundle under it — an installer that cannot run on the machine its
 * name promises.
 */
export function matchesArch(name, target) {
  const arm = /(^|[^a-z0-9])(arm64|aarch64)([^a-z0-9]|$)/i.test(name);
  return target.endsWith("-aarch64") ? arm : !arm;
}

/** The one file of this kind for this target, or null. */
export function findBundle({ bundle, kind, target }) {
  const spec = BUNDLE_KINDS[kind];
  if (!spec || !existsSync(bundle)) return null;
  const matches = readdirSync(bundle)
    .filter(
      (name) =>
        isReleaseAsset(name) &&
        name.endsWith(spec.suffix) &&
        (target === undefined || matchesArch(name, target)),
    )
    .sort();
  return matches.length === 0 ? null : join(bundle, matches[0]);
}

/**
 * Copy every desktop bundle this target publishes into `out` under its
 * published name.
 *
 * `requireUpdater` is false for an unsigned build. It no longer changes which
 * bundles the packager produces — electron-builder writes the zip, the
 * installer and the AppImage whether or not a certificate was available — so
 * it only decides whether a MISSING updater bundle is tolerated, which is the
 * case where packaging half-finished rather than the case where signing was
 * skipped.
 */
export function stageDesktop({
  target,
  bundle,
  out,
  version,
  requireUpdater = false,
}) {
  mkdirSync(out, { recursive: true });
  const staged = [];
  const missing = [];
  for (const asset of desktopAssets(version, target)) {
    const source = findBundle({ bundle, kind: asset.kind, target });
    if (!source) {
      if (asset.updater && !requireUpdater) continue;
      missing.push(`${asset.kind} (for ${asset.name})`);
      continue;
    }
    const destination = join(out, asset.name);
    copyFileSync(source, destination);
    staged.push({ kind: asset.kind, name: asset.name, path: destination });
  }
  // 更新包在，清单就必须在：没有它 electron-updater 的下载一步在真实 Release 上
  // 是 404。没签名的构建（requireUpdater 为假）缺清单只是少一份清单，不算失败。
  const { feed, problem } = stageFeed({ target, bundle, out, version, staged });
  // A missing bundle was reported above; its feed has nothing to describe.
  if (
    problem !== null &&
    problem !== "bundleMissing" &&
    (requireUpdater || problem !== "feedMissing")
  )
    missing.push(problem);
  return { staged, missing, feed };
}

/* ----------------------- electron-updater 的清单 ----------------------- */

/**
 * electron-builder 给一个目标写的清单名。它只按平台分：macOS 一律
 * `latest-mac.yml`，Windows 一律 `latest.yml`，Linux 按架构
 * `latest-linux.yml` / `latest-linux-arm64.yml`。
 */
export function builderFeedFile(target) {
  if (target.startsWith("darwin-")) return "latest-mac.yml";
  if (target.startsWith("windows-")) return "latest.yml";
  return target.endsWith("-aarch64")
    ? "latest-linux-arm64.yml"
    : "latest-linux.yml";
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * 读 electron-builder 写的 `latest*.yml`。
 *
 * 只认它真会写出的那一小块 YAML：顶层 `key: value`，加一个 `files:` 列表，列表项
 * 是 `- key: value` 起头、缩进续行的映射。不认识的形状抛错，而不是猜。
 */
export function parseFeed(text) {
  const feed = { files: [] };
  let inFiles = false;
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const indented = /^\s/.test(raw);
    const line = raw.trim();
    if (!indented && !line.startsWith("-")) {
      inFiles = false;
      current = null;
      const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
      if (!match) throw new Error(`unexpected feed line: ${raw}`);
      if (match[1] === "files" && match[2] === "") {
        inFiles = true;
        continue;
      }
      feed[match[1]] = unquote(match[2]);
      continue;
    }
    if (!inFiles) throw new Error(`unexpected feed line: ${raw}`);
    let body = line;
    if (body.startsWith("-")) {
      current = {};
      feed.files.push(current);
      body = body.slice(1).trim();
      if (body === "") continue;
    }
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(body);
    if (!match || current === null)
      throw new Error(`unexpected feed line: ${raw}`);
    current[match[1]] = unquote(match[2]);
  }
  return feed;
}

/** 按 electron-updater 读的形状写清单；字段顺序固定，同一份输入写出同一个文件。 */
export function formatFeed({ version, files, releaseDate }) {
  const lines = [`version: ${version}`, "files:"];
  for (const file of files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
  }
  lines.push(`path: ${files[0].url}`);
  lines.push(`sha512: ${files[0].sha512}`);
  if (releaseDate) lines.push(`releaseDate: '${releaseDate}'`);
  return `${lines.join("\n")}\n`;
}

/** 文件的 sha512，base64——electron-builder 27 起清单只认这种写法。 */
export function sha512Base64(bytes) {
  return createHash("sha512").update(bytes).digest("base64");
}

/**
 * 清单里写的 sha512 统一成 base64。现版本 electron-builder 写 base64，更老的写
 * hex（electron-updater 仍认，但已弃用）；两种都读，写出时只写 base64。
 */
export function normalizeSha512(value) {
  const text = String(value ?? "").trim();
  if (/^[0-9a-f]{128}$/i.test(text))
    return Buffer.from(text, "hex").toString("base64");
  return text;
}

/**
 * 把 electron-builder 为这个目标写的清单改写成发布用的那份：只留这个目标的更新包，
 * `url` / `path` 换成 `artifacts.mjs` 的发布名，sha512 用 base64，按
 * `updaterFeedFile(target)` 写进 `out`。
 *
 * 清单里的条目按**字节**而不是按名字对上暂存的包：electron-builder 在清单里写的
 * 名字与磁盘上的文件名并不总是一样（旧版 Windows 安装包名里的空格在清单里是 `-`），
 * 而 sha512 相同就是同一份字节。对不上说明打包器描述的不是我们要发布的那个文件，
 * 这时宁可在这里失败，也不发一份会让客户端下错包的清单。
 */
export function stageFeed({ target, bundle, out, version, staged }) {
  const updater = desktopAssets(version, target).find((asset) => asset.updater);
  const item = staged.find((each) => each.name === updater.name);
  if (!item) return { feed: null, problem: "bundleMissing" };
  const source = join(bundle, builderFeedFile(target));
  if (!existsSync(source)) return { feed: null, problem: "feedMissing" };
  let parsed;
  try {
    parsed = parseFeed(readFileSync(source, "utf8"));
  } catch (error) {
    return { feed: null, problem: `feedMalformed: ${error.message}` };
  }
  if (String(parsed.version).replace(/^v/, "") !== version)
    return {
      feed: null,
      problem: `feedVersion: ${builderFeedFile(target)} names ${parsed.version}, not ${version}`,
    };
  const bytes = readFileSync(item.path);
  const sha512 = sha512Base64(bytes);
  const described = parsed.files.some(
    (file) => normalizeSha512(file.sha512) === sha512,
  );
  if (!described)
    return {
      feed: null,
      problem: `feedMismatch: ${builderFeedFile(target)} does not describe the bytes staged as ${updater.name}`,
    };
  const name = updaterFeedFile(target);
  const path = join(out, name);
  writeFileSync(
    path,
    formatFeed({
      version,
      files: [{ url: updater.name, sha512, size: bytes.length }],
      releaseDate: parsed.releaseDate,
    }),
  );
  return { feed: { name, path }, problem: null };
}

function flag(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function main(argv) {
  const target = flag(argv, "target");
  const from = flag(argv, "from") || "apps/desktop/release";
  const out = flag(argv, "out");
  if (!target || !out) {
    console.error(
      "usage: node tools/release/stage-desktop.mjs --target <os>-<arch> --out <dir> [--from <output dir>] [--version X.Y.Z] [--require-updater]",
    );
    return 2;
  }
  const { staged, missing, feed } = stageDesktop({
    target,
    bundle: resolve(from),
    out: resolve(out),
    version: flag(argv, "version") || workspaceVersion(),
    requireUpdater: argv.includes("--require-updater"),
  });
  for (const item of staged) console.log(`Staged ${item.kind}: ${item.name}`);
  if (feed) console.log(`Staged updater feed: ${feed.name}`);
  if (missing.length > 0) {
    console.error(`✗ not produced for ${target}: ${missing.join(", ")}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
