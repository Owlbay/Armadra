/**
 * One version, three manifests, one tag — for the desktop suite.
 *
 * The root `package.json` is the only source; the two shells are checked
 * against it. A release built from files that disagree would ship a desktop
 * shell and a server shell that report different versions, and the update
 * check compares versions — so this runs first in CI and refuses the tag
 * rather than producing that release.
 *
 * The phone / tablet app is not part of that suite: it has its own version
 * line in `apps/mobile/package.json` (plain X.Y.Z, its own `mobile-vX.Y.Z`
 * tag, its own `apps/mobile/CHANGELOG.md`), and whether it works with a host
 * is decided by protocol (compatibility.json `mobile`), not by the numbers
 * being equal. The `mobile` subcommands look after it.
 *
 *   node tools/release/version.mjs check [--tag vX.Y.Z]
 *   node tools/release/version.mjs set X.Y.Z
 *   node tools/release/version.mjs print
 *   node tools/release/version.mjs mobile check [--tag mobile-vX.Y.Z]
 *   node tools/release/version.mjs mobile set X.Y.Z
 *   node tools/release/version.mjs mobile print
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AGENT_PACKAGE,
  compareVersions,
  parseVersion,
  PLATFORM_PACKAGE,
  readAgentPin,
  readCompatibility,
  readMobileCompatibility,
  readPlatformPin,
} from "./compatibility.mjs";
import { changelogSection } from "./changelog.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Every file that repeats the version. The root manifest is first because it
 * is the source; the rest are compared with it.
 *
 * Both shells are here because both are published: electron-builder reads the
 * version out of the desktop manifest, and the server shell reports its own.
 */
export const VERSION_SITES = [
  { path: "package.json", kind: "json" },
  { path: "apps/desktop/package.json", kind: "json" },
  { path: "apps/server/package.json", kind: "json" },
  // 手机壳不在这里：它有自己的版本线，见下面的 MOBILE_* 与 `mobile` 子命令。
  // core 与 armadra-hook 各把版本写成常量（运行时不读 manifest）；漏改时
  // instance.test / hook.test 才会在单测里红，这里让 set 一起改、check 一起看。
  { path: "apps/desktop/src/core/instance.ts", kind: "ts", name: "VERSION" },
  {
    path: "apps/desktop/src/cli/armadra-hook/usage.ts",
    kind: "ts",
    name: "CLIENT_VERSION",
  },
];

