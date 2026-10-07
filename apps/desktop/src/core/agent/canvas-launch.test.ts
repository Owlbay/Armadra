import { execFileSync } from "node:child_process";
import {
  chmodSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCollaborationSkill } from "../collab/skill";
import {
  artifactLayout,
  launcherMarkerPath,
  launcherPath,
  prepareInjection,
  shimDirectoryOf,
} from "../hook/install/inject";
import { launchLine as coldStartLine } from "../schedule/cold-start";
import { resumeLine } from "../terminal/hibernator";
import { tempDir } from "../testing/temp-dir";
import { acpAdapter } from "../acp/adapters";
import {
  acpInjection,
  canvasEnvironment,
  canvasLaunch,
  canvasLaunchLine,
  launcherFor,
  nodeDialect,
} from "./canvas-launch";
import { quoteShellWord } from "../terminal/shell";
import type { AgentSettings, CustomAgent } from "./registry";

/**
 * The one exit every canvas launch line leaves through
 * (docs/design/canvas-launcher.md §9).
 *
 * Two halves: the shapes (each road starts the CLI through its launcher
 * `run/<cli>`, the line itself carries no injection), and a structural check
 * that no road builds a launch line anywhere else — a new launch path that
 * skipped `canvas-launch.ts` would start CLIs without our hooks, skill and
 * rules, and nothing else would notice.
 */

const CORE = join(__dirname, "..");
const WEB = join(__dirname, "..", "..", "..", "..", "web", "src");
const POSIX = process.platform !== "win32";

let dataDir: string;
let release: (() => void) | undefined;
const custom: CustomAgent[] = [];
const settings: AgentSettings = { customAgents: () => custom };

beforeEach(() => {
  // 数据目录带空格：启动器路径要在每种方言里都引得对。
  const root = tempDir("armadra-canvas-launch-");
  dataDir = join(root, "data dir");
  const hookBin = join(root, "armadra-hook");
  writeFileSync(hookBin, "#!/bin/sh\n", "utf8");
  release = installCollaborationSkill();
  for (const agentId of ["claude", "codex", "opencode"]) {
    prepareInjection(agentId, {
      dataDir,
      env: { ...process.env, ARMADRA_HOOK_BIN: hookBin },
    });
  }
  custom.length = 0;
});

afterEach(() => {
  release?.();
  release = undefined;
});

