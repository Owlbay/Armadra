#!/usr/bin/env node
// Windows 真机验收（补全计划 G3-2，架构 §11）：在一台真的 Windows 上一键走完
// 「安装 → 起应用 → 终端与会话宿主 → 画布启动器三种 shell → 凭据 / Gateway / 更新
// 状态 → 文件监听 → 保活 → 重启存活 → ConPTY 关闭 → 卸载」，把每一项写进
// `result.json`。人跑一次、把这个文件贴回来，就是一次 C 档验收的记录。
//
// 用法（Node 22+，单文件、不依赖仓库里的包，可以只拷这一个文件过去）：
//
//   node windows-acceptance.mjs --installer Armadra-Setup-0.1.0-x64.exe
//   node windows-acceptance.mjs --app "C:\Users\me\AppData\Local\Programs\Armadra\Armadra.exe"
//   node windows-acceptance.mjs --dry-run            # 任何平台：只验脚本自己
//
// 选项：
//   --installer <exe>   NSIS 安装包：静默装进临时目录，跑完静默卸载并核对卸载干净
//   --app <exe>         已经装好的 Armadra.exe（或 win-unpacked）：不装、不卸
//   --out <dir>         产物目录，默认 target/windows-acceptance/<时间戳>
//   --soak-minutes <n>  保活时长，默认 30；CI 用 1–2
//   --with-codex        有 codex 且 %USERPROFILE%\.codex\auth.json 在时，经页面起一次
//                       Codex（只把 auth.json 复制进临时 HOME）
//   --require-signed    安装包与 Armadra.exe 的 Authenticode 不是 Valid 就算失败
//   --keep              失败时不清理临时目录（排查用）
//   --dry-run           不装包、不起应用：解析参数、探测本机、自检快照与启动行，
//                       写出全部检查项都是 skip 的 result.json
//
// 不碰操作员的东西：数据目录（ARMADRA_DATA_DIR）、HOME / USERPROFILE、Chromium
// profile（--user-data-dir）全在临时目录；开始前与卸载后各给操作员真实的用户配置
// （各 CLI 的配置目录、%APPDATA%\Armadra）拍一次快照，两次必须逐字节相同。机器上已经
// 登记了一份 Armadra 安装时，--installer 模式拒绝运行（同一个 appId 的安装包会先卸
// 掉那一份），改用 --app 对着它跑。
//
// result.json 的形状见 docs/guides/development.md「Windows 真机验收」；检查项的 id
// 与含义在下面的 CHECKS 里，是稳定的。
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const SCHEMA = "armadra-windows-acceptance/1";

/**
 * 每一项检查：id 稳定（贴回来的结果按它对照），title 是给人看的一句话。
 * 顺序就是执行顺序。
 */
export const CHECKS = [
  ["preflight.platform", "在 Windows 上运行，Node 22+"],
  ["preflight.existing", "--installer 模式下机器上没有已登记的 Armadra 安装"],
  ["install.silent", "NSIS 安装包 /S 静默装进临时目录"],
  [
    "install.layout",
    "包里有 armadra-hook.exe / armadra-launch.exe / 会话宿主 / ConPTY 原生模块",
  ],
  [
    "install.signature",
    "安装包、Armadra.exe、armadra-launch.exe 的 Authenticode 状态",
  ],
  ["app.start", "临时数据目录与临时 HOME 起应用，页面与 core 应答"],
  ["app.updater", "更新器状态（签名、是否本地构建）读得出"],
  ["terminal.backend", "终端后端是 sessionHost"],
  [
    "terminal.shells",
    "cmd / pwsh 7 / Windows PowerShell 5.1 各起一个终端，输入有回显，capture 读得到",
  ],
  ["sessionHost.process", "会话宿主进程在，命名管道 armadra-session-* 在"],
  [
    "launcher.dialects",
    "armadra-launch.exe 在三种 shell 里：参数原样、注入在后、门关时不注入",
  ],
  ["launcher.credential", "armadra-launch.exe 兑换节点凭据：变量只进 CLI 进程"],
  ["credentials.status", "GET /api/credentials：DPAPI 后端且可用"],
  ["gateway.loopback", "Gateway 开在回环上能握 TLS，关掉后停止监听"],
  ["files.watch", "文件监听：外部改文件后收到 file.changed"],
  ["agent.codex", "经页面起 Codex，画面出现 Codex 的界面（--with-codex）"],
  ["soak", "保活：终端持续输出，进程都在，资源采样"],
  [
    "restart.survives",
    "应用主进程被杀后会话宿主与 shell 都在，重启后接回同一会话",
  ],
  ["conpty.close", "终止会话后 shell 进程与它的控制台宿主都退出"],
  ["app.logs", "数据目录日志里的 error / fatal 行"],
  ["uninstall.silent", "卸载程序 /S 后安装目录、注册表卸载项与快捷方式都不在"],
  ["userConfig.untouched", "操作员真实用户配置在开始前与结束后逐字节相同"],
].map(([id, title]) => ({ id, title }));

const CHECK_IDS = new Set(CHECKS.map((check) => check.id));

/* --------------------------------- options -------------------------------- */

export function parseArgs(argv) {
  const options = {
    installer: undefined,
    app: undefined,
    out: undefined,
    soakMinutes: 30,
    withCodex: false,
    requireSigned: false,
    keep: false,
    dryRun: false,
  };
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--"))
      throw new Error(`${flag} 需要一个值`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--installer":
        options.installer = resolve(value(index, arg));
        index += 1;
        break;
      case "--app":
        options.app = resolve(value(index, arg));
        index += 1;
        break;
      case "--out":
        options.out = resolve(value(index, arg));
        index += 1;
        break;
      case "--soak-minutes": {
        const minutes = Number(value(index, arg));
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60)
          throw new Error("--soak-minutes 是 0 到 1440 之间的数");
        options.soakMinutes = minutes;
        index += 1;
        break;
      }
      case "--with-codex":
        options.withCodex = true;
        break;
      case "--require-signed":
        options.requireSigned = true;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`不认识的参数：${arg}`);
    }
  }
  if (!options.dryRun && !options.help) {
    if ((options.installer === undefined) === (options.app === undefined))
      throw new Error(
        "--installer 与 --app 必须给且只给一个（或用 --dry-run）",
      );
  }
  return options;
}

/* --------------------------------- result --------------------------------- */

export function newResult(options) {
  return {
    schema: SCHEMA,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationSeconds: null,
    options: {
      mode: options.dryRun ? "dryRun" : options.installer ? "installer" : "app",
      installer: options.installer ? basename(options.installer) : null,
      app: options.app ?? null,
      soakMinutes: options.soakMinutes,
      withCodex: options.withCodex,
      requireSigned: options.requireSigned,
    },
    machine: null,
    app: null,
    checks: CHECKS.map(({ id, title }) => ({
      id,
      title,
      status: "pending",
      detail: null,
      seconds: null,
    })),
    samples: [],
    selfTest: [],
    failures: [],
  };
}

/**
 * 整体结论：有 fail 就是 failed；干跑是 dryRun（自检失败也算 failed）；还有
 * pending 的项（中途退出）是 incomplete；否则 passed（skip 与 warn 不拉低）。
 */
