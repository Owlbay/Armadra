import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  findChrome,
  loadManifest,
  runTier,
  sortEntries,
  validateManifest,
} from "./e2e.mjs";

const manifest = loadManifest();

test("the repository's manifest is valid and tier A names the CI probes", () => {
  assert.deepEqual(validateManifest(manifest), []);
  const tierA = manifest.entries
    .filter((entry) => entry.tier === "a")
    .map((entry) => entry.id);
  for (const id of [
    "server-e2e",
    "ui-features-e2e",
    "core-terminal-smoke",
    "core-terminal-lifecycle",
    "remote-e2e",
  ])
    assert.ok(tierA.includes(id), `${id} is not in tier A`);
});

test("the manifest is one file per entry, loaded tier by tier and by id", () => {
  const directory = mkdtempSync(join(tmpdir(), "armadra-e2e-d-"));
  try {
    const entry = (id, tier) => ({
      id,
      tier,
      script: "tools/ci/e2e.mjs",
      timeoutMinutes: 1,
    });
    const put = (file, body) =>
      writeFileSync(
        join(directory, file),
        typeof body === "string" ? body : JSON.stringify(body),
      );
    put("zeta.json", entry("zeta", "a"));
    put("alpha.json", entry("alpha", "b"));
    put("beta.json", entry("beta", "a"));
    put("renamed.json", entry("other", "a"));
    put("notes.md", "not an entry");
    put(".DS_Store", "finder");
    put("._zeta.json", "resource fork");
    put("broken.json", "{");
    const legacy = `${directory}-e2e.json`;
    writeFileSync(legacy, "{}");
    const loaded = loadManifest(directory, legacy);
    assert.deepEqual(
      loaded.entries.map((item) => item.id),
      ["beta", "other", "zeta", "alpha"],
    );
    assert.equal(loaded.entries[0].file, "beta.json");
    const problems = validateManifest(loaded);
    for (const fragment of [
      "e2e.json is back",
      "notes.md is not a .json entry",
      "broken.json is not valid JSON",
      "lives in renamed.json, not <id>.json",
    ])
      assert.ok(
        problems.some((problem) => problem.includes(fragment)),
        `expected a problem mentioning "${fragment}" in ${JSON.stringify(problems)}`,
      );
    assert.equal(problems.length, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(`${directory}-e2e.json`, { force: true });
  }
  // Order does not depend on the order the entries arrived in.
  assert.deepEqual(
    sortEntries([
      { id: "b", tier: "b" },
      { id: "x", tier: "nope" },
      { id: "c", tier: "a" },
      { id: "a", tier: "b" },
    ]).map((item) => item.id),
    ["c", "a", "b", "x"],
  );
});

test("a malformed manifest is reported entry by entry", () => {
  const problems = validateManifest({
    entries: [
      { id: "ok", tier: "a", script: "tools/ci/e2e.mjs", timeoutMinutes: 1 },
      {
        id: "ok",
        tier: "c",
        script: "tools/nope.mjs",
        requires: ["gpu"],
        args: [1],
        platforms: ["beos"],
      },
      {
        tier: "a",
        script: "tools/ci/e2e.mjs",
        timeoutMinutes: 1,
        devStack: "yes",
      },
    ],
  });
  for (const fragment of [
    "repeats its id",
    "has tier c",
    "does not exist",
    "requires gpu",
    "platforms that are not a non-empty list",
    "args that are not a list of strings",
    "no positive timeoutMinutes",
    "no kebab-case id",
    "devStack that is not a boolean",
  ])
    assert.ok(
      problems.some((problem) => problem.includes(fragment)),
      `expected a problem mentioning "${fragment}" in ${JSON.stringify(problems)}`,
    );
  assert.deepEqual(validateManifest({}), ["manifest has no entries list"]);
});

test("CHROME_PATH wins, and a missing one is not silently replaced", () => {
  assert.equal(findChrome({ CHROME_PATH: process.execPath }), process.execPath);
  assert.equal(findChrome({ CHROME_PATH: "/nowhere/chrome" }), null);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "armadra-e2e-test-"));
  const script = (name, body) => {
    writeFileSync(join(root, name), body);
    return name;
  };
  script(
    "pass.mjs",
    `import { writeFileSync } from "node:fs"; import { join } from "node:path"; writeFileSync(join(process.argv[2], "result.json"), JSON.stringify({ chrome: process.env.CHROME_PATH ?? null })); console.log("fine");`,
  );
  script("fail.mjs", `console.error("broken"); process.exit(3);`);
  script("hang.mjs", `setInterval(() => {}, 1000);`);
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

const quiet = () => {};
const present = {
  tmux: () => true,
  chrome: () => "/fake/chrome",
  docker: () => true,
};

test("a tier runs every entry, records each one and fails if any did", async () => {
  const { root, remove } = fixture();
  try {
    const out = join(root, "out");
    const summary = await runTier({
      tier: "a",
      root,
      out,
      log: quiet,
      env: { PATH: process.env.PATH },
      probe: present,
      manifest: {
        entries: [
          {
            id: "pass",
            tier: "a",
            script: "pass.mjs",
            args: ["{out}"],
            requires: ["chrome"],
            timeoutMinutes: 1,
          },
          { id: "fail", tier: "a", script: "fail.mjs", timeoutMinutes: 1 },
          { id: "hang", tier: "a", script: "hang.mjs", timeoutMinutes: 0.01 },
          { id: "later", tier: "b", script: "fail.mjs", timeoutMinutes: 1 },
        ],
      },
    });
    assert.equal(summary.status, "failed");
    assert.deepEqual(
      summary.entries.map((entry) => [entry.id, entry.status]),
      [
        ["pass", "passed"],
        ["fail", "failed"],
        ["hang", "failed"],
      ],
    );
    assert.equal(summary.entries[1].exitCode, 3);
    assert.match(summary.entries[2].reason, /timed out/);
    // {out} became the entry's own directory, and the probe saw CHROME_PATH.
    assert.deepEqual(
      JSON.parse(readFileSync(join(out, "pass", "result.json"), "utf8")),
      { chrome: "/fake/chrome" },
    );
    assert.match(
      readFileSync(join(out, "fail", "output.log"), "utf8"),
      /broken/,
    );
    const written = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    assert.equal(written.status, "failed");
    assert.equal(written.entries.length, 3);
  } finally {
    remove();
  }
});

test("a missing requirement fails the entry without running it", async () => {
  const { root, remove } = fixture();
  try {
    const summary = await runTier({
      tier: "a",
      root,
      out: join(root, "out"),
      log: quiet,
      env: {},
      probe: { ...present, tmux: () => false, chrome: () => null },
      manifest: {
        entries: [
          {
            id: "pass",
            tier: "a",
            script: "pass.mjs",
            args: ["{out}"],
            requires: ["tmux", "chrome"],
            timeoutMinutes: 1,
          },
        ],
      },
    });
    assert.equal(summary.status, "failed");
    assert.equal(summary.entries[0].reason, "missing tmux, chrome");
  } finally {
    remove();
  }
});

test("dev-stack entries are skipped unless ARMADRA_DEV_STACK=1 and Docker answers", async () => {
  const { root, remove } = fixture();
  const entries = [
    {
      id: "stack",
      tier: "a",
      script: "pass.mjs",
      args: ["{out}"],
      devStack: true,
      timeoutMinutes: 1,
    },
    {
      id: "plain",
      tier: "a",
      script: "pass.mjs",
      args: ["{out}"],
      timeoutMinutes: 1,
    },
  ];
  const calls = [];
  const devStack = {
    up: () => (calls.push("up"), 0),
    down: () => (calls.push("down"), 0),
  };
  try {
    const off = await runTier({
      tier: "a",
      root,
      out: join(root, "off"),
      log: quiet,
      env: {},
      probe: present,
      devStack,
      manifest: { entries },
    });
    assert.equal(off.status, "passed");
    assert.deepEqual(
      off.entries.map((entry) => entry.status),
      ["skipped", "passed"],
    );
    assert.match(off.entries[0].reason, /ARMADRA_DEV_STACK/);

    const noDocker = await runTier({
      tier: "a",
      root,
      out: join(root, "nodocker"),
      log: quiet,
      env: { ARMADRA_DEV_STACK: "1" },
      probe: { ...present, docker: () => false },
      devStack,
      manifest: { entries },
    });
    assert.deepEqual(
      noDocker.entries.map((entry) => entry.status),
      ["skipped", "passed"],
    );
    assert.match(noDocker.entries[0].reason, /Docker/);
    assert.deepEqual(calls, []);

    const on = await runTier({
      tier: "a",
      root,
      out: join(root, "on"),
      log: quiet,
      env: { ARMADRA_DEV_STACK: "1", PATH: process.env.PATH },
      probe: present,
      devStack,
      manifest: { entries },
    });
    assert.deepEqual(
      on.entries.map((entry) => entry.status),
      ["passed", "passed"],
    );
    assert.equal(on.devStack, "up");
    assert.deepEqual(calls, ["up", "down"]);

    const broken = await runTier({
      tier: "a",
      root,
      out: join(root, "broken"),
      log: quiet,
      env: { ARMADRA_DEV_STACK: "1" },
      probe: present,
      devStack: { up: () => 1, down: () => 0 },
      manifest: { entries },
    });
    assert.equal(broken.status, "failed");
    assert.equal(broken.entries[0].status, "failed");
  } finally {
    remove();
  }
});

test("an entry for another platform is skipped, and docker is a requirement", async () => {
  const { root, remove } = fixture();
  try {
    const summary = await runTier({
      tier: "b",
      root,
      out: join(root, "out"),
      log: quiet,
      env: { PATH: process.env.PATH },
      platform: "linux",
      probe: { ...present, docker: () => false },
      manifest: {
        entries: [
          {
            id: "mac-only",
            tier: "b",
            script: "fail.mjs",
            platforms: ["darwin"],
            timeoutMinutes: 1,
          },
          {
            id: "linux-only",
            tier: "b",
            script: "pass.mjs",
            args: ["{out}"],
            platforms: ["linux"],
            timeoutMinutes: 1,
          },
          {
            id: "container",
            tier: "b",
            script: "pass.mjs",
            args: ["{out}"],
            requires: ["docker"],
            timeoutMinutes: 1,
          },
        ],
      },
    });
    assert.deepEqual(
      summary.entries.map((entry) => [entry.id, entry.status, entry.reason]),
      [
        ["mac-only", "skipped", "only on darwin"],
        ["linux-only", "passed", undefined],
        ["container", "failed", "missing docker"],
      ],
    );
    assert.equal(summary.platform, `linux-${process.arch}`);
  } finally {
    remove();
  }
});

test("a cloud requirement is skipped without a checkout and passes the path with one", async () => {
  const { root, remove } = fixture();
  const manifest = {
    entries: [
      {
        id: "needs-cloud",
        tier: "a",
        script: "pass.mjs",
        args: ["{out}"],
        requires: ["cloud"],
        timeoutMinutes: 1,
      },
    ],
  };
  try {
    const without = await runTier({
      tier: "a",
      root,
      out: join(root, "without"),
      log: quiet,
      env: { PATH: process.env.PATH },
      probe: { ...present, cloud: () => null },
      manifest,
    });
    assert.equal(without.status, "passed");
    assert.equal(without.entries[0].status, "skipped");
    assert.match(without.entries[0].reason, /armadra-cloud/);
    const withIt = await runTier({
      tier: "a",
      root,
      out: join(root, "with"),
      log: quiet,
      env: { PATH: process.env.PATH },
      probe: { ...present, cloud: () => "/somewhere/armadra-cloud" },
      manifest,
    });
    assert.equal(withIt.entries[0].status, "passed");
  } finally {
    remove();
  }
});

test("an unknown tier or an id outside the tier is refused", async () => {
  await assert.rejects(runTier({ tier: "c", log: quiet }), /unknown tier/);
  await assert.rejects(
    runTier({
      tier: "a",
      only: ["nope"],
      log: quiet,
      out: join(tmpdir(), "armadra-e2e-never"),
    }),
    /not in tier a: nope/,
  );
});