describe.runIf(POSIX)("canvas launch lines", () => {
  it("starts Claude through its launcher, the injection left to it", () => {
    const launcher = launcherPath(dataDir, "claude");
    const launch = canvasLaunch({
      settings,
      dataDir,
      agentId: "claude",
      permissionMode: "plan",
      model: "opus",
      dialect: "posix",
    });
    expect(launch.launcher).toBe(launcher);
    expect(launch.program).toBe(launcher);
    expect(launch.args).toEqual([
      "claude",
      "--permission-mode",
      "plan",
      "--model",
      "opus",
    ]);
    expect(launch.line).toBe(
      `${quoteShellWord(launcher, "posix")} claude --permission-mode plan --model opus`,
    );
    expect(launch.line).not.toContain("--settings");
  });

  it("keeps Codex's resume subcommand first, after the program", () => {
    const line = canvasLaunchLine({
      settings,
      dataDir,
      agentId: "codex",
      resume: "thread-9",
      dialect: "posix",
    });
    expect(line).toBe(
      `${quoteShellWord(launcherPath(dataDir, "codex"), "posix")} codex resume thread-9`,
    );
    // 几 KB 的 `-c` 都在启动器文件里，行与 CLI、与注入内容无关。
    expect(line).not.toContain(" -c ");
    expect(line).not.toContain("ARMADRA_CODEX");
  });

  it("writes the launcher in the node shell's dialect", () => {
    const launcher = launcherPath(dataDir, "codex");
    const program = "C:\\Program Files\\codex.exe";
    const cmd = canvasLaunchLine({
      settings,
      dataDir,
      agentId: "codex",
      program,
      dialect: "cmd",
    });
    expect(cmd).toBe(
      `${quoteShellWord(launcher, "cmd")} "C:\\Program Files\\codex.exe"`,
    );
    const powershell = canvasLaunchLine({
      settings,
      dataDir,
      agentId: "codex",
      program,
      model: "gpt-5",
      dialect: "powershell",
    });
    expect(powershell).toBe(
      `& '${launcher}' 'C:\\Program Files\\codex.exe' --model gpt-5`,
    );
    expect(nodeDialect("C:\\Windows\\system32\\cmd.exe")).toBe("cmd");
    expect(nodeDialect("pwsh.exe")).toBe("powershell");
    // An SSH node's line is read by the far host's shell.
    expect(nodeDialect("C:\\Windows\\system32\\cmd.exe", true)).toBe("posix");
  });

  it("starts a custom entry through its base's launcher", () => {
    custom.push({
      id: "custom:mine",
      label: "Mine",
      launchCmd: "/opt/claude-wrapper",
      baseAgent: "claude",
    });
    const launch = canvasLaunch({ settings, dataDir, agentId: "custom:mine" });
    expect(launch.program).toBe(launcherPath(dataDir, "claude"));
    expect(launch.args[0]).toBe("/opt/claude-wrapper");
    expect(launch.args).not.toContain("--plugin-dir");
    expect(launcherFor(settings, dataDir, "custom:mine")).toBe(
      launcherPath(dataDir, "claude"),
    );
  });

  /** No current launcher: a bare line, never the injection on the line. */
  it("falls back to a bare line without a current launcher", () => {
    expect(
      canvasLaunchLine({
        settings,
        agentId: "claude",
        model: "opus",
        dialect: "posix",
      }),
    ).toBe("claude --model opus");
    rmSync(launcherMarkerPath(dataDir));
    expect(launcherFor(settings, dataDir, "claude")).toBeUndefined();
    expect(
      canvasLaunchLine({
        settings,
        dataDir,
        agentId: "claude",
        model: "opus",
        dialect: "posix",
      }),
    ).toBe("claude --model opus");
  });

  /**
   * A wrapper that could not be read stays the program of a bare line: the
   * line is written only when every word survives `cmd.exe`'s second read.
   */
  it("keeps an unreadable batch wrapper on a bare line to safe words", () => {
    const wrapper = join(tempDir("armadra-batch-"), "codex.cmd");
    writeFileSync(wrapper, '@echo off\r\nset "P=x"\r\n"%P%" %*\r\n', "utf8");
    chmodSync(wrapper, 0o755);
    custom.push({
      id: "custom:batch",
      label: "Batch",
      launchCmd: wrapper,
      baseAgent: "codex",
    });
    expect(
      canvasLaunchLine({
        settings,
        agentId: "custom:batch",
        program: wrapper,
        frozenArgs: ["--model", "gpt-5"],
        dialect: "cmd",
      }),
    ).toBe(`${quoteShellWord(wrapper, "cmd")} --model gpt-5`);
    expect(() =>
      canvasLaunchLine({
        settings,
        agentId: "custom:batch",
        program: wrapper,
        frozenArgs: ["--prompt", "fix a&b"],
        dialect: "cmd",
      }),
    ).toThrow(/batch/);
  });

  /** The road that used to leave `--settings` off. */
  it("gives a schedule's cold start the launcher, not the frozen plan alone", () => {
    const spec = {
      agentId: "claude",
      workingDirectory: "/tmp/ws",
      args: ["--model", "opus"],
      permissionMode: "",
      modelId: "",
      accountId: "default",
    };
    const line = coldStartLine(settings, spec, dataDir);
    expect(line).toBe(
      `${quoteShellWord(launcherPath(dataDir, "claude"), nodeDialect(undefined))} claude --model opus`,
    );
    expect(coldStartLine(settings, spec)).toBe("claude --model opus");
  });

  it("gives the Eco wake-up the launcher on its resume line", () => {
    const line = resumeLine(
      settings,
      "claude",
      { agent: { id: "claude" } },
      "session-1",
      { dataDir, dialect: "posix" },
    );
    expect(line).toBe(
      `${quoteShellWord(launcherPath(dataDir, "claude"), "posix")} claude --resume session-1`,
    );
  });

  it("leaves an SSH node's line bare: the host's shims inject", () => {
    const launch = canvasLaunch({
      settings,
      dataDir,
      agentId: "claude",
      nodeId: "n1",
      model: "opus",
      program: "/opt/homebrew/bin/claude",
      dialect: "cmd",
      ssh: true,
    });
    // 本机的启动器、程序路径与注入路径在执行主机上都不存在；行按 POSIX 写。
    expect(launch.line).toBe("claude --model opus");
    expect(launch.launcher).toBeUndefined();
    const resumed = resumeLine(
      settings,
      "codex",
      { agent: { id: "codex" }, ssh: { hostId: "far" } },
      "thread-1",
      { dataDir, path: "/usr/local/bin/codex" },
    );
    expect(resumed).toBe("codex resume thread-1");
  });

  /**
   * The line really read by `/bin/sh`: with `ARMADRA_NODE_ID` the program
   * receives the caller's words then Claude's injection; without it — the
   * same line again from shell history — the caller's words only.
   */
  it("injects through the launcher only inside a canvas node", () => {
    const root = tempDir("armadra-canvas-launch-run-");
    const fake = join(root, "fake-claude");
    writeFileSync(
      fake,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
      "utf8",
    );
    chmodSync(fake, 0o755);
    const line = canvasLaunchLine({
      settings,
      dataDir,
      agentId: "claude",
      program: fake,
      model: "opus",
      dialect: "posix",
    });
    const run = (env: NodeJS.ProcessEnv): string[] =>
      JSON.parse(
        execFileSync("/bin/sh", ["-c", line], { encoding: "utf8", env }),
      ) as string[];
    const outside: NodeJS.ProcessEnv = { ...process.env };
    delete outside.ARMADRA_NODE_ID;
    expect(run(outside)).toEqual(["--model", "opus"]);
    const layout = artifactLayout(dataDir, "claude");
    expect(run({ ...outside, ARMADRA_NODE_ID: "node-1" })).toEqual([
      "--model",
      "opus",
      "--settings",
      layout.settings,
      "--plugin-dir",
      layout.pluginDir,
      "--append-system-prompt-file",
      layout.instructions,
    ]);
  });
});

