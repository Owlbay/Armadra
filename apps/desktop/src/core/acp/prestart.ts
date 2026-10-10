/**
 * ACP 创建提速（界面第二波 §7.2、契约 §51）：菜单打开时的预启动池与冷启动预热。
 *
 * **预启动**：右键 / Dock `+` 菜单打开时，页面对默认 Agent 调一次
 * `POST /api/acp/prestart`。core 按与起会话同一份程序、argv、环境起适配器并做完
 * `initialize`，挂在 `(agentId, workspaceId)` 下；{@link PRESTART_IDLE_MS} 内没被
 * 领走就收掉。起会话时池里有同家同工作空间、启动签名相同的进程就领走，直接
 * `session/new`。
 *
 * 预启动的进程起的时候还没有节点，所以环境里没有节点身份（`ARMADRA_NODE_ID`
 * 等）。画布工具的身份随 `session/new` 的 `mcpServers` 走，不受影响；但终端注入
 * 的环境或 argv（`injection.reuse` 非空）在 CLI 里按节点身份生效，那几家不预启动。
 * 带节点凭据（§26.4）的节点不领：密钥只设给那个节点自己的进程。
 *
 * **预热**：适配器装好或升级后、core 起来空闲一会儿后、以及预启动时发现适配器换
 * 过了，对每家已装的适配器跑一次 `initialize` 并执行一次它自带 CLI 的 `--version`，
 * 把首次执行的扫描与换页提前做掉。串行；同一家同一份程序 10 分钟内只做一次。
 *
 * 这里只记数字（毫秒），不记任何输出正文。
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { AcpProcess } from "./client";
import {
  ACP_CLIENT_INFO,
  type AcpPrestarted,
  type AcpStartOptions,
  callbackRelay,
  negotiate,
} from "./host";

/** 预启动的进程没被领走时多久收掉。 */
export const PRESTART_IDLE_MS = 10_000;
/** 同一家同一份程序两次预热之间至少隔这么久。 */
export const WARM_INTERVAL_MS = 10 * 60_000;
/** core 起来之后空闲多久开始预热。 */
export const IDLE_WARM_DELAY_MS = 10_000;
/** 自带 CLI 的 `--version` 最多等这么久。 */
const VERSION_TIMEOUT_MS = 10_000;

type Log = (message: string, fields: Record<string, unknown>) => void;

/** 起一个预启动进程：起、`initialize`。缺省真起；用例注入。 */
export type PrestartSpawner = (plan: AcpStartOptions) => Promise<AcpPrestarted>;

export const spawnPrestarted: PrestartSpawner = async (plan) => {
  const relay = callbackRelay();
  const process_ = AcpProcess.spawn({
    program: plan.program,
    args: plan.args,
    cwd: plan.cwd,
    ...(plan.env === undefined ? {} : { env: plan.env }),
    clientInfo: ACP_CLIENT_INFO,
    ...relay.callbacks,
  });
  try {
    const { initialized } = await negotiate(process_, plan);
    return { process: process_, initialized, attach: relay.attach };
  } catch (error) {
    await process_.terminate();
    throw error;
  }
};

/**
 * 启动签名：程序、argv 与环境（键排好序）。领走的前提是这一份与节点要起的
 * 完全相同。
 */