export function summarize(result) {
  const failed = result.checks.filter((check) => check.status === "fail");
  const selfFailed = result.selfTest.filter((test) => !test.ok);
  result.failures = [
    ...failed.map((check) => check.id),
    ...selfFailed.map((test) => `selfTest.${test.name}`),
  ];
  if (result.failures.length > 0) return "failed";
  if (result.options.mode === "dryRun") return "dryRun";
  if (result.checks.some((check) => check.status === "pending"))
    return "incomplete";
  return "passed";
}

/** 结果文件的形状自检：贴回来的文件先过这一关。答问题列表，空 = 合格。 */
export function validateResult(result) {
  const problems = [];
  if (result?.schema !== SCHEMA) problems.push(`schema 不是 ${SCHEMA}`);
  if (!["passed", "failed", "incomplete", "dryRun"].includes(result?.status))
    problems.push(`status 不认识：${result?.status}`);
  const ids = (result?.checks ?? []).map((check) => check.id);
  for (const id of CHECK_IDS)
    if (!ids.includes(id)) problems.push(`缺检查项 ${id}`);
  for (const check of result?.checks ?? []) {
    if (!CHECK_IDS.has(check.id)) problems.push(`多出的检查项 ${check.id}`);
    if (!["pass", "fail", "warn", "skip", "pending"].includes(check.status))
      problems.push(`${check.id} 的 status 不认识：${check.status}`);
  }
  if (!Array.isArray(result?.samples)) problems.push("samples 不是数组");
  return problems;
}

class Recorder {
  constructor(result, log = console.log) {
    this.result = result;
    this.log = log;
  }

  entry(id) {
    const entry = this.result.checks.find((check) => check.id === id);
    if (entry === undefined) throw new Error(`没有登记的检查项 ${id}`);
    return entry;
  }

  set(id, status, detail, seconds = null) {
    const entry = this.entry(id);
    entry.status = status;
    entry.detail = detail ?? null;
    entry.seconds = seconds;
    const mark = { pass: "ok  ", fail: "FAIL", warn: "warn", skip: "skip" }[
      status
    ];
    this.log(
      `  ${mark} ${id}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`,
    );
  }

  skip(id, reason) {
    this.set(id, "skip", { reason });
  }

  /**
   * 跑一项：`run` 答 `{ ok, detail, warn? }`；抛错记 fail。答 `ok`，让调用方决定
   * 后面依赖它的项还跑不跑。
   */
  async check(id, run) {
    const started = Date.now();
    try {
      const outcome = await run();
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const status = outcome.ok ? (outcome.warn ? "warn" : "pass") : "fail";
      this.set(id, status, outcome.detail, seconds);
      return outcome.ok;
    } catch (error) {
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      this.set(
        id,
        "fail",
        { error: error instanceof Error ? error.message : String(error) },
        seconds,
      );
      return false;
    }
  }

  skipRest(reason) {
    for (const check of this.result.checks)
      if (check.status === "pending") this.skip(check.id, reason);
  }
}

/* ------------------------------ user config -------------------------------- */

/**
 * 操作员真实用户配置里，Armadra 或它的安装 / 卸载程序可能写到的地方。
 * 只读：拍快照前后比较，从不打开写。
 */
export function userConfigTargets({ home, appData, localAppData }) {
  const targets = [
    join(home, ".claude", "settings.json"),
    join(home, ".claude", "settings.local.json"),
    join(home, ".claude.json"),
    join(home, ".claude", "skills", "armadra"),
    join(home, ".codex", "config.toml"),
    join(home, ".codex", "hooks.json"),
    join(home, ".codex", "skills", "armadra"),
    join(home, ".copilot", "hooks"),
    join(home, ".copilot", "config.json"),
    join(home, ".config", "opencode"),
    join(home, ".pi"),
    join(home, ".omp"),
    join(home, ".gitconfig"),
  ];
  if (appData) {
    targets.push(join(appData, "Armadra"));
    targets.push(join(appData, "npm", "armadra-hook.cmd"));
  }
  if (localAppData) targets.push(join(localAppData, "armadra-updater"));
  return targets;
}

const MAX_HASHED_FILES = 2_000;

function hashFile(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    return `unreadable:${error.code ?? "error"}`;
  }
}

function describePath(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { exists: false };
  }
  if (stat.isFile())
    return { exists: true, kind: "file", sha256: hashFile(path) };
  if (!stat.isDirectory()) return { exists: true, kind: "other" };
  const entries = [];
  const walk = (directory, prefix) => {
    let names;
    try {
      names = readdirSync(directory, { withFileTypes: true });
    } catch {
      entries.push(`${prefix}<unreadable>`);
      return;
    }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= MAX_HASHED_FILES) return;
      const full = join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        entries.push(`${name}/`);
        walk(full, `${name}/`);
      } else if (entry.isFile()) {
        entries.push(`${name}:${hashFile(full)}`);
      } else {
        entries.push(`${name}@`);
      }
    }
  };
  walk(path, "");
  return {
    exists: true,
    kind: "directory",
    entries: entries.length,
    sha256: createHash("sha256").update(entries.join("\n")).digest("hex"),
  };
}

/** `{ 路径: 描述 }`：文件是内容的 SHA-256，目录是逐个条目名与内容的摘要。 */
export function snapshot(paths) {
  return Object.fromEntries(paths.map((path) => [path, describePath(path)]));
}

/** 两次快照不同的路径。 */
export function diffSnapshots(before, after) {
  const changed = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[path]) !== JSON.stringify(after[path]))
      changed.push({
        path,
        before: before[path] ?? null,
        after: after[path] ?? null,
      });
  }
  return changed;
}

/* ------------------------------- launch lines ------------------------------ */

/** 调用者给的值：空格、`&`、`|` 都要原样到达。没有 `"` 与 `%`（cmd 交互读不了）。 */
export const CALLER_VALUES = ["a b", "c&d", "x|y", "plain"];
/** 注入的词与变量：写在 `.launch` 里，不经任何 shell。 */
export const INJECTED_ARGS = ["--injected", 'say "hi" & 100% ^ | <x>'];
export const INJECTED_ENV = ["ARMADRA_PROBE_ENV", "a b & c | d <e> 100% ^f"];

/**
 * 节点 shell 里敲的那一行：启动器、程序、程序的参数。`cmd` 用双引号；两种
 * PowerShell 用 `&` 加单引号（单引号里只有 `'` 要写成两个）。值里不许有 `"`、`%`
 * ——那是 cmd 交互读不了的，脚本自己的值没有。
 */
