import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./workflow-yaml.mjs";
import {
  checkE2eTiers,
  checkWorkflow,
  checkWorkflowDirectory,
} from "./validate-workflows.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function check(yaml) {
  return checkWorkflow("test.yml", parseYaml(yaml));
}

test("the repository's own workflows pass", () => {
  const { files, problems } = checkWorkflowDirectory();
  assert.deepEqual(problems, []);
  assert.ok(files.includes("ci.yml"));
  assert.ok(files.includes("release.yml"));
});

test("the parser reads the shapes a workflow actually uses", () => {
  const document = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
  );
  assert.equal(document.name, "ci");
  // Nested mappings, flow sequences, block scalars and lists of mappings.
  assert.deepEqual(document.on.push.branches, ["main"]);
  assert.equal(document.jobs.check["runs-on"], "${{ matrix.runner }}");
  assert.equal(document.jobs.check.steps[0].uses, "actions/checkout@v4");
  assert.deepEqual(
    document.jobs.check.strategy.matrix.include.map((entry) => entry.runner),
    ["ubuntu-latest", "macos-14", "windows-latest"],
  );
  // A block scalar with several lines, read back whole.
  const identity = document.jobs.check.steps.find(
    (step) => step.name === "给 Git 一个身份",
  );
  assert.match(identity.run, /set -euo pipefail[\s\S]*user\.email/);
  assert.equal(document.jobs.check.steps.at(-2).name, "桌面壳构建（不打包）");
  assert.equal(
    document.jobs.check.steps.at(-1).name,
    "Unix controller 故障探针",
  );
});

test("Unix controller probes run on Linux and macOS after the core is built", () => {
  const document = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
  );
  const steps = document.jobs.check.steps;
  const probe = steps.find((step) => step.name === "Unix controller 故障探针");
  assert.ok(
    probe,
    "Linux needs executable Unix controller evidence, not only platform branches",
  );
  assert.equal(probe.if, "runner.os != 'Windows'");
  assert.equal(probe.shell, "bash");
  assert.ok(
    steps.indexOf(probe) >
      steps.findIndex(
        (step) => step.run === "pnpm --filter @armadra/desktop build",
      ),
  );
  for (const command of [
    "controller-smoke.mjs",
    "--cancel",
    "--large-output",
    "--crash",
    "--fault=launch.before",
    "--fault=launch.after",
    "--fault=delivery.before",
    "--fault=delivery.after",
  ])
    assert.ok(probe.run.includes(command), `Missing ${command}`);
  assert.ok(
    steps.some((step) => step.run === "pnpm plugin:test"),
    "Portable plugin installation paths need verification on every platform",
  );
});

test("the three platforms are all in the matrix, and none is filtered out", () => {
  const document = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
  );
  const runners = document.jobs.check.strategy.matrix.include.map(
    (entry) => entry.runner,
  );
  for (const prefix of ["ubuntu-", "macos-", "windows-"])
    assert.ok(
      runners.some((runner) => runner.startsWith(prefix)),
      `${prefix} is missing from the matrix`,
    );
  // Platform differences belong in `cfg(...)`, not in a CI filter: a test the
  // workflow skips by name is a test nobody deletes when it starts passing.
  const body = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(body, /cargo test[^\n]*--skip/);
  assert.doesNotMatch(body, /go -C apps\/host test[^\n]*-run /);
});

test("a multi-command Windows step with no shell is reported", () => {
  const windows = `
name: x
on:
  push:
jobs:
  build:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        include:
          - runner: ubuntu-latest
          - runner: windows-latest
    steps:
      - run: |
          install-something
          verify-it
`;
  const problems = check(windows);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /only the last exit code counts/);
  // Naming the shell, or running one command, is enough.
  assert.deepEqual(
    check(windows.replace("- run: |", "- shell: bash\n        run: |")),
    [],
  );
  assert.deepEqual(
    check(windows.replace(/- run: \|\n.*\n.*\n/, "- run: verify-it\n")),
    [],
  );
  // A job that never lands on Windows keeps its default shell.
  assert.deepEqual(
    check(windows.replace("          - runner: windows-latest\n", "")),
    [],
  );
});

test("an unserved runner label is reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  build:
    runs-on: macOS-14
    steps:
      - run: echo hi
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /GitHub does not offer/);
});

