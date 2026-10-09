/**
 * 主机与会话资源，以及订阅制的采样循环。移植自
 * 合并前的实现。
 *
 * ## 采样是订阅，不是定时器
 *
 * 没人在看就什么都不测。面板拿一个带 TTL 的订阅并在开着的时候续；采样任务只在至少
 * 有一个活订阅时存在，最后一个过期时自己停。所以一个关上的面板什么都不花——不走一
 * 次进程表、不读一次磁盘、不唤醒一次。
 *
 * 这一版多一道门：**即使订阅还在，没有人连着那个工作空间的事件流时也不发布**。
 * `resource.sample` 只走事件 socket，一个没有订阅者的 socket 意味着这一帧发出去
 * 也没人收。`eventStream()?.subscriberCount` 是那个问题的答案（R1b）。
 *
 * ## 未知是一个值
 *
 * 每一项都可能是 `null`。这个平台答不上来的指标在线上是 `null`、在面板上是一个
 * 破折号——**永远不是 `0`**，那会被读成「空闲」。
 */

import type { DatabaseSync } from "node:sqlite";
import { cpus } from "node:os";
import { randomUUID as uuid } from "node:crypto";

import type { EventBus } from "../bus";
import { eventStream } from "../events";
import type { SettingsStore } from "../settings/store";
import {
  browserProcesses,
  components,
  shellComponents,
  shellProcesses,
  type PlatformComponent,
  type ShellProcessReport,
  type TrackedProcess,
} from "./platform";
import { RuntimeMetrics } from "./metrics";
import {
  PROBE_TTL_MS,
  ProbeCache,
  memoryPressureAsync,
  powerSourceAsync,
  swapUsageAsync,
} from "./platform-probe";
import {
  SampleTimeout,
  Sampler,
  childrenByParent,
  cpuPercent,
  deadline,
  hostResources,
  isGone,
  readProcessTableAsync,
  round,
  sessionResources,
  type HostResources,
  type PowerSource,
  type Refresh,
  type SessionResources,
} from "./sample";
import {
  TMUX_TIMEOUT_MS,
  aliveBackendReferences,
  listOrphans,
  panePidsAsync,
  sessionTargets,
  type OrphanSession,
} from "./sessions";

/**
 * 一个订阅在多少倍采样间隔之后过期，下限 {@link MIN_SUBSCRIPTION_TTL_MS}。每个间隔
 * 续一次的面板因此有两次错过续订的余量。
 */
export const TTL_INTERVALS = 3;
export const MIN_SUBSCRIPTION_TTL_MS = 10_000;
export const MAX_SUBSCRIPTIONS = 32;

/**
 * 订阅者能要求的最慢节奏。滚出屏幕的节点徽标要 30 s；这是那个的上限，所以客户端
 * 没法停一个一小时采一次的订阅然后把结果当成当前的。
 */
export const MAX_REQUESTED_INTERVAL_MS = 60_000;

const DEFAULT_INTERVAL_MS = 2_000;

/**
 * `GET …/resources` 与阈值慢轮复用多新的一轮：正在进行的那一轮，或这么久之内
 * 刚完成的那一轮。不另起 `ps`。
 */
export const ROUND_REUSE_MS = 500;

/**
 * 一轮采样读到的整机那张表：一次 `ps`、一次 `tmux list-panes`、三个低频探针的
 * 缓存值。所有工作空间共用这一轮——CPU 的分母（`refresh.elapsedMs`）也就只算
 * 一次，第 2 个以后的工作空间不再是一个约 100 ms 的基线。
 */
export interface SampleRound {
  readonly refresh: Refresh;
  readonly pids: ReadonlyMap<string, number>;
  readonly pressure: string | null;
  readonly power: PowerSource;
  readonly swap: { totalBytes: number | null; usedBytes: number | null };
  readonly cpuCores: number;
  /** `ps` 答回来的时刻。 */
  readonly atMs: number;
}

/** 一次资源采样，`GET …/resources` 与 `resource.sample` 事件用的是同一份。 */
export interface ResourceSnapshot {
  readonly workspaceId: string;
  readonly host: HostResources;
  readonly sessions: readonly SessionResources[];
  /** Armadra 自己的进程，和用户的会话分开列。 */
  readonly components: readonly PlatformComponent[];
  readonly orphans: readonly OrphanSession[];
  readonly power: PowerState;
  /** 循环现在实际跑的节奏：所有活订阅里最快的那个。 */
  readonly intervalMs: number;
  readonly sampledAt: string;
}

