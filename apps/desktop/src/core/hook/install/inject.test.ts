import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetProbes, rememberProbe } from "../../agent/probe";
import { installCollaborationSkill } from "../../collab/skill";
import { configPath as codexConfigPath } from "./codex";
import {
  CLAUDE_HOOK_EVENTS,
  COPILOT_HOOK_EVENTS,
  INTEGRATION_REVISION,
} from "./events";
import {
  CODEX_BYPASS_HOOK_TRUST,
  CODEX_HOOK_VAR,
  CODEX_INSTRUCTIONS_VAR,
  INJECTED_AGENTS,
  artifactLayout,
  canvasInjection,
  codexBypassesTrust,
  codexHooksWarning,
  currentLauncher,
  launcherPath,
  prepareInjection,
  codexTomlString,
  readLauncherMarker,
  removeInjection,
  shimPath,
} from "./inject";
import { tempDir } from "../../testing/temp-dir";

/**
 * The canvas injection: what each CLI is handed, and what is written for it.
 *
 * The argv shapes are the ones measured against the real CLIs on 2026-09-26
 * (docs/design/canvas-only-integration.md §3). They are asserted literally,
 * because a flag spelled differently is a CLI that silently starts without
 * our hooks.
 */

let dataDir: string;
let codexHome: string;
let env: NodeJS.ProcessEnv;
let hookBin: string;
let launchExe: string;
let release: (() => void) | undefined;

beforeEach(() => {
  const root = tempDir("armadra-inject-");
  dataDir = join(root, "data");
  codexHome = join(root, "codex");
  hookBin = join(root, "bin", "armadra-hook");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(hookBin, "#!/bin/sh\n", "utf8");
  // Windows' launchers are copies of armadra-launch.exe; any bytes will do
  // here (windows-launch.test.ts runs the real one). Ignored elsewhere.
  launchExe = join(root, "bin", "armadra-launch.exe");
  writeFileSync(launchExe, "MZ not a program", "utf8");
  env = {
    ...process.env,
    ARMADRA_HOOK_BIN: hookBin,
    ARMADRA_LAUNCH_EXE: launchExe,
    CODEX_HOME: codexHome,
    ARMADRA_NO_GLOBAL_WRITES: "",
  };
  release = installCollaborationSkill();
});

afterEach(() => {
  release?.();
  release = undefined;
  forgetProbes();
});

function prepare(agentId: string) {
  return prepareInjection(agentId, { dataDir, env });
}

const windows = process.platform === "win32";

/**
 * What the launcher carries, as text: the script itself, or on Windows the
 * `.launch` beside the copied program.
 */
function launcherText(agentId: string): string {
  const path = launcherPath(dataDir, agentId);
  return readFileSync(
    windows ? `${path.slice(0, -".exe".length)}.launch` : path,
    "utf8",
  );
}

function inject(agentId: string, resume = false) {
  return canvasInjection({ dataDir, agentId, nodeId: "node-1", resume });
}

