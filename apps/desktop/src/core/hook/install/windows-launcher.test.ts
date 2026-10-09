import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../testing/temp-dir";
import {
  LAUNCH_CONFIG_HEADER,
  LAUNCH_GATE,
  findLaunchExe,
  launchConfig,
  shimTargetFor,
  windowsLauncherFiles,
  windowsLauncherPath,
  windowsShimPath,
  withoutDirectory,
  writeWindowsLauncherFiles,
} from "./windows-launcher";

/**
 * The Windows launcher's files (docs/design/canvas-launcher.md §5): the
 * `.launch` text, which files a CLI gets, and the shim's target. Runs on every
 * platform; the program itself is exercised on Windows in
 * `agent/windows-launch.test.ts`.
 */

/** A Codex-shaped value: quotes, backslashes, `&`, `%` and CJK, all literal. */
const TOML =
  'hooks.SessionStart=[{hooks=[{type="command",command="C:\\\\Program Files\\\\armadra-hook.exe codex & 100% 画布"}]}]';
const INSTRUCTIONS =
  'developer_instructions="[Armadra canvas rules r16]\\n规则"';
/** The trust records: a Windows key with backslashes and angle brackets. */
const STATE =
  'hooks.state={"C:\\\\<session-flags>\\\\config.toml:session_start:0:0"={trusted_hash="sha256:00"}}';

const CODEX = {
  agentId: "codex",
  args: [
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    "features.daemon_auto_start=false",
    "-c",
    TOML,
    "-c",
    STATE,
    "-c",
    INSTRUCTIONS,
  ],
  env: [] as (readonly [string, string])[],
};

const OPENCODE = {
  agentId: "opencode",
  args: [] as string[],
  env: [
    ["OPENCODE_CONFIG_DIR", "C:\\data\\integration\\opencode\\config"],
    ["OPENCODE_CONFIG_CONTENT", '{"a": "b c"}'],
  ] as (readonly [string, string])[],
};

const TARGET = {
  program: "C:\\Program Files\\nodejs\\node.exe",
  args: ["C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"],
};

function lines(text: string): string[] {
  expect(text.endsWith("\r\n")).toBe(true);
  return text.slice(0, -2).split("\r\n");
}

