import { strict as assert } from "node:assert";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MOBILE_MANIFEST,
  MOBILE_PAGE_PROTOCOL,
  VERSION_SITES,
  checkAgentPin,
  checkChangelog,
  checkMobile,
  checkDesktopServe,
  checkPlatformPin,
  checkVersions,
  readVersions,
  setVersion,
  workspaceVersion,
} from "./version.mjs";
import {
  compareVersions,
  extractFence,
  normalize,
  normalizeAcp,
  normalizeAgentPin,
  normalizeClaudeMods,
  normalizeMobile,
  normalizePlatformPin,
  readAcpCompatibility,
  readAgentPin,
  readClaudeModsCompatibility,
  readCompatibility,
  readMobileCompatibility,
  readPlatformPin,
  releaseNote,
  renderFence,
} from "./compatibility.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** A throwaway copy of just the files that carry a version. */
function workspace(version = "0.2.0") {
  const base = mkdtempSync(join(tmpdir(), "armadra-version-")) + "/";
  for (const site of VERSION_SITES) {
    mkdirSync(dirname(base + site.path), { recursive: true });
    cpSync(root + site.path, base + site.path);
  }
  setVersion(version, base);
  return base;
}

test("the repository's own versions agree", () => {
  const { problems } = checkVersions({});
  assert.deepEqual(problems, []);
  assert.equal(readVersions()[0].version, workspaceVersion());
});