export function launchLine(dialect, launcher, words) {
  for (const word of [launcher, ...words]) {
    if (/["%\r\n]/.test(word))
      throw new Error(`启动行的值不能含 " % 或换行：${word}`);
  }
  if (dialect === "cmd")
    return [launcher, ...words].map((word) => `"${word}"`).join(" ");
  if (dialect === "pwsh" || dialect === "powershell")
    return `& ${[launcher, ...words].map((word) => `'${word.replaceAll("'", "''")}'`).join(" ")}`;
  throw new Error(`不认识的 shell：${dialect}`);
}

/** 设一个环境变量的那一行。 */
export function setEnvLine(dialect, name, value) {
  if (dialect === "cmd")
    return value === "" ? `set ${name}=` : `set ${name}=${value}`;
  return value === ""
    ? `Remove-Item Env:${name} -ErrorAction SilentlyContinue`
    : `$env:${name}='${value.replaceAll("'", "''")}'`;
}

/**
 * 打印一个记号的那一行：源码里没有连续的记号文本，所以 shell 回显输入时不会
 * 误判——只有命令真的执行了，输出里才出现完整的记号。
 */
export function markerLine(dialect, marker) {
  const [head, tail] = [marker.slice(0, -2), marker.slice(-2)];
  if (dialect === "cmd") return `echo ${head}^${tail[0]}^${tail[1]}`;
  return `Write-Output ('${head}' + '${tail}')`;
}

/** 一直打印的循环（保活）；Ctrl+C 停。 */
export function loopLine(dialect) {
  if (dialect === "cmd")
    return "for /L %i in (1,0,2) do @(echo tick-^O^K & ping -n 2 127.0.0.1 >nul)";
  return "while ($true) { 'tick-' + 'OK'; Start-Sleep -Seconds 1 }";
}

const ECHO_SCRIPT = [
  "const fs = require('node:fs');",
  "const [out, ...argv] = process.argv.slice(2);",
  "const pick = (name) => process.env[name] ?? null;",
  `fs.writeFileSync(out, JSON.stringify({ argv, env: pick(${JSON.stringify(INJECTED_ENV[0])}), token: pick('ARMADRA_PROBE_TOKEN') }));`,
].join("\n");

const FAKE_CLIENT_SCRIPT = [
  "if (process.argv[2] !== 'credential') process.exit(9);",
  "process.stdout.write('ARMADRA_PROBE_TOKEN=probe-' + 'token & 100%');",
].join("\n");

const PROBE_TOKEN = "probe-token & 100%";

/** 探针自己的启动器：安装包里的 armadra-launch.exe 拷一份，旁边一份 `.launch`。 */
export function probeLaunchConfig({ client }) {
  return [
    "armadra-launch 1",
    "# windows-acceptance probe",
    "gate=ARMADRA_NODE_ID",
    `env=${INJECTED_ENV[0]}=${INJECTED_ENV[1]}`,
    ...INJECTED_ARGS.map((word) => `arg=${word}`),
    `credential=${client}`,
    "credential-var=ARMADRA_PROBE_TOKEN",
    "",
  ].join("\r\n");
}

/* ------------------------------ machine probes ----------------------------- */

const isWindows = process.platform === "win32";

/** Windows PowerShell 5.1：从 pwsh 7 里起它要去掉 PSModulePath（G3-3 的结论）。 */
function powershell(command, { timeout = 60_000 } = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.toUpperCase() === "PSMODULEPATH") delete env[name];
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(
        `$ProgressPreference='SilentlyContinue'; ${command}`,
        "utf16le",
      ).toString("base64"),
    ],
    { env, encoding: "utf8", timeout, windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `powershell 失败（${result.status}）：${result.stderr.trim().slice(0, 500)}`,
    );
  return result.stdout.trim();
}

function powershellJson(command, options) {
  const text = powershell(
    `${command} | ConvertTo-Json -Depth 4 -Compress`,
    options,
  );
  if (text === "") return [];
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

function where(program) {
  if (!isWindows) {
    const found = spawnSync("which", [program], { encoding: "utf8" });
    return found.status === 0 ? found.stdout.trim().split("\n")[0] : null;
  }
  const found = spawnSync("where.exe", [program], {
    encoding: "utf8",
    windowsHide: true,
  });
  return found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : null;
}

function powershellVersion(program) {
  if (program === null) return null;
  const probe = spawnSync(
    program,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name.toUpperCase() !== "PSMODULEPATH",
        ),
      ),
    },
  );
  return probe.status === 0 ? probe.stdout.trim() : null;
}