describe("canvas injection", () => {
  it("hands nothing over before the artifacts exist", () => {
    for (const agentId of INJECTED_AGENTS) {
      expect(inject(agentId), agentId).toEqual({
        args: [],
        words: [],
        env: [],
      });
    }
    expect(inject("custom:unknown")).toEqual({ args: [], words: [], env: [] });
  });

  it("writes everything under the data directory, byte-identical twice", () => {
    for (const agentId of INJECTED_AGENTS) {
      const first = prepare(agentId);
      expect(first.written.length, agentId).toBeGreaterThan(0);
      for (const path of first.written) {
        expect(
          [
            join(dataDir, "integration", agentId),
            // `run\<cli>.exe` comes with its `.launch` on Windows.
            launcherPath(dataDir, agentId).replace(/\.exe$/, "."),
            shimPath(dataDir, agentId).replace(/\.exe$/, "."),
          ].some((prefix) => path.startsWith(prefix)),
          path,
        ).toBe(true);
      }
      const layout = artifactLayout(dataDir, agentId);
      const skill = readFileSync(layout.skill, "utf8");
      const again = prepareInjection(agentId, {
        dataDir,
        env,
        force: true,
      });
      expect(again.written, agentId).toEqual([]);
      expect(readFileSync(layout.skill, "utf8")).toBe(skill);
    }
  });

  it("gives Claude its settings, its plugin and the instructions", () => {
    prepare("claude");
    const layout = artifactLayout(dataDir, "claude");
    const { args, env: vars } = inject("claude");
    expect(args).toEqual([
      "--settings",
      layout.settings,
      "--plugin-dir",
      layout.pluginDir,
      "--append-system-prompt-file",
      layout.instructions,
    ]);
    expect(vars).toEqual([]);
    const settings = JSON.parse(
      readFileSync(layout.settings as string, "utf8"),
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(Object.keys(settings.hooks)).toEqual([...CLAUDE_HOOK_EVENTS]);
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
      `${hookBin} claude`,
    );
    const manifest = JSON.parse(
      readFileSync(layout.manifest as string, "utf8"),
    ) as { name: string };
    expect(manifest.name).toBe("armadra");
    expect(layout.skill).toBe(
      join(layout.pluginDir as string, "skills", "armadra", "SKILL.md"),
    );
  });

  it("gives Codex the trust flag, its hooks, its instructions and no update prompt", () => {
    prepare("codex");
    const layout = artifactLayout(dataDir, "codex");
    const { args, env: vars } = inject("codex");
    // The flag first, then only `-c` pairs.
    expect(args[0]).toBe(CODEX_BYPASS_HOOK_TRUST);
    const rest = args.slice(1);
    expect(
      rest.filter((_, index) => index % 2 === 0).every((a) => a === "-c"),
    ).toBe(true);
    const pairs = rest.filter((_, index) => index % 2 === 1);
    expect(pairs[0]).toBe("check_for_update_on_startup=false");
    expect(pairs).toContain(
      `hooks.SessionStart=[{hooks=[{type="command",command=${JSON.stringify(`${hookBin} codex`)}}]}]`,
    );
    expect(pairs.filter((pair) => pair.startsWith("hooks.")).length).toBe(8);
    // Codex has no Notification event; it is not passed.
    expect(pairs.some((pair) => pair.startsWith("hooks.Notification"))).toBe(
      false,
    );
    const instructions = pairs.at(-1) as string;
    expect(instructions.startsWith("developer_instructions=")).toBe(true);
    const text = JSON.parse(
      instructions.slice("developer_instructions=".length),
    ) as string;
    expect(text).toContain("canvas open-agent");
    expect(text).toContain(layout.skill);
    expect(existsSync(layout.skill)).toBe(true);
    // Nothing for the environment: the launcher carries it all as argv.
    expect(vars).toEqual([]);
  });

  it("gates Codex's flag and hooks on its probed version", () => {
    prepare("codex");
    const old = canvasInjection({
      dataDir,
      agentId: "codex",
      codexVersion: "0.133.0",
    }).args;
    expect(old).not.toContain(CODEX_BYPASS_HOOK_TRUST);
    expect(old.some((arg) => arg.startsWith("hooks."))).toBe(false);
    expect(old).toContain("check_for_update_on_startup=false");
    expect(old.at(-1)?.startsWith("developer_instructions=")).toBe(true);
    for (const version of ["0.134.0", "0.160.1", null]) {
      expect(
        canvasInjection({ dataDir, agentId: "codex", codexVersion: version })
          .args[0],
        String(version),
      ).toBe(CODEX_BYPASS_HOOK_TRUST);
    }
    expect(codexBypassesTrust("0.133.9")).toBe(false);
    expect(codexBypassesTrust("1.0")).toBe(true);
    expect(codexBypassesTrust("garbage")).toBe(true);
    expect(codexHooksWarning("0.120.0")).toMatch(/0\.120\.0.*no hooks/);
    expect(codexHooksWarning("0.134.0")).toBeUndefined();

    // Read off the cached probe, and the launcher follows it.
    rememberProbe({
      agentId: "codex",
      launchCmd: "codex",
      version: "0.133.0",
      status: "ok",
      probedAt: new Date().toISOString(),
    });
    expect(inject("codex").args).not.toContain(CODEX_BYPASS_HOOK_TRUST);
    prepare("codex");
    expect(launcherText("codex")).not.toContain(CODEX_BYPASS_HOOK_TRUST);
    forgetProbes();
    prepare("codex");
    expect(launcherText("codex")).toContain(CODEX_BYPASS_HOOK_TRUST);
  });

  it("hands every other CLI's argv over as its (deprecated) words", () => {
    for (const agentId of ["claude", "opencode", "pi", "omp", "copilot"]) {
      prepare(agentId);
      const { args, words } = inject(agentId);
      expect(words, agentId).toEqual(args);
    }
  });

  it("gives OpenCode a fixed config directory and the instructions by env", () => {
    prepare("opencode");
    const layout = artifactLayout(dataDir, "opencode");
    const { args, env: vars } = inject("opencode");
    expect(args).toEqual([]);
    expect(vars).toEqual([
      ["OPENCODE_CONFIG_DIR", layout.configDir],
      [
        "OPENCODE_CONFIG_CONTENT",
        JSON.stringify({ instructions: [layout.instructions] }),
      ],
    ]);
    expect(existsSync(join(layout.configDir as string, "plugins"))).toBe(true);
    expect(existsSync(layout.skill)).toBe(true);
  });

  it("gives Pi its extension, its skill and the instructions", () => {
    prepare("pi");
    const layout = artifactLayout(dataDir, "pi");
    expect(inject("pi")).toMatchObject({
      args: [
        "--extension",
        layout.module,
        "--skill",
        layout.skillDir,
        "--append-system-prompt",
        layout.instructions,
      ],
      env: [],
    });
  });

  it("gives OMP the `=` forms and a skills overlay", () => {
    prepare("omp");
    const layout = artifactLayout(dataDir, "omp");
    expect(inject("omp")).toMatchObject({
      args: [
        `--extension=${layout.module}`,
        `--config=${layout.overlay}`,
        `--append-system-prompt=${layout.instructions}`,
      ],
      env: [],
    });
    expect(readFileSync(layout.overlay as string, "utf8")).toContain(
      "customDirectories",
    );
  });

  it("gives Copilot a plugin with hooks and skills, instructions by env", () => {
    prepare("copilot");
    const layout = artifactLayout(dataDir, "copilot");
    expect(inject("copilot")).toMatchObject({
      args: ["--plugin-dir", layout.pluginDir],
      env: [["COPILOT_CUSTOM_INSTRUCTIONS_DIRS", layout.instructionsDir]],
    });
    const manifest = JSON.parse(
      readFileSync(layout.manifest as string, "utf8"),
    ) as Record<string, string>;
    expect(manifest.hooks).toBe("hooks.json");
    expect(manifest.skills).toBe("skills/");
    const hooks = JSON.parse(
      readFileSync(layout.pluginHooks as string, "utf8"),
    ) as { version: number; hooks: Record<string, { bash: string }[]> };
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks)).toEqual([...COPILOT_HOOK_EVENTS]);
    // The blocking event stays out.
    expect(hooks.hooks.preToolUse).toBeUndefined();
    expect(readFileSync(layout.instructions as string, "utf8")).toMatch(
      /^---\napplyTo: "\*\*"\n---/,
    );
  });

  /** Measured: every CLI needs the same argv again when it resumes. */
  it("hands a resumed session exactly what a new one gets", () => {
    for (const agentId of INJECTED_AGENTS) {
      prepare(agentId);
      expect(inject(agentId, true), agentId).toEqual(inject(agentId, false));
      expect(
        inject(agentId, true).args.length + inject(agentId).env.length,
      ).toBeGreaterThan(0);
    }
  });

  it("regenerates when the revision on disk is not this one", () => {
    prepare("pi");
    const layout = artifactLayout(dataDir, "pi");
    writeFileSync(
      layout.marker,
      JSON.stringify({ revision: 1, clientBin: hookBin, writtenAt: "" }),
      "utf8",
    );
    writeFileSync(layout.module as string, "stale", "utf8");
    prepare("pi");
    expect(readFileSync(layout.module as string, "utf8")).not.toBe("stale");
  });
});

