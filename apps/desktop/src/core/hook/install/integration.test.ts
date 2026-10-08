import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
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
  canvasAgentsOf,
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
    // Nothing outside the data directory was migrated, so nothing is shown.
    expect(report.migration?.version).toBe(3);
    expect(state("codex", options("codex")).migration).toBeUndefined();
    for (const agentId of INJECTED_AGENTS) {
      expect(state(agentId, options(agentId)).hook.installed, agentId).toBe(
        true,
      );
    }
  });

  /**
   * A machine carrying both an install of ours from before canvas-only
   * integration and another tool's hooks, skills and instruction blocks:
   * start-up changes none of it, and the page lists only what is ours.
   */
  it("leaves every CLI file alone and lists only our residue", () => {
    const dataDir = join(root, "data");
    const files: Record<string, string> = {
      [join(root, "claude", "settings.json")]: JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: `${hookBin} claude` }] },
            {
              hooks: [
                {
                  type: "command",
                  command: "sh '/Users/dev/.othertool/agent-hooks/claude.sh'",
                },
              ],
            },
          ],
        },
      }),
      [join(root, "claude", "skills", "armadra", "SKILL.md")]:
        "---\nname: armadra\n---\n<!-- armadra:skill-revision 9 -->\n",
      [join(root, "claude", "skills", "othertool-canvas", "SKILL.md")]:
        "---\nname: othertool-canvas\n---\n",
      [join(root, "codex", "AGENTS.md")]:
        "<!-- othertool:manage-canvas:start -->\nx\n<!-- othertool:manage-canvas:end -->\n",
      [join(root, "copilot", "hooks", "othertool-status.json")]: JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              {
                type: "command",
                bash: "sh ~/.othertool/agent-hooks/copilot.sh",
              },
            ],
          },
        },
      ),
    };
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body, "utf8");
    }

    prepareAtStartup({ dataDir, env: env() });
    for (const [path, body] of Object.entries(files)) {
      expect(readFileSync(path, "utf8"), path).toBe(body);
    }

    const claude = state("claude", {
      ...options("claude"),
      home: join(root, "claude"),
    });
    expect(claude.legacy.found.map((one) => one.kind).sort()).toEqual([
      "hook_entry",
      "skill_dir",
    ]);
    expect(JSON.stringify(claude)).not.toContain("othertool");
    for (const agentId of ["codex", "copilot"]) {
      const answer = state(agentId, {
        ...options(agentId),
        home: join(root, agentId),
      });
      expect(answer.legacy.found, agentId).toEqual([]);
      expect(JSON.stringify(answer), agentId).not.toContain("othertool");
    }
  });

  it("does not show another tool's paths from an earlier build's record", () => {
    const dataDir = join(root, "data");
    const skills = join(root, "claude", "skills");
    mkdirSync(join(dataDir, "integration"), { recursive: true });
    writeFileSync(
      join(dataDir, "integration", "global-migration.json"),
      JSON.stringify({
        version: 2,
        migratedAt: "2026-09-26T00:00:00.000Z",
        agents: {
          claude: {
            removed: [
              join(skills, "armadra", "SKILL.md"),
              join(skills, "othertool-canvas", "SKILL.md"),
            ],
            backups: [
              join(
                dataDir,
                "integration",
                "global-backup-1",
                "claude",
                "skills",
                "othertool-canvas",
                "SKILL.md",
              ),
            ],
          },
        },
      }),
      "utf8",
    );
    const migration = state("claude", options("claude")).migration;
    expect(migration?.removed).toEqual([join(skills, "armadra", "SKILL.md")]);
    expect(migration?.backups).toEqual([]);
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

/* ------------------------- 在画布中创建 Agent（§48） ------------------------- */

describe("canvasAgents", () => {
  const ready = {
    cliInstalled: true,
    hookInstalled: true,
    skillInstalled: true,
    launcherLimited: false,
    acp: { installed: true, canvasTools: "mcp" as const },
    clientMcp: true,
  };

  it("both drivers available when everything is in place", () => {
    expect(canvasAgentsOf(ready)).toEqual({
      terminal: "available",
      acp: "available",
      reasons: [],
    });
  });

  it("terminal: skill without hook or with a limited launcher is limited", () => {
    expect(canvasAgentsOf({ ...ready, hookInstalled: false })).toMatchObject({
      terminal: "limited",
      reasons: ["hook_missing"],
    });
    expect(canvasAgentsOf({ ...ready, launcherLimited: true })).toMatchObject({
      terminal: "limited",
      reasons: ["launcher_limited"],
    });
  });

  it("terminal: no CLI or no skill is unavailable", () => {
    expect(canvasAgentsOf({ ...ready, cliInstalled: false }).terminal).toBe(
      "unavailable",
    );
    expect(
      canvasAgentsOf({ ...ready, skillInstalled: false, hookInstalled: false }),
    ).toMatchObject({
      terminal: "unavailable",
      reasons: ["skill_missing", "hook_missing"],
    });
  });

  it("acp: none without an entry, unavailable when not installed", () => {
    const { acp: _drop, ...noAcp } = ready;
    expect(canvasAgentsOf(noAcp).acp).toBe("none");
    expect(
      canvasAgentsOf({
        ...ready,
        acp: { installed: false, canvasTools: "mcp" },
      }),
    ).toMatchObject({ acp: "unavailable", reasons: ["acp_missing"] });
  });

  it("acp: an adapter without MCP or a client without MCP is limited", () => {
    expect(
      canvasAgentsOf({
        ...ready,
        acp: { installed: true, canvasTools: "none" },
      }),
    ).toMatchObject({ acp: "limited", reasons: ["mcp_not_wired"] });
    expect(canvasAgentsOf({ ...ready, clientMcp: false })).toMatchObject({
      acp: "limited",
      reasons: ["client_without_mcp"],
    });
    // ama 的 runners 不经 MCP：客户端带不带都可用。
    expect(
      canvasAgentsOf({
        ...ready,
        clientMcp: false,
        acp: { installed: true, canvasTools: "runners" },
      }).acp,
    ).toBe("available");
  });

  it.skipIf(process.platform === "win32")(
    "state() answers it from the PATH, the artifacts and the adapter table",
    () => {
      const bin = join(root, "path-bin");
      mkdirSync(bin, { recursive: true });
      for (const name of ["claude", "claude-agent-acp", "pi", "pi-acp"]) {
        writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
        chmodSync(join(bin, name), 0o755);
      }
      const withPath = (agentId: string): IntegrationOptions => ({
        ...options(agentId),
        env: env({ PATH: [bin, process.env.PATH ?? ""].join(delimiter) }),
        clientMcp: () => true,
      });
      install("claude", withPath("claude"));
      expect(state("claude", withPath("claude")).canvasAgents).toEqual({
        terminal: "available",
        acp: "available",
        reasons: [],
      });
      install("pi", withPath("pi"));
      expect(state("pi", withPath("pi")).canvasAgents).toEqual({
        terminal: "available",
        acp: "limited",
        reasons: ["mcp_not_wired"],
      });
    },
  );
});