function findCsc() {
  if (!isWindows) return null;
  const windir = process.env.WINDIR ?? "C:\\Windows";
  for (const framework of ["Framework64", "Framework"]) {
    const candidate = join(
      windir,
      "Microsoft.NET",
      framework,
      "v4.0.30319",
      "csc.exe",
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function machineInfo() {
  const pwsh = where("pwsh");
  const legacy = isWindows ? where("powershell") : null;
  return {
    platform: process.platform,
    release: os.release(),
    version: typeof os.version === "function" ? os.version() : null,
    arch: process.arch,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? null,
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    shells: {
      cmd: isWindows ? (process.env.ComSpec ?? where("cmd")) : null,
      pwsh,
      pwshVersion: powershellVersion(pwsh),
      powershell: legacy,
      powershellVersion: powershellVersion(legacy),
    },
    csc: findCsc(),
    clis: Object.fromEntries(
      ["claude", "codex", "copilot", "opencode", "pi", "omp", "ama", "git"].map(
        (name) => [name, where(name)],
      ),
    ),
  };
}

/** 注册表里登记的 Armadra 安装（HKCU 与 HKLM 的卸载项）。 */
function registeredInstalls() {
  return powershellJson(
    "$paths = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; " +
      "Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Armadra*' } | Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString,PSPath",
  );
}

function authenticode(path) {
  const [row] = powershellJson(
    `Get-AuthenticodeSignature -LiteralPath '${path.replaceAll("'", "''")}' | Select-Object @{n='status';e={$_.Status.ToString()}},@{n='subject';e={$_.SignerCertificate.Subject}},@{n='message';e={$_.StatusMessage}}`,
  );
  return row ?? { status: "Unknown" };
}

/** Armadra.exe 的每个进程：pid、父 pid、命令行、工作集（MB）、句柄数。 */
function appProcesses(exe) {
  const escaped = exe.replaceAll("\\", "\\\\").replaceAll("'", "''");
  return powershellJson(
    `Get-CimInstance Win32_Process -Filter "ExecutablePath='${escaped}'" | Select-Object ProcessId,ParentProcessId,CommandLine,WorkingSetSize,HandleCount`,
  ).map((row) => ({
    pid: row.ProcessId,
    parent: row.ParentProcessId,
    commandLine: row.CommandLine ?? "",
    rssMb: Math.round((Number(row.WorkingSetSize) / 1024 ** 2) * 10) / 10,
    handles: row.HandleCount,
  }));
}

function processesById(pids) {
  if (pids.length === 0) return [];
  return powershellJson(
    `Get-CimInstance Win32_Process -Filter "${pids.map((pid) => `ProcessId=${Number(pid)}`).join(" OR ")}" | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,HandleCount`,
  ).map((row) => ({
    pid: row.ProcessId,
    parent: row.ParentProcessId,
    name: row.Name,
    rssMb: Math.round((Number(row.WorkingSetSize) / 1024 ** 2) * 10) / 10,
    handles: row.HandleCount,
  }));
}

function childrenOf(pid) {
  return powershellJson(
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | Select-Object ProcessId,Name`,
  ).map((row) => ({ pid: row.ProcessId, name: row.Name }));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sessionPipes() {
  try {
    return readdirSync("\\\\.\\pipe\\").filter((name) =>
      name.startsWith("armadra-session-"),
    );
  } catch {
    return [];
  }
}

async function freePort() {
  return await new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function waitFor(what, test, { timeout = 60_000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await test();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时（${Math.round(timeout / 1000)}s）：${what}`);
}

/* ----------------------------------- CDP ----------------------------------- */

async function attachToRenderer(port) {
  let seen = [];
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      seen = targets.map((target) => `${target.type} ${target.url}`);
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          target.webSocketDebuggerUrl &&
          /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(target.url ?? ""),
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // 应用还在起。
    }
    await sleep(500);
  }
  throw new Error(
    `调试端口 ${port} 上没有回环页面；看到 ${JSON.stringify(seen)}`,
  );
}

async function cdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let next = 1;
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", () => fail(new Error("CDP 连不上")), {
      once: true,
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error) waiter.fail(new Error(JSON.stringify(message.error)));
    else waiter.done(message.result);
  });
  const send = (method, params) =>
    new Promise((done, fail) => {
      const id = next;
      next += 1;
      pending.set(id, { done, fail });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          `页面里抛错：${JSON.stringify(result.exceptionDetails).slice(0, 500)}`,
        );
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

/**
 * 装进页面的小工具：经页面自己的地址与身份调 core（core 判的就是这个来源），
 * 终端经 WebSocket 附着、输入、等输出。
 */
const PAGE_HELPERS = `(() => {
  const bridge = globalThis.window?.armadra;
  if (!bridge?.transport) throw new Error("window.armadra 上没有壳的桥");
  const { httpBase, wsBase } = bridge.transport.endpointsSync();
  async function api(method, path, body) {
    const response = await fetch(httpBase + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text === "" ? null : JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
    return { status: response.status, body: json };
  }
  function terminal(sessionId, writer, lines, waitFor, timeoutMs) {
    return new Promise((done) => {
      const socket = new WebSocket(wsBase + "/api/terminals/" + sessionId + "/ws?writer=" + writer);
      let output = "";
      let hello = null;
      let inputId = 0;
      const finish = (ok, reason) => {
        clearTimeout(timer);
        try { socket.close(); } catch {}
        done({ ok, reason, hello, tail: output.slice(-2000) });
      };
      const timer = setTimeout(() => finish(waitFor === null, "timeout"), timeoutMs);
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === "hello") {
          hello = frame;
          for (const line of lines) {
            inputId += 1;
            socket.send(JSON.stringify({ type: "input", data: line, inputId }));
          }
          if (waitFor === null) setTimeout(() => finish(true, "sent"), 500);
          return;
        }
        if (frame.type === "output" || frame.type === "snapshot") {
          output += frame.data;
          if (waitFor !== null && output.includes(waitFor)) finish(true, "matched");
        }
      };
      socket.onerror = () => finish(false, "socket error");
    });
  }
  async function events(workspaceId, type, trigger, timeoutMs) {
    return await new Promise((done) => {
      const socket = new WebSocket(wsBase + "/api/workspaces/" + workspaceId + "/events");
      const timer = setTimeout(() => { try { socket.close(); } catch {} done({ ok: false, reason: "timeout" }); }, timeoutMs);
      socket.onopen = () => { setTimeout(() => trigger(), 300); };
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === type) { clearTimeout(timer); socket.close(); done({ ok: true, event: frame }); }
      };
      socket.onerror = () => { clearTimeout(timer); done({ ok: false, reason: "socket error" }); };
    });
  }
  globalThis.__acceptance = { httpBase, wsBase, api, terminal, events };
  return { httpBase, wsBase };
})()`;

class App {
  constructor({ exe, dataDir, home, userDataDir, log }) {
    Object.assign(this, { exe, dataDir, home, userDataDir, log });
    this.child = undefined;
    this.page = undefined;
    this.output = "";
  }

  async start() {
    const port = await freePort();
    this.child = spawn(
      this.exe,
      [
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${this.userDataDir}`,
      ],
      {
        env: {
          ...process.env,
          ARMADRA_DATA_DIR: this.dataDir,
          USERPROFILE: this.home,
          HOME: this.home,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      },
    );
    this.child.stdout.on("data", (chunk) => (this.output += chunk));
    this.child.stderr.on("data", (chunk) => (this.output += chunk));
    this.exited = new Promise((done) => this.child.once("exit", done));
    const url = await attachToRenderer(port);
    this.page = await cdp(url);
    const endpoints = await waitFor(
      "页面上的桥",
      async () => {
        try {
          return await this.page.evaluate(PAGE_HELPERS);
        } catch {
          return undefined;
        }
      },
      { timeout: 60_000, interval: 1_000 },
    );
    return endpoints;
  }

  get pid() {
    return this.child?.pid;
  }

  async api(method, path, body) {
    return await this.page.evaluate(
      `globalThis.__acceptance.api(${JSON.stringify(method)}, ${JSON.stringify(path)}, ${JSON.stringify(body)})`,
    );
  }

  async terminal(sessionId, lines, waitFor, timeoutMs = 30_000) {
    return await this.page.evaluate(
      `globalThis.__acceptance.terminal(${JSON.stringify(sessionId)}, "acceptance", ${JSON.stringify(lines)}, ${JSON.stringify(waitFor)}, ${timeoutMs})`,
    );
  }

  async evaluate(expression) {
    return await this.page.evaluate(expression);
  }

  /** 只杀主进程（模拟崩溃）：渲染、GPU 与 core 随它退出，分离起的会话宿主不该。 */
  async kill() {
    this.page?.close();
    this.page = undefined;
    if (this.child && this.child.exitCode === null) {
      try {
        process.kill(this.child.pid);
      } catch {
        // 已经退了。
      }
      await Promise.race([this.exited, sleep(15_000)]);
    }
  }
}

/* ---------------------------------- phases --------------------------------- */

function newestUninstaller(installDir) {
  try {
    return readdirSync(installDir)
      .filter((name) => /^Uninstall .*\.exe$/i.test(name))
      .map((name) => join(installDir, name))[0];
  } catch {
    return undefined;
  }
}

function findFile(root, name, depth = 6) {
  if (depth < 0) return undefined;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries)
    if (entry.isFile() && entry.name.toLowerCase() === name)
      return join(root, entry.name);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFile(join(root, entry.name), name, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function logFindings(dataDir) {
  const files = [];
  const walk = (directory, depth) => {
    if (depth < 0) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full, depth - 1);
      else if (entry.isFile() && /\.(log|jsonl)$/i.test(entry.name))
        files.push(full);
    }
  };
  walk(dataDir, 3);
  const findings = [];
  let bytes = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    bytes += Buffer.byteLength(text);
    for (const line of text.split(/\r?\n/))
      if (/\b(error|fatal|uncaught|unhandled)\b/i.test(line))
        findings.push(`${basename(file)}: ${line.slice(0, 300)}`);
  }
  return { files: files.map((file) => basename(file)), bytes, findings };
}

function httpsProbe(origin) {
  return new Promise((done) => {
    const url = new URL("/api/identity/hello", origin);
    const req = httpsRequest(
      url,
      { rejectUnauthorized: false, timeout: 10_000 },
      (response) => {
        const certificate = response.socket.getPeerCertificate?.();
        response.resume();
        done({
          ok: true,
          status: response.statusCode,
          subject: certificate?.subject?.CN ?? null,
        });
      },
    );
    req.on("error", (error) => done({ ok: false, error: error.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function runFull(options, result, record, out) {
  const work = mkdtempSync(join(os.tmpdir(), "armadra-acceptance-"));
  const cleanup = [];
  let app;
  const realHome = os.homedir();
  const targets = userConfigTargets({
    home: realHome,
    appData: process.env.APPDATA,
    localAppData: process.env.LOCALAPPDATA,
  });
  const before = snapshot(targets);
  const say = (message) => console.log(`\n== ${message}`);
  let installDir;
  let exe = options.app;

  try {
    say("预检");
    const preflightOk = await record.check("preflight.platform", async () => ({
      ok: isWindows && Number(process.versions.node.split(".")[0]) >= 22,
      detail: { platform: process.platform, node: process.version },
    }));
    if (!preflightOk) {
      record.skipRest("不是 Windows 或 Node 太旧");
      return;
    }
    result.machine = machineInfo();
    const existing = registeredInstalls();
    if (options.installer) {
      const ok = await record.check("preflight.existing", async () => ({
        ok: existing.length === 0,
        detail: {
          registered: existing.map((row) => ({
            name: row.DisplayName,
            version: row.DisplayVersion,
            location: row.InstallLocation,
          })),
        },
      }));
      if (!ok) {
        record.skipRest(
          "机器上已有 Armadra 安装；先卸载它，或用 --app 对着它跑",
        );
        return;
      }
    } else {
      record.set("preflight.existing", "skip", {
        reason: "--app 模式",
        registered: existing.map((row) => ({
          name: row.DisplayName,
          version: row.DisplayVersion,
        })),
      });
    }

    say("安装");
    if (options.installer) {
      installDir = join(work, "install");
      const ok = await record.check("install.silent", async () => {
        // NSIS：/D= 必须是最后一个参数、不加引号。
        const status = await new Promise((done) => {
          const child = spawn(options.installer, ["/S", `/D=${installDir}`], {
            windowsVerbatimArguments: true,
            stdio: "ignore",
          });
          child.on("exit", (code) => done(code));
          child.on("error", (error) => done(error.message));
        });
        exe = join(installDir, "Armadra.exe");
        await waitFor("Armadra.exe 出现", () => existsSync(exe), {
          timeout: 180_000,
        });
        return {
          ok: status === 0 && existsSync(exe),
          detail: { exitCode: status, installDir },
        };
      });
      if (!ok) {
        record.skipRest("没装上");
        return;
      }
    } else {
      record.skip("install.silent", "--app 模式");
      installDir = dirname(exe);
    }

    const resources = join(installDir, "resources");
    const launchExe = join(resources, "cli", "armadra-launch.exe");
    await record.check("install.layout", async () => {
      const files = {
        hookExe: join(resources, "cli", "armadra-hook.exe"),
        hookBundle: join(resources, "cli", "armadra-hook.js"),
        launchExe,
        sessionHost: join(resources, "session-host", "host.cjs"),
      };
      const present = Object.fromEntries(
        Object.entries(files).map(([name, path]) => [name, existsSync(path)]),
      );
      const conpty =
        findFile(join(resources, "app.asar.unpacked"), "conpty.node") ?? null;
      present.conpty = conpty !== null;
      return {
        ok: Object.values(present).every(Boolean),
        detail: { present, conpty },
      };
    });

    await record.check("install.signature", async () => {
      const signatures = {
        installer: options.installer ? authenticode(options.installer) : null,
        app: authenticode(exe),
        launcher: existsSync(launchExe) ? authenticode(launchExe) : null,
      };
      const statuses = Object.values(signatures)
        .filter(Boolean)
        .map((row) => row.status);
      const broken = statuses.some(
        (status) => !["Valid", "NotSigned"].includes(status),
      );
      const unsigned = statuses.some((status) => status !== "Valid");
      return {
        ok: !broken && !(options.requireSigned && unsigned),
        warn: unsigned,
        detail: signatures,
      };
    });
    result.app = {
      exe,
      version: (() => {
        try {
          return powershell(
            `(Get-Item -LiteralPath '${exe.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
          );
        } catch {
          return null;
        }
      })(),
    };

    say("起应用");
    const dataDir = join(work, "data");
    const home = join(work, "home");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    if (options.withCodex) {
      const auth = join(realHome, ".codex", "auth.json");
      if (existsSync(auth)) {
        mkdirSync(join(home, ".codex"), { recursive: true });
        copyFileSync(auth, join(home, ".codex", "auth.json"));
      }
    }
    app = new App({
      exe,
      dataDir,
      home,
      userDataDir: join(work, "electron"),
    });
    cleanup.push(() => app?.kill());
    const started = await record.check("app.start", async () => {
      const endpoints = await app.start();
      const health = await app.api("GET", "/api/health");
      return {
        ok: health.status === 200,
        detail: { endpoints, health: health.body, mainPid: app.pid },
      };
    });
    if (!started) {
      record.skipRest("应用没起来");
      result.appOutput = app.output.slice(-4000);
      return;
    }

    await record.check("app.updater", async () => {
      const state = await app.evaluate(
        "(async () => { const updates = globalThis.window?.armadra?.updates; return updates ? await updates.state() : null; })()",
      );
      return { ok: state !== null, detail: state };
    });

    const backend = await app.api("GET", "/api/terminals/backend");
    await record.check("terminal.backend", async () => ({
      ok: backend.body?.effective === "sessionHost",
      detail: backend.body,
    }));

    say("工作空间与终端");
    const wsDir = join(work, "workspace");
    mkdirSync(wsDir, { recursive: true });
    const created = await app.api("POST", "/api/workspaces", {
      name: "acceptance",
      rootPath: wsDir,
    });
    const workspaceId = created.body?.id;
    if (typeof workspaceId !== "string") {
      record.skipRest(
        `建不了工作空间：${JSON.stringify(created).slice(0, 300)}`,
      );
      return;
    }
    const shells = [
      ["cmd", result.machine.shells.cmd],
      ["pwsh", result.machine.shells.pwsh],
      ["powershell", result.machine.shells.powershell],
    ].filter(([, path]) => path);
    const sessions = [];
    await record.check("terminal.shells", async () => {
      const detail = {};
      for (const [dialect, shell] of shells) {
        const response = await app.api("POST", "/api/terminals", {
          workspaceId,
          cwd: wsDir,
          shell,
        });
        const session = response.body;
        if (response.status >= 300 || typeof session?.id !== "string") {
          detail[dialect] = { ok: false, response };
          continue;
        }
        const marker = `ACC-${dialect}-${randomBytes(3).toString("hex")}-OK`;
        const typed = await app.terminal(
          session.id,
          [`${markerLine(dialect, marker)}\r`],
          marker,
          45_000,
        );
        const capture = await app.api(
          "GET",
          `/api/terminals/${session.id}/capture?lines=200`,
        );
        const captured =
          typeof capture.body?.data === "string" &&
          capture.body.data.includes(marker);
        sessions.push({
          dialect,
          id: session.id,
          pid: session.pid,
          backend: session.backend,
        });
        detail[dialect] = {
          ok: typed.ok && captured && session.backend === "sessionHost",
          pid: session.pid,
          backend: session.backend,
          echoed: typed.ok,
          captured,
          tail: typed.ok && captured ? undefined : typed.tail,
        };
      }
      return {
        ok:
          shells.length > 0 &&
          Object.values(detail).every((entry) => entry.ok) &&
          sessions.length === shells.length,
        warn: !result.machine.shells.pwsh,
        detail,
      };
    });

    let hostPid;
    await record.check("sessionHost.process", async () => {
      const processes = appProcesses(exe);
      const host = processes.find(
        (row) =>
          /session-host[\\/]host\.cjs/i.test(row.commandLine) &&
          row.commandLine.includes(dataDir),
      );
      hostPid = host?.pid;
      const pipes = sessionPipes();
      return {
        ok: host !== undefined && pipes.length > 0,
        detail: {
          hostPid: host?.pid ?? null,
          hostParent: host?.parent ?? null,
          pipes,
          processes: processes.length,
        },
      };
    });

    say("画布启动器");
    const probeDir = join(work, "launcher");
    mkdirSync(join(probeDir, "run"), { recursive: true });
    const echo = join(probeDir, "echo.js");
    writeFileSync(echo, ECHO_SCRIPT);
    const fakeClient = join(probeDir, "fake-client.js");
    writeFileSync(fakeClient, FAKE_CLIENT_SCRIPT);
    const clientCmd = join(probeDir, "armadra-hook.cmd");
    writeFileSync(clientCmd, `@"${process.execPath}" "${fakeClient}" %*\r\n`);
    const probeLauncher = join(probeDir, "run", "probe.exe");
    const launcherReady = existsSync(launchExe);
    if (launcherReady) {
      copyFileSync(launchExe, probeLauncher);
      writeFileSync(
        join(probeDir, "run", "probe.launch"),
        probeLaunchConfig({ client: clientCmd }),
      );
    }
    const launcherRuns = {};
    if (!launcherReady) {
      record.skip("launcher.dialects", "包里没有 armadra-launch.exe");
      record.skip("launcher.credential", "包里没有 armadra-launch.exe");
    } else {
      for (const session of sessions) {
        const { dialect } = session;
        const runOnce = async (label, gate) => {
          const outFile = join(probeDir, `${dialect}-${label}.json`);
          const lines = [
            setEnvLine(dialect, "ARMADRA_NODE_ID", gate ? "acceptance" : ""),
            setEnvLine(
              dialect,
              "ARMADRA_CREDENTIAL_REF",
              gate ? "0123456789abcdef" : "",
            ),
            launchLine(dialect, probeLauncher, [
              process.execPath,
              echo,
              outFile,
              ...CALLER_VALUES,
            ]),
          ].map((line) => `${line}\r`);
          await app.terminal(session.id, lines, null, 5_000);
          try {
            await waitFor(
              `${dialect} 的启动器写出结果`,
              () => existsSync(outFile),
              {
                timeout: 30_000,
              },
            );
            return JSON.parse(readFileSync(outFile, "utf8"));
          } catch (error) {
            return { error: error.message };
          }
        };
        launcherRuns[dialect] = { canvas: await runOnce("canvas", true) };
        if (dialect === "cmd")
          launcherRuns[dialect].outside = await runOnce("outside", false);
      }
      await record.check("launcher.dialects", async () => {
        const verdicts = {};
        for (const [dialect, runs] of Object.entries(launcherRuns)) {
          const canvas = runs.canvas;
          verdicts[dialect] = {
            ok:
              JSON.stringify(canvas.argv) ===
                JSON.stringify([...CALLER_VALUES, ...INJECTED_ARGS]) &&
              canvas.env === INJECTED_ENV[1],
            argv: canvas.argv ?? null,
            error: canvas.error,
          };
          if (runs.outside) {
            verdicts[`${dialect}-outside`] = {
              ok:
                JSON.stringify(runs.outside.argv) ===
                  JSON.stringify(CALLER_VALUES) &&
                runs.outside.env === null &&
                runs.outside.token === null,
              argv: runs.outside.argv ?? null,
              error: runs.outside.error,
            };
          }
        }
        const values = Object.values(verdicts);
        return {
          ok: values.length > 0 && values.every((verdict) => verdict.ok),
          detail: verdicts,
        };
      });
      await record.check("launcher.credential", async () => {
        const tokens = Object.fromEntries(
          Object.entries(launcherRuns).map(([dialect, runs]) => [
            dialect,
            runs.canvas.token === PROBE_TOKEN,
          ]),
        );
        return {
          ok:
            Object.values(tokens).length > 0 &&
            Object.values(tokens).every(Boolean),
          detail: tokens,
        };
      });
    }

    say("凭据、Gateway、文件监听");
    await record.check("credentials.status", async () => {
      const listed = await app.api("GET", "/api/credentials");
      return {
        ok:
          listed.status === 200 &&
          listed.body?.backend === "dpapi" &&
          listed.body?.available === true,
        detail: {
          status: listed.status,
          backend: listed.body?.backend,
          available: listed.body?.available,
          reason: listed.body?.reason ?? null,
        },
      };
    });

    await record.check("gateway.loopback", async () => {
      const opened = await app.api("PUT", "/api/gateway", {
        enabled: true,
        listen: "loopback",
        port: 0,
      });
      const origin = opened.body?.origin ?? opened.body?.origins?.[0];
      const reached =
        typeof origin === "string" ? await httpsProbe(origin) : { ok: false };
      const closed = await app.api("PUT", "/api/gateway", { enabled: false });
      const after =
        typeof origin === "string" ? await httpsProbe(origin) : { ok: false };
      return {
        ok:
          opened.body?.running === true &&
          reached.ok &&
          closed.body?.running === false &&
          !after.ok,
        detail: {
          running: opened.body?.running ?? null,
          origin: origin ?? null,
          tls: opened.body?.tls?.source ?? null,
          error: opened.body?.error ?? null,
          reached,
          stoppedAfterwards: !after.ok,
        },
      };
    });

    await record.check("files.watch", async () => {
      const file = join(wsDir, "acceptance-watch.txt");
      writeFileSync(file, "one\n");
      const registered = await app.api(
        "POST",
        `/api/workspaces/${workspaceId}/file-watch`,
        { path: "acceptance-watch.txt", nodeId: "acceptance-node" },
      );
      if (registered.body?.status !== "watching")
        return { ok: false, detail: { registered } };
      // 页面开着事件流时由探针（应用之外）改文件。
      const waiting = app.evaluate(
        `globalThis.__acceptance.events(${JSON.stringify(workspaceId)}, "file.changed", () => {}, 20000)`,
      );
      await sleep(1_500);
      writeFileSync(file, `two ${Date.now()}\n`);
      const seen = await waiting;
      return {
        ok: seen.ok === true,
        detail: {
          mode: registered.body?.mode,
          event: seen.event ?? seen.reason,
        },
      };
    });

    if (!options.withCodex) {
      record.skip("agent.codex", "没有 --with-codex");
    } else if (
      !result.machine.clis.codex ||
      !existsSync(join(home, ".codex", "auth.json"))
    ) {
      record.skip("agent.codex", "没有 codex 或没有 ~/.codex/auth.json");
    } else {
      await record.check("agent.codex", async () => {
        const nodeId = crypto.randomUUID();
        const response = await app.api("POST", "/api/terminals", {
          workspaceId,
          cwd: wsDir,
          nodeId,
          agent: { id: "codex" },
        });
        const id = response.body?.id;
        if (typeof id !== "string") return { ok: false, detail: { response } };
        let screen = "";
        try {
          await waitFor(
            "Codex 的界面",
            async () => {
              const capture = await app.api(
                "GET",
                `/api/terminals/${id}/capture?lines=80`,
              );
              screen = capture.body?.data ?? "";
              return /codex/i.test(screen) && /(›|>|\u276f)/.test(screen);
            },
            { timeout: 90_000, interval: 2_000 },
          );
        } catch {
          // 屏幕留在 detail 里。
        }
        const agents = await app.api("GET", "/api/agents");
        const row = (
          Array.isArray(agents.body) ? agents.body : (agents.body?.agents ?? [])
        ).find((entry) => entry.id === "codex");
        await app.api("POST", `/api/terminals/${id}/terminate`, {
          mode: "session",
        });
        const ok =
          /codex/i.test(screen) &&
          /run[\\/]codex\.exe$/i.test(row?.launcher ?? "");
        // 画面只在失败时带上，且只要尾部：结果文件要贴回来，不收终端正文。
        return {
          ok,
          detail: {
            launcher: row?.launcher ?? null,
            ...(ok ? {} : { screenTail: screen.slice(-800) }),
          },
        };
      });
    }

    say(`保活 ${options.soakMinutes} 分钟`);
    if (options.soakMinutes <= 0 || sessions.length === 0) {
      record.skip("soak", "保活时长为 0 或没有终端");
    } else {
      await record.check("soak", async () => {
        for (const session of sessions)
          await app.terminal(
            session.id,
            [`${loopLine(session.dialect)}\r`],
            null,
            3_000,
          );
        const pids = () => [
          app.pid,
          ...(hostPid ? [hostPid] : []),
          ...sessions.map((session) => session.pid).filter(Boolean),
        ];
        const sample = (minute) => {
          const row = {
            minute,
            at: new Date().toISOString(),
            app: appProcesses(exe).map(
              ({ pid, rssMb, handles, commandLine }) => ({
                pid,
                role:
                  pid === app.pid
                    ? "main"
                    : pid === hostPid
                      ? "sessionHost"
                      : (/--type=([a-z-]+)/.exec(commandLine)?.[1] ?? "other"),
                rssMb,
                handles,
              }),
            ),
            shells: processesById(
              sessions.map((session) => session.pid).filter(Boolean),
            ),
          };
          result.samples.push(row);
          console.log(
            `  [${minute} min] ${row.app.map((p) => `${p.role}:${p.rssMb}MB/${p.handles}h`).join(" ")}`,
          );
          return row;
        };
        const first = sample(0);
        const deadline = Date.now() + options.soakMinutes * 60_000;
        let minute = 0;
        while (Date.now() < deadline) {
          await sleep(Math.min(60_000, Math.max(0, deadline - Date.now())));
          minute += 1;
          sample(minute);
        }
        const last = result.samples.at(-1);
        const dead = pids().filter((pid) => !alive(pid));
        const responsive = {};
        for (const session of sessions) {
          const marker = `ACC-after-${session.dialect}-${randomBytes(3).toString("hex")}-OK`;
          const typed = await app.terminal(
            session.id,
            ["\u0003", "\r", `${markerLine(session.dialect, marker)}\r`],
            marker,
            30_000,
          );
          responsive[session.dialect] = typed.ok;
        }
        const growth = (role) => {
          const a = first.app.find((p) => p.role === role);
          const b = last.app.find((p) => p.role === role);
          return a && b
            ? { rssMb: [a.rssMb, b.rssMb], handles: [a.handles, b.handles] }
            : null;
        };
        const host = growth("sessionHost");
        const suspicious =
          host !== null &&
          (host.rssMb[1] > host.rssMb[0] * 3 + 50 ||
            host.handles[1] > host.handles[0] + 2_000);
        return {
          ok: dead.length === 0 && Object.values(responsive).every(Boolean),
          warn: suspicious,
          detail: { dead, responsive, main: growth("main"), sessionHost: host },
        };
      });
    }

    say("重启存活");
    await record.check("restart.survives", async () => {
      const shellPids = sessions.map((session) => session.pid).filter(Boolean);
      await app.kill();
      await sleep(3_000);
      const hostAlive = hostPid ? alive(hostPid) : false;
      const shellsAlive = shellPids.every(alive);
      const leftovers = appProcesses(exe)
        .filter((row) => row.pid !== hostPid)
        .map((row) => row.pid);
      await app.start();
      const back = {};
      for (const session of sessions) {
        const row = await app.api("GET", `/api/terminals/${session.id}`);
        const marker = `ACC-back-${session.dialect}-${randomBytes(3).toString("hex")}-OK`;
        const typed = await app.terminal(
          session.id,
          [`${markerLine(session.dialect, marker)}\r`],
          marker,
          45_000,
        );
        back[session.dialect] = {
          status: row.body?.status ?? null,
          samePid: row.body?.pid === session.pid,
          echoed: typed.ok,
        };
      }
      return {
        ok:
          hostAlive &&
          shellsAlive &&
          Object.values(back).every(
            (entry) => entry.status === "running" && entry.echoed,
          ),
        warn: leftovers.length > 0,
        detail: { hostAlive, shellsAlive, leftoversAfterKill: leftovers, back },
      };
    });

    say("ConPTY 关闭");
    await record.check("conpty.close", async () => {
      const consolesBefore = hostPid
        ? childrenOf(hostPid).filter((row) =>
            /^(conhost|OpenConsole)\.exe$/i.test(row.name),
          )
        : [];
      const detail = { consolesBefore: consolesBefore.length, sessions: {} };
      for (const session of sessions) {
        const answer = await app.api(
          "POST",
          `/api/terminals/${session.id}/terminate`,
          {
            mode: "session",
          },
        );
        let gone = false;
        try {
          await waitFor(
            `${session.dialect} 的 shell 退出`,
            () => !alive(session.pid),
            {
              timeout: 20_000,
            },
          );
          gone = true;
        } catch {
          gone = false;
        }
        detail.sessions[session.dialect] = {
          status: answer.status,
          shellGone: gone,
        };
      }
      await sleep(2_000);
      const consolesAfter =
        hostPid && alive(hostPid)
          ? childrenOf(hostPid).filter((row) =>
              /^(conhost|OpenConsole)\.exe$/i.test(row.name),
            )
          : [];
      detail.consolesAfter = consolesAfter.length;
      return {
        ok:
          Object.values(detail.sessions).every((entry) => entry.shellGone) &&
          consolesAfter.length === 0,
        detail,
      };
    });

    await record.check("app.logs", async () => {
      const found = logFindings(dataDir);
      return {
        ok: true,
        warn: found.findings.length > 0,
        detail: { ...found, findings: found.findings.slice(0, 30) },
      };
    });

    say("收尾");
    await app.kill();
    app = undefined;
    // 会话都终止了，宿主会自己空闲退出；等一会儿，还在就结束它（卸载要删它的映像）。
    if (hostPid) {
      try {
        await waitFor("会话宿主空闲退出", () => !alive(hostPid), {
          timeout: 15_000,
        });
      } catch {
        try {
          process.kill(hostPid);
        } catch {
          // 已经退了。
        }
      }
    }

    if (options.installer) {
      await record.check("uninstall.silent", async () => {
        const uninstaller = newestUninstaller(installDir);
        if (uninstaller === undefined)
          return { ok: false, detail: { reason: "安装目录里没有卸载程序" } };
        spawnSync(uninstaller, ["/S"], { stdio: "ignore" });
        // NSIS 卸载程序把自己拷到临时目录再跑，先返回：按结果轮询。
        try {
          await waitFor("安装目录清空", () => !existsSync(exe), {
            timeout: 180_000,
          });
        } catch {
          // 结论在下面。
        }
        await sleep(2_000);
        const registered = registeredInstalls();
        const programs = join(
          process.env.APPDATA ?? "",
          "Microsoft",
          "Windows",
          "Start Menu",
          "Programs",
        );
        const shortcuts = [
          join(programs, "Armadra.lnk"),
          join(os.homedir(), "Desktop", "Armadra.lnk"),
        ].filter(existsSync);
        const left = existsSync(installDir) ? readdirSync(installDir) : [];
        return {
          ok:
            !existsSync(exe) &&
            registered.length === 0 &&
            shortcuts.length === 0,
          warn: left.length > 0,
          detail: {
            exeGone: !existsSync(exe),
            leftInInstallDir: left,
            registered,
            shortcuts,
          },
        };
      });
    } else {
      record.skip("uninstall.silent", "--app 模式");
    }
  } finally {
    for (const undo of cleanup.reverse()) {
      try {
        await undo();
      } catch {
        // 尽力而为。
      }
    }
    const after = snapshot(targets);
    const changed = diffSnapshots(before, after);
    const entry = record.entry("userConfig.untouched");
    if (entry.status === "pending")
      record.set(
        "userConfig.untouched",
        changed.length === 0 ? "pass" : "fail",
        {
          watched: targets.length,
          changed,
        },
      );
    record.skipRest("前面的步骤中止");
    const failed = result.checks.some((check) => check.status === "fail");
    if (!(options.keep && failed)) {
      try {
        rmSync(work, { recursive: true, force: true, maxRetries: 10 });
      } catch {
        result.leftover = work;
      }
    } else {
      result.leftover = work;
    }
    writeFileSync(join(out, "app-output.log"), app?.output ?? "");
  }
}