/** 一条「保持唤醒」的租约。写在这里是因为它是快照的一部分；簿子在 `power.ts`。 */
export interface PowerLease {
  readonly id: string;
  readonly source: "session" | "automation" | "manual";
  readonly reason: string;
  readonly sessionId: string | null;
  readonly workspaceId: string | null;
  readonly createdAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  /** 真的在顶着机器不睡。被策略或平台挡下的租约照样列出来，只是这里是 `false`。 */
  readonly active: boolean;
  readonly blockedBy: "policy" | "unavailable" | null;
}

/**
 * 快照里的电源那一段。
 *
 * 租约的**增删**不归这个域（那是 `power.ts` 的 `/api/power/leases*`），但它们
 * 要和策略、抑制机制出现在同一屏上，所以快照里带着当下这份租约表。没有租约簿
 * 时 `leases` 是空数组而不是缺席：一个缺席的字段会让前端的 schema 判成不匹配
 * 而整帧丢掉。
 */
export interface PowerState {
  readonly policy: string;
  readonly holding: boolean;
  readonly mechanism: string | null;
  readonly inhibitor: {
    readonly platform: string;
    readonly kind: string | null;
    readonly available: boolean;
    readonly detail: string | null;
  };
  readonly leases: readonly PowerLease[];
}

export interface Subscription {
  readonly subscriptionId: string;
  readonly workspaceId: string;
  /**
   * 这个订阅自己的节奏，也是它该按着续的那个。它不一定是样本到达的频率：另一个
   * 订阅者可能在要更快的，而那些所有人都看得到。
   */
  readonly intervalMs: number;
  /** 考虑所有活订阅之后，采样循环实际在跑的节奏。 */
  readonly effectiveIntervalMs: number;
  readonly expiresAt: string;
}

export interface SubscribeRequest {
  /**
   * 续这个订阅而不是拿一个新的。一个已经过期的 id 不是错误：会发一个新订阅，客户端
   * 从响应里得知新的 id。
   */
  readonly subscriptionId?: string;
  /** 这个订阅者多久要一个样本。夹在 `[resources.intervalMs, 60s]`。 */
  readonly intervalMs?: number;
}

interface Watcher {
  readonly workspaceId: string;
  readonly intervalMs: number;
  expiresAtMs: number;
}

export interface ResourceServiceOptions {
  readonly database: DatabaseSync;
  readonly settings: SettingsStore | undefined;
  readonly bus: EventBus;
  readonly dataDir: string;
  readonly now?: () => number;
  /** 哪些工作空间现在有人在看事件流；默认问 R1b 的事件流。 */
  readonly audience?: (workspaceId: string) => number;
  /** 注入的进程表读取，测试用。缺省异步读 `ps`。 */
  readonly sampler?: Sampler;
  /** 注入的 tmux 会话 → pid，测试用。缺省异步问这个数据目录的 tmux。 */
  readonly panes?: () => Promise<ReadonlyMap<string, number>>;
  /** 注入的三个低频探针，测试用。缺省按 {@link PROBE_TTL_MS} 缓存的异步探针。 */
  readonly probes?: {
    readonly pressure: () => Promise<string | null>;
    readonly power: () => Promise<PowerSource>;
    readonly swap: () => Promise<{
      totalBytes: number | null;
      usedBytes: number | null;
    }>;
  };
  /** 采样计数与事件循环延迟（契约 §54）。缺省自己建一份（不启用延迟监视）。 */
  readonly metrics?: RuntimeMetrics;
  /** 语言域记下来的服务器进程。 */
  readonly languageProcesses?: () => readonly TrackedProcess[];
  /** 测试注入；缺省读 headless 后端登记的来源（`platform.browserProcesses`）。 */
  readonly browserProcesses?: () => readonly TrackedProcess[];
  /** 测试注入；缺省读壳最近一次的报告（`platform.shellProcesses`）。 */
  readonly shellProcesses?: () => readonly ShellProcessReport[];
  /**
   * 当下的电源状态，由租约簿回答。不给就只报策略与机制、租约恒空——单测与
   * 任何只要一次采样的调用方不必先装一个租约簿。
   */
  readonly power?: () => PowerState;
  /**
   * 每份发出去的样本再交给它一次：阈值判定（`thresholds.ts`，契约 §27.4）。
   * 抛错不影响采样。
   */
  readonly onSample?: (snapshot: ResourceSnapshot) => void;
}