describe("canvas node terminal environment", () => {
  it("answers the shims directory and a PATH that starts with it", () => {
    const shims = shimDirectoryOf(dataDir);
    const env = canvasEnvironment(settings, dataDir, "opencode", undefined, {
      ambient: { PATH: ["/usr/bin", shims, "/bin"].join(delimiter) },
    });
    expect(env.map(([name]) => name)).toEqual(["ARMADRA_SHIMS", "PATH"]);
    expect(env[0]).toEqual(["ARMADRA_SHIMS", shims]);
    const path = (env[1]?.[1] ?? "").split(delimiter);
    expect(path[0]).toBe(shims);
    expect(path.slice(1, 3)).toEqual(["/usr/bin", "/bin"]);
    // 只给 CLI 进程的变量不进节点 shell：由启动器设。
    expect(env.some(([name]) => name.startsWith("OPENCODE_"))).toBe(false);
  });

  it("answers nothing for an SSH node or a CLI without an injection", () => {
    expect(
      canvasEnvironment(settings, dataDir, "claude", undefined, { ssh: true }),
    ).toEqual([]);
    expect(canvasEnvironment(settings, dataDir, "gemini")).toEqual([]);
  });

  it("makes the launcher current on the way", () => {
    rmSync(launcherMarkerPath(dataDir));
    expect(launcherFor(settings, dataDir, "claude")).toBeUndefined();
    canvasEnvironment(settings, dataDir, "claude");
    if (POSIX) {
      expect(launcherFor(settings, dataDir, "claude")).toBe(
        launcherPath(dataDir, "claude"),
      );
    }
  });
});