/* --------------------------------- dry run --------------------------------- */

function selfTests() {
  const tests = [];
  const test = (name, run) => {
    try {
      const detail = run();
      tests.push({ name, ok: true, detail: detail ?? null });
    } catch (error) {
      tests.push({ name, ok: false, detail: error.message });
    }
  };
  const equal = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}：${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  };
  test("snapshot", () => {
    const root = mkdtempSync(join(os.tmpdir(), "armadra-acceptance-dry-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), "model = 'x'\n");
      const targets = userConfigTargets({
        home,
        appData: join(root, "appdata"),
      });
      const first = snapshot(targets);
      equal(diffSnapshots(first, snapshot(targets)), [], "没改时两次快照不同");
      writeFileSync(join(home, ".codex", "config.toml"), "model = 'y'\n");
      mkdirSync(join(root, "appdata", "Armadra"), { recursive: true });
      const changed = diffSnapshots(first, snapshot(targets)).map((row) =>
        basename(row.path),
      );
      equal(changed.sort(), ["Armadra", "config.toml"], "改动没被发现");
      return { targets: targets.length };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("launchLines", () => {
    const exe = "C:\\data dir\\run\\probe.exe";
    equal(
      launchLine("cmd", exe, ["C:\\node.exe", "c&d"]),
      '"C:\\data dir\\run\\probe.exe" "C:\\node.exe" "c&d"',
      "cmd 行",
    );
    equal(
      launchLine("pwsh", exe, ["it's", "x|y"]),
      "& 'C:\\data dir\\run\\probe.exe' 'it''s' 'x|y'",
      "pwsh 行",
    );
    let refused = false;
    try {
      launchLine("cmd", exe, ["100%"]);
    } catch {
      refused = true;
    }
    equal(refused, true, "带 % 的值没被拒绝");
    for (const dialect of ["cmd", "pwsh", "powershell"]) {
      const line = markerLine(dialect, "ACC-x-OK");
      if (line.includes("ACC-x-OK"))
        throw new Error(`${dialect} 的记号行含完整记号`);
    }
  });
  test("launchConfig", () => {
    const text = probeLaunchConfig({ client: "C:\\x\\armadra-hook.cmd" });
    const lines = text.split("\r\n");
    equal(lines[0], "armadra-launch 1", "首行");
    if (!lines.includes("credential=C:\\x\\armadra-hook.cmd"))
      throw new Error("没有 credential= 行");
    if (lines.some((line) => /[\r\n]/.test(line)))
      throw new Error("值里有换行");
  });
  test("resultShape", () => {
    const result = newResult(parseArgs(["--dry-run"]));
    result.status = summarize(result);
    equal(validateResult(result), [], "空结果的形状");
  });
  test("parseArgs", () => {
    let refused = false;
    try {
      parseArgs(["--installer", "a.exe", "--app", "b.exe"]);
    } catch {
      refused = true;
    }
    equal(refused, true, "--installer 与 --app 同时给没被拒绝");
    equal(
      parseArgs(["--app", "x.exe", "--soak-minutes", "2"]).soakMinutes,
      2,
      "保活时长",
    );
  });
  return tests;
}

/* ---------------------------------- main ----------------------------------- */

function printSummary(result, file) {
  console.log("\n结果：");
  for (const check of result.checks) {
    const mark = { pass: "✓", fail: "✗", warn: "!", skip: "-", pending: "?" }[
      check.status
    ];
    console.log(`  ${mark} ${check.id.padEnd(22)} ${check.title}`);
  }
  console.log(`\n${result.status}；结果文件：${file}`);
  console.log(
    "把 result.json 整个贴回来即可（不含凭据、终端原始输出只有失败时的尾部）。",
  );
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`windows-acceptance: ${error.message}`);
    return 2;
  }
  if (options.help) {
    console.log(
      readFileSync(fileURLToPath(import.meta.url), "utf8").split(
        "\nimport ",
      )[0],
    );
    return 0;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, "../..");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out =
    options.out ??
    (existsSync(join(repo, "pnpm-workspace.yaml"))
      ? join(repo, "target", "windows-acceptance", stamp)
      : join(process.cwd(), `windows-acceptance-${stamp}`));
  mkdirSync(out, { recursive: true });
  const result = newResult(options);
  const record = new Recorder(result);
  const started = Date.now();

  if (options.dryRun) {
    result.machine = machineInfo();
    result.selfTest = selfTests();
    for (const test of result.selfTest)
      console.log(`  ${test.ok ? "ok  " : "FAIL"} selfTest.${test.name}`);
    record.skipRest("dry-run");
  } else {
    try {
      await runFull(options, result, record, out);
    } catch (error) {
      result.error = error instanceof Error ? error.stack : String(error);
      record.skipRest(
        `中止：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  result.finishedAt = new Date().toISOString();
  result.durationSeconds = Math.round((Date.now() - started) / 1000);
  result.status = summarize(result);
  const file = join(out, "result.json");
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  printSummary(result, file);
  return result.status === "passed" || result.status === "dryRun" ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
