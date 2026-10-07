import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { mkdir, cp, readFile, writeFile } from "node:fs/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "apps/server/package.json"));
const { build } = require("esbuild");
const destination = resolve(
  process.argv[2] ?? resolve(root, "target/plugins/armadra"),
);
await mkdir(resolve(destination, "scripts"), { recursive: true });
await build({
  entryPoints: [resolve(root, "apps/desktop/src/cli/armadra/main.ts")],
  outfile: resolve(destination, "scripts/armadra.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  packages: "bundle",
  logLevel: "warning",
  metafile: true,
}).then((result) => {
  const forbidden = Object.keys(result.metafile.inputs).filter((input) =>
    /(?:node-pty|core\/db\/|core\/runs\/|core\/controller\/|electron)/.test(
      input,
    ),
  );
  if (forbidden.length)
    throw new Error(`CLI must be pure Node: ${forbidden.join(", ")}`);
});
const source = resolve(root, "tools/plugins/armadra");
await cp(resolve(source, "plugin.json"), resolve(destination, "plugin.json"));
await cp(resolve(source, "skills"), resolve(destination, "skills"), {
  recursive: true,
});
const marketplaceRoot = dirname(destination);
const catalogPath = resolve(
  marketplaceRoot,
  ".agents/plugins/marketplace.json",
);
await mkdir(dirname(catalogPath), { recursive: true });
let catalog;
try {
  catalog = JSON.parse(await readFile(catalogPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  catalog = {
    name: "armadra-local",
    interface: { displayName: "Armadra Local" },
    plugins: [],
  };
}
if (catalog.name !== "armadra-local" || !Array.isArray(catalog.plugins))
  throw new Error(
    "Destination contains a different marketplace; refusing to replace it",
  );
const entry = {
  name: "armadra",
  source: {
    source: "local",
    path: "./" + relative(marketplaceRoot, destination).split("\\").join("/"),
  },
  policy: { installation: "AVAILABLE", authentication: "ON_USE" },
  category: "Productivity",
};
const index = catalog.plugins.findIndex((plugin) => plugin.name === "armadra");
if (index >= 0) catalog.plugins[index] = entry;
else catalog.plugins.push(entry);
await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
console.log(
  JSON.stringify({
    ok: true,
    plugin: destination,
    client: resolve(destination, "scripts/armadra.cjs"),
    marketplaceRoot,
  }),
);