export class ResourceService {
  private readonly watchers = new Map<string, Watcher>();
  private readonly sampler: Sampler;
  private readonly now: () => number;
  private readonly audience: (workspaceId: string) => number;
  private timer: NodeJS.Timeout | undefined;
  /** 正在进行的那一轮；`GET` 与阈值慢轮搭它，不另起。 */
  private roundPromise: Promise<SampleRound> | undefined;
  private lastRound: SampleRound | undefined;
  private lastRoundDoneMs = 0;
  /** 采样循环的一拍还没走完（包括它之后的发布）。 */
  private ticking = false;
  readonly metrics: RuntimeMetrics;
  private readonly probeCache: ProbeCache;

  constructor(private readonly options: ResourceServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sampler =
      options.sampler ?? new Sampler(this.now, () => readProcessTableAsync());
    this.audience =
      options.audience ??
      ((workspaceId) => eventStream()?.subscriberCount(workspaceId) ?? 0);
    this.metrics = options.metrics ?? new RuntimeMetrics();
    this.probeCache = new ProbeCache(this.now, () =>
      this.metrics.sampling.noteTimeout("probe"),
    );
  }

  /** 配置好的节奏：任何订阅者能要求的最快值。 */
  private configuredInterval(): number {
    const value = this.options.settings?.get("resources.intervalMs");
    return typeof value === "number" && value > 0 ? value : DEFAULT_INTERVAL_MS;
  }

  /**
   * 一个订阅者被授予什么。要求更慢的被满足；要求比设置更快的不被满足，因为设置就是
   * 预算。
   */
  private grantedInterval(requested: number | undefined): number {
    const configured = this.configuredInterval();
    if (requested === undefined) return configured;
    const ceiling = Math.max(MAX_REQUESTED_INTERVAL_MS, configured);
    return Math.min(Math.max(requested, configured), ceiling);
  }

