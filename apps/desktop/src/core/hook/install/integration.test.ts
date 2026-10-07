import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetProbes, rememberProbe } from "../../agent/probe";
import { installCollaborationSkill } from "../../collab/skill";
import { configPath as codexConfigPath } from "./codex";
import {
  HOOK_CLIENT_REVISION,
  INTEGRATION_REVISION,
  SKILLS_REVISION,
} from "./events";
import {
  INJECTED_AGENTS,
  artifactLayout,
  launcherPath,
  shimPath,
} from "./inject";
import {
  type IntegrationOptions,
  install,
  prepareAtStartup,
  state,
  uninstall,
} from "./integration";
import { readMigration } from "./migrate";
import { tempDir } from "../../testing/temp-dir";

let root: string;
let hookBin: string;
let release: (() => void) | undefined;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARMADRA_HOOK_BIN: hookBin,
    // Windows' launchers copy it; any bytes do here. Ignored elsewhere.
    ARMADRA_LAUNCH_EXE: join(root, "bin", "armadra-launch.exe"),
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    COPILOT_HOME: join(root, "copilot"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    ARMADRA_NO_GLOBAL_WRITES: "",
    ...extra,
  };
}

function options(agentId: string): IntegrationOptions {
  return {
    dataDir: join(root, "data"),
    env: env(),
    ...(agentId === "codex" ? { home: join(root, "codex") } : {}),
  };
}

beforeEach(() => {
  root = tempDir("armadra-integration-");
  hookBin = join(root, "bin", "armadra-hook");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(hookBin, "#!/bin/sh\n", "utf8");
  writeFileSync(join(root, "bin", "armadra-launch.exe"), "MZ", "utf8");
  release = installCollaborationSkill();
});

afterEach(() => {
  release?.();
  release = undefined;
  forgetProbes();
});

describe("the canvas integration", () => {
  /**
   * The composed revision is what makes hook and skill one switch: a change to
   * either half has to move it, or a stale artifact reads as current.
   */
  it("carries both halves in the revision", () => {
    expect(INTEGRATION_REVISION).toBe(
      HOOK_CLIENT_REVISION * 100 + SKILLS_REVISION,
    );
  });

  it("reads as missing, then current after a regeneration, then gone", () => {
    for (const agentId of INJECTED_AGENTS) {
      const before = state(agentId, options(agentId));
      expect(before.mode).toBe("canvas");
      expect(before.hook.installed, agentId).toBe(false);
      expect(before.skill.installed, agentId).toBe(false);
      expect(before.launchArgs).toEqual([]);

      const after = install(agentId, options(agentId));
      expect(after.hook.installed, agentId).toBe(true);
      expect(after.skill.installed, agentId).toBe(true);
      expect(after.skill.revision).toBe(SKILLS_REVISION);
      expect(after.installedRevision).toBe(INTEGRATION_REVISION);
      expect(after.stale).toBe(false);
      expect(after.launchArgs.length + after.launchEnv.length).toBeGreaterThan(
        0,
      );
      expect(after.skill.path?.startsWith(join(root, "data"))).toBe(true);

      const removed = uninstall(agentId, options(agentId));
      expect(removed.hook.installed, agentId).toBe(false);
      expect(existsSync(artifactLayout(join(root, "data"), agentId).dir)).toBe(
        false,
      );
    }
  });

  /** Nothing is written outside the data directory; the field stays empty. */
  it("names no global write, for any CLI", () => {
    for (const agentId of INJECTED_AGENTS) {
      install(agentId, options(agentId));
      expect(state(agentId, options(agentId)).globalWrites).toEqual([]);
    }
    expect(existsSync(codexConfigPath(join(root, "codex")))).toBe(false);
  });

  it("answers the launcher and the shim once they are written", () => {
    const dataDir = join(root, "data");
    const before = state("claude", options("claude"));
    expect(before.launcher).toBeUndefined();
    expect(before.shim).toBeUndefined();
    const after = install("claude", options("claude"));
    expect(after.launcher).toBe(launcherPath(dataDir, "claude"));
    // Windows writes the shim only for a CLI it finds on `PATH` (§5.4).
    if (process.platform !== "win32") {
      expect(after.shim).toBe(shimPath(dataDir, "claude"));
    }
    expect(after.launcherWarning).toBeUndefined();
    // Codex's hooks live in its launcher.
    const codex = install("codex", options("codex"));
    expect(codex.hook.installed).toBe(true);
    expect(codex.hook.path).toBe(launcherPath(dataDir, "codex"));
    expect(codex.launchArgs[0]).toBe("--dangerously-bypass-hook-trust");
  });

  it.runIf(process.platform === "win32")(
    "answers no launcher on Windows without armadra-launch.exe",
    () => {
      const state = install("claude", { ...options("claude"), launchExe: "" });
      expect(state.launcher).toBeUndefined();
      expect(state.launcherWarning).toMatch(/armadra-launch\.exe/);
    },
  );

  it("warns when the probed Codex is too old for hooks", () => {
    rememberProbe({
      agentId: "codex",
      launchCmd: "codex",
      version: "0.120.0",
      status: "ok",
      probedAt: new Date().toISOString(),
    });
    const codex = install("codex", options("codex"));
    expect(codex.launcherWarning).toMatch(/0\.120\.0/);
    expect(codex.launchArgs).not.toContain("--dangerously-bypass-hook-trust");
    expect(install("claude", options("claude")).launcherWarning).toBe(
      undefined,
    );
  });

  it("refuses a CLI it has no injection for", () => {
    expect(() => state("custom:thing", options("x"))).toThrow(
      /no canvas injection/,
    );
  });
});

describe("start-up", () => {
  it("migrates once and prepares every CLI", () => {
    const dataDir = join(root, "data");
    mkdirSync(join(root, "codex"), { recursive: true });
    const report = prepareAtStartup({ dataDir, env: env() });
    expect(report.failures).toEqual([]);
    expect(report.prepared).toEqual([...INJECTED_AGENTS]);
    expect(readMigration(dataDir)).toEqual(report.migration);
    // Codex has a config home here, and still nothing is written into it:
    // its hooks are trusted by the launcher's flag.
    expect(existsSync(codexConfigPath(join(root, "codex")))).toBe(false);
    // The migration's second step is reported on Codex's state.
    expect(state("codex", options("codex")).migration?.sessionTrust).toEqual({
      at: report.migration?.sessionTrust?.at,
      removed: [],
    });
    for (const agentId of INJECTED_AGENTS) {
      expect(state(agentId, options(agentId)).hook.installed, agentId).toBe(
        true,
      );
    }
  });

  it("creates no Codex home on a machine that never ran Codex", () => {
    prepareAtStartup({ dataDir: join(root, "data"), env: env() });
    expect(existsSync(join(root, "codex"))).toBe(false);
  });

  it("touches nothing global when global writes are off", () => {
    const dataDir = join(root, "data");
    mkdirSync(join(root, "codex"), { recursive: true });
    const report = prepareAtStartup({
      dataDir,
      env: env({ ARMADRA_NO_GLOBAL_WRITES: "1" }),
    });
    expect(report.migration).toBeUndefined();
    expect(readMigration(dataDir)).toBeUndefined();
    expect(existsSync(codexConfigPath(join(root, "codex")))).toBe(false);
  });
});