describe("the launcher and the shim", () => {
  it("writes run/ and shims/ for every CLI, carrying the literal injection", () => {
    for (const agentId of INJECTED_AGENTS) {
      const report = prepare(agentId);
      expect(report.launcher, agentId).toBe(launcherPath(dataDir, agentId));
      expect(report.launcherWarning).toBeUndefined();
      expect(currentLauncher(dataDir, agentId)).toBe(report.launcher);
      const launcher = launcherText(agentId);
      if (windows) {
        // `.launch` lines are literals: no quoting at all.
        expect(readFileSync(report.launcher as string, "utf8")).toBe(
          "MZ not a program",
        );
        for (const arg of inject(agentId).args) {
          expect(launcher, agentId).toContain(`\r\narg=${arg}\r\n`);
        }
        for (const [name, value] of inject(agentId).env) {
          expect(launcher).toContain(`\r\nenv=${name}=${value}\r\n`);
        }
        // The shim is only written for a CLI found on `PATH` (§5.4).
        continue;
      }
      for (const arg of inject(agentId).args) {
        expect(launcher, agentId).toContain(arg.replace(/'/g, "'\\''"));
      }
      for (const [name] of inject(agentId).env) {
        expect(launcher).toContain(`export ${name}`);
      }
      expect(statSync(report.launcher as string).mode & 0o777).toBe(0o755);
      expect(readFileSync(shimPath(dataDir, agentId), "utf8")).toContain(
        `${agentId} "$@"`,
      );
    }
    expect(readLauncherMarker(dataDir)).toMatchObject({
      revision: INTEGRATION_REVISION,
      clientBin: hookBin,
      platform: process.platform,
    });
  });

  it("rewrites nothing when nothing changed", () => {
    prepare("claude");
    const marker = readFileSync(
      join(dataDir, "integration", "launcher.json"),
      "utf8",
    );
    expect(prepare("claude").written).toEqual([]);
    expect(
      readFileSync(join(dataDir, "integration", "launcher.json"), "utf8"),
    ).toBe(marker);
  });

  // Windows only: elsewhere the launcher is a script and needs no program.
  it.runIf(windows)(
    "writes no launcher on Windows without armadra-launch.exe (§5.3)",
    () => {
      prepare("claude");
      expect(currentLauncher(dataDir, "claude")).toBeDefined();
      const report = prepareInjection("claude", {
        dataDir,
        env,
        launchExe: "",
      });
      expect(report.launcher).toBeUndefined();
      expect(report.launcherWarning).toMatch(/armadra-launch\.exe/);
      expect(readLauncherMarker(dataDir)?.warning).toMatch(/armadra-launch/);
      // The run\ left from before is not trusted: the line goes bare.
      expect(currentLauncher(dataDir, "claude")).toBeUndefined();
      const fresh = join(dirname(dataDir), "fresh");
      prepareInjection("pi", {
        dataDir: fresh,
        env: { ...env, ARMADRA_LAUNCH_EXE: join(fresh, "missing.exe") },
      });
      expect(existsSync(launcherPath(fresh, "pi"))).toBe(false);
      expect(currentLauncher(fresh, "pi")).toBeUndefined();
    },
  );

  it("is not trusted when written by another revision", () => {
    prepare("pi");
    writeFileSync(
      join(dataDir, "integration", "launcher.json"),
      JSON.stringify({
        revision: 1,
        clientBin: hookBin,
        platform: process.platform,
        writtenAt: "",
      }),
      "utf8",
    );
    expect(currentLauncher(dataDir, "pi")).toBeUndefined();
    expect(currentLauncher(dataDir, "custom:x")).toBeUndefined();
  });

  it("is removed with the artifacts", () => {
    prepare("claude");
    removeInjection("claude", { dataDir, env });
    expect(existsSync(launcherPath(dataDir, "claude"))).toBe(false);
    expect(existsSync(shimPath(dataDir, "claude"))).toBe(false);
    expect(existsSync(artifactLayout(dataDir, "claude").dir)).toBe(false);
  });
});

describe("nothing outside the data directory", () => {
  it("leaves Codex's config.toml alone, with global writes on", () => {
    for (const agentId of INJECTED_AGENTS) prepare(agentId);
    expect(existsSync(codexHome)).toBe(false);
    mkdirSync(codexHome, { recursive: true });
    const mine = '# mine\nmodel = "gpt-5"\n';
    writeFileSync(codexConfigPath(codexHome), mine, "utf8");
    prepareInjection("codex", { dataDir, env, force: true });
    removeInjection("codex", { dataDir, env });
    expect(readFileSync(codexConfigPath(codexHome), "utf8")).toBe(mine);
    expect(readdirSync(codexHome)).toEqual(["config.toml"]);
  });
});

/**
 * 过渡（deprecated）：启动行改经启动器之前，Codex 的长值仍放在节点终端的环境里
 * 由行展开。Windows 上那个 shell 默认是 `cmd.exe`；行里的词由 `terminal/shell.ts`
 * 按方言引用，这里只管 Codex 那两个由行展开的环境变量。
 */
describe("Codex's expanded values per shell (deprecated typed line)", () => {
  const nasty = 'say "hi" & a|b <c> ^d (e) 100% !x! C:\\dir\\ 画布\n';

  it("keeps a plain TOML string where the shell expands one finished word", () => {
    expect(codexTomlString(nasty)).toBe(JSON.stringify(nasty));
    expect(codexTomlString(nasty, "powershell")).toBe(JSON.stringify(nasty));
  });

  it("writes cmd.exe's so nothing in it is live and its quotes survive", () => {
    const value = codexTomlString(nasty, "cmd");
    expect(value.startsWith('\\"')).toBe(true);
    expect(value.endsWith('\\"')).toBe(true);
    // Between the `\"` pair: nothing cmd.exe or the C runtime acts on, and a
    // backslash only as the start of a `\uXXXX` escape.
    const body = value.slice(2, -2);
    expect(body).not.toMatch(/["%!^&|<>()\r\n]/);
    expect(body).not.toMatch(/\\(?!u[0-9a-f]{4})/);
    // The program receives `"` for each `\"`: a TOML basic string of the
    // value, whose escapes here are JSON's.
    expect(JSON.parse(value.replace(/\\"/g, '"'))).toBe(nasty);
  });

  it("puts the node shell's form into the terminal's environment", () => {
    prepare("codex");
    const vars = canvasInjection({
      dataDir,
      agentId: "codex",
      nodeId: "node-1",
      dialect: "cmd",
    }).env;
    expect(vars.map(([name]) => name)).toEqual([
      CODEX_HOOK_VAR,
      CODEX_INSTRUCTIONS_VAR,
    ]);
    const hook = vars.find(([name]) => name === CODEX_HOOK_VAR)?.[1] ?? "";
    expect(hook).toBe(
      `[{hooks=[{type=${codexTomlString("command", "cmd")},command=${codexTomlString(`${hookBin} codex`, "cmd")}}]}]`,
    );
    expect(hook).not.toMatch(/(?<!\\)"/);
  });
});
