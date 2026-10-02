import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type WindowsLauncherSpec,
  shimTargetFor,
  windowsLauncherFiles,
  windowsLauncherPath,
  windowsShimPath,
  writeWindowsLauncherFiles,
} from "../hook/install/windows-launcher";
import { tempDir } from "../testing/temp-dir";
import { type ShellDialect, shellCommandLine } from "../terminal/shell";
import { launchTargetOf, resolveCommand } from "./registry";
import type { ShimTarget } from "./windows-shim";

/**
 * 启动行经 Windows 画布启动器（`run\<cli>.exe`，docs/design/canvas-launcher.md
 * §5）交给真的 Windows shell 读一遍。Windows 专用：`armadra-launch.exe` 要用
 * 系统自带的 `csc.exe` 现编，别的平台整组跳过（`runIf`），`.launch` 的写法由
 * `hook/install/windows-launcher.test.ts` 在所有平台上测。
 *
 * 程序是一个把 argv 与环境回显成 JSON 的 node 脚本。断言：
 *
 *   * `cmd.exe`、pwsh 7、Windows PowerShell 5.1 敲进去的整行里，调用者的每个
 *     值原样到达，注入的词（带 `"`、`\`、`&`、`%`、中文的 Codex 式 TOML 串）
 *     原样接在后面，注入的环境变量只在 CLI 进程里；
 *   * 没有 `ARMADRA_NODE_ID` 时不注入——画布外重跑同一行就是普通启动；
 *   * 退出码透传；
 *   * 程序是读不出的 `.cmd` 包装时经 `cmd.exe` 起来，不安全的注入词整组跳过并
 *     在 stderr 说明，安全的照常注入；
 *   * 垫片模式起 `.launch` 里的程序，并从 PATH 摘掉自己的目录。
 */

const windows = process.platform === "win32";
const desktop = resolve(import.meta.dirname, "../../..");

/** 调用者的值：各种要特殊处理的字符；`cmd.exe` 收不了换行，这里没有。 */
const VALUES = [
  "plain",
  "a b",
  "it's",
  'say "hi"',
  "100%",
  "%PATH%",
  "a^b",
  "a&b",
  "a|b",
  "<in> (group)",
  "$HOME",
  "`id`",
  "!x!",
  "画布 说明",
  "C:\\dir with space\\",
  "C:\\dir\\",
  'a\\"b & 100%',
  "",
];

/** 注入的词：照 Codex 的形状，写在 `.launch` 里，不经任何 shell。 */
const TOML =
  'hooks.SessionStart=[{hooks=[{type="command",command="C:\\\\Program Files\\\\armadra-hook.exe codex & 100% 画布"}]}]';
const INJECTED = [
  "--dangerously-bypass-hook-trust",
  "-c",
  TOML,
  "-c",
  'developer_instructions="r16\\n%PATH% ^ | <x>"',
  "C:\\trailing\\",
];
/** 只给 CLI 进程的变量。 */
const PLAIN = "a b & c | d <e> 100% ^f 画布 C:\\dir\\x";
const NODE_ID = "node-1";

const ECHO = [
  "const out = { argv: process.argv.slice(2), plain: process.env.ARMADRA_PLAIN ?? null, path: process.env.PATH ?? '' };",
  // 只输出 ASCII：控制台代码页不该决定断言。
  "process.stdout.write(JSON.stringify(out).replace(/[\\u0080-\\uffff]/g, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));",
].join("\n");

interface Echo {
  argv: string[];
  plain: string | null;
  path: string;
}

let root = "";
let exe = "";
let echo = "";
let launcher = "";
let shim = "";
let shimDir = "";

/** 编出 `armadra-launch.exe`，写一个 CLI 的 `run\` 与 `shims\`。 */
function writeLauncher(
  agentId: string,
  args: readonly string[],
  env: readonly (readonly [string, string])[],
  shimTarget?: ShimTarget,
): WindowsLauncherSpec {
  const spec: WindowsLauncherSpec = {
    agentId,
    runDir: join(root, "integration", "run"),
    shimDir: join(root, "integration", "shims"),
    args,
    env,
    exe,
    ...(shimTarget === undefined ? {} : { shimTarget }),
  };
  writeWindowsLauncherFiles(windowsLauncherFiles(spec));
  return spec;
}

