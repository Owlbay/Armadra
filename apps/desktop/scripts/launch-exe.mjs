/**
 * Builds `armadra-launch.exe`, the Windows canvas launcher
 * (`src/cli/armadra-launch/windows-launch.cs`, docs/design/canvas-launcher.md
 * §5).
 *
 * The core copies it into `<data>/integration/run/<cli>.exe` and
 * `shims/<cli>.exe`, each beside a `.launch` naming what to inject. A console
 * `.exe` receives the caller's command line untouched, so neither the typed
 * launch line nor the injected words go through `cmd.exe` a second time.
 *
 * Built with the same `csc.exe` as the hook launcher (`hook-launcher.mjs`).
 * Only a Windows host has it: `after-pack.mjs` builds it into a Windows
 * package's resources, and `pnpm --filter @armadra/desktop build` runs this
 * file with `--if-windows` so an unpackaged development tree on Windows has
 * `out/cli/armadra-launch.exe` too. Without it the core starts canvas agents
 * on a bare line, with no injection (§5.3).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileCSharp, findCsc } from "./hook-launcher.mjs";

const app = dirname(dirname(fileURLToPath(import.meta.url)));

/** The C# source, relative to `apps/desktop`. */
export const LAUNCH_EXE_SOURCE = "src/cli/armadra-launch/windows-launch.cs";

/** Where it goes in a packaged app, beside `cli/armadra-hook.exe`. */
export const LAUNCH_EXE_RESOURCE = "cli/armadra-launch.exe";

/** Compiles the canvas launcher into `output` and returns its path. */
export function compileLaunchExe(
  output,
  { source = join(app, LAUNCH_EXE_SOURCE), env = process.env, run } = {},
) {
  return compileCSharp(source, output, {
    env,
    name: "launch-exe",
    ...(run === undefined ? {} : { run }),
  });
}

/**
 * What `node scripts/launch-exe.mjs [--if-windows] [out]` does: off Windows
 * with `--if-windows` nothing (the build of every other platform), on Windows
 * without a compiler a warning, otherwise a compile — whose failure fails.
 * Returns the built path or `undefined`.
 */
export function buildLaunchExe(
  argv,
  {
    host = process.platform,
    env = process.env,
    compile = compileLaunchExe,
    log = console.log,
  } = {},
) {
  const optional = argv.includes("--if-windows");
  const output =
    argv.find((arg) => !arg.startsWith("--")) ??
    join(app, "out", LAUNCH_EXE_RESOURCE);
  if (optional && host !== "win32") return undefined;
  if (optional && findCsc({ env }) === undefined) {
    log(
      `launch-exe: WARNING no csc.exe; ${LAUNCH_EXE_RESOURCE} not built, canvas agents start without injection`,
    );
    return undefined;
  }
  const built = compile(output, { env });
  log(`launch-exe: built ${built}`);
  return built;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildLaunchExe(process.argv.slice(2));
}
