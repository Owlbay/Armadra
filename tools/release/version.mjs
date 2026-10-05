/**
 * One version, three manifests, one tag.
 *
 * The root `package.json` is the only source; the two shells are checked
 * against it. A release built from files that disagree would ship a desktop
 * shell and a server shell that report different versions, and the update
 * check compares versions — so this runs first in CI and refuses the tag
 * rather than producing that release.
 *
 *   node tools/release/version.mjs check [--tag vX.Y.Z]
 *   node tools/release/version.mjs set X.Y.Z
 *   node tools/release/version.mjs print
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
  readPlatformPin,
} from "./compatibility.mjs";

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
  // 手机壳随桌面 / 服务器一起发（补全架构 §10）；Android 的版本名从这里读。
  { path: "apps/mobile/package.json", kind: "json" },
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
    console.error("usage: node tools/release/version.mjs check|set|print");
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
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) {
    console.error(
      `\nRelease version check failed: ${problems.length} problem(s)`,
    );
    return 1;
  }
  console.log(
    `Version ${version} agrees across ${VERSION_SITES.length} files${tag ? ` and tag ${tag}` : ""}; ${AGENT_PACKAGE} and ${PLATFORM_PACKAGE} pinned as installed.`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
