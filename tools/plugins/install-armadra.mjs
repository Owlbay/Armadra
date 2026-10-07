import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const marketplaceRoot = realpathSync(
  resolve(
    process.argv.find(
      (arg) =>
        !arg.startsWith("--") &&
        arg !== process.argv[0] &&
        arg !== process.argv[1],
    ) ?? join(root, "target/plugins"),
  ),
);
const catalog = JSON.parse(
  readFileSync(
    join(marketplaceRoot, ".agents/plugins/marketplace.json"),
    "utf8",
  ),
);
assert.equal(catalog.name, "armadra-local");
const entry = catalog.plugins.find((item) => item.name === "armadra");
assert.ok(entry);
const plugin = realpathSync(resolve(marketplaceRoot, entry.source.path));
assert.ok(plugin.startsWith(marketplaceRoot + "/"));
assert.equal(
  JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf8")).name,
  "armadra",
);
for (const path of [
  "scripts/armadra.cjs",
  "skills/armadra/SKILL.md",
  "skills/armadra/references/commands.md",
  "skills/armadra/references/failures.md",
])
  assert.ok(existsSync(join(plugin, path)));
const commands = [
  ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
  ["plugin", "add", "armadra@armadra-local", "--json"],
];
if (!process.argv.includes("--install")) {
  console.log(
    JSON.stringify({
      plan: true,
      plugin,
      marketplaceRoot,
      commands,
      publicPublishing: false,
    }),
  );
  process.exit(0);
}
const configRoot = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const digest = (path) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
};
const protectedFiles = ["auth.json", "hooks.json"].map((path) =>
  join(configRoot, path),
);
const beforeProtected = protectedFiles.map(digest);
function unchangedConfigBlocks() {
  let text = "";
  try {
    text = readFileSync(join(configRoot, "config.toml"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return text
    .split(/(?=^\[)/m)
    .filter((block) => !/^\[(?:plugins|marketplaces)(?:\.|\])/m.test(block))
    .map((block) => block.trim())
    .filter(Boolean);
}
const beforeBlocks = unchangedConfigBlocks();
const results = [];
for (const args of commands) {
  const result = spawnSync("codex", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  results.push(JSON.parse(result.stdout));
}
assert.deepEqual(
  protectedFiles.map(digest),
  beforeProtected,
  "Native plugin installation changed protected auth/Hook files",
);
assert.deepEqual(
  unchangedConfigBlocks(),
  beforeBlocks,
  "Native plugin installation changed unrelated configuration blocks",
);
console.log(
  JSON.stringify({
    ok: true,
    plugin,
    marketplaceRoot,
    results,
    protectedConfigurationUnchanged: true,
    publicPublishing: false,
  }),
);
