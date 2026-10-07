import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import {
  ADAPTER_INSTALL_TARGETS,
  type AdapterInstallFailure,
  type AdapterInstallJob,
  type AdapterInstallTarget,
  installablePackage,
} from "@armadra/shared";

import { acpAdapter } from "../acp/adapters";
import { forgetAcpVersion } from "../acp/host";
import { REDACTED, redact } from "../collab/redact";
import { fail } from "../http/errors";
import type { CoreServer } from "../http/server";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import { audit } from "../identity/audit";
import { isOwner } from "../identity/authorize";
import { currentSubject } from "../identity/gate";
import { OUTBOUND } from "../net/outbound";
import { agentPath } from "../terminal/environment";
import { definition, resolveCommand } from "./registry";

/**
 * ACP 适配器与 CLI 的安装（契约 §39.7，自 1.22 起 §47）。
 *
 * 只做一件事：对 `ACP_ADAPTER_PACKAGES` / `AGENT_CLI_PACKAGES`（`@armadra/shared`）
 * 两张表里的包，跑固定的 `npm install --global <包>`。不收别的参数，不写 CLI 的
 * 配置；npm 读用户自己的 `.npmrc`（镜像、代理），那是用户的设置，这里不改。
 *
 * 开始前用同一个 npm 读一次已装版本（`npm ls --global`），记作 `previousVersion`；
 * 新装的坏了，`rollback` 装回 `<包>@<previousVersion>`。
 *
 * npm 用与这家 CLI 同一个 Node 安装：CLI 所在 bin 目录里的 npm 先试，找不到再退回
 * 补齐过的 PATH 上的 npm。子进程的 PATH 把那个目录排在最前，`#!/usr/bin/env node`
 * 解析到的也就是同一个 Node，全局前缀因此落在同一个 bin 目录里。
 *
 * 任务只在内存里：一家每一样一个最近的任务（键 `${agentId}:${target}`），同一家
 * 两样不并行；页面轮询 {@link AdapterInstaller.status}。
 * 输出只留最后 {@link TAIL_LINES} 行，去掉控制字符并脱敏，不进日志、不落盘。
 * 结束后忘掉这家记着的 ACP 版本，再在 PATH 上重新探一次适配器程序。
 */

/**
 * npm 子进程的联网登记在出站表（`net/outbound.ts` 的 `npmRegistry`）：core 自己不
 * 连，但这是 core 替用户起的联网，不算用户自己的程序。
 */
export const ADAPTER_INSTALL_OUTBOUND = OUTBOUND.npmRegistry;

/** 输出尾部留几行。 */
export const TAIL_LINES = 40;
/** 一行最多留多少字符。 */
const LINE_CHARS = 300;
/** npm 装一个包到这会儿还没完，就不会完了。 */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface InstallCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export interface InstallProcess {
  /** 退出码；起不来或被信号结束时是 `null`。 */
  readonly done: Promise<{ exitCode: number | null; error?: string }>;
  /** 按 pid 结束这一个子进程。 */
  kill(): void;
}

/** 起进程的那一层；用例给一个假的，不真去 npm。 */
export type InstallRunner = (
  command: InstallCommand,
  onOutput: (chunk: string) => void,
) => InstallProcess;