beforeAll(async () => {
  if (!windows) return;
  root = tempDir("armadra-windows-launch-");
  const script = pathToFileURL(join(desktop, "scripts", "launch-exe.mjs")).href;
  const { compileLaunchExe } = (await import(script)) as {
    compileLaunchExe(output: string): string;
  };
  exe = compileLaunchExe(join(root, "build", "armadra-launch.exe"));
  echo = join(root, "echo.js");
  writeFileSync(echo, ECHO, "utf8");
  const spec = writeLauncher("claude", INJECTED, [["ARMADRA_PLAIN", PLAIN]], {
    program: process.execPath,
    args: [echo],
  });
  launcher = windowsLauncherPath(spec.runDir, "claude");
  shim = windowsShimPath(spec.shimDir, "claude");
  shimDir = spec.shimDir;
}, 120_000);

/** 画布节点终端的环境：门开着。 */
function canvasEnv(): NodeJS.ProcessEnv {
  return { ...outsideEnv(), ARMADRA_NODE_ID: NODE_ID };
}

/** 画布外：同一个环境去掉 `ARMADRA_NODE_ID`。 */
function outsideEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toUpperCase() !== "ARMADRA_NODE_ID") env[name] = value;
  }
  return env;
}

/** 敲进节点 shell 的那一行：启动器、程序、程序前置词、调用者的值。 */
function launchLine(
  dialect: ShellDialect,
  values: readonly string[] = VALUES,
): string {
  return shellCommandLine(
    launcher,
    [process.execPath, echo, ...values],
    dialect,
  );
}

/** `env` with `first` put in front of its `PATH`, however `PATH` was spelt. */
function withPath(env: NodeJS.ProcessEnv, first: string): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  let path = "";
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === "PATH") path = value ?? "";
    else copy[name] = value;
  }
  copy.PATH = `${first}${delimiter}${path}`;
  return copy;
}

function parse(stdout: string): Echo {
  return JSON.parse(stdout) as Echo;
}

function expectInjected(stdout: string, values: readonly string[] = VALUES) {
  const out = parse(stdout);
  expect(out.argv).toEqual([...values, ...INJECTED]);
  expect(out.plain).toBe(PLAIN);
}

/** `cmd.exe /d /s /c "<行>"`：去掉最外一层引号，其余照交互时敲进去的那样读。 */
function runCmd(line: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.env.COMSPEC ?? "cmd.exe",
    ["/d", "/s", "/c", `"${line}"`],
    { env, encoding: "utf8", windowsVerbatimArguments: true },
  );
}

function runPowerShell(program: string, line: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    program,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(line, "utf16le").toString("base64"),
    ],
    { env, encoding: "utf8" },
  );
}

function powershellMajor(program: string): number {
  if (!windows) return 0;
  const probe = spawnSync(
    program,
    ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
    { encoding: "utf8" },
  );
  return probe.status === 0 ? Number(probe.stdout.trim()) : 0;
}

/**
 * PowerShell 7.3 起把参数按 C 运行库的规则交给原生程序；Windows PowerShell 5.1
 * 的行在 `--%` 之后写（`shell.ts`），那里带不了 `%` 与 `|`——这只限制调用者
 * 的值，注入的词不经 shell，`%`、`|` 照样到达。
 */
const modern = powershellMajor("pwsh") >= 7;
const legacy = powershellMajor("powershell.exe") === 5;
const LEGACY_VALUES = VALUES.filter((value) => !/[%|]/.test(value));

