// windows-acceptance.mjs 的纯函数一半（补全计划 G3-2）：检查项表、参数、结果文件、
// 用户配置快照、各 shell 的启动行与探针自己的 `.launch`、干跑的自检。不起进程、不碰
// 系统，任何平台都能导入；测试（windows-acceptance.test.mjs）与探针共用它。
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import { basename, join, resolve } from "node:path";

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

/** 中途放弃时也要做的收尾项：日志、卸载、用户配置比对。 */
export const TEARDOWN_CHECKS = [
  "app.logs",
  "uninstall.silent",
  "userConfig.untouched",
];

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
  // 脚本自己中途抛错：后面的项都成了 skip，不能因此算通过。
  if (result.error) result.failures.push("probe.error");
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

export class Recorder {
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
    this.log(`  …    ${id}`);
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

  /** 还没跑的项都记 skip；`keep` 里的留给收尾去做。 */
  skipRest(reason, keep = []) {
    for (const check of this.result.checks)
      if (check.status === "pending" && !keep.includes(check.id))
        this.skip(check.id, reason);
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

export const ECHO_SCRIPT = [
  "const fs = require('node:fs');",
  "const [out, ...argv] = process.argv.slice(2);",
  "const pick = (name) => process.env[name] ?? null;",
  `fs.writeFileSync(out, JSON.stringify({ argv, env: pick(${JSON.stringify(INJECTED_ENV[0])}), token: pick('ARMADRA_PROBE_TOKEN') }));`,
].join("\n");

export const FAKE_CLIENT_SCRIPT = [
  "if (process.argv[2] !== 'credential') process.exit(9);",
  "process.stdout.write('ARMADRA_PROBE_TOKEN=probe-' + 'token & 100%');",
].join("\n");

export const PROBE_TOKEN = "probe-token & 100%";

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

/* ------------------------------ app & install ---------------------------- */

/**
 * 装进页面的小工具：经页面自己的地址与身份调 core（core 判的就是这个来源），
 * 终端经 WebSocket 附着、输入、等输出。
 */
export const PAGE_HELPERS = `(() => {
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

export function newestUninstaller(installDir) {
  try {
    return readdirSync(installDir)
      .filter((name) => /^Uninstall .*\.exe$/i.test(name))
      .map((name) => join(installDir, name))[0];
  } catch {
    return undefined;
  }
}

export function findFile(root, name, depth = 6) {
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

export function logFindings(dataDir) {
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

/** 对一个 https 来源发一次请求：握得上 TLS、拿到状态码就算到了（证书不在这里验）。 */
export function httpsProbe(origin) {
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

/* --------------------------------- dry run --------------------------------- */

export function selfTests() {
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