const JSON_VERSION = /^(\s*"version"\s*:\s*")([^"]*)(")/m;

function pattern(site) {
  if (site.kind === "ts")
    return new RegExp(`^(export const ${site.name} = ")([^"]*)(";)`, "m");
  return JSON_VERSION;
}

/** Read the version each site declares. */
export function readVersions(base = root) {
  return VERSION_SITES.map((site) => {
    const text = readFileSync(base + site.path, "utf8");
    const match = pattern(site).exec(text);
    if (!match) throw new Error(`no version field in ${site.path}`);
    return { ...site, version: match[2] };
  });
}

/** The version the root manifest declares — the one everything else must equal. */
export function workspaceVersion(base = root) {
  return readVersions(base)[0].version;
}

/**
 * Check every site, the tag if one was given, and the compatibility range.
 * Returns the problems rather than throwing, so all of them are reported at
 * once: a release engineer fixing one line at a time per CI run is a release
 * engineer who stops reading the output.
 */
export function checkVersions({ base = root, tag = "", compatibility } = {}) {
  const problems = [];
  const sites = readVersions(base);
  const expected = sites[0].version;
  try {
    parseVersion(expected);
  } catch {
    problems.push(`${sites[0].path} holds ${expected}, which is not a version`);
    return { version: expected, problems };
  }
  for (const site of sites.slice(1)) {
    if (site.version !== expected)
      problems.push(
        `${site.path} says ${site.version}, the root manifest says ${expected}`,
      );
  }
  if (tag) {
    if (!tag.startsWith("v"))
      problems.push(`tag ${tag} does not start with "v"`);
    else if (tag.slice(1) !== expected)
      problems.push(`tag ${tag} does not name the version ${expected}`);
  }
  const range = compatibility ?? readCompatibility();
  if (compareVersions(range.minimumInstalled, expected) > 0) {
    problems.push(
      `compatibility.json accepts installs from ${range.minimumInstalled} upward, which excludes ${expected} itself`,
    );
  }
  if (
    range.maximumInstalled &&
    compareVersions(range.maximumInstalled, expected) >= 0
  ) {
    // A ceiling exists to stop an older line from offering this release to a
    // newer install. One at or above this version would refuse nothing.
    problems.push(
      `compatibility.json declares maximumInstalled ${range.maximumInstalled}, which does not exclude anything below ${expected}`,
    );
  }
  return { version: expected, problems };
}

/**
 * The pinned `@armadra/agent` (compatibility.json's `agent`) against what is
 * installed: the desktop manifest's devDependency must be that exact version,
 * and the lockfile's specifier and resolved version too. Returns problems.
 */
export function checkAgentPin({ base = root, agent } = {}) {
  const problems = [];
  let pin;
  try {
    pin = agent ?? readAgentPin();
  } catch (error) {
    return [String(error instanceof Error ? error.message : error)];
  }
  const manifest = JSON.parse(
    readFileSync(base + "apps/desktop/package.json", "utf8"),
  );
  const declared =
    manifest.devDependencies?.[AGENT_PACKAGE] ??
    manifest.dependencies?.[AGENT_PACKAGE];
  if (declared !== pin.version) {
    problems.push(
      `apps/desktop/package.json pins ${AGENT_PACKAGE} at ${declared ?? "nothing"}, compatibility.json at ${pin.version}`,
    );
  }
  const lock = readFileSync(base + "pnpm-lock.yaml", "utf8");
  const entry = new RegExp(
    `'${AGENT_PACKAGE.replace("/", "\\/")}':\\n\\s+specifier: (\\S+)\\n\\s+version: (\\S+)`,
  ).exec(lock);
  if (entry === null) {
    problems.push(`pnpm-lock.yaml installs no ${AGENT_PACKAGE}`);
  } else {
    const installed = entry[2].replace(/\(.*$/, "");
    if (entry[1] !== pin.version || installed !== pin.version) {
      problems.push(
        `pnpm-lock.yaml has ${AGENT_PACKAGE} ${entry[1]} → ${installed}, compatibility.json pins ${pin.version}`,
      );
    }
  }
  return problems;
}

/** Workspaces that depend on the protocol package (platform-protocol §1.3). */
const PLATFORM_CONSUMERS = ["packages/shared", "apps/desktop", "apps/web"];

/**
 * The pinned `@armadra/platform-protocol` (compatibility.json's `platform`)
 * against what is installed: each consumer manifest names the vendored
 * tarball of that exact version, the tarball's sha256 is the recorded one, the
 * lockfile resolved it from that file, and the installed copy reports the
 * version. Returns problems.
 */
export function checkPlatformPin({ base = root, platform } = {}) {
  const problems = [];
  let pin;
  try {
    pin = platform ?? readPlatformPin();
  } catch (error) {
    return [String(error instanceof Error ? error.message : error)];
  }
  const tarball = `tools/vendor/${pin.tarball.file}`;
  if (!pin.tarball.file.endsWith(`-${pin.version}.tgz`)) {
    problems.push(
      `platform.tarball.file ${pin.tarball.file} does not carry version ${pin.version}`,
    );
  }
  if (!existsSync(base + tarball)) {
    problems.push(`${tarball} is missing`);
  } else {
    const sha = createHash("sha256")
      .update(readFileSync(base + tarball))
      .digest("hex");
    if (sha !== pin.tarball.sha256)
      problems.push(
        `${tarball} has sha256 ${sha}, compatibility.json records ${pin.tarball.sha256}`,
      );
  }
  for (const dir of PLATFORM_CONSUMERS) {
    const manifest = JSON.parse(
      readFileSync(`${base}${dir}/package.json`, "utf8"),
    );
    const declared =
      manifest.dependencies?.[PLATFORM_PACKAGE] ??
      manifest.devDependencies?.[PLATFORM_PACKAGE];
    const depth = "../".repeat(dir.split("/").length);
    const expected = `file:${depth}${tarball}`;
    if (declared !== expected) {
      problems.push(
        `${dir}/package.json depends on ${PLATFORM_PACKAGE} at ${declared ?? "nothing"}, expected ${expected}`,
      );
    }
    const installed = `${base}${dir}/node_modules/${PLATFORM_PACKAGE}/package.json`;
    if (existsSync(installed)) {
      const version = JSON.parse(readFileSync(installed, "utf8")).version;
      if (version !== pin.version)
        problems.push(
          `${dir} has ${PLATFORM_PACKAGE} ${version} installed, compatibility.json pins ${pin.version}`,
        );
    } else {
      problems.push(
        `${dir} has no installed ${PLATFORM_PACKAGE}; run pnpm install`,
      );
    }
  }
  const lock = readFileSync(base + "pnpm-lock.yaml", "utf8");
  const key = `'${PLATFORM_PACKAGE}@file:${tarball}`;
  const at = lock.indexOf(key);
  if (at < 0) {
    problems.push(
      `pnpm-lock.yaml resolves no ${PLATFORM_PACKAGE} from ${tarball}`,
    );
  } else if (!/^\s+version: (\S+)/m.test(lock.slice(at, at + 600))) {
    problems.push(
      `pnpm-lock.yaml entry for ${PLATFORM_PACKAGE} has no version`,
    );
  } else {
    const lockVersion = /^\s+version: (\S+)/m.exec(lock.slice(at, at + 600))[1];
    if (lockVersion !== pin.version)
      problems.push(
        `pnpm-lock.yaml has ${PLATFORM_PACKAGE} ${lockVersion}, compatibility.json pins ${pin.version}`,
      );
    if (!/integrity: sha512-/.test(lock.slice(at, at + 600)))
      problems.push(`pnpm-lock.yaml has no integrity for ${PLATFORM_PACKAGE}`);
  }
  return problems;
}

/**
 * The desktop package carries the server shell (`Armadra serve`, platform plan
 * A5-1): the manifest's `main` is the gate `main/entry.ts` builds, the build
 * config emits it, and `after-pack.mjs` places the shell's `main.js` and page
 * under `resources/server/`. Returns problems.
 */
export function checkDesktopServe({ base = root } = {}) {
  const problems = [];
  const read = (path) => {
    try {
      return readFileSync(base + path, "utf8");
    } catch {
      problems.push(`${path} is missing`);
      return "";
    }
  };
  const main = JSON.parse(read("apps/desktop/package.json") || "{}").main;
  if (main !== "./out/main/entry.js")
    problems.push(
      `apps/desktop/package.json main is ${main}, expected ./out/main/entry.js (the Armadra serve gate)`,
    );
  if (
    !/entry:\s*resolve\(here,\s*"src\/main\/entry\.ts"\)/.test(
      read("apps/desktop/electron.vite.config.ts"),
    )
  )
    problems.push("electron.vite.config.ts does not build src/main/entry.ts");
  const afterPack = read("apps/desktop/scripts/after-pack.mjs");
  for (const place of ['SERVER_TO = "server/main.js"', 'WEB_TO = "server/web"'])
    if (!afterPack.includes(place))
      problems.push(`after-pack.mjs no longer places ${place}`);
  return problems;
}

/** The phone / tablet app's own version line. */
export const MOBILE_MANIFEST = "apps/mobile/package.json";
export const MOBILE_CHANGELOG = "apps/mobile/CHANGELOG.md";
export const MOBILE_TAG_PREFIX = "mobile-v";
/** Where the bundled page keeps its copy of compatibility.json `mobile`. */
export const MOBILE_PAGE_PROTOCOL = "apps/web/src/mobile/host-compatibility.ts";
const CORE_PROTOCOL = "apps/desktop/src/core/identity/protocol.ts";
const IOS_PROJECT = "apps/mobile/ios/App/App.xcodeproj/project.pbxproj";
const IOS_VERSION_XCCONFIG = "apps/mobile/ios/version.xcconfig";
const IOS_DEBUG_XCCONFIG = "apps/mobile/ios/debug.xcconfig";
const ANDROID_GRADLE = "apps/mobile/android/app/build.gradle";

/** Store version names take no pre-release suffix (CFBundleShortVersionString). */
const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The version `apps/mobile/package.json` declares. */
export function mobileVersion(base = root) {
  const match = JSON_VERSION.exec(readFileSync(base + MOBILE_MANIFEST, "utf8"));
  if (!match) throw new Error(`no version field in ${MOBILE_MANIFEST}`);
  return match[2];
}

/** Write a new mobile version. Plain X.Y.Z only. */
export function setMobileVersion(next, base = root) {
  const version = String(next ?? "").trim();
  if (!PLAIN_VERSION.test(version))
    throw new Error(
      `mobile version must be a plain X.Y.Z (no pre-release): ${next}`,
    );
  const file = base + MOBILE_MANIFEST;
  const text = readFileSync(file, "utf8");
  let previous = "";
  const replaced = text.replace(JSON_VERSION, (_, head, current, tail) => {
    previous = current;
    return head + version + tail;
  });
  if (replaced !== text) writeFileSync(file, replaced);
  return {
    version,
    changed:
      previous && previous !== version
        ? [`${MOBILE_MANIFEST}: ${previous} -> ${version}`]
        : [],
  };
}

function protocolOf(text, majorName, minorName) {
  const major = new RegExp(`${majorName}\\s*=\\s*(\\d+)`).exec(text);
  const minor = new RegExp(`${minorName}\\s*=\\s*(\\d+)`).exec(text);
  return major && minor
    ? { major: Number(major[1]), minor: Number(minor[1]) }
    : null;
}

/**
 * Check the mobile app's version line on its own: the version is a plain
 * X.Y.Z, the tag (if any) names it, both native projects derive their version
 * and build number from the generated files instead of hard-coding them, the
 * app's changelog has a section for it, and compatibility.json `mobile`
 * agrees with the bundled page and with the core's protocol. Returns problems.
 */
export function checkMobile({ base = root, tag = "", mobile } = {}) {
  const problems = [];
  const read = (path) => {
    try {
      return readFileSync(base + path, "utf8");
    } catch {
      problems.push(`${path} is missing`);
      return "";
    }
  };
  let version = "";
  try {
    version = mobileVersion(base);
  } catch (error) {
    problems.push(String(error instanceof Error ? error.message : error));
  }
  if (version && !PLAIN_VERSION.test(version))
    problems.push(
      `${MOBILE_MANIFEST} holds ${version}; the mobile version must be a plain X.Y.Z (store version names take no pre-release suffix)`,
    );
  if (tag) {
    if (!tag.startsWith(MOBILE_TAG_PREFIX))
      problems.push(`tag ${tag} does not start with "${MOBILE_TAG_PREFIX}"`);
    else if (tag.slice(MOBILE_TAG_PREFIX.length) !== version)
      problems.push(`tag ${tag} does not name the mobile version ${version}`);
  }

  const project = read(IOS_PROJECT);
  if (/\b(MARKETING_VERSION|CURRENT_PROJECT_VERSION)\s*=/.test(project))
    problems.push(
      `${IOS_PROJECT} hard-codes MARKETING_VERSION or CURRENT_PROJECT_VERSION; they come from ${IOS_VERSION_XCCONFIG}`,
    );
  if (
    project &&
    !/baseConfigurationReference = [0-9A-F]{24} \/\* version\.xcconfig \*\/;/.test(
      project,
    )
  )
    problems.push(
      `${IOS_PROJECT} does not base a configuration on version.xcconfig`,
    );
  if (
    !/^#include "version\.generated\.xcconfig"$/m.test(
      read(IOS_VERSION_XCCONFIG),
    )
  )
    problems.push(
      `${IOS_VERSION_XCCONFIG} does not include version.generated.xcconfig`,
    );
  if (!/^#include "version\.xcconfig"$/m.test(read(IOS_DEBUG_XCCONFIG)))
    problems.push(`${IOS_DEBUG_XCCONFIG} does not include version.xcconfig`);

  const gradle = read(ANDROID_GRADLE);
  if (
    gradle &&
    (!gradle.includes("file('version.properties')") ||
      /ARMADRA_VERSION_CODE|JsonSlurper/.test(gradle))
  )
    problems.push(
      `${ANDROID_GRADLE} does not take versionName / versionCode from version.properties`,
    );

  const changelog = read(MOBILE_CHANGELOG);
  if (changelog && version && changelogSection(changelog, version) === null)
    problems.push(`${MOBILE_CHANGELOG} has no "## ${version}" section`);

  let range;
  try {
    range = mobile ?? readMobileCompatibility();
  } catch (error) {
    problems.push(String(error instanceof Error ? error.message : error));
    return { version, problems };
  }
  const wanted = range.minimumHostProtocol;
  const core = protocolOf(
    read(CORE_PROTOCOL),
    "PROTOCOL_MAJOR",
    "PROTOCOL_MINOR",
  );
  if (core === null) problems.push(`${CORE_PROTOCOL} declares no protocol`);
  else if (wanted.major !== core.major)
    problems.push(
      `compatibility.json mobile.minimumHostProtocol is ${wanted.major}.${wanted.minor}, the core speaks major ${core.major}`,
    );
  else if (wanted.minor > core.minor)
    problems.push(
      `compatibility.json mobile.minimumHostProtocol is ${wanted.major}.${wanted.minor}, above the core's own ${core.major}.${core.minor}`,
    );
  const pageText = read(MOBILE_PAGE_PROTOCOL);
  const page =
    /MINIMUM_HOST_PROTOCOL\s*=\s*\{\s*major:\s*(\d+),\s*minor:\s*(\d+)\s*,?\s*\}/.exec(
      pageText,
    );
  if (pageText && page === null)
    problems.push(`${MOBILE_PAGE_PROTOCOL} declares no MINIMUM_HOST_PROTOCOL`);
  else if (
    page &&
    (Number(page[1]) !== wanted.major || Number(page[2]) !== wanted.minor)
  )
    problems.push(
      `${MOBILE_PAGE_PROTOCOL} says ${page[1]}.${page[2]}, compatibility.json mobile.minimumHostProtocol says ${wanted.major}.${wanted.minor}`,
    );
  return { version, problems };
}

function mobileMain(argv) {
  const [mode, ...rest] = argv;
  if (mode === "print") {
    process.stdout.write(mobileVersion() + "\n");
    return 0;
  }
  if (mode === "set") {
    const { version, changed } = setMobileVersion(rest[0]);
    for (const line of changed) console.log(line);
    console.log(`Mobile version is ${version}.`);
    return 0;
  }
  if (mode !== "check") {
    console.error(
      "usage: node tools/release/version.mjs mobile check|set|print",
    );
    return 2;
  }
  const tagFlag = rest.indexOf("--tag");
  const tag =
    tagFlag >= 0
      ? (rest[tagFlag + 1] ?? "")
      : (process.env.GITHUB_REF_NAME ?? "");
  const named = tag.startsWith(MOBILE_TAG_PREFIX) || tagFlag >= 0 ? tag : "";
  const { version, problems } = checkMobile({ tag: named });
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) {
    console.error(
      `\nMobile version check failed: ${problems.length} problem(s)`,
    );
    return 1;
  }
  console.log(
    `Mobile version ${version}${named ? ` matches tag ${named}` : ""}; iOS and Android derive it, compatibility.json mobile agrees with the page and the core.`,
  );
  return 0;
}

/** Write a new version into every site. */
export function setVersion(next, base = root) {
  const version = parseVersion(next).text;
  const changed = [];
  for (const site of VERSION_SITES) {
    const file = base + site.path;
    const text = readFileSync(file, "utf8");
    const replaced = text.replace(pattern(site), (_, head, current, tail) => {
      if (current !== version)
        changed.push(`${site.path}: ${current} -> ${version}`);
      return head + version + tail;
    });
    if (replaced !== text) writeFileSync(file, replaced);
  }
  return { version, changed };
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "mobile") return mobileMain(rest);
  if (mode === "print") {
    process.stdout.write(workspaceVersion() + "\n");
    return 0;
  }
  if (mode === "set") {
    const { version, changed } = setVersion(rest[0]);
    for (const line of changed) console.log(line);
    console.log(`Version is ${version}.`);
    return 0;
  }
  if (mode !== "check") {
    console.error(
      "usage: node tools/release/version.mjs check|set|print | mobile check|set|print",
    );
    return 2;
  }
  const tagFlag = rest.indexOf("--tag");
  const tag =
    tagFlag >= 0
      ? (rest[tagFlag + 1] ?? "")
      : (process.env.GITHUB_REF_NAME ?? "");
  const { version, problems } = checkVersions({
    tag: tag.startsWith("v") ? tag : "",
  });
  problems.push(...checkAgentPin());
  problems.push(...checkPlatformPin());
  problems.push(...checkDesktopServe());
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) {
    console.error(
      `\nRelease version check failed: ${problems.length} problem(s)`,
    );
    return 1;
  }
  console.log(
    `Desktop suite version ${version} agrees across ${VERSION_SITES.length} files${tag ? ` and tag ${tag}` : ""}; ${AGENT_PACKAGE} and ${PLATFORM_PACKAGE} pinned as installed.`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