describe.runIf(windows)(
  "the canvas launcher read by the real Windows shells",
  () => {
    it("cmd.exe", () => {
      const result = runCmd(launchLine("cmd"), canvasEnv());
      expect(result.status, result.stderr).toBe(0);
      expectInjected(result.stdout);
    });

    it.runIf(modern)("PowerShell 7", () => {
      const result = runPowerShell(
        "pwsh",
        launchLine("powershell"),
        canvasEnv(),
      );
      expect(result.status, result.stderr).toBe(0);
      expectInjected(result.stdout);
    });

    it.runIf(legacy)("Windows PowerShell 5.1", () => {
      const line = launchLine("windows-powershell", LEGACY_VALUES);
      expect(line).toContain(" --% ");
      const result = runPowerShell("powershell.exe", line, canvasEnv());
      expect(result.status, result.stderr).toBe(0);
      expectInjected(result.stdout, LEGACY_VALUES);
    });

    it("injects nothing without ARMADRA_NODE_ID: the same line outside a canvas", () => {
      const result = runCmd(launchLine("cmd"), outsideEnv());
      expect(result.status, result.stderr).toBe(0);
      const out = parse(result.stdout);
      expect(out.argv).toEqual(VALUES);
      expect(out.plain).toBeNull();
    });

    it("finds a bare program name on PATH", () => {
      const result = spawnSync(launcher, ["node", echo, "x y"], {
        env: withPath(canvasEnv(), dirname(process.execPath)),
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(parse(result.stdout).argv).toEqual(["x y", ...INJECTED]);
    });

    it("passes the program's exit code through", () => {
      const exit = join(root, "exit.js");
      writeFileSync(exit, "process.exit(7)", "utf8");
      const line = shellCommandLine(launcher, [process.execPath, exit], "cmd");
      expect(runCmd(line, canvasEnv()).status).toBe(7);
      expect(runCmd(line, outsideEnv()).status).toBe(7);
    });

    it("refuses a missing program and an unknown .launch", () => {
      const missing = spawnSync(launcher, [join(root, "missing.exe")], {
        env: canvasEnv(),
        encoding: "utf8",
      });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/program not found/);

      const broken = writeLauncher("pi", [], []);
      const brokenExe = windowsLauncherPath(broken.runDir, "pi");
      writeFileSync(
        brokenExe.replace(/\.exe$/, ".launch"),
        "something else\r\n",
      );
      const refused = spawnSync(brokenExe, [process.execPath, echo], {
        env: canvasEnv(),
        encoding: "utf8",
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toMatch(/armadra-launch 1/);
    });
  },
);

/**
 * 读不出的 `.cmd` 包装（`custom:` 条目指向手写的批处理）：`launchTargetOf`
 * 答不出它背后的程序，启动器只好经 `cmd.exe` 起它，`%*` 让参数被再读一遍。
 */
describe.runIf(windows)("a batch wrapper behind the launcher", () => {
  function wrapper(): string {
    const dir = join(root, "batch");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "mine.cmd");
    writeFileSync(
      file,
      `@echo off\r\nset "PROG=${process.execPath}"\r\n"%PROG%" "${echo}" %*\r\n`,
      "utf8",
    );
    expect(launchTargetOf(file)).toBeUndefined();
    return file;
  }

  const SAFE = ["plain", "a b", "it's", "$HOME", "`id`", "!x!", "C:\\dir\\"];

  it("skips injected words cmd.exe would read again, and says so", () => {
    const line = shellCommandLine(launcher, [wrapper(), ...SAFE], "cmd");
    const result = runCmd(line, canvasEnv());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/batch wrapper; canvas injection skipped/);
    const out = parse(result.stdout);
    expect(out.argv).toEqual(SAFE);
    expect(out.plain).toBeNull();
  });

  it("injects words that survive the second read", () => {
    const safe = ["--extension", "C:\\dir with space\\m.js", "it's"];
    const spec = writeLauncher("omp", safe, [["ARMADRA_PLAIN", PLAIN]]);
    const line = shellCommandLine(
      windowsLauncherPath(spec.runDir, "omp"),
      [wrapper(), ...SAFE],
      "cmd",
    );
    const result = runCmd(line, canvasEnv());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const out = parse(result.stdout);
    expect(out.argv).toEqual([...SAFE, ...safe]);
    expect(out.plain).toBe(PLAIN);
  });
});

/** 垫片：手敲 `claude` 命中 `shims\claude.exe`，它起 `.launch` 里的程序。 */
describe.runIf(windows)("the canvas shim", () => {
  it("starts its program, drops its own directory from PATH, injects", () => {
    const result = spawnSync(shim, VALUES, {
      env: withPath(canvasEnv(), `${shimDir}\\`),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const out = parse(result.stdout);
    expect(out.argv).toEqual([...VALUES, ...INJECTED]);
    expect(out.plain).toBe(PLAIN);
    const entries = out.path
      .split(delimiter)
      .map((entry) => entry.replace(/\\+$/, "").toLowerCase());
    expect(entries).not.toContain(shimDir.toLowerCase());
  });

  it("is found by name from cmd.exe and injects nothing outside a canvas", () => {
    const result = runCmd(
      'claude "a&b" "c d"',
      withPath(outsideEnv(), shimDir),
    );
    expect(result.status, result.stderr).toBe(0);
    const out = parse(result.stdout);
    expect(out.argv).toEqual(["a&b", "c d"]);
    expect(out.plain).toBeNull();
  });
});

/**
 * npm 装的 CLI 是 `.cmd` 包装：`launchTargetOf` 读出它背后的 `node <脚本>`，
 * 启动行与垫片都绕过包装，`.cmd` 挡不住的值也原样到达。
 */
describe.runIf(windows)("npm wrappers behind the launcher", () => {
  function npmShim(): { shim: string; script: string; dir: string } {
    const dir = join(root, "npm");
    const bin = join(dir, "node_modules", "fake-cli", "bin");
    mkdirSync(bin, { recursive: true });
    const script = join(bin, "echo.js");
    writeFileSync(script, ECHO, "utf8");
    const file = join(dir, "claude.cmd");
    writeFileSync(
      file,
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        "",
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        '  SET "_prog=node"',
        "  SET PATHEXT=%PATHEXT:;.JS;=;%",
        ")",
        "",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\bin\\echo.js" %*',
        "",
      ].join("\r\n"),
      "utf8",
    );
    return { shim: file, script, dir };
  }

  it("starts node past the wrapper, every value and injected word intact", () => {
    const { shim: wrapperFile, script } = npmShim();
    expect(resolveCommand(wrapperFile)).toBe(wrapperFile);
    const target = launchTargetOf(wrapperFile);
    expect(target?.args).toEqual([script]);
    expect(target?.program.toLowerCase()).toMatch(/node\.exe$/);
    const line = shellCommandLine(
      launcher,
      [target!.program, ...target!.args, ...VALUES],
      "cmd",
    );
    const result = runCmd(line, canvasEnv());
    expect(result.status, result.stderr).toBe(0);
    expectInjected(result.stdout);
  });

  it("gives the shim node and the script behind the wrapper (§5.4)", () => {
    const { dir, script } = npmShim();
    const ambient = withPath(
      { HOME: root, PATH: dirname(process.execPath) },
      dir,
    );
    const claude = shimTargetFor("claude", { ambient, shimDir });
    expect(claude?.args).toEqual([script]);
    expect(claude?.program.toLowerCase()).toMatch(/node\.exe$/);
    const spec = writeLauncher(
      "claude",
      INJECTED,
      [["ARMADRA_PLAIN", PLAIN]],
      claude,
    );
    try {
      const result = runCmd(
        'claude "a&b" "c d"',
        withPath(canvasEnv(), spec.shimDir),
      );
      expect(result.status, result.stderr).toBe(0);
      expect(parse(result.stdout).argv).toEqual(["a&b", "c d", ...INJECTED]);
    } finally {
      writeLauncher("claude", INJECTED, [["ARMADRA_PLAIN", PLAIN]], {
        program: process.execPath,
        args: [echo],
      });
    }
  });
});