  /** 循环跑的节奏：所有活订阅里最快的那个。 */
  effectiveInterval(): number {
    this.prune();
    let fastest: number | undefined;
    for (const watcher of this.watchers.values()) {
      if (fastest === undefined || watcher.intervalMs < fastest) {
        fastest = watcher.intervalMs;
      }
    }
    return fastest ?? this.configuredInterval();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, watcher] of this.watchers) {
      if (watcher.expiresAtMs <= now) this.watchers.delete(id);
    }
  }

  /** 拿或者续一个订阅，并在采样循环没在跑时把它起起来。 */
  subscribe(workspaceId: string, request: SubscribeRequest): Subscription {
    const intervalMs = this.grantedInterval(request.intervalMs);
    const ttl = Math.max(intervalMs * TTL_INTERVALS, MIN_SUBSCRIPTION_TTL_MS);
    const expiresAtMs = this.now() + ttl;
    this.prune();
    let id = request.subscriptionId;
    if (id === undefined || !this.watchers.has(id)) {
      id =
        this.watchers.size >= MAX_SUBSCRIPTIONS
          ? // 每个位子都活着；复用最接近过期的那个，而不是无界地长。客户端从
            // 响应里得知它实际拿到的 id。
            ([...this.watchers.entries()].sort(
              (left, right) => left[1].expiresAtMs - right[1].expiresAtMs,
            )[0]?.[0] ?? uuid())
          : uuid();
    }
    this.watchers.set(id, { workspaceId, intervalMs, expiresAtMs });
    this.ensurePump();
    return {
      subscriptionId: id,
      workspaceId,
      intervalMs,
      effectiveIntervalMs: this.effectiveInterval(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /** 丢掉一个订阅。未知 id 被忽略：一个面板关两次不是错误。 */
  unsubscribe(subscriptionId: string): void {
    this.watchers.delete(subscriptionId);
  }

  /** 采样循环这一拍会不会采这个工作空间：有活订阅、且有人连着事件流。 */
  watching(workspaceId: string): boolean {
    return (
      this.timer !== undefined &&
      this.subscribedWorkspaces().includes(workspaceId) &&
      this.audience(workspaceId) > 0
    );
  }

  /** 现在至少有一个活订阅的工作空间。 */
  private subscribedWorkspaces(): string[] {
    this.prune();
    const workspaces = new Set<string>();
    for (const watcher of this.watchers.values()) {
      workspaces.add(watcher.workspaceId);
    }
    return [...workspaces].sort();
  }

  /**
   * 读一轮整机的表。正在进行的那一轮直接搭上；`reuseMs` 之内刚完成的那一轮也
   * 直接用。`ps` 或 `tmux` 超时抛 {@link SampleTimeout}，计数，这一轮作废。
   */
  round(reuseMs = ROUND_REUSE_MS): Promise<SampleRound> {
    if (this.roundPromise !== undefined) return this.roundPromise;
    if (
      this.lastRound !== undefined &&
      reuseMs > 0 &&
      this.now() - this.lastRoundDoneMs <= reuseMs
    ) {
      return Promise.resolve(this.lastRound);
    }
    const started = performance.now();
    this.metrics.sampling.inFlight = true;
    const work = this.readRound().then(
      (sampled) => {
        this.lastRound = sampled;
        this.lastRoundDoneMs = this.now();
        this.metrics.sampling.noteRound(
          performance.now() - started,
          sampled.atMs,
        );
        return sampled;
      },
      (error: unknown) => {
        if (error instanceof SampleTimeout) {
          this.metrics.sampling.noteTimeout(error.source);
        }
        throw error;
      },
    );
    const settled = work.finally(() => {
      if (this.roundPromise === settled) this.roundPromise = undefined;
      this.metrics.sampling.inFlight = false;
    });
    this.roundPromise = settled;
    return settled;
  }

  private async readRound(): Promise<SampleRound> {
    const probes = this.options.probes;
    // 探针不进这一轮的关键路径：缓存交出旧值、后台去问（注入的探针照样经缓存）。
    const pressure = this.probeCache.cached(
      "pressure",
      PROBE_TTL_MS.pressure,
      probes?.pressure ?? memoryPressureAsync,
      null,
    );
    const power = this.probeCache.cached(
      "power",
      PROBE_TTL_MS.power,
      probes?.power ?? powerSourceAsync,
      { source: null, batteryPercent: null, charging: null },
    );
    const swap = this.probeCache.cached(
      "swap",
      PROBE_TTL_MS.swap,
      probes?.swap ?? swapUsageAsync,
      { totalBytes: null, usedBytes: null },
    );
    const panes =
      this.options.panes ?? (() => panePidsAsync(this.options.dataDir));
    const [refresh, pids] = await Promise.all([
      this.sampler.refreshAsync(),
      // 注入的读取不一定认超时，期限在这里再加一道。
      deadline(panes(), TMUX_TIMEOUT_MS, "tmux"),
    ]);
    return {
      refresh,
      pids,
      pressure,
      power,
      swap,
      cpuCores: cpus().length,
      atMs: refresh.atMs,
    };
  }

  /** 一个工作空间的一次采样：取（或搭）一轮，再算这个工作空间的那一份。 */
  async snapshot(workspaceId: string): Promise<ResourceSnapshot> {
    return this.snapshotFrom(await this.round(), workspaceId);
  }

  /**
   * 纯计算：一轮整机的表 → 一个工作空间的快照。SQL、树求和、组件、孤立会话；
   * 不跑任何外部命令。采样中途被删掉的工作空间查出来就是空数组，不抛。
   */
  snapshotFrom(sampled: SampleRound, workspaceId: string): ResourceSnapshot {
    const { refresh, pids } = sampled;
    const targets = sessionTargets(this.options.database, workspaceId, pids);
    const children = childrenByParent(refresh.table);
    const sessions = targets
      .map((target) =>
        sessionResources(
          target,
          refresh,
          refresh.previousTable,
          refresh.elapsedMs,
          children,
        ),
      )
      .filter((session) => !isGone(session));
    const orphans = listOrphans(
      this.options.database,
      workspaceId,
      aliveBackendReferences(pids),
    );
    const sampledAt = new Date(refresh.atMs).toISOString();
    const cores = sampled.cpuCores;
    return {
      workspaceId,
      host: hostResources({
        dataDir: this.options.dataDir,
        cpuCores: cores,
        pressure: sampled.pressure,
        power: sampled.power,
        swap: sampled.swap,
        cpuPercent: hostCpuPercent(refresh, cores),
        sampledAt,
      }),
      sessions,
      components: components({
        table: refresh.table,
        previousTable: refresh.previousTable,
        elapsedMs: refresh.elapsedMs,
        selfPid: process.pid,
        language: this.options.languageProcesses?.() ?? [],
        // 服务器壳上浏览器节点的页面在 core 自己起的 headless Chromium 里，
        // 按 pid + 启动时间计入（按树算，渲染进程是它的子进程）。桌面壳上
        // 这里是空的：那些页面是窗口的 guest，由壳报上来，在下面那一组里。
        browsers: this.options.browserProcesses?.() ?? browserProcesses(),
      }).concat(
        shellComponents({
          reports: this.options.shellProcesses?.() ?? shellProcesses(),
          table: refresh.table,
          previousTable: refresh.previousTable,
          elapsedMs: refresh.elapsedMs,
          selfPid: process.pid,
        }),
      ),
      orphans,
      power: this.powerState(),
      intervalMs: this.effectiveInterval(),
      sampledAt,
    };
  }

  private powerState(): PowerState {
    const held = this.options.power?.();
    if (held !== undefined) return held;
    const policy = this.options.settings?.get("power.policy");
    const available =
      process.platform === "darwin" || process.platform === "linux";
    return {
      policy: typeof policy === "string" ? policy : "manual",
      holding: false,
      mechanism: null,
      inhibitor: {
        platform:
          process.platform === "darwin"
            ? "macos"
            : process.platform === "win32"
              ? "windows"
              : process.platform === "linux"
                ? "linux"
                : "unknown",
        kind: available
          ? process.platform === "darwin"
            ? "caffeinate"
            : "systemd-inhibit"
          : null,
        available,
        detail: available ? null : "no inhibit mechanism on this platform",
      },
      leases: [],
    };
  }

  /**
   * 起采样循环，除非已经有一个在跑。
   *
   * 循环在最后一个订阅过期时自己返回，所以没有人开着面板时什么都不被拖着活。
   */
  private ensurePump(): void {
    if (this.timer !== undefined) return;
    this.schedule();
  }

  /**
   * 采样循环的一拍。一轮整机表给所有在看的工作空间；下一拍在这一拍**走完之后**
   * 才挂（`setTimeout`，不是 `setInterval`），所以循环自己不会叠。上一拍还没走完
   * （停掉又重起的循环撞上一个还挂着的读）就跳过并计数。
   */
  private async tick(): Promise<void> {
    if (this.ticking) {
      this.metrics.sampling.noteOverlap();
      this.schedule();
      return;
    }
    const workspaces = this.subscribedWorkspaces();
    if (workspaces.length === 0) {
      this.stop();
      return;
    }
    // 即使订阅还在，没有人连着这个工作空间的事件流时这一帧也发不到任何人手里。
    // 不采样，而不是采完再丢掉——采样本身才是那笔开销。
    const audience = workspaces.filter(
      (workspaceId) => this.audience(workspaceId) > 0,
    );
    if (audience.length === 0) {
      this.schedule();
      return;
    }
    this.ticking = true;
    try {
      let sampled: SampleRound;
      try {
        sampled = await this.round();
      } catch {
        // 超时或读失败：这一轮不发（面板留着上一帧），下一拍再试。
        return;
      }
      for (const workspaceId of audience) {
        try {
          const snapshot = this.snapshotFrom(sampled, workspaceId);
          this.options.bus.emit("workspace.event", {
            workspaceId,
            event: { type: "resource.sample", snapshot } as never,
          });
          try {
            this.options.onSample?.(snapshot);
          } catch {
            // 阈值判定出错不停采样。
          }
        } catch {
          // 一次采样失败不该停掉循环：下一拍再试。
        }
      }
      this.metrics.checkSlowLoop();
    } finally {
      this.ticking = false;
      // 循环在这一拍里被停掉（最后一个订阅过期）就不再挂下一拍。
      if (this.timer !== undefined) this.schedule();
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), this.effectiveInterval());
    // 采样循环不该把进程拖着不退。
    this.timer.unref?.();
  }

  /** 停掉循环。装配方在 core 关闭时调它；循环自己在最后一个订阅过期时也调。 */
  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 这一轮有没有一个采样循环在跑，给测试和诊断看。 */
  sampling(): boolean {
    return this.timer !== undefined;
  }
}

/**
 * 全机 CPU：所有进程的 CPU 差之和除以核数。
 *
 * 没有基线时是 `null`——第一次采样没有可减的东西，报 0 会画出一台空闲的机器。
 */
function hostCpuPercent(
  refresh: {
    table: Map<number, import("./sample").ProcessRow>;
    previousTable: Map<number, import("./sample").ProcessRow> | undefined;
    elapsedMs: number;
  },
  cores: number,
): number | null {
  if (refresh.previousTable === undefined || cores <= 0) return null;
  let total = 0;
  let known = false;
  for (const row of refresh.table.values()) {
    const percent = cpuPercent(row, refresh.previousTable, refresh.elapsedMs);
    if (percent !== null) {
      total += percent;
      known = true;
    }
  }
  return known ? round(Math.min(total / cores, 100)) : null;
}
