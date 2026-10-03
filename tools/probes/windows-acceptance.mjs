#!/usr/bin/env node
// Windows 真机验收（补全计划 G3-2，架构 §11）：在一台真的 Windows 上一键走完
// 「安装 → 起应用 → 终端与会话宿主 → 画布启动器三种 shell → 凭据 / Gateway / 更新
// 状态 → 文件监听 → 保活 → 重启存活 → ConPTY 关闭 → 卸载」，把每一项写进
// `result.json`。人跑一次、把这个文件贴回来，就是一次 C 档验收的记录。
//
// 用法（Node 22+，不依赖仓库里的包：只拷本文件、windows-acceptance-lib.mjs 与 probe-home.mjs 三个文件过去也能跑）：
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
// 与含义在 windows-acceptance-lib.mjs 的 CHECKS 里，是稳定的。
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  CALLER_VALUES,
  ECHO_SCRIPT,
  FAKE_CLIENT_SCRIPT,
  INJECTED_ARGS,
  INJECTED_ENV,
  PROBE_TOKEN,
  PAGE_HELPERS,
  Recorder,
  TEARDOWN_CHECKS,
  findFile,
  httpsProbe,
  logFindings,
  newestUninstaller,
  diffSnapshots,
  launchLine,
  loopLine,
  markerLine,
  newResult,
  parseArgs,
  probeLaunchConfig,
  selfTests,
  setEnvLine,
  snapshot,
  summarize,
  userConfigTargets,
} from "./windows-acceptance-lib.mjs";
import { isolatedEnv, probeHome } from "./probe-home.mjs";

export * from "./windows-acceptance-lib.mjs";

/* ------------------------------ machine probes ----------------------------- */

const isWindows = process.platform === "win32";

/**
 * Windows PowerShell 5.1：从 pwsh 7 里起它要去掉 PSModulePath（G3-3 的结论）。
 * 只有终止错误算失败：一条非终止错误（某个注册表路径不在）也会让 `-Command`
 * 的退出码变 1，而 stderr 是空的。
 */
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
        `$ProgressPreference='SilentlyContinue'; try { ${command} } catch { [Console]::Error.WriteLine($_); exit 1 }; exit 0`,
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

/** 会话宿主名下的控制台宿主进程（每个 ConPTY 一个，外加它自己的）。 */
function consolesOf(pid) {
  return childrenOf(pid).filter((row) =>
    /^(conhost|OpenConsole)\.exe$/i.test(row.name),
  );
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

/**
 * 调试端口上应用自己的回环页面。应用退了、或 core 起不来（壳会弹一个模态错误框，
 * 页面永远不出现）时立刻放弃，原因来自 `dead()`。
 */
async function attachToRenderer(port, dead = () => undefined) {
  let seen = [];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const reason = dead();
    if (reason !== undefined) throw new Error(reason);
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(5_000),
        })
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

