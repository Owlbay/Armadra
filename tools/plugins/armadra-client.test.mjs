import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("installed client works from unrelated cwd and spaced installation paths, without native dependencies", () => {
  const directory = mkdtempSync(join(tmpdir(), "Armadra plugin paths "));
  try {
    for (const name of ["first", "second path with spaces"]) {
      const destination = join(directory, name);
      const built = spawnSync(
        process.execPath,
        [join(root, "tools/plugins/build-armadra.mjs"), destination],
        { cwd: directory, encoding: "utf8" },
      );
      assert.equal(built.status, 0, built.stderr);
      const script = join(destination, "scripts/armadra.cjs");
      const manifest = JSON.parse(
        readFileSync(join(destination, "plugin.json"), "utf8"),
      );
      assert.equal(manifest.name, "armadra");
      assert.equal(
        manifest.$schema,
        "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      );
      const skill = readFileSync(
        join(destination, "skills/armadra/SKILL.md"),
        "utf8",
      );
      assert.match(skill, /name: armadra/);
      for (const reference of ["commands.md", "failures.md"])
        assert.ok(
          readFileSync(
            join(destination, "skills/armadra/references", reference),
            "utf8",
          ).length > 0,
        );
      const help = spawnSync(process.execPath, [script, "--help"], {
        cwd: tmpdir(),
        encoding: "utf8",
      });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /run artifacts/);
      const absent = spawnSync(
        process.execPath,
        [script, "doctor", "--data-dir", join(directory, "absent"), "--json"],
        { cwd: tmpdir(), encoding: "utf8" },
      );
      assert.equal(absent.status, 3, absent.stderr);
      assert.equal(
        JSON.parse(absent.stdout).error.code,
        process.platform === "win32"
          ? "unsupported_platform"
          : "core_unavailable",
      );
      assert.doesNotMatch(
        readFileSync(script, "utf8"),
        /require\(["'](?:electron|node-pty|node:sqlite)["']\)/,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
