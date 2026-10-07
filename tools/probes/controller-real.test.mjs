import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeEnvironment } from "./controller-real-config.mjs";
import {
  checkRealDirectories,
  realVersion,
  scenarioFiles,
  verifyRealReports,
  trustedProject,
  parseRealOptions,
  readRealArtifact,
} from "./controller-real-checks.mjs";

test("readiness mode cannot accidentally enable real execution", () => {
  assert.throws(
    () => parseRealOptions(["--preflight", "--execute"]),
    /mutually exclusive/,
  );
  assert.throws(() => parseRealOptions(["--data-dir"]), /Missing/);
  assert.throws(() => parseRealOptions(["--unknown"]), /Unknown/);
  assert.deepEqual(parseRealOptions(["--preflight"]), { preflight: true });
});

test("reads only a bounded current report reference and refuses escaped or changed files", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-real-read-"));
  const outside = mkdtempSync(join(tmpdir(), "ar-real-outside-"));
  try {
    const text = "A real report",
      path = join(root, "report.md");
    writeFileSync(path, text);
    const ref = {
      path: "report.md",
      exists: true,
      type: "file",
      size: Buffer.byteLength(text),
      versionKind: "contentHash",
      contentVersion:
        "sha256:" + createHash("sha256").update(text).digest("hex"),
    };
    assert.equal(readRealArtifact(root, ref), text);
    assert.throws(
      () => readRealArtifact(root, { ...ref, size: 65537 }),
      /small/,
    );
    writeFileSync(path, "changed report");
    assert.throws(() => readRealArtifact(root, ref), /changed/);
    assert.throws(
      () => readRealArtifact(root, { ...ref, path: "../outside" }),
      /ENOENT|outside/,
    );
    writeFileSync(
      join(outside, "report.md"),
      "outside content must not be read",
    );
    symlinkSync(
      outside,
      join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => readRealArtifact(root, { ...ref, path: "escape/report.md" }),
      /outside/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a blocked real preflight performs no graph, task or profile mutations", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./controller-real.mjs", import.meta.url)),
      "--preflight",
    ],
    {
      env: probeEnvironment({ ...process.env, ARMADRA_REAL_CODEX_HOME: "" }),
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.state, "blocked");
  assert.equal(report.calls, 0);
  assert.equal(report.realCliTasks, 0);
  assert.equal(report.protectedConfigurationUnchanged, true);
});

test("readiness subprocesses do not inherit another chat's identity", () => {
  assert.deepEqual(
    probeEnvironment({
      PATH: "/bin",
      CADK_TEST_CONTEXT: "unit-test-only",
      CODEX_THREAD_ID: "unit-test-only",
      ARMADRA_NODE_ID: "unit-test-only",
    }),
    { PATH: "/bin" },
  );
});

test("a review must declare a reviewed-files array, not a matching string", () => {
  assert.throws(
    () =>
      verifyRealReports({
        change: "A real implementation report",
        review:
          '{"verdict":"pass","issues":[],"reviewedFiles":"src/slug.mjs test/slug.test.mjs reports/change.md"}',
        testsUnchanged: true,
        testExitCode: 0,
      }),
    /review/,
  );
});