/** 页面里最长的一次等待（起 Codex 九十秒）再留余量。 */
const CDP_TIMEOUT_MS = 180_000;

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
  // 应用退出或页面卡住时不能一直等：每次调用都有上限，连接断了全部失败。
  socket.addEventListener("close", () => {
    for (const waiter of pending.values())
      waiter.fail(new Error("CDP 连接断了"));
    pending.clear();
  });
  const send = (method, params) =>
    new Promise((done, fail) => {
      const id = next;
      next += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(
          new Error(`CDP ${method} 在 ${CDP_TIMEOUT_MS / 1000}s 内没有回答`),
        );
      }, CDP_TIMEOUT_MS);
      pending.set(id, {
        done: (value) => {
          clearTimeout(timer);
          done(value);
        },
        fail: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
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
 * 页面里的工具，没装（页面刚换过一次地址）就先装：每次调用都从页面自己的桥现读
 * 地址。
 */
const HELPERS = `(globalThis.__acceptance ?? (${PAGE_HELPERS}, globalThis.__acceptance))`;

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
        // 临时 HOME（probe-home.mjs：HOME / USERPROFILE、XDG、各 CLI 的配置目录、
        // git 全局配置），并去掉指向真实账号的凭据变量。
        env: isolatedEnv(this.home, { ARMADRA_DATA_DIR: this.dataDir }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      },
    );
    this.child.stdout.on("data", (chunk) => (this.output += chunk));
    this.child.stderr.on("data", (chunk) => (this.output += chunk));
    this.exited = new Promise((done) => this.child.once("exit", done));
    const url = await attachToRenderer(port, () => {
      if (this.child.exitCode !== null)
        return `应用退出了（${this.child.exitCode}）：${this.output.slice(-1500)}`;
      const failed =
        /Runtime process exited before becoming ready|core could not start/.exec(
          this.output,
        );
      return failed ? `core 没起来：${this.output.slice(-1500)}` : undefined;
    });
    this.page = await cdp(url);
    // 页面可能比 core 先到，或换过一次地址：等到经页面问得到 /api/health 为止。
    let last;
    const endpoints = await waitFor(
      "经页面问到 core 的 /api/health",
      async () => {
        try {
          const ready = await this.page.evaluate(
            `(async () => { delete globalThis.__acceptance; const helpers = ${HELPERS}; const health = await helpers.api("GET", "/api/health"); return health.status === 200 ? { httpBase: helpers.httpBase, wsBase: helpers.wsBase } : null; })()`,
          );
          return ready ?? undefined;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
          return undefined;
        }
      },
      { timeout: 90_000, interval: 1_000 },
    ).catch((error) => {
      throw new Error(`${error.message}；最后一次：${last ?? "无"}`);
    });
    return endpoints;
  }

  get pid() {
    return this.child?.pid;
  }

  async api(method, path, body) {
    return await this.page.evaluate(
      `${HELPERS}.api(${JSON.stringify(method)}, ${JSON.stringify(path)}, ${JSON.stringify(body)})`,
    );
  }

  async terminal(sessionId, lines, waitFor, timeoutMs = 30_000) {
    return await this.page.evaluate(
      `${HELPERS}.terminal(${JSON.stringify(sessionId)}, "acceptance", ${JSON.stringify(lines)}, ${JSON.stringify(waitFor)}, ${timeoutMs})`,
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

  let hostPid;
  let dataDir;
  let installed = false;
  // 中途放弃时收尾的几项照样做：已经装上的要卸掉，用户配置照样比对。
  const abort = (reason) => record.skipRest(reason, TEARDOWN_CHECKS);

  const phases = async () => {
    say("预检");
    const preflightOk = await record.check("preflight.platform", async () => ({
      ok: isWindows && Number(process.versions.node.split(".")[0]) >= 22,
      detail: { platform: process.platform, node: process.version },
    }));
    if (!preflightOk) {
      abort("不是 Windows 或 Node 太旧");
      return;
    }
    result.machine = machineInfo();
    let existing = [];
    if (options.installer) {
      const ok = await record.check("preflight.existing", async () => {
        existing = registeredInstalls();
        return {
          ok: existing.length === 0,
          detail: {
            registered: existing.map((row) => ({
              name: row.DisplayName,
              version: row.DisplayVersion,
              location: row.InstallLocation,
            })),
          },
        };
      });
      if (!ok) {
        abort("机器上已有 Armadra 安装；先卸载它，或用 --app 对着它跑");
        return;
      }
    } else {
      try {
        existing = registeredInstalls();
      } catch {
        // 只是记录。
      }
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
          const timer = setTimeout(() => {
            child.kill();
            done("安装程序五分钟没有退出");
          }, 300_000);
          child.on("exit", (code) => {
            clearTimeout(timer);
            done(code);
          });
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
        abort("没装上");
        return;
      }
      installed = true;
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
    dataDir = join(work, "data");
    mkdirSync(dataDir, { recursive: true });
    const isolated = probeHome("armadra-acceptance-home-");
    cleanup.push(() => isolated.remove());
    const home = isolated.path;
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
      home: isolated,
      userDataDir: join(work, "electron"),
    });
    const started = await record.check("app.start", async () => {
      const endpoints = await app.start();
      const health = await app.api("GET", "/api/health");
      return {
        ok: health.status === 200,
        detail: { endpoints, health: health.body, mainPid: app.pid },
      };
    });
    if (!started) {
      abort("应用没起来");
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
      abort(`建不了工作空间：${JSON.stringify(created).slice(0, 300)}`);
      return;
    }
    const shells = [
      ["cmd", result.machine.shells.cmd],
      ["pwsh", result.machine.shells.pwsh],
      ["powershell", result.machine.shells.powershell],
    ].filter(([, path]) => path);
    const sessions = [];
    // 起终端之前会话宿主自己的控制台宿主（它以 CREATE_NO_WINDOW 起时有一个）：
    // ConPTY 关闭证明比的是终止之后回到这个数，而不是 0。
    let consoleBaseline;
    try {
      const host = appProcesses(exe).find(
        (row) =>
          /session-host[\\/]host\.cjs/i.test(row.commandLine) &&
          row.commandLine.includes(dataDir),
      );
      if (host !== undefined) consoleBaseline = consolesOf(host.pid).length;
    } catch {
      // 没有基线时退回「比终止前少」。
    }
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
          ...(typed.ok && captured
            ? {}
            : {
                tail: typed.tail.slice(-600),
                capture: {
                  status: capture.status,
                  lines: capture.body?.lines ?? null,
                  tail:
                    typeof capture.body?.data === "string"
                      ? capture.body.data.slice(-600)
                      : capture.body,
                },
              }),
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
    if (!launcherReady || sessions.length === 0) {
      const reason = launcherReady
        ? "没有起来的终端"
        : "包里没有 armadra-launch.exe";
      record.skip("launcher.dialects", reason);
      record.skip("launcher.credential", reason);
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
        const ok = values.length > 0 && values.every((verdict) => verdict.ok);
        if (!ok) {
          // 失败时带上各终端此刻的屏幕尾部：启动器的报错就在那里。
          for (const session of sessions) {
            const capture = await app.api(
              "GET",
              `/api/terminals/${session.id}/capture?lines=40`,
            );
            verdicts[`${session.dialect}-screen`] = {
              status: capture.status,
              tail:
                typeof capture.body?.data === "string"
                  ? capture.body.data.slice(-800)
                  : capture.body,
            };
          }
        }
        return { ok, detail: verdicts };
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
        `${HELPERS}.events(${JSON.stringify(workspaceId)}, "file.changed", () => {}, 20000)`,
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
    if (sessions.length === 0)
      record.skip("restart.survives", "没有起来的终端");
    else
      await record.check("restart.survives", async () => {
        const shellPids = sessions
          .map((session) => session.pid)
          .filter(Boolean);
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
          detail: {
            hostAlive,
            shellsAlive,
            leftoversAfterKill: leftovers,
            back,
          },
        };
      });

    say("ConPTY 关闭");
    if (sessions.length === 0) record.skip("conpty.close", "没有起来的终端");
    else
      await record.check("conpty.close", async () => {
        const consolesBefore = hostPid ? consolesOf(hostPid) : [];
        const detail = {
          consoleBaseline: consoleBaseline ?? null,
          consolesBefore: consolesBefore.length,
          sessions: {},
        };
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
          hostPid && alive(hostPid) ? consolesOf(hostPid) : [];
        detail.consolesAfter = consolesAfter.length;
        const consolesReleased =
          consoleBaseline === undefined
            ? consolesAfter.length < consolesBefore.length ||
              consolesAfter.length === 0
            : consolesAfter.length <= consoleBaseline;
        return {
          ok:
            Object.values(detail.sessions).every((entry) => entry.shellGone) &&
            consolesReleased,
          detail,
        };
      });
  };

  const teardown = async () => {
    say("收尾");
    if (app !== undefined) {
      await app.kill();
      app = undefined;
    }
    // 会话都终止了，宿主会自己空闲退出；等一会儿，还在就结束它（卸载要删它的映像）。
    if (exe !== undefined && dataDir !== undefined && isWindows) {
      try {
        hostPid ??= appProcesses(exe).find((row) =>
          row.commandLine.includes(dataDir),
        )?.pid;
      } catch {
        // 找不到就算了。
      }
    }
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

    if (
      record.entry("app.logs").status === "pending" &&
      dataDir !== undefined
    ) {
      await record.check("app.logs", async () => {
        const found = logFindings(dataDir);
        return {
          ok: true,
          warn: found.findings.length > 0,
          detail: { ...found, findings: found.findings.slice(0, 30) },
        };
      });
    }

    if (installed) {
      await record.check("uninstall.silent", async () => {
        const uninstaller = newestUninstaller(installDir);
        if (uninstaller === undefined)
          return { ok: false, detail: { reason: "安装目录里没有卸载程序" } };
        spawnSync(uninstaller, ["/S"], { stdio: "ignore", timeout: 300_000 });
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
    } else if (record.entry("uninstall.silent").status === "pending") {
      record.skip(
        "uninstall.silent",
        options.installer ? "没有装上" : "--app 模式",
      );
    }
  };

  let appOutput = "";
  try {
    await phases();
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
    abort(`中止：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    appOutput = app?.output ?? "";
    try {
      await teardown();
    } catch (error) {
      result.teardownError =
        error instanceof Error ? error.message : String(error);
    }
    for (const undo of cleanup.reverse()) {
      try {
        await undo();
      } catch {
        // 尽力而为。
      }
    }
    const after = snapshot(targets);
    const changed = diffSnapshots(before, after);
    record.set("userConfig.untouched", changed.length === 0 ? "pass" : "fail", {
      watched: targets.length,
      changed,
    });
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
    writeFileSync(join(out, "app-output.log"), appOutput);
  }
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