test("a matrix target the packaging code cannot map is reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  build:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        include:
          - runner: ubuntu-latest
            target: linux-riscv64
    steps:
      - run: echo hi
`);
  assert.equal(problems.length, 1);
  assert.match(
    problems.join("\n"),
    /not a target in tools\/release\/artifacts\.mjs/,
  );
});

test("a job that needs a job nobody defined is reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  build:
    needs: [verify]
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /needs verify, which is not a job/);
});

// Reading needs.<job> without declaring it does not wait for that job, so the
// value is empty at exactly the moment it is used.
test("reading an undeclared needs output is reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ needs.verify.outputs.version }}
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /reads needs\.verify without declaring it/);
});

test("a step output with no matching step id is reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  verify:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.versoin.outputs.version }}
    steps:
      - id: version
        run: echo hi
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /steps\.versoin\.outputs/);
});

test("a cycle in needs is reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  a:
    needs: [b]
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  b:
    needs: [a]
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`);
  assert.ok(problems.some((problem) => /form a cycle/.test(problem)));
});

test("steps that do nothing, do two things, or float a version are reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: nothing
      - uses: actions/checkout
      - uses: actions/setup-node@v4
        run: echo both
`);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /neither runs nor uses/);
  assert.match(problems[1], /without pinning a version/);
  assert.match(problems[2], /both runs and uses/);
});

test("a workflow with no trigger, runner or steps is reported", () => {
  assert.ok(
    check(
      "name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
    ).some((p) => /no trigger/.test(p)),
  );
  assert.ok(
    check(
      "name: x\non:\n  push:\njobs:\n  a:\n    steps:\n      - run: x\n",
    ).some((p) => /names no runner/.test(p)),
  );
  assert.ok(
    check(
      "name: x\non:\n  push:\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
    ).some((p) => /has no steps/.test(p)),
  );
});

test("a malformed file is reported as a problem rather than crashing the run", () => {
  const directory = mkdtempSync(join(tmpdir(), "armadra-workflows-"));
  try {
    writeFileSync(join(directory, "broken.yml"), "name: x\n\tjobs:\n");
    const { problems } = checkWorkflowDirectory(directory);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /broken\.yml: .*tabs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the release workflow has the five jobs the design names plus the channel checks, and publishes only drafts", () => {
  const document = parseYaml(
    readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
  );
  assert.deepEqual(Object.keys(document.jobs), [
    "verify",
    "web",
    "build",
    "notarize",
    "assemble",
    // The update mirror (G5-18): the draft's files into the versioned path
    // of an S3-compatible bucket; "latest" moves only in distribute.yml.
    "mirror",
    // Distribution channels (completion plan G3-9): rendered and installed
    // from the draft's artifacts, never pushed from here.
    "channels",
    "channels-macos",
    "channels-windows",
  ]);
  assert.deepEqual(document.on.push.tags, ["v*"]);
  const text = readFileSync(
    join(root, ".github/workflows/release.yml"),
    "utf8",
  );
  for (const secret of [
    "HOMEBREW_TAP_TOKEN",
    "SCOOP_BUCKET_TOKEN",
    "WINGET_TOKEN",
  ])
    assert.ok(
      !text.includes(secret),
      `release.yml must not publish with ${secret}`,
    );
  // Six targets, one runner each.
  assert.equal(document.jobs.build.strategy.matrix.include.length, 6);
  const targets = document.jobs.build.strategy.matrix.include.map(
    (entry) => entry.target,
  );
  assert.deepEqual(new Set(targets).size, 6);
  // Publishing is a human act: the workflow only ever creates a draft.
  const create = document.jobs.assemble.steps.at(-1).run;
  assert.match(create, /gh release create/);
  assert.match(create, /--draft/);
  assert.ok(!/gh release edit .*--draft=false/.test(create));
  assert.ok(!/--latest/.test(create));
  // The mirror gets only what a real draft gets, and only the versioned path.
  assert.equal(
    document.jobs.mirror.if,
    "needs.verify.outputs.publish == 'true'",
  );
  const mirrorRun = document.jobs.mirror.steps.at(-1).run;
  assert.match(mirrorRun, /mirror\.mjs stage/);
  assert.ok(!/promote/.test(mirrorRun));
});

test("the mirror's latest moves only once a stable release is published", () => {
  const document = parseYaml(
    readFileSync(join(root, ".github/workflows/distribute.yml"), "utf8"),
  );
  const job = document.jobs.mirror;
  assert.equal(job.needs, "render");
  assert.match(job.if, /needs\.render\.outputs\.stable == 'true'/);
  assert.match(job.steps.at(-1).run, /mirror\.mjs promote/);
});

test("channels are pushed only once a release is published, each behind its own secret", () => {
  const document = parseYaml(
    readFileSync(join(root, ".github/workflows/distribute.yml"), "utf8"),
  );
  assert.deepEqual(document.on.release.types, ["published"]);
  assert.deepEqual(document.permissions, { contents: "read" });
  const secrets = {
    "publish-tap": "HOMEBREW_TAP_TOKEN",
    "publish-scoop": "SCOOP_BUCKET_TOKEN",
    "publish-winget": "WINGET_TOKEN",
  };
  for (const [job, secret] of Object.entries(secrets)) {
    const steps = document.jobs[job].steps;
    assert.equal(document.jobs[job].needs, "render");
    assert.match(
      document.jobs[job].if,
      /needs\.render\.outputs\.stable == 'true'/,
    );
    // The first step decides whether the secret is there; every later step is
    // skipped without it, so a missing token skips rather than fails.
    assert.equal(steps[0].id, "token");
    assert.equal(steps[0].env.TOKEN, `\${{ secrets.${secret} }}`);
    for (const step of steps.slice(1))
      assert.equal(step.if, "steps.token.outputs.enabled == 'true'");
  }
});

test("tier A runs as ci.yml's e2e job on ubuntu, tier B on a nightly schedule", () => {
  const read = (name) =>
    parseYaml(readFileSync(join(root, ".github/workflows", name), "utf8"));
  const documents = {
    "ci.yml": read("ci.yml"),
    "nightly.yml": read("nightly.yml"),
  };
  assert.deepEqual(checkE2eTiers(documents), []);
  assert.equal(documents["ci.yml"].jobs.e2e["runs-on"], "ubuntu-latest");

  const ciWithout = structuredClone(documents["ci.yml"]);
  delete ciWithout.jobs.e2e;
  assert.deepEqual(checkE2eTiers({ ...documents, "ci.yml": ciWithout }), [
    "ci.yml: has no e2e job running tier A",
  ]);

  const ciElsewhere = structuredClone(documents["ci.yml"]);
  ciElsewhere.jobs.e2e["runs-on"] = "macos-14";
  ciElsewhere.jobs.e2e.steps = [{ run: "node tools/ci/e2e.mjs --tier b" }];
  assert.deepEqual(checkE2eTiers({ ...documents, "ci.yml": ciElsewhere }), [
    "ci.yml: job e2e does not run node tools/ci/e2e.mjs --tier a",
    "ci.yml: job e2e must run on ubuntu (tmux, xvfb)",
  ]);

  assert.deepEqual(checkE2eTiers({ "ci.yml": documents["ci.yml"] }), [
    "nightly.yml: is missing; tier B has nowhere to run",
  ]);
  const manual = parseYaml(
    "name: nightly\non:\n  push:\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n",
  );
  assert.deepEqual(
    checkE2eTiers({ "ci.yml": documents["ci.yml"], "nightly.yml": manual }),
    [
      "nightly.yml: has no schedule trigger",
      "nightly.yml: cannot be run by hand (workflow_dispatch)",
      "nightly.yml: no job runs node tools/ci/e2e.mjs --tier b",
    ],
  );
});

test("tier B runs on every system its entries name, reports failures as issues and spends no secret", () => {
  const read = (name) =>
    parseYaml(readFileSync(join(root, ".github/workflows", name), "utf8"));
  const ci = read("ci.yml");
  const nightly = read("nightly.yml");
  const entries = [
    { id: "packaged-smoke", tier: "b", platforms: ["darwin", "linux"] },
    { id: "deb-install", tier: "b", platforms: ["linux"] },
    { id: "anywhere", tier: "b" },
    { id: "a-only", tier: "a", platforms: ["win32"] },
  ];
  const check = (document) =>
    checkE2eTiers({ "ci.yml": ci, "nightly.yml": document }, entries);
  assert.deepEqual(check(nightly), []);
  // The repository's own entries agree with the repository's nightly.yml.
  assert.deepEqual(checkE2eTiers({ "ci.yml": ci, "nightly.yml": nightly }), []);

  const noMac = structuredClone(nightly);
  delete noMac.jobs.macos;
  noMac.jobs.report.needs = ["linux", "linux-arm64"];
  assert.deepEqual(check(noMac), [
    "nightly.yml: no job runs --tier b on darwin, where packaged-smoke must run",
  ]);

  const silent = structuredClone(nightly);
  delete silent.jobs.report;
  assert.deepEqual(check(silent), [
    "nightly.yml: no job opens an issue when a tier B job fails",
  ]);

  const partial = structuredClone(nightly);
  partial.jobs.report.needs = ["linux", "linux-arm64"];
  delete partial.jobs.report.permissions;
  assert.deepEqual(check(partial), [
    "nightly.yml: job report does not need macos, so their failures open no issue",
    "nightly.yml: job report opens issues without permissions: issues: write",
  ]);

  const spending = structuredClone(nightly);
  spending.jobs.linux.steps[0].env = {
    TOKEN: "${{ secrets.RELEASE_TOKEN }}",
    OK: "${{ secrets.GITHUB_TOKEN }}",
  };
  assert.deepEqual(check(spending), [
    "nightly.yml: reads RELEASE_TOKEN; tier B may use only the default GITHUB_TOKEN",
  ]);
});
