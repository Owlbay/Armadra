/**
 * What a release publishes, and what each file is called.
 *
 * The names are load-bearing. The updater reads a component out of the prefix
 * before the first "_" and a target out of the "<os>-<arch>" segment after the
 * version, and it matches a detached signature by name plus ".sig". A file
 * named a little differently is not a slightly wrong download — it is an
 * artifact nothing can place, and the pipeline refuses rather than guesses.
 *
 * A release publishes two things now: the desktop bundles, and the web bundle
 * the server shell (`apps/server`) serves. There are no component archives —
 * the managed binaries they carried do not exist any more.
 */

/** Every target a release builds for, in the contract's "<os>-<arch>" form. */
export const TARGETS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "linux-aarch64",
  "windows-x86_64",
  "windows-aarch64",
];

/** The two files that describe a release rather than carry a program. */
export const MANIFEST_ASSETS = ["latest.json", "SHA256SUMS"];

/**
 * The published name of the built web bundle, which has no target.
 *
 * This is `apps/web`'s `dist/` in a tarball: the artifact an operator unpacks
 * beside the server shell (`apps/server`), which serves it. It is not a
 * program archive — there are none left.
 */
export function webAsset(version) {
  return `armadra-web_${version}.tar.gz`;
}

/**
 * electron-updater 的「通道」名：桌面壳下载前设 `autoUpdater.channel` 为它。
 *
 * 一次发布把六个目标的产物放进同一个扁平目录，而 electron-builder 的清单名只按
 * 平台区分——两台 macOS runner 都写 `latest-mac.yml`，两台 Windows runner 都写
 * `latest.yml`，合并时后到的覆盖先到的。按目标起通道名，每个目标就有自己的一份。
 */
export function updaterChannel(target) {
  return `latest-${target}`;
}

/**
 * 某目标的 electron-updater 清单在发布里的文件名。
 *
 * 这是 electron-updater（6.8.9）对通道 `updaterChannel(target)` 自己算出的名字：
 * `<channel><平台后缀>.yml`，macOS 后缀 `-mac`，Linux 后缀 `-linux`（非 x64 再加
 * `-<process.arch>`），Windows 没有后缀（`providers/Provider.js::getChannelFilePrefix`）。
 * 名字对不上，下载一步就是 404；`apps/desktop` 里有一条测试拿钉住的 electron-updater
 * 自己的算法核对这里。
 */
export function updaterFeedFile(target) {
  const [system, arch] = target.split("-");
  const channel = updaterChannel(target);
  if (system === "darwin") return `${channel}-mac.yml`;
  if (system === "windows") return `${channel}.yml`;
  if (system === "linux")
    return `${channel}-linux${arch === "x86_64" ? "" : "-arm64"}.yml`;
  throw new Error(`no updater feed for target ${target}`);
}

/** 每个目标一份 electron-updater 清单。 */
export const UPDATER_FEEDS = TARGETS.map(updaterFeedFile);

/** 文件名是哪个目标的 electron-updater 清单；不是清单则为 ""。 */
export function feedTarget(name) {
  return TARGETS.find((target) => updaterFeedFile(target) === name) ?? "";
}

/**
 * The component a published name declares. A name that follows no convention
 * declares none, and nothing matches it.
 */
export function assetComponent(name) {
  if (MANIFEST_ASSETS.includes(name)) return "manifest";
  if (feedTarget(name) !== "") return "manifest";
  const separator = name.indexOf("_");
  if (separator < 0) return "";
  const prefixes = { Armadra: "desktop", "armadra-web": "web" };
  return prefixes[name.slice(0, separator)] ?? "";
}

/** The target a published name declares. */
export function assetTarget(name) {
  const lower = name.toLowerCase();
  for (const system of ["darwin", "linux", "windows"]) {
    const index = lower.indexOf(`${system}-`);
    if (index < 0) continue;
    if (index > 0 && /[a-z0-9]/.test(lower[index - 1])) continue;
    const rest = lower.slice(index + system.length + 1);
    const match = /^[a-z0-9_]+/.exec(rest);
    if (!match) continue;
    return `${system}-${match[0]}`;
  }
  return "";
}

/**
 * The desktop bundles a target produces. Exactly one per platform takes part
 * in automatic updates; the rest exist so a first install is possible.
 *
 * `kind` names the electron-builder target each one comes from, and it is
 * one-for-one with `apps/desktop/electron-builder.yml`'s per-platform `target`
 * lists — `apps/desktop/scripts/artifact-targets.test.mjs` fails if the two
 * drift apart.
 *
 * The names below are NOT electron-builder's own. It writes
 * `Armadra-0.1.0-arm64.dmg`, `Armadra-Setup-0.1.0-arm64.exe` and
 * `armadra_0.1.0_amd64.deb`, and none of those declares a target `assetTarget`
 * can read (it finds nothing in `arm64` or `amd64`). None of them, and none
 * of the names below, has a space: Azure Artifact Signing cannot sign one. `stage-desktop.mjs` looks each bundle up by `kind`
 * and renames it to the name here, so the rename is stated once rather than
 * repeated as a `find` in every release job.
 *
 * Which one updates in place is electron-updater's rule, not a choice:
 *
 * - macOS updates from the **zip**, never the `.dmg` — a dmg is a disk image
 *   a person mounts, and the updater replaces an app bundle.
 * - Windows updates from the **NSIS installer**, run with its silent flags.
 *   The zip is the portable copy for machines where an installer cannot run;
 *   it is not an updater target, because nothing records where it was
 *   unpacked to.
 * - Linux updates from the **AppImage**, which is one self-contained file.
 *   A `.deb` or `.rpm` belongs to a package manager, and offering to replace
 *   one behind the package manager's back is how a system ends up with two
 *   disagreeing records of what is installed.
 */
export function desktopAssets(version, target) {
  if (target.startsWith("darwin-"))
    return [
      { name: `Armadra_${version}_${target}.zip`, updater: true, kind: "zip" },
      { name: `Armadra_${version}_${target}.dmg`, updater: false, kind: "dmg" },
    ];
  if (target.startsWith("windows-"))
    return [
      {
        name: `Armadra_${version}_${target}-setup.exe`,
        updater: true,
        kind: "nsis",
      },
      {
        name: `Armadra_${version}_${target}-portable.zip`,
        updater: false,
        kind: "zip",
      },
    ];
  return [
    {
      name: `Armadra_${version}_${target}.AppImage`,
      updater: true,
      kind: "AppImage",
    },
    { name: `Armadra_${version}_${target}.deb`, updater: false, kind: "deb" },
    { name: `Armadra_${version}_${target}.rpm`, updater: false, kind: "rpm" },
  ];
}