export function launchSignature(
  plan: Pick<AcpStartOptions, "program" | "args" | "env">,
): string {
  const env = Object.entries(plan.env ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([plan.program, plan.args, env]);
}

interface Entry {
  readonly signature: string;
  readonly ready: Promise<AcpPrestarted | undefined>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface PrestartPoolOptions {
  readonly spawn?: PrestartSpawner;
  readonly idleMs?: number;
  readonly log?: Log;
}

/** `(agentId, workspaceId)` → 一个起好、协商过、还没开会话的适配器进程。 */
export class AcpPrestartPool {
  private readonly entries = new Map<string, Entry>();
  private readonly spawn: PrestartSpawner;
  private readonly idleMs: number;
  private readonly log: Log | undefined;
  /** 用例看起过几次。 */
  spawned = 0;

  constructor(options: PrestartPoolOptions = {}) {
    this.spawn = options.spawn ?? spawnPrestarted;
    this.idleMs = options.idleMs ?? PRESTART_IDLE_MS;
    this.log = options.log;
  }

  static key(agentId: string, workspaceId: string): string {
    return `${agentId}\u0000${workspaceId}`;
  }

  /**
   * 幂等：同一个键上已有同一签名的进程（起着或起好了）只重新计时；签名变了
   * （设置改了）换一个。
   */
  prestart(key: string, plan: AcpStartOptions): void {
    const signature = launchSignature(plan);
    const existing = this.entries.get(key);
    if (existing !== undefined && existing.signature === signature) {
      this.arm(key, existing);
      return;
    }
    if (existing !== undefined) this.drop(key, existing);
    const started = performance.now();
    this.spawned += 1;
    const ready = this.spawn(plan).then(
      (prestarted) => {
        this.log?.("ACP adapter prestarted", {
          agentId: plan.agentId ?? "",
          initializeMs: Math.round(performance.now() - started),
        });
        void prestarted.process.exited.then(() => {
          // 没被领走之前自己没了：池里不留一个死进程。
          if (this.entries.get(key) === entry) this.entries.delete(key);
        });
        return prestarted;
      },
      (error: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        this.log?.("ACP prestart failed", {
          agentId: plan.agentId ?? "",
          code: (error as { code?: unknown } | null)?.code ?? "unknown",
        });
        return undefined;
      },
    );
    const entry: Entry = { signature, ready, timer: undefined };
    this.entries.set(key, entry);
    this.arm(key, entry);
  }

  /**
   * 领走：同键同签名、还活着就交出去（起着的等它起好）；否则 `undefined`，调用
   * 方照常起。领走后池里不再有它。
   */
  async claim(
    key: string,
    plan: Pick<AcpStartOptions, "program" | "args" | "env">,
  ): Promise<AcpPrestarted | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.signature !== launchSignature(plan)) return undefined;
    this.entries.delete(key);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const prestarted = await entry.ready;
    if (prestarted === undefined || !prestarted.process.alive) return undefined;
    return prestarted;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** 收掉所有没领走的。 */
  async dispose(): Promise<void> {
    const all = [...this.entries.entries()];
    this.entries.clear();
    await Promise.all(
      all.map(async ([, entry]) => {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        const prestarted = await entry.ready;
        await prestarted?.process.terminate();
      }),
    );
  }

  /** 同步收掉（core 退出时）。 */
  killAllSync(): void {
    for (const [key, entry] of [...this.entries.entries()]) {
      this.drop(key, entry);
    }
  }

  private arm(key: string, entry: Entry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.entries.get(key) === entry) this.drop(key, entry);
    }, this.idleMs);
    entry.timer.unref?.();
  }

  private drop(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    void entry.ready.then((prestarted) => prestarted?.process.terminate());
  }
}

/* --------------------------------- 预热 --------------------------------- */

/**
 * 适配器自带的那份 CLI（与终端方式用的不是同一个文件，缓存不共用）：
 * Claude 是 SDK 平台包里的 `claude`，Codex 是 `@openai/codex-<平台>` 里的原生
 * 程序。从适配器程序（或它背后的脚本）的真实路径往上找 `node_modules`。
 */