describe("launchConfig", () => {
  it("writes the header, the gate, then every injected word verbatim", () => {
    const text = launchConfig(CODEX, "run");
    const all = lines(text);
    expect(all[0]).toBe(LAUNCH_CONFIG_HEADER);
    expect(all[1]).toMatch(/^# Armadra canvas launcher \(codex\)/);
    expect(all.slice(2)).toEqual([
      `gate=${LAUNCH_GATE}`,
      ...CODEX.args.map((word) => `arg=${word}`),
    ]);
    // No quoting, no escaping: the program reads each value as it stands.
    expect(text).toContain(`arg=${TOML}\r\n`);
    expect(text).not.toMatch(/^(program|lead)=/m);
  });

  it("puts the environment before the arguments", () => {
    const all = lines(
      launchConfig({ ...OPENCODE, args: ["--x"] }, "run"),
    ).slice(2);
    expect(all).toEqual([
      `gate=${LAUNCH_GATE}`,
      "env=OPENCODE_CONFIG_DIR=C:\\data\\integration\\opencode\\config",
      'env=OPENCODE_CONFIG_CONTENT={"a": "b c"}',
      "arg=--x",
    ]);
  });

  it("names the program and its lead words only for a shim", () => {
    const all = lines(launchConfig(CODEX, "shim", TARGET));
    expect(all[1]).toMatch(/^# Armadra canvas shim \(codex\)/);
    expect(all.slice(2, 5)).toEqual([
      `gate=${LAUNCH_GATE}`,
      `program=${TARGET.program}`,
      `lead=${TARGET.args[0]}`,
    ]);
    expect(() => launchConfig(CODEX, "shim")).toThrow(/needs a program/);
    expect(() =>
      launchConfig(CODEX, "shim", { program: "", args: [] }),
    ).toThrow(/empty/);
  });

  it("refuses a value holding a line break, and a bad variable name", () => {
    for (const bad of ["a\nb", "a\rb"]) {
      expect(() => launchConfig({ ...CODEX, args: [bad] }, "run")).toThrow(
        /line break/,
      );
      expect(() =>
        launchConfig({ ...OPENCODE, env: [["NAME", bad]] }, "run"),
      ).toThrow(/line break/);
      expect(() =>
        launchConfig(CODEX, "shim", { program: bad, args: [] }),
      ).toThrow(/line break/);
      expect(() =>
        launchConfig(CODEX, "shim", { program: "p", args: [bad] }),
      ).toThrow(/line break/);
    }
    for (const name of ["A=B", "1X", "", "A B"]) {
      expect(() =>
        launchConfig({ ...OPENCODE, env: [[name, "v"]] }, "run"),
      ).toThrow(/environment variable name/);
    }
  });

  it("carries the node credential exchange, in run and shim mode", () => {
    const client = "C:\\data\\bin\\armadra-hook.exe";
    const spec = {
      ...CODEX,
      args: [],
      credential: { client, variables: ["CODEX_API_KEY", "OPENAI_API_KEY"] },
    };
    for (const text of [
      launchConfig(spec, "run"),
      launchConfig(spec, "shim", TARGET),
    ]) {
      expect(
        lines(text).filter((line) => line.startsWith("credential")),
      ).toEqual([
        `credential=${client}`,
        "credential-var=CODEX_API_KEY",
        "credential-var=OPENAI_API_KEY",
      ]);
    }
    // No client: still written, so a bound credential is refused, not skipped.
    expect(
      lines(
        launchConfig(
          { ...spec, credential: { client: "", variables: ["X"] } },
          "run",
        ),
      ),
    ).toContain("credential=");
    // A CLI with no credential kind writes nothing.
    expect(
      launchConfig({ ...spec, credential: { client, variables: [] } }, "run"),
    ).not.toMatch(/^credential/m);
    expect(() =>
      launchConfig(
        { ...spec, credential: { client, variables: ["A B"] } },
        "run",
      ),
    ).toThrow(/environment variable name/);
    expect(() =>
      launchConfig(
        { ...spec, credential: { client: "a\nb", variables: ["X"] } },
        "run",
      ),
    ).toThrow(/line break/);
  });

  it("carries the ama key exchange only with a client", () => {
    const client = "C:\\data\\bin\\armadra-hook.exe";
    const spec = {
      agentId: "ama",
      args: [],
      env: [],
      amaKeys: {
        client,
        variables: ["AMA_API_KEY_OPENAI", "AMA_API_KEY_ANTHROPIC"],
      },
    };
    expect(lines(launchConfig(spec, "run")).slice(3)).toEqual([
      `ama-keys=${client}`,
      "ama-var=AMA_API_KEY_OPENAI",
      "ama-var=AMA_API_KEY_ANTHROPIC",
    ]);
    expect(
      launchConfig(
        { ...spec, amaKeys: { client: "", variables: ["X"] } },
        "run",
      ),
    ).not.toMatch(/^ama-/m);
  });

  it("is deterministic", () => {
    expect(launchConfig(CODEX, "shim", TARGET)).toBe(
      launchConfig(CODEX, "shim", TARGET),
    );
  });
});

describe("windowsLauncherFiles", () => {
  function spec(shim: boolean) {
    const root = tempDir("armadra-windows-launcher-");
    const exe = join(root, "armadra-launch.exe");
    writeFileSync(exe, Buffer.from([0x4d, 0x5a, 1, 2, 3]));
    return {
      ...CODEX,
      runDir: join(root, "integration", "run"),
      shimDir: join(root, "integration", "shims"),
      exe,
      ...(shim ? { shimTarget: TARGET } : {}),
    };
  }

  it("gives a CLI its launcher, and its shim only with a target", () => {
    const withShim = spec(true);
    const files = windowsLauncherFiles(withShim);
    const run = windowsLauncherPath(withShim.runDir, "codex");
    const shim = windowsShimPath(withShim.shimDir, "codex");
    expect(run).toBe(join(withShim.runDir, "codex.exe"));
    expect([...files.keys()]).toEqual([
      run,
      join(withShim.runDir, "codex.launch"),
      shim,
      join(withShim.shimDir, "codex.launch"),
    ]);
    // Both programs are byte copies of the one build.
    expect(files.get(run)?.content).toEqual(readFileSync(withShim.exe));
    expect(files.get(shim)?.content).toEqual(readFileSync(withShim.exe));
    expect(files.get(join(withShim.runDir, "codex.launch"))?.content).toBe(
      launchConfig(CODEX, "run"),
    );
    expect(files.get(join(withShim.shimDir, "codex.launch"))?.content).toBe(
      launchConfig(CODEX, "shim", TARGET),
    );

    const without = spec(false);
    expect([...windowsLauncherFiles(without).keys()]).toEqual([
      join(without.runDir, "codex.exe"),
      join(without.runDir, "codex.launch"),
    ]);
  });

  it("refuses to build without the program", () => {
    expect(() =>
      windowsLauncherFiles({ ...spec(false), exe: join(tempDir("x-"), "no") }),
    ).toThrow();
  });

  it("writes only what changed, and clears an old program moved aside", () => {
    const s = spec(true);
    const files = windowsLauncherFiles(s);
    expect(writeWindowsLauncherFiles(files)).toEqual([...files.keys()]);
    for (const [file, { content }] of files) {
      expect(readFileSync(file)).toEqual(
        typeof content === "string" ? Buffer.from(content) : content,
      );
    }
    expect(writeWindowsLauncherFiles(files)).toEqual([]);

    const aside = join(s.runDir, "codex.exe.old-1-2");
    writeFileSync(aside, "old");
    const changed = windowsLauncherFiles({ ...s, args: ["--other"] });
    expect(writeWindowsLauncherFiles(changed)).toEqual([
      join(s.runDir, "codex.launch"),
      join(s.shimDir, "codex.launch"),
    ]);
    expect(readdirSync(s.runDir).sort()).toEqual(["codex.exe", "codex.launch"]);
  });

  it("finds the built program among its candidates", () => {
    const s = spec(false);
    expect(findLaunchExe([join(s.runDir, "missing.exe"), s.exe])).toBe(s.exe);
    expect(findLaunchExe([join(s.runDir, "missing.exe")])).toBeUndefined();
  });
});

describe("shimTargetFor", () => {
  /** A fake CLI the way `resolveCommand` finds one on this platform. */
  function fakeCli(directory: string, name: string): string {
    mkdirSync(directory, { recursive: true });
    const file = join(
      directory,
      process.platform === "win32" ? `${name}.exe` : name,
    );
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    return file;
  }

  it("resolves past the shims directory to the real CLI", () => {
    const root = tempDir("armadra-shim-target-");
    const shims = join(root, "shims");
    const shim = fakeCli(shims, "claude");
    const real = fakeCli(join(root, "bin"), "claude");
    const ambient = {
      PATH: [shims, join(root, "bin")].join(delimiter),
      HOME: root,
    };
    // Unfiltered, the shim would start itself.
    expect(shimTargetFor("claude", { ambient })?.program).toBe(shim);
    expect(shimTargetFor("claude", { ambient, shimDir: shims })).toEqual({
      program: real,
      args: [],
    });
  });

  it("answers nothing for an id that is not a built-in CLI", () => {
    expect(shimTargetFor("custom:mine")).toBeUndefined();
    expect(shimTargetFor("nope")).toBeUndefined();
  });

  it("drops a directory from PATH however it is spelt", () => {
    const windows = delimiter === ";";
    const entries = windows
      ? ["C:\\A", "C:\\Shims\\", "c:\\shims", "D:\\B"]
      : ["/a", "/data/shims/", "/data/shims", "/b"];
    const kept = withoutDirectory(
      entries.join(delimiter),
      windows ? "C:\\Shims" : "/data/shims",
    );
    expect(kept.split(delimiter)).toEqual(
      windows ? ["C:\\A", "D:\\B"] : ["/a", "/b"],
    );
  });
});
