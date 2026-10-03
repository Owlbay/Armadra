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
  VERSION_SITES,
  checkAgentPin,
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
  readAcpCompatibility,
  readAgentPin,
  readCompatibility,
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