export function bundledCli(
  paths: readonly string[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const exe = platform === "win32" ? ".exe" : "";
  const tag = `${platform === "win32" ? "win32" : platform}-${arch}`;
  for (const given of paths) {
    let real: string;
    try {
      real = realpathSync(given);
    } catch {
      continue;
    }
    let dir = dirname(real);
    for (let depth = 0; depth < 6; depth += 1) {
      const modules = join(dir, "node_modules");
      const claude = join(
        modules,
        "@anthropic-ai",
        `claude-agent-sdk-${tag}`,
        `claude${exe}`,
      );
      if (isFile(claude)) return claude;
      const vendor = join(modules, "@openai", `codex-${tag}`, "vendor");
      for (const triple of list(vendor)) {
        const codex = join(vendor, triple, "bin", `codex${exe}`);
        if (isFile(codex)) return codex;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/**
 * 适配器自带的 Claude Code 的版本（契约 §59 的 mod 门）：{@link bundledCli} 找到
 * 的 SDK 平台包旁边，`@anthropic-ai/claude-agent-sdk/package.json` 的
 * `claudeCodeVersion`。只读一个小文件，不起进程。`CLAUDE_CODE_EXECUTABLE` 设了
 * （适配器改用别的 CLI）、找不到或读不出时答 `undefined`：门按未知关着。
 */
export function bundledClaudeCodeVersion(
  paths: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if ((env.CLAUDE_CODE_EXECUTABLE ?? "") !== "") return undefined;
  const cli = bundledCli(paths, platform, arch);
  if (cli === undefined || !/claude-agent-sdk-/.test(cli)) return undefined;
  try {
    const manifest = JSON.parse(
      readFileSync(
        join(dirname(dirname(cli)), "claude-agent-sdk", "package.json"),
        "utf8",
      ),
    ) as { claudeCodeVersion?: unknown };
    const version = manifest.claudeCodeVersion;
    return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function list(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

/** 程序文件的指纹（路径 + mtime）：适配器换过（重装、升级）就变。 */
export function programFingerprint(program: string): string {
  try {
    const real = realpathSync(program);
    return `${real}@${statSync(real).mtimeMs}`;
  } catch {
    return program;
  }
}

/** 一家要预热的东西：与起会话同一份启动计划。 */
export interface WarmTarget {
  readonly agentId: string;
  readonly plan: AcpStartOptions;
}

export interface AcpWarmerOptions {
  /** 此刻装着的各家（没装的不在里面）。 */
  readonly targets: () => readonly WarmTarget[];
  readonly log?: Log;
  readonly intervalMs?: number;
  readonly now?: () => number;
  /** 只做 `initialize` 的能力探测；缺省真起。 */
  readonly probe?: (plan: AcpStartOptions) => Promise<void>;
  /** 执行一次自带 CLI 的 `--version`；缺省真执行。 */
  readonly version?: (
    program: string,
    env: NodeJS.ProcessEnv | undefined,
  ) => Promise<void>;
  /** Codex 之类要排队的：与真启动走同一个闸门。缺省不排。 */
  readonly gate?: (agentId: string, run: () => Promise<void>) => Promise<void>;
}

const probeOnly = async (plan: AcpStartOptions): Promise<void> => {
  const prestarted = await spawnPrestarted(plan);
  await prestarted.process.terminate();
};

const runVersion = (
  program: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<void> =>
  new Promise((resolve) => {
    const child = execFile(
      program,
      ["--version"],
      {
        timeout: VERSION_TIMEOUT_MS,
        env: env ?? process.env,
        windowsHide: true,
      },
      () => resolve(),
    );
    // 输出不要：只为把这个程序跑一遍。
    child.stdout?.resume();
    child.stderr?.resume();
  });

export class AcpWarmer {
  private readonly warmed = new Map<string, { at: number; print: string }>();
  private chain: Promise<void> = Promise.resolve();
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: AcpWarmerOptions) {
    this.intervalMs = options.intervalMs ?? WARM_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** 每家都过一遍（串行）；`agentId` 只做那一家。 */
  warm(reason: string, agentId?: string): Promise<void> {
    const next = this.chain.then(async () => {
      for (const target of this.options.targets()) {
        if (agentId !== undefined && target.agentId !== agentId) continue;
        await this.warmOne(target, reason);
      }
    });
    this.chain = next.catch(() => undefined);
    return this.chain;
  }

  /** 这家的程序和上次预热时不是同一份了（或从没预热过）。 */
  stale(target: WarmTarget): boolean {
    const last = this.warmed.get(target.agentId);
    return (
      last === undefined ||
      last.print !== programFingerprint(target.plan.program)
    );
  }

  private async warmOne(target: WarmTarget, reason: string): Promise<void> {
    const print = programFingerprint(target.plan.program);
    const last = this.warmed.get(target.agentId);
    if (
      last !== undefined &&
      last.print === print &&
      this.now() - last.at < this.intervalMs
    ) {
      return;
    }
    this.warmed.set(target.agentId, { at: this.now(), print });
    const run = async () => {
      const started = performance.now();
      let initializeMs = -1;
      try {
        await (this.options.probe ?? probeOnly)(target.plan);
        initializeMs = Math.round(performance.now() - started);
      } catch {
        // 起不来由真起会话时报；预热不报错。
      }
      let versionMs = -1;
      const cli = bundledCli([
        target.plan.program,
        ...target.plan.args.slice(0, 1),
      ]);
      if (cli !== undefined) {
        const at = performance.now();
        try {
          await (this.options.version ?? runVersion)(cli, target.plan.env);
          versionMs = Math.round(performance.now() - at);
        } catch {
          // 同上。
        }
      }
      this.options.log?.("ACP adapter warmed", {
        agentId: target.agentId,
        reason,
        initializeMs,
        versionMs,
      });
    };
    if (this.options.gate !== undefined) {
      await this.options.gate(target.agentId, run);
    } else {
      await run();
    }
  }
}

/**
 * claude-agent-acp 往 stderr 打的阶段耗时：`[session/create] phase=<名> durationMs=<n>`。
 * 只取名字与数字（契约 §51），正文不进日志。
 */
const ADAPTER_PHASE =
  /\[session\/create\]\s+phase=([A-Za-z0-9_.:-]{1,48})\s+durationMs=(\d{1,9}(?:\.\d+)?)/g;

export function adapterPhases(
  text: string,
): { phase: string; durationMs: number }[] {
  const out: { phase: string; durationMs: number }[] = [];
  for (const match of text.matchAll(ADAPTER_PHASE)) {
    out.push({
      phase: match[1] as string,
      durationMs: Math.round(Number(match[2])),
    });
  }
  return out;
}

/* --------------------------------- 装配 --------------------------------- */

let warmer: AcpWarmer | undefined;

/** ACP 域装配时登记；没装配时下面的触发什么都不做。 */
export function setAcpWarmer(next: AcpWarmer | undefined): void {
  warmer = next;
}

/** 适配器或 CLI 装好 / 升级成功之后（`agent/adapter-install.ts`）。 */
export function warmAfterInstall(agentId: string): void {
  void warmer?.warm("install", agentId);
}