test("requires an isolated data directory and a distinct Codex home before effects", () => {
  assert.throws(() => checkRealDirectories({}), /data directory/);
  const root = mkdtempSync(join(tmpdir(), "ar-real-guard-"));
  try {
    const production = join(root, "production"),
      data = join(root, "data");
    mkdirSync(production);
    mkdirSync(data);
    assert.throws(
      () =>
        checkRealDirectories({
          dataDir: data,
          codexHome: production,
          productionHome: production,
        }),
      /production/,
    );
    const nested = join(production, "nested");
    mkdirSync(nested);
    assert.throws(
      () =>
        checkRealDirectories({
          dataDir: data,
          codexHome: nested,
          productionHome: production,
        }),
      /production/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project trust requires native evidence, honors a nearer untrusted directory and rejects conflicts", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-real-trust-")),
    cwd = join(root, "child");
  try {
    const layer = (projects) => ({ config: { projects } });
    assert.equal(
      trustedProject(
        { layers: [layer({ [root]: { trust_level: "trusted" } })] },
        cwd,
      ),
      true,
    );
    assert.equal(
      trustedProject(
        {
          layers: [
            layer({
              [root]: { trust_level: "trusted" },
              [cwd]: { trust_level: "untrusted" },
            }),
          ],
        },
        cwd,
      ),
      false,
    );
    assert.equal(
      trustedProject(
        {
          layers: [
            layer({ [root]: { trust_level: "trusted" } }),
            layer({ [root]: { trust_level: "untrusted" } }),
          ],
        },
        cwd,
      ),
      false,
    );
    assert.equal(trustedProject({}, cwd), false);
    assert.equal(
      trustedProject(
        {
          layers: [
            {
              ...layer({ [root]: { trust_level: "trusted" } }),
              disabledReason: "untrusted",
            },
          ],
        },
        cwd,
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project trust resolves macOS path aliases and Windows junctions to the same directory", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-real-project-alias-"));
  try {
    const project = join(root, "project"),
      alias = join(root, "alias");
    mkdirSync(project);
    symlinkSync(
      project,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      trustedProject(
        {
          layers: [
            {
              name: { type: "user" },
              config: { projects: { [alias]: { trust_level: "trusted" } } },
            },
          ],
        },
        realpathSync(project),
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects canonical aliases and credential/config symlinks outside the isolated home", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-real-alias-"));
  try {
    const production = join(root, "production"),
      data = join(root, "data"),
      isolated = join(root, "isolated");
    for (const path of [production, data, isolated]) mkdirSync(path);
    symlinkSync(
      production,
      join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () =>
        checkRealDirectories({
          dataDir: data,
          codexHome: join(root, "alias"),
          productionHome: production,
        }),
      /production/,
    );
    // A directory junction is sufficient on Windows too; no elevated file-symlink permission.
    symlinkSync(
      production,
      join(isolated, "config.toml"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () =>
        checkRealDirectories({
          dataDir: data,
          codexHome: isolated,
          productionHome: production,
        }),
      /outside/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects fake CLI version evidence and unknown providers", () => {
  assert.equal(realVersion("codex", "codex-cli 0.159.0"), "0.159.0");
  assert.equal(realVersion("claude", "2.1.0 (Claude Code)"), "2.1.0");
  for (const text of [
    "codex-cli 0.159.0 (fixture)",
    "2.1.0 (Claude Code fixture)",
    "fake 2.1.0",
    "",
  ])
    assert.equal(realVersion("claude", text), null);
  assert.equal(realVersion("other", "2.1.0"), null);
});

test("the real scenario includes immutable tests and an intentionally failing implementation", () => {
  const files = scenarioFiles();
  assert.match(files["src/slug.mjs"], /Not implemented/);
  assert.match(files["test/slug.test.mjs"], /node:assert\/strict/);
  assert.match(files["test/slug.test.mjs"], /Mixed CASE/);
  assert.ok(!Object.values(files).join("\n").includes("skip("));
});

test("task completion alone does not satisfy the report and implementation quality gate", () => {
  assert.throws(
    () =>
      verifyRealReports({
        change: "",
        review: '{"verdict":"pass","issues":[]}',
        testsUnchanged: true,
        testExitCode: 0,
      }),
    /change report/,
  );
  assert.throws(
    () =>
      verifyRealReports({
        change: "A real implementation report",
        review: '{"verdict":"pass","issues":[]}',
        testsUnchanged: false,
        testExitCode: 0,
      }),
    /test file/,
  );
  assert.throws(
    () =>
      verifyRealReports({
        change: "A real implementation report",
        review: '{"verdict":"pass","issues":[]}',
        testsUnchanged: true,
        testExitCode: 1,
      }),
    /quality tests/,
  );
  assert.throws(
    () =>
      verifyRealReports({
        change: "A real implementation report",
        review: '{"verdict":"issues","issues":["bug"]}',
        testsUnchanged: true,
        testExitCode: 0,
      }),
    /review/,
  );
  assert.doesNotThrow(() =>
    verifyRealReports({
      change: "A real implementation report",
      review:
        '{"verdict":"pass","issues":[],"reviewedFiles":["src/slug.mjs","test/slug.test.mjs","reports/change.md"]}',
      testsUnchanged: true,
      testExitCode: 0,
    }),
  );
});
