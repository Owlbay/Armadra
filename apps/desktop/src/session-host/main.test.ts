import { describe, expect, it } from "vitest";
import {
  ORPHAN_EXIT_ENV,
  USAGE,
  orphanExitFromEnv,
  parseArguments,
  run,
} from "./main";
import { runShutdownIfIdle } from "./shutdown-if-idle";

/**
 * The command line, which is the one interface of this program that a person
 * types and that every process on the machine can read.
 *
 * One argument, no options. The rule is not style: `ps` and Task Manager show
 * a command line to anybody, so a session key, a token or a pipe name on it
 * would be a leak with no way back. Everything is derived from the data
 * directory instead, and a second argument is **refused** rather than ignored
 * so a caller that thought it was passing an option finds out immediately
 * instead of running a host that quietly disagrees with it.
 */

describe("the command line", () => {
  it("takes exactly one data directory", () => {
    expect(parseArguments(["C:\\Users\\a\\AppData\\Local\\armadra"])).toEqual({
      ok: true,
      dataDir: "C:\\Users\\a\\AppData\\Local\\armadra",
    });
  });

  it("refuses to run with no arguments", () => {
    expect(parseArguments([])).toEqual({ ok: false, reason: USAGE });
  });

  it("refuses more than one argument rather than ignoring the rest", () => {
    const parsed = parseArguments(["C:\\data", "--idle-exit-minutes", "0"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain("3");
  });

  /**
   * An empty path would resolve to this process' working directory, which is
   * wherever the core happened to be — a host silently serving a different
   * data directory than the one asked for.
   */
  it("refuses an empty data directory", () => {
    expect(parseArguments([""]).ok).toBe(false);
    expect(parseArguments(["   "]).ok).toBe(false);
  });

  it("refuses something that looks like an option", () => {
    const parsed = parseArguments(["--help"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain("选项");
  });
});

describe("run", () => {
  /**
   * A stub that pretended to work off Windows would be worse than one that
   * says what it is: on Unix the terminal domain has tmux and the direct
   * backend, and a session host there would be a second, silent answer to a
   * question already answered.
   */
  it("refuses to start anywhere but Windows, before touching the data directory", async () => {
    const lines: string[] = [];
    await expect(
      run({
        argv: ["/nonexistent/armadra"],
        platform: "darwin",
        log: (line) => lines.push(line),
      }),
    ).resolves.toBe(2);
    expect(lines.join("\n")).toContain("只在 Windows 上运行");
  });

  it("reports a bad command line with the usage exit code", async () => {
    const lines: string[] = [];
    await expect(
      run({ argv: [], platform: "win32", log: (line) => lines.push(line) }),
    ).resolves.toBe(2);
    expect(lines.join("\n")).toContain(USAGE);
  });
});

describe("the orphan exit override", () => {
  it("takes a positive whole number of milliseconds from the environment", () => {
    expect(orphanExitFromEnv({ [ORPHAN_EXIT_ENV]: "120000" })).toBe(120_000);
  });

  it("ignores anything else and keeps the default", () => {
    for (const raw of ["", "0", "-5", "1e3", "abc", "10s"]) {
      expect(orphanExitFromEnv({ [ORPHAN_EXIT_ENV]: raw })).toBeUndefined();
    }
    expect(orphanExitFromEnv({})).toBeUndefined();
  });
});

/** What the NSIS installer runs before it touches `Armadra.exe`. */
describe("shutdown-if-idle", () => {
  it("asks the host of the one data directory it is given, and exits 0", async () => {
    const asked: unknown[] = [];
    const lines: string[] = [];
    await expect(
      runShutdownIfIdle({
        argv: ["C:\\Users\\a\\AppData\\Local\\Armadra"],
        platform: "win32",
        log: (line) => lines.push(line),
        request: async (request) => {
          asked.push(request);
          return { kind: "left", pid: 7 };
        },
      }),
    ).resolves.toBe(0);
    expect(asked).toEqual([
      {
        dataDir: "C:\\Users\\a\\AppData\\Local\\Armadra",
        client: "armadra-installer",
        waitMs: 5_000,
      },
    ]);
    expect(lines.join("\n")).toContain('"kind":"left"');
  });

  it("exits 0 whatever the host answered, so an uninstall is never blocked by it", async () => {
    await expect(
      runShutdownIfIdle({
        argv: ["C:\\data"],
        platform: "win32",
        log: () => {},
        request: async () => ({ kind: "failed", reason: "timed out" }),
      }),
    ).resolves.toBe(0);
  });

  it("refuses a command line that is not exactly one data directory", async () => {
    for (const argv of [[], ["a", "b"], [" "]]) {
      await expect(
        runShutdownIfIdle({
          argv,
          platform: "win32",
          log: () => {},
          request: async () => {
            throw new Error("must not be asked");
          },
        }),
      ).resolves.toBe(2);
    }
  });

  it("does nothing off Windows", async () => {
    await expect(
      runShutdownIfIdle({
        argv: ["/data"],
        platform: "linux",
        log: () => {},
        request: async () => {
          throw new Error("must not be asked");
        },
      }),
    ).resolves.toBe(0);
  });
});