export const spawnRunner: InstallRunner = (command, onOutput) => {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command.program, [...command.args], {
      cwd: command.cwd,
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return {
      done: Promise.resolve({
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
      }),
      kill: () => undefined,
    };
  }
  const done = new Promise<{ exitCode: number | null; error?: string }>(
    (resolve) => {
      let failed: string | undefined;
      child.stdout?.setEncoding("utf8").on("data", onOutput);
      child.stderr?.setEncoding("utf8").on("data", onOutput);
      child.on("error", (error) => {
        failed = error.message;
      });
      child.on("close", (code) =>
        resolve(
          failed === undefined
            ? { exitCode: code }
            : { exitCode: code, error: failed },
        ),
      );
    },
  );
  return {
    done,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
};

/* --------------------------------- npm 的位置 -------------------------------- */

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 一个找到的 npm 怎么起。Windows 上的 `npm.cmd` 不经 shell 起不来，改成同目录的
 * `node.exe` 跑 `node_modules/npm/bin/npm-cli.js`；拼不出来答 `undefined`。
 */
export function npmInvocation(
  path: string,
  platform: NodeJS.Platform,
): { program: string; prefix: string[] } | undefined {
  if (platform !== "win32" || !/\.(cmd|bat|ps1)$/i.test(path)) {
    return { program: path, prefix: [] };
  }
  const directory = dirname(path);
  const cli = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
  const node = join(directory, "node.exe");
  return isFile(cli) && isFile(node)
    ? { program: node, prefix: [cli] }
    : undefined;
}

export interface NpmLocation {
  readonly program: string;
  /** 跟在程序后面、在 npm 自己的参数之前的（Windows 上是 `npm-cli.js`）。 */
  readonly prefix: readonly string[];
  /** npm 所在的目录：子进程 PATH 的第一项。 */
  readonly directory: string;
  /** `cli` = 与 CLI 同一个 Node 安装；`path` = PATH 上的。 */
  readonly source: "cli" | "path";
}

/** 先找 CLI 旁边的 npm，再找 PATH 上的；都没有答 `undefined`。 */
export function locateNpm(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NpmLocation | undefined {
  const launchCmd = definition(agentId)?.launchCmd;
  const cli =
    launchCmd === undefined ? undefined : resolveCommand(launchCmd, env);
  const candidates: { path: string | undefined; source: "cli" | "path" }[] = [
    {
      path:
        cli === undefined
          ? undefined
          : resolveCommand(join(dirname(cli), "npm"), env),
      source: "cli",
    },
    { path: resolveCommand("npm", env), source: "path" },
  ];
  for (const { path, source } of candidates) {
    if (path === undefined) continue;
    const invocation = npmInvocation(path, platform);
    if (invocation === undefined) continue;
    return { ...invocation, directory: dirname(path), source };
  }
  return undefined;
}

/* ---------------------------------- 输出 ---------------------------------- */

/** npm 自己那几种令牌与 URL 里的账号口令；其余凭据交给协作那一份脱敏表。 */
const NPM_SECRETS: readonly RegExp[] = [
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /(_authToken|_auth|_password)(\s*=\s*)\S+/g,
  /(\/\/)[^\s/@:]+:[^\s/@]+@/g,
];

/** 去掉 ANSI 与其余控制字符，脱敏，截长。 */
export function cleanLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  let text = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  text = redact(text);
  text = text
    .replace(NPM_SECRETS[0]!, REDACTED)
    .replace(
      NPM_SECRETS[1]!,
      (_match, key: string, eq: string) => `${key}${eq}${REDACTED}`,
    )
    .replace(
      NPM_SECRETS[2]!,
      (_match, slashes: string) => `${slashes}${REDACTED}@`,
    );
  return text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS)}…` : text;
}

/** 只留尾部的行缓冲：完整的行进表，末尾半行另存。 */
class Tail {
  private lines: string[] = [];
  private partial = "";

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n|\r/);
    this.partial = parts.pop() ?? "";
    // 半行太长也不留着整段：只要尾部。
    if (this.partial.length > LINE_CHARS * 4) {
      this.partial = this.partial.slice(-LINE_CHARS * 4);
    }
    for (const part of parts) {
      if (part.trim() === "") continue;
      this.lines.push(cleanLine(part));
    }
    if (this.lines.length > TAIL_LINES) {
      this.lines = this.lines.slice(-TAIL_LINES);
    }
  }

  snapshot(): string[] {
    const last = this.partial.trim() === "" ? [] : [cleanLine(this.partial)];
    return [...this.lines, ...last].slice(-TAIL_LINES);
  }
}

/* ------------------------------- 上一版本 ------------------------------- */

/** `npm ls` 到这会儿还没答，就当拿不到上一版本。 */
const VERSION_TIMEOUT_MS = 30 * 1000;

/** `npm ls --global --depth=0 --json <包>` 的输出里那个包的版本；读不出答 `undefined`。 */
export function parseNpmLsVersion(
  output: string,
  name: string,
): string | undefined {
  try {
    const parsed = JSON.parse(output) as {
      dependencies?: Record<string, { version?: unknown }>;
    };
    const version = parsed.dependencies?.[name]?.version;
    return typeof version === "string" && version !== "" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** 找已装版本的那一层；用例给一个假的。 */
export type InstalledVersion = (
  name: string,
  command: Omit<InstallCommand, "args"> & {
    readonly prefix: readonly string[];
  },
) => Promise<string | undefined>;

/** 用同一个 npm 跑一次 `npm ls`；输出只拿来读版本，不进任务的输出尾部。 */
export function npmLsVersion(runner: InstallRunner): InstalledVersion {
  return async (name, command) => {
    let output = "";
    const run = runner(
      {
        program: command.program,
        args: [
          ...command.prefix,
          "ls",
          "--global",
          "--depth=0",
          "--json",
          name,
        ],
        cwd: command.cwd,
        env: command.env,
      },
      (chunk) => {
        if (output.length < 256 * 1024) output += chunk;
      },
    );
    const timer = setTimeout(() => run.kill(), VERSION_TIMEOUT_MS);
    timer.unref?.();
    try {
      await run.done;
    } finally {
      clearTimeout(timer);
    }
    // 没装时 npm 以 1 退出，但 JSON 照样给；版本缺席就是没有上一版本。
    return parseNpmLsVersion(output, name);
  };
}

/* ---------------------------------- 任务 ---------------------------------- */

interface Job {
  agentId: string;
  target: AdapterInstallTarget;
  package: string;
  reinstall: boolean;
  rollback: boolean;
  previousVersion?: string;
  state: "running" | "succeeded" | "failed";
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  installed?: boolean;
  failure?: { code: AdapterInstallFailure; message: string };
  tail: Tail;
  process?: InstallProcess;
  finished: Promise<void>;
}

export interface StartOptions {
  readonly target?: AdapterInstallTarget;
  readonly reinstall?: boolean;
  readonly rollback?: boolean;
}

export interface AdapterInstallerOptions {
  readonly runner?: InstallRunner;
  /** 探测与子进程用的环境；缺省是 `process.env`。 */
  readonly env?: () => NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /**
   * 这一样的程序在不在；缺省在补齐过的 PATH 上找（适配器找适配器程序，CLI 找
   * `launchCmd`）。用例注入。
   */
  readonly probe?: (agentId: string, target: AdapterInstallTarget) => boolean;
  /** 找 npm；缺省 {@link locateNpm}（用例注入）。 */
  readonly locate?: (
    agentId: string,
    env: NodeJS.ProcessEnv,
  ) => NpmLocation | undefined;
  /**
   * 开始前已装的版本（§47 的「恢复上一版本」）。缺省：没注入 `runner` 时用真 npm
   * 跑 `npm ls`；注入了 `runner` 而没注入它时不查（用例里的假 runner 只管安装）。
   */
  readonly installedVersion?: InstalledVersion;
  /** 一个任务结束（成功或失败）之后；装配点用它通知页面。 */
  readonly onFinished?: (job: AdapterInstallJob) => void;
}

const keyOf = (agentId: string, target: AdapterInstallTarget): string =>
  `${agentId}:${target}`;

export class AdapterInstaller {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly options: AdapterInstallerOptions = {}) {}

  private env(): NodeJS.ProcessEnv {
    return this.options.env?.() ?? process.env;
  }

  private now(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }

  /** 两张表（allowlist）外的一律拒绝；答包名。 */
  private packageOf(agentId: string, target: AdapterInstallTarget): string {
    const name = installablePackage(agentId, target);
    if (name === null) {
      throw fail(
        "adapter_not_installable",
        target === "cli"
          ? `${agentId} 没有可代装的 CLI`
          : `${agentId} 没有可代装的 ACP 适配器`,
      );
    }
    return name;
  }

  /** 这一样的程序现在在不在补齐过的 PATH 上。 */
  private probe(agentId: string, target: AdapterInstallTarget): boolean {
    if (this.options.probe !== undefined) {
      return this.options.probe(agentId, target);
    }
    const program =
      target === "cli"
        ? definition(agentId)?.launchCmd
        : acpAdapter(agentId)?.program;
    return (
      program !== undefined && resolveCommand(program, this.env()) !== undefined
    );
  }

  private installedVersion(): InstalledVersion | undefined {
    if (this.options.installedVersion !== undefined) {
      return this.options.installedVersion;
    }
    return this.options.runner === undefined
      ? npmLsVersion(spawnRunner)
      : undefined;
  }

  status(
    agentId: string,
    target: AdapterInstallTarget = "adapter",
  ): AdapterInstallJob {
    const name = this.packageOf(agentId, target);
    const job = this.jobs.get(keyOf(agentId, target));
    if (job === undefined) {
      return { agentId, target, state: "idle", package: name, output: [] };
    }
    return view(job);
  }

  start(
    agentId: string,
    options: StartOptions | boolean = {},
  ): AdapterInstallJob {
    const given: StartOptions =
      typeof options === "boolean" ? { reinstall: options } : options;
    const target = given.target ?? "adapter";
    const rollback = given.rollback === true;
    const reinstall = rollback || given.reinstall === true;
    const name = this.packageOf(agentId, target);
    const key = keyOf(agentId, target);
    const current = this.jobs.get(key);
    if (current?.state === "running") return view(current);
    // 同一家两样不并行：两个 npm 同时改同一个全局前缀，谁也说不清结果。
    for (const other of ADAPTER_INSTALL_TARGETS) {
      if (other === target) continue;
      if (this.jobs.get(keyOf(agentId, other))?.state === "running") {
        throw fail("adapter_install_busy", `${agentId} 正在装另一项`);
      }
    }
    const previousVersion = rollback ? current?.previousVersion : undefined;
    if (rollback && previousVersion === undefined) {
      throw fail(
        "adapter_rollback_unavailable",
        `${name} 没有可恢复的上一版本`,
      );
    }
    if (!reinstall && this.probe(agentId, target)) {
      throw fail(
        "adapter_already_installed",
        target === "cli"
          ? `${agentId} 的 CLI 已安装`
          : `${agentId} 的 ACP 适配器已安装`,
      );
    }
    const env = this.env();
    const npm =
      this.options.locate?.(agentId, env) ??
      (this.options.locate === undefined
        ? locateNpm(agentId, env, this.options.platform)
        : undefined);
    if (npm === undefined) {
      throw fail("npm_not_found", "找不到 npm");
    }
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      PATH: [npm.directory, agentPath(env)].join(delimiter),
      NO_COLOR: "1",
      npm_config_color: "false",
      npm_config_progress: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
      npm_config_update_notifier: "false",
    };
    const spec =
      previousVersion === undefined ? name : `${name}@${previousVersion}`;
    const command: InstallCommand = {
      program: npm.program,
      args: [...npm.prefix, "install", "--global", spec],
      cwd: tmpdir(),
      env: childEnv,
    };
    const job: Job = {
      agentId,
      target,
      package: name,
      reinstall,
      rollback,
      ...(previousVersion === undefined ? {} : { previousVersion }),
      state: "running",
      startedAt: this.now(),
      tail: new Tail(),
      finished: Promise.resolve(),
    };
    this.jobs.set(key, job);
    audit({
      action: "agent.adapter.install",
      target: agentId,
      detail: {
        package: name,
        kind: target,
        reinstall,
        rollback,
        npm: npm.source,
      },
    });
    const lookup = rollback ? undefined : this.installedVersion();
    const before: Promise<void> =
      lookup === undefined
        ? Promise.resolve()
        : lookup(name, {
            program: npm.program,
            prefix: npm.prefix,
            cwd: command.cwd,
            env: childEnv,
          }).then(
            (version) => {
              if (version !== undefined) job.previousVersion = version;
            },
            () => undefined,
          );
    job.finished = before.then(() => this.run(job, command));
    return view(job);
  }

  /** 跑安装那一步，结束后重新探测并写好结果。 */
  private run(job: Job, command: InstallCommand): Promise<void> {
    const run = (this.options.runner ?? spawnRunner)(command, (chunk) =>
      job.tail.push(chunk),
    );
    job.process = run;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      run.kill();
    }, this.options.timeoutMs ?? INSTALL_TIMEOUT_MS);
    timer.unref?.();
    return run.done.then(({ exitCode, error }) => {
      clearTimeout(timer);
      job.process = undefined;
      // 换过的适配器或 CLI（原生 ACP 的 CLI 就是入口）：旧版本号不作数，PATH 上重新探。
      forgetAcpVersion(job.agentId);
      const installed = this.probe(job.agentId, job.target);
      job.exitCode = exitCode;
      job.installed = installed;
      job.endedAt = this.now();
      if (timedOut) {
        job.state = "failed";
        job.failure = { code: "adapter_install_timeout", message: "安装超时" };
      } else if (exitCode !== 0 || error !== undefined) {
        job.state = "failed";
        job.failure = {
          code: "adapter_install_failed",
          message:
            error === undefined ? `npm 以 ${exitCode} 退出` : cleanLine(error),
        };
      } else if (!installed) {
        job.state = "failed";
        job.failure = {
          code: "adapter_install_missing",
          message:
            job.target === "cli"
              ? "安装完成但 PATH 上找不到 CLI"
              : "安装完成但 PATH 上找不到适配器",
        };
      } else {
        job.state = "succeeded";
      }
      audit({
        action: "agent.adapter.install.finish",
        target: job.agentId,
        detail: {
          package: job.package,
          kind: job.target,
          state: job.state,
          exitCode,
          ...(job.failure === undefined ? {} : { failure: job.failure.code }),
        },
      });
      this.options.onFinished?.(view(job));
    });
  }

  /** 用例等任务结束。 */
  async settled(
    agentId: string,
    target: AdapterInstallTarget = "adapter",
  ): Promise<AdapterInstallJob> {
    const job = this.jobs.get(keyOf(agentId, target));
    if (job !== undefined) await job.finished;
    return this.status(agentId, target);
  }

  /**
   * 结束还在跑的 npm（只结束自己起的那几个 pid）。用例用；关 core 时不调：
   * 装到一半被打断的全局包比让它装完更糟。
   */
  dispose(): void {
    for (const job of this.jobs.values()) job.process?.kill();
  }
}

function view(job: Job): AdapterInstallJob {
  return {
    agentId: job.agentId,
    target: job.target,
    state: job.state,
    package: job.package,
    reinstall: job.reinstall,
    ...(job.rollback ? { rollback: true } : {}),
    ...(job.previousVersion === undefined
      ? {}
      : { previousVersion: job.previousVersion }),
    startedAt: job.startedAt,
    ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
    ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
    output: job.tail.snapshot(),
    ...(job.installed === undefined ? {} : { installed: job.installed }),
    ...(job.failure === undefined ? {} : { failure: { ...job.failure } }),
  };
}

/* --------------------------------- procedure -------------------------------- */

/** 装软件是本机管理：只有 owner，不看任何共享授予。 */
function requireOwner(): void {
  if (!isOwner(currentSubject())) {
    throw fail("forbidden", "只有 owner 能安装适配器");
  }
}

/** `agents.installAdapter` / `agents.adapterInstall`（契约 §39.7、§47）。 */
export function installAdapterInstallRoutes(
  server: CoreServer,
  installer: AdapterInstaller,
): void {
  registerProcedures(server, "agents", {
    installAdapter: ({
      agentId,
      reinstall,
      target,
      rollback,
    }: {
      agentId: string;
      reinstall?: boolean;
      target?: AdapterInstallTarget;
      rollback?: boolean;
    }) => {
      requireOwner();
      return installer.start(agentId, {
        target: target ?? "adapter",
        reinstall: reinstall === true,
        rollback: rollback === true,
      });
    },
    adapterInstall: ({
      agentId,
      target,
    }: {
      agentId: string;
      target?: AdapterInstallTarget;
    }) => {
      requireOwner();
      return installer.status(agentId, target ?? "adapter");
    },
  } as unknown as DomainHandlers<"agents">);
}
