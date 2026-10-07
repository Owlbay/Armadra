/**
 * latest.json — the static manifest the desktop updater reads.
 *
 * Only the desktop bundles that can actually be applied in place appear in it:
 * the macOS zip, the Windows NSIS installer and the Linux AppImage
 * (`artifacts.mjs`'s `desktopAssets()` marks exactly one per platform). A
 * `.deb` or `.rpm` is installed and updated by a package manager, a `.dmg` is
 * a disk image and the Windows zip records no install location — listing any
 * of them would offer an update the updater cannot perform.
 *
 * Every platform entry needs a signature, which `assemble.mjs` produces over
 * the staged directory before it calls this. An unsigned bundle is left out
 * with a stated reason rather than published without one: a manifest entry
 * without a signature is an offer to install whatever the endpoint serves.
 *
 * 每个平台条目还带 `feed: { url, sha256 }`：这个目标的 electron-updater 清单
 * （`stage-desktop.mjs` 暂存的 `latest-<target>….yml`）在哪、是哪份字节。桌面壳下载前
 * 先取这份 yml、核对 sha256 与它描述的包，再交给 electron-updater——latest.json
 * 是签过名的那一份，yml 由它点名，而不是由「同一目录里恰好有一份」。
 *
 * 可选的 `rollout: { percent, seed }` 是灰度：客户端拿安装 id 与 seed 的哈希落在
 * 百分比之内才接受这次更新（`shell-core/updates/offer.ts::rolloutAccepts`）。seed
 * 缺省是版本号，所以同一台机器在同一个版本的灰度里结论不变，换一个版本重新抽。
 * 这里不写 electron-updater 自己的 `stagingPercentage`：两道闸各用各的 id，同一台
 * 机器会被筛两次。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopAssets, updaterFeedFile } from "./artifacts.mjs";

/** The sha256 of a file, hex. */
function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 灰度字段。百分比是 0–100 的整数；seed 缺省为版本号。不给就是全量，不写字段。
 */
export function normalizeRollout(rollout, version) {
  if (rollout === undefined || rollout === null) return null;
  const percent = Number(rollout.percent);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100)
    throw new Error(
      `rollout percent must be an integer 0-100, got ${rollout.percent}`,
    );
  const seed = String(rollout.seed ?? "").trim() || version;
  return { percent, seed };
}

/** Platforms are named "<os>-<arch>", the same spelling the Host uses. */
const PLATFORM_OS = { darwin: "darwin", linux: "linux", windows: "windows" };

/** The platform key the updater looks up, derived from a release target. */
export function platformKey(target) {
  const [system, arch] = target.split("-");
  const os = PLATFORM_OS[system];
  if (!os) throw new Error(`no updater platform for target ${target}`);
  return `${os}-${arch}`;
}

/**
 * Build the manifest from a directory of release assets.
 *
 * `downloadUrl` turns an asset name into the URL clients fetch; the caller
 * supplies it because the release URL is not knowable from the files.
 */
export function buildManifest({
  directory,
  version,
  notes,
  downloadUrl,
  targets,
  pub = "",
  rollout,
}) {
  const platforms = {};
  const skipped = [];
  for (const target of targets) {
    const updater = desktopAssets(version, target).find(
      (asset) => asset.updater,
    );
    if (!updater) continue;
    const bundle = join(directory, updater.name);
    let signature;
    try {
      // The whole detached signature file goes into the manifest, not a path
      // to it: a client that has the manifest has everything it needs to
      // verify, without a second fetch that could be answered differently.
      signature = readFileSync(
        join(directory, `${updater.name}.sig`),
        "utf8",
      ).trim();
    } catch {
      skipped.push({ target, asset: updater.name, reason: "signatureMissing" });
      continue;
    }
    try {
      readFileSync(bundle);
    } catch {
      skipped.push({ target, asset: updater.name, reason: "bundleMissing" });
      continue;
    }
    const entry = { signature, url: downloadUrl(updater.name) };
    const feedName = updaterFeedFile(target);
    const feedPath = join(directory, feedName);
    // A missing feed is not skipped here: the bundle can still be verified and
    // installed by hand. `assemble.mjs` reports it as a hole in the release.
    if (existsSync(feedPath))
      entry.feed = { url: downloadUrl(feedName), sha256: digest(feedPath) };
    platforms[platformKey(target)] = entry;
  }
  const manifest = {
    version,
    notes: String(notes ?? "").trim(),
    pub_date: new Date(0).toISOString(),
    platforms,
  };
  if (pub) manifest.pub_date = pub;
  const gate = normalizeRollout(rollout, version);
  if (gate !== null) manifest.rollout = gate;
  return { manifest, skipped };
}

/** Write latest.json, sorted so two runs of one release produce one file. */
export function writeManifest(options) {
  const { manifest, skipped } = buildManifest(options);
  const ordered = {
    version: manifest.version,
    notes: manifest.notes,
    pub_date: manifest.pub_date,
    ...(manifest.rollout ? { rollout: manifest.rollout } : {}),
    platforms: Object.fromEntries(
      Object.keys(manifest.platforms)
        .sort()
        .map((key) => [key, manifest.platforms[key]]),
    ),
  };
  // `output` puts the file elsewhere: the mirror's copy names the same bundles
  // at the mirror's addresses and must not replace the release's own.
  const path = options.output ?? join(options.directory, "latest.json");
  writeFileSync(path, JSON.stringify(ordered, null, 2) + "\n");
  return { path, manifest: ordered, skipped };
}