/* ------------------------------- structure -------------------------------- */

function sources(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === "node_modules") continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(path);
      }
    }
  };
  walk(root);
  return out;
}

function callers(root: string, pattern: RegExp): string[] {
  return sources(root)
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort();
}

describe.runIf(POSIX)("the ACP driver's half of the injection", () => {
  it("keeps only what each ACP entry point accepts, and nothing for Claude", () => {
    // Claude 的适配器经 SDK 起 claude：Hook 设置与插件目录在 ACP 下没有参数，
    // 画布工具全由 MCP 承担。
    expect(
      acpInjection(settings, dataDir, "claude", acpAdapter("claude")!),
    ).toEqual({ env: [], args: [] });
    // OpenCode 的配置目录是环境变量，ACP 入口照认。
    const opencode = acpInjection(
      settings,
      dataDir,
      "opencode",
      acpAdapter("opencode")!,
    );
    expect(opencode.args).toEqual([]);
    expect(opencode.env.map(([name]) => name)).toContain("OPENCODE_CONFIG_DIR");
  });
});

describe("the single exit", () => {
  /**
   * `planLaunch` turns a node's agent into flags. Anything that calls it is
   * building a launch line, and the only place allowed to is the exit that
   * adds the injection.
   */
  it("builds core launch lines in canvas-launch.ts only", () => {
    expect(callers(CORE, /(?<!function )\bplanLaunch\(/)).toEqual([
      "agent/canvas-launch.ts",
    ]);
  });

  /** The page quotes with `@armadra/shared`, the core with its own copy. */
  it("keeps the core's quoting rules byte for byte the page's", () => {
    const shared = join(CORE, "..", "..", "..", "..", "packages", "shared");
    expect(readFileSync(join(CORE, "terminal", "shell.ts"), "utf8")).toBe(
      readFileSync(join(shared, "src", "shell.ts"), "utf8"),
    );
  });

  /**
   * Two readers: the integration state (what the launcher carries), and the
   * ACP driver's trimmed copy (`acpInjection`, ACP 会话视图设计 §5.8) — an ACP
   * session is started by the core itself, with no launcher in between, so it
   * takes the same injection and keeps only what its entry point accepts.
   */
  it("answers the injection argv from inject.ts to the integration state and the ACP trim only", () => {
    expect(callers(CORE, /(?<!function )\bcanvasInjection\(/)).toEqual([
      "agent/canvas-launch.ts",
      "hook/install/integration.ts",
    ]);
  });

  /** Which launcher a line goes through is asked in one place. */
  it("asks for the launcher in canvas-launch.ts only", () => {
    expect(callers(CORE, /(?<!function )\blauncherFor\(/)).toEqual([
      "agent/canvas-launch.ts",
    ]);
  });

  /** `launchCommand` is the bare program for display, never a launch. */
  it("uses the bare launch command only for what open-agent reports", () => {
    expect(callers(CORE, /(?<!function )\blaunchCommand\(/)).toEqual([
      "collab/control/nodes.ts",
    ]);
  });

  /**
   * The page builds its own lines, from `GET /api/agents`: every one of them
   * goes through `agent/launch.ts`, which starts them through the row's
   * `launcher` (docs/design/canvas-launcher.md §8.1, §9).
   */
  it("builds page launch lines in agent/launch.ts only, through the launcher", () => {
    expect(callers(WEB, /\bassemble(LaunchCommand|LaunchArgv)\(/)).toEqual([
      "agent/launch.ts",
    ]);
    expect(readFileSync(join(WEB, "agent", "launch.ts"), "utf8")).toMatch(
      /\?\.launcher\b/,
    );
  });
});
