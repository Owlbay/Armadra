import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "apps/server/package.json"));
await require("esbuild").build({
  entryPoints: [resolve(root, "tools/probes/controller-fault-core.ts")],
  outfile: resolve(root, "apps/desktop/out/core/fault.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["node-pty"],
  banner: { js: "globalThis.__armadraShellEntry = true;" },
});
