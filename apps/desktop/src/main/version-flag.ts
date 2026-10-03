/**
 * `armadra --version`: the one question a package manager, an install script
 * or a container check asks of an installed binary without wanting a window.
 *
 * Electron itself does not answer it for a packaged app — the flag reaches the
 * app's argv and the app starts as usual — so `main/index.ts` asks this before
 * anything else is assembled and exits with the line written. It must not
 * need a display, a data directory or the core: the deb check in nightly.yml
 * runs it in a bare `ubuntu:22.04` container.
 */
export function versionLine(
  argv: readonly string[],
  name: string,
  version: string,
): string | null {
  // argv[0] is the executable; in development argv[1] is the app directory.
  return argv.slice(1).includes("--version") ? `${name} ${version}\n` : null;
}