test("one file left behind fails the check", () => {
  const base = workspace();
  try {
    const stale = base + "apps/desktop/package.json";
    writeFileSync(
      stale,
      readFileSync(stale, "utf8").replace(
        '"version": "0.2.0"',
        '"version": "0.1.9"',
      ),
    );
    const { problems } = checkVersions({
      base,
      compatibility: normalize({
        minimumInstalled: "0.1.0",
      }),
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /apps\/desktop\/package\.json says 0\.1\.9/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("set rewrites the version constants in source, and check reads them", () => {
  const base = workspace("0.3.1");
  try {
    for (const path of [
      "apps/desktop/src/core/instance.ts",
      "apps/desktop/src/cli/armadra-hook/usage.ts",
    ]) {
      assert.match(readFileSync(base + path, "utf8"), /= "0\.3\.1";/);
    }
    const stale = base + "apps/desktop/src/core/instance.ts";
    writeFileSync(
      stale,
      readFileSync(stale, "utf8").replace('"0.3.1"', '"0.3.0"'),
    );
    const { problems } = checkVersions({
      base,
      compatibility: normalize({ minimumInstalled: "0.1.0" }),
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /instance\.ts says 0\.3\.0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a tag that does not name the version fails the check", () => {
  const base = workspace();
  const compatibility = normalize({
    minimumInstalled: "0.1.0",
  });
  try {
    assert.deepEqual(
      checkVersions({ base, tag: "v0.2.0", compatibility }).problems,
      [],
    );
    assert.match(
      checkVersions({ base, tag: "v0.3.0", compatibility }).problems[0],
      /does not name/,
    );
    assert.match(
      checkVersions({ base, tag: "0.2.0", compatibility }).problems[0],
      /does not start/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// A release that excluded its own version would be offered to nobody, which is
// the kind of mistake that only shows up when a client fails to update.
test("a compatibility range that excludes the release fails the check", () => {
  const base = workspace("0.2.0");
  try {
    const tooNew = normalize({
      minimumInstalled: "0.3.0",
    });
    assert.match(
      checkVersions({ base, compatibility: tooNew }).problems[0],
      /excludes 0\.2\.0/,
    );
    const uselessCeiling = normalize({
      minimumInstalled: "0.1.0",
      maximumInstalled: "0.2.0",
    });
    assert.match(
      checkVersions({ base, compatibility: uselessCeiling }).problems[0],
      /does not exclude/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("set writes every site and reports what changed", () => {
  const base = workspace("0.2.0");
  try {
    const { version, changed } = setVersion("0.3.0-beta.1", base);
    assert.equal(version, "0.3.0-beta.1");
    assert.equal(changed.length, VERSION_SITES.length);
    for (const site of readVersions(base))
      assert.equal(site.version, "0.3.0-beta.1");
    assert.deepEqual(
      setVersion("0.3.0-beta.1", base).changed,
      [],
      "a no-op set reports no change",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("versions order the way the updater orders them", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("0.2.0-beta.1", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0-beta.1", "0.2.0-beta.2"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("the fence round-trips and refuses what a reader would refuse", () => {
  const range = { minimumInstalled: "0.1.0" };
  const fence = renderFence(range);
  assert.equal(fence.split("\n")[1], '{"minimumInstalled":"0.1.0"}');
  assert.deepEqual(extractFence(`notes\n\n${fence}\n\nmore`), range);
  assert.equal(extractFence("no fence here"), null);
  // The fence is parsed strictly, so an extra key must fail here rather than
  // at the moment a client tries to update. The protocol numbers the fence
  // used to carry are exactly such a key now: there is no second process to
  // declare a protocol to.
  for (const extra of [
    { channel: "stable" },
    { protocolMajor: 1 },
    { minimumProtocolMinor: 2 },
  ]) {
    assert.throws(
      () => normalize({ ...range, ...extra }),
      /unknown compatibility key/,
    );
  }
  assert.throws(
    () => normalize({ ...range, maximumInstalled: "0.0.1" }),
    /minimumInstalled is above maximumInstalled/,
  );
});

test("the acp key sits beside the fence and never enters it", () => {
  const fence = readCompatibility();
  assert.equal("acp" in fence, false);
  assert.match(
    renderFence(fence),
    /^```armadra-compatibility\n\{"minimumInstalled"/,
  );
  const acp = readAcpCompatibility();
  assert.equal(acp.protocolVersion, 1);
  assert.equal(acp.adapters.claude.program, "claude-agent-acp");
  // The fence itself still refuses it: a reader parses the fence strictly.
  assert.throws(
    () => normalize({ minimumInstalled: "0.1.0", acp: {} }),
    /unknown compatibility key/,
  );
  assert.deepEqual(
    normalizeAcp({
      protocolVersion: 1,
      adapters: {
        codex: { program: "codex-acp", verified: { min: "1.10.0" } },
      },
    }).adapters.codex,
    { program: "codex-acp", verified: { min: "1.10.0" } },
  );
  for (const bad of [
    { protocolVersion: 2, adapters: {} },
    { protocolVersion: 1, adapters: { x: { program: "", verified: null } } },
    {
      protocolVersion: 1,
      adapters: {
        x: { program: "x", verified: { min: "2.0.0", max: "1.0.0" } },
      },
    },
  ]) {
    assert.throws(() => normalizeAcp(bad));
  }
});

test("a release note carries the fence and says when nothing notarised it", () => {
  const range = { minimumInstalled: "0.1.0" };
  const plain = releaseNote({
    version: "0.2.0",
    notes: "Fixes.",
    compatibility: range,
  });
  assert.ok(plain.startsWith("Fixes."));
  assert.deepEqual(extractFence(plain), range);
  const unsigned = releaseNote({
    version: "0.2.0",
    notes: "Fixes.",
    compatibility: range,
    unnotarized: ["macOS", "Windows"],
  });
  assert.match(unsigned.split("\n")[0], /^> Not notarised.*macOS, Windows/);
  assert.deepEqual(extractFence(unsigned), range);
});

test("the agent pin agrees with the desktop manifest and the lockfile", () => {
  assert.deepEqual(checkAgentPin(), []);
  const pin = readAgentPin();
  assert.equal(pin.package, "@armadra/agent");
  assert.equal(pin.hostApi, 1);
  // Never in the fence: a reader parses it strictly.
  assert.ok(!renderFence(readCompatibility()).includes("agent"));
});

test("an agent pin that moved alone fails the check", () => {
  const base = mkdtempSync(join(tmpdir(), "armadra-agent-pin-")) + "/";
  try {
    mkdirSync(base + "apps/desktop", { recursive: true });
    cpSync(
      root + "apps/desktop/package.json",
      base + "apps/desktop/package.json",
    );
    cpSync(root + "pnpm-lock.yaml", base + "pnpm-lock.yaml");
    const moved = { ...readAgentPin(), version: "9.9.9" };
    const problems = checkAgentPin({ base, agent: moved });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /apps\/desktop\/package\.json pins/);
    assert.match(problems[1], /pnpm-lock\.yaml/);
    assert.throws(() => normalizeAgentPin({ ...moved, version: "^0.6.2" }));
    assert.throws(() => normalizeAgentPin({ ...moved, package: "other" }));
    assert.throws(() => normalizeAgentPin({ ...moved, extra: 1 }));
    // A fence is parsed strictly: the agent key is refused there.
    assert.throws(() => normalize({ minimumInstalled: "0.1.0", agent: moved }));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the platform pin agrees with the manifests, tarball, lockfile and install", () => {
  assert.deepEqual(checkPlatformPin(), []);
  const pin = readPlatformPin();
  assert.equal(pin.package, "@armadra/platform-protocol");
  // Never in the fence: installed clients parse it strictly.
  assert.ok(!renderFence(readCompatibility()).includes("platform"));
});

test("a platform pin that moved alone, or a changed tarball, fails the check", () => {
  const base = mkdtempSync(join(tmpdir(), "armadra-platform-pin-")) + "/";
  try {
    const pin = readPlatformPin();
    const tarball = "tools/vendor/" + pin.tarball.file;
    mkdirSync(base + "tools/vendor", { recursive: true });
    cpSync(root + tarball, base + tarball);
    cpSync(root + "pnpm-lock.yaml", base + "pnpm-lock.yaml");
    for (const dir of ["packages/shared", "apps/desktop", "apps/web"]) {
      mkdirSync(base + dir, { recursive: true });
      cpSync(root + dir + "/package.json", base + dir + "/package.json");
    }
    // No node_modules in the copy: only the install check complains.
    const only = (problems) =>
      problems.filter((problem) => !/no installed/.test(problem));
    assert.deepEqual(only(checkPlatformPin({ base })), []);
    writeFileSync(base + tarball, "tampered");
    assert.match(only(checkPlatformPin({ base }))[0], /sha256/);
    cpSync(root + tarball, base + tarball);
    const moved = { ...pin, version: "9.9.9" };
    assert.ok(only(checkPlatformPin({ base, platform: moved })).length > 0);
    assert.throws(() =>
      normalizePlatformPin({ ...pin, images: { ...pin.images, relay: "x" } }),
    );
    assert.throws(() => normalizePlatformPin({ ...pin, version: "^0.1.0" }));
    assert.throws(() => normalizePlatformPin({ ...pin, extra: 1 }));
    assert.throws(() =>
      normalizePlatformPin({
        ...pin,
        tarball: { ...pin.tarball, sha256: "a" },
      }),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the desktop package carries the server shell behind the serve gate", () => {
  assert.deepEqual(checkDesktopServe(), []);
  const base = mkdtempSync(join(tmpdir(), "desktop-serve-"));
  try {
    for (const file of [
      "apps/desktop/package.json",
      "apps/desktop/electron.vite.config.ts",
      "apps/desktop/scripts/after-pack.mjs",
    ]) {
      mkdirSync(dirname(join(base, file)), { recursive: true });
      cpSync(join(root, file), join(base, file));
    }
    const base2 = base + "/";
    assert.deepEqual(checkDesktopServe({ base: base2 }), []);
    // A manifest that points `main` back at index.js skips the gate.
    const manifest = join(base, "apps/desktop/package.json");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace("entry.js", "index.js"),
    );
    assert.match(checkDesktopServe({ base: base2 })[0], /entry\.js/);
    // An after-pack that stops placing the shell fails too.
    const hook = join(base, "apps/desktop/scripts/after-pack.mjs");
    writeFileSync(
      hook,
      readFileSync(hook, "utf8").replace('"server/main.js"', '"x/main.js"'),
    );
    assert.ok(
      checkDesktopServe({ base: base2 }).some((p) =>
        /server\/main\.js/.test(p),
      ),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** The files the mobile check reads, copied out of the repository. */
const MOBILE_FILES = [
  MOBILE_MANIFEST,
  MOBILE_PAGE_PROTOCOL,
  "apps/mobile/ios/App/App.xcodeproj/project.pbxproj",
  "apps/mobile/ios/version.xcconfig",
  "apps/mobile/ios/debug.xcconfig",
  "apps/mobile/android/app/build.gradle",
  "apps/desktop/src/core/identity/protocol.ts",
];

function mobileWorkspace() {
  const base = mkdtempSync(join(tmpdir(), "armadra-mobile-version-")) + "/";
  for (const path of MOBILE_FILES) {
    mkdirSync(dirname(base + path), { recursive: true });
    cpSync(root + path, base + path);
  }
  return base;
}

function edit(base, path, from, to) {
  const text = readFileSync(base + path, "utf8");
  assert.ok(
    from.test ? from.test(text) : text.includes(from),
    `${path} has ${from}`,
  );
  writeFileSync(base + path, text.replace(from, to));
}

const mobileRange = (minor = 14) =>
  normalizeMobile({ minimumHostProtocol: { major: 1, minor } });

test("the mobile app shares the suite version line", () => {
  assert.ok(VERSION_SITES.some((site) => site.path === MOBILE_MANIFEST));
  const mobile = readVersions().find((s) => s.path === MOBILE_MANIFEST);
  assert.equal(mobile.version, workspaceVersion());
  assert.deepEqual(checkVersions({}).problems, []);
});

test("a mobile manifest left behind fails the check, and set moves it too", () => {
  const base = workspace("0.2.0");
  try {
    edit(base, MOBILE_MANIFEST, /"version": "0\.2\.0"/, '"version": "1.1.0"');
    assert.match(
      checkVersions({ base }).problems.join("\n"),
      /apps\/mobile\/package\.json says 1\.1\.0, the root manifest says 0\.2\.0/,
    );
    const { changed } = setVersion("0.3.0", base);
    assert.ok(changed.some((l) => l.startsWith("apps/mobile/package.json:")));
    assert.deepEqual(checkVersions({ base }).problems, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the repository's own mobile projects and protocol check out", () => {
  const { problems } = checkMobile({});
  assert.deepEqual(problems, []);
  assert.deepEqual(readMobileCompatibility().minimumHostProtocol, {
    major: 1,
    minor: 14,
  });
});

test("the changelog needs a section for the version", () => {
  assert.deepEqual(checkChangelog(workspaceVersion()), []);
  assert.match(checkChangelog("9.9.9")[0], /no "## 9\.9\.9" section/);
});

test("a hard-coded iOS version or an Android derivation from semver fails", () => {
  const base = mobileWorkspace();
  try {
    edit(
      base,
      "apps/mobile/ios/App/App.xcodeproj/project.pbxproj",
      "INFOPLIST_FILE = App/Info.plist;",
      "INFOPLIST_FILE = App/Info.plist;\n\t\t\t\tMARKETING_VERSION = 0.2.0;",
    );
    edit(
      base,
      "apps/mobile/android/app/build.gradle",
      "versionCode appVersion.versionCode",
      "versionCode((System.getenv('ARMADRA_VERSION_CODE') ?: '1').toInteger())",
    );
    edit(
      base,
      "apps/mobile/ios/debug.xcconfig",
      '#include "version.xcconfig"',
      "",
    );
    const problems = checkMobile({ base, mobile: mobileRange() }).problems;
    assert.equal(problems.length, 3, problems.join("\n"));
    assert.match(problems[0], /hard-codes MARKETING_VERSION/);
    assert.match(
      problems[1],
      /debug\.xcconfig does not include version\.xcconfig/,
    );
    assert.match(problems[2], /build\.gradle does not take versionName/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("compatibility.json mobile follows the core's protocol and the page's copy", () => {
  const base = mobileWorkspace();
  try {
    const core = readFileSync(
      root + "apps/desktop/src/core/identity/protocol.ts",
      "utf8",
    );
    const coreMinor = Number(/PROTOCOL_MINOR = (\d+)/.exec(core)[1]);
    assert.match(
      checkMobile({ base, mobile: mobileRange(coreMinor + 1) }).problems.join(
        "\n",
      ),
      /above the core's own 1\./,
    );
    assert.match(
      checkMobile({
        base,
        mobile: normalizeMobile({
          minimumHostProtocol: { major: 2, minor: 0 },
        }),
      }).problems.join("\n"),
      /the core speaks major 1/,
    );
    edit(base, MOBILE_PAGE_PROTOCOL, /minor: 14/, "minor: 15");
    assert.match(
      checkMobile({ base, mobile: mobileRange() }).problems[0],
      /host-compatibility\.ts says 1\.15, compatibility\.json .* says 1\.14/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the mobile entry is strict and stays out of the fence", () => {
  assert.throws(() => normalizeMobile(undefined), /no mobile entry/);
  assert.throws(
    () =>
      normalizeMobile({ minimumHostProtocol: { major: 1, minor: 1 }, x: 1 }),
    /unknown mobile key/,
  );
  assert.throws(
    () => normalizeMobile({ minimumHostProtocol: { major: 0, minor: 1 } }),
    /major/,
  );
  assert.throws(
    () => normalizeMobile({ minimumHostProtocol: { major: 1, minor: -1 } }),
    /minor/,
  );
  const fence = extractFence(
    releaseNote({
      version: "0.2.4",
      notes: "x",
      compatibility: readCompatibility(),
    }),
  );
  assert.deepEqual(Object.keys(fence), ["minimumInstalled"]);
});

test("the claudeMods key sits beside the fence, and only widens what it verified", () => {
  assert.equal("claudeMods" in readCompatibility(), false);
  assert.equal(readClaudeModsCompatibility().minVersion, "2.1.293");
  assert.throws(
    () => normalize({ minimumInstalled: "0.1.0", claudeMods: {} }),
    /unknown compatibility key/,
  );
  assert.deepEqual(
    normalizeClaudeMods({
      minVersion: "2.1.293",
      verified: { min: "2.1.293", max: "2.1.295" },
    }),
    { minVersion: "2.1.293", verified: { min: "2.1.293", max: "2.1.295" } },
  );
  for (const bad of [
    null,
    { minVersion: "x", verified: null },
    { minVersion: "2.1.293", verified: { min: "2.1.200" } },
    { minVersion: "2.1.293", verified: { min: "2.1.296", max: "2.1.293" } },
    { minVersion: "2.1.293", verified: null, extra: 1 },
  ]) {
    assert.throws(() => normalizeClaudeMods(bad), JSON.stringify(bad));
  }
});
