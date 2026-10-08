import { homedir } from "node:os";
import { join } from "node:path";
import type { EventBus } from "../bus";

/**
 * 启动闸门（界面第二波 §8.2、契约 §52）：同一份 CLI 配置目录上的启动排队。
 *
 * 同时敲出三个 Codex 时，它们会同时迁移同一个状态库、同时对同一个账号做路由
 * 探测，于是有一个起不来。闸门按 `(agentId, 配置目录)` 排队：Codex 一次只放一
 * 个，持有者报出第一条状态（`SessionStart` 之类）或者 {@link GatePolicy.holdMs}
 * 到期，先到者放行下一个，下一个再加一点抖动。其余 CLI 不排队。
 *
 * 它是减速带不是门禁：等满上限就放（`granted: false`），调用方照常启动。状态只
 * 在内存里，重启即清空。
 */

export interface GatePolicy {
  /** 同一个键上同时启动的上限。 */
  readonly concurrency: number;
  /** 持有者最长占用多久（毫秒）。 */
  readonly holdMs: number;
  /** 放行下一个之前的随机间隔（毫秒，闭区间）。 */
  readonly jitterMs: readonly [number, number];
}

const FREE: GatePolicy = {
  concurrency: Number.POSITIVE_INFINITY,
  holdMs: 0,
  jitterMs: [0, 0],
};

/** 策略表。core 常量，不是用户设置。 */
export const GATE_POLICIES: Readonly<Record<string, GatePolicy>> = {
  codex: { concurrency: 1, holdMs: 6_000, jitterMs: [500, 1_500] },
};

/** 一次申请最多等这么久（毫秒）；与 `launch-slot` 长轮询的上限同一个数。 */
export const SLOT_WAIT_MS = 30_000;

export function policyFor(baseAgentId: string): GatePolicy {
  return GATE_POLICIES[baseAgentId] ?? FREE;
}

/**
 * 这家 CLI 的配置目录：闸门的另一半键。两个节点用不同的 `CODEX_HOME` 就不共享
 * 状态库与登录态，不必排在一起。
 */
export function configDirFor(
  baseAgentId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const given = (name: string) => {
    const value = env[name];
    return value !== undefined && value !== "" ? value : undefined;
  };
  switch (baseAgentId) {
    case "codex":
      return given("CODEX_HOME") ?? join(home, ".codex");
    case "claude":
      return given("CLAUDE_CONFIG_DIR") ?? join(home, ".claude");
    default:
      return join(home, `.${baseAgentId}`);
  }
}

export interface SlotRequest {
  /** 内置 Agent 的 id（自定义条目按它的 base）。 */
  readonly agentId: string;
  readonly configDir: string;
  readonly nodeId: string;
  /** 缺省 {@link SLOT_WAIT_MS}。 */
  readonly timeoutMs?: number;
}

export interface SlotAnswer {
  /** `false`：等满上限没轮到（或被同一节点的新申请顶掉），调用方照常启动。 */
  readonly granted: boolean;
  readonly waitedMs: number;
}

export interface GateClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** `[0, 1)`。 */
  random(): number;
}

const SYSTEM_CLOCK: GateClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // 闸门的定时器不该让进程多活一秒。
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  random: () => Math.random(),
};

interface Waiter {
  readonly nodeId: string;
  readonly since: number;
  readonly timer: unknown;
  readonly resolve: (answer: SlotAnswer) => void;
}

interface Lane {
  readonly policy: GatePolicy;
  /** 持有者 → 它的 holdMs 定时器。 */
  readonly holders: Map<string, unknown>;
  readonly queue: Waiter[];
  /** 下一个最早什么时候能放（放行后的抖动）。 */
  notBefore: number;
  /** 等 `notBefore` 到点的那个定时器。 */
  wake: unknown;
}

export class LaunchGate {
  private readonly lanes = new Map<string, Lane>();
  /** 节点 → 它所在的键：持有与等待都按节点找。 */
  private readonly laneOf = new Map<string, string>();

  constructor(private readonly clock: GateClock = SYSTEM_CLOCK) {}

  acquire(request: SlotRequest): Promise<SlotAnswer> {
    const policy = policyFor(request.agentId);
    if (!Number.isFinite(policy.concurrency)) {
      return Promise.resolve({ granted: true, waitedMs: 0 });
    }
    const key = `${request.agentId}\u0000${request.configDir}`;
    // 同一节点再申请一次（重试、页面重载）：先让出它原来的位置。
    this.forget(request.nodeId);
    const lane = this.lane(key, policy);
    this.laneOf.set(request.nodeId, key);
    const since = this.clock.now();
    return new Promise<SlotAnswer>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        const index = lane.queue.findIndex(
          (waiter) => waiter.nodeId === request.nodeId,
        );
        if (index < 0) return;
        lane.queue.splice(index, 1);
        if (this.laneOf.get(request.nodeId) === key) {
          this.laneOf.delete(request.nodeId);
        }
        resolve({ granted: false, waitedMs: this.clock.now() - since });
      }, request.timeoutMs ?? SLOT_WAIT_MS);
      lane.queue.push({ nodeId: request.nodeId, since, timer, resolve });
      this.pump(key);
    });
  }

  /**
   * 持有者起来了（报出第一条状态，ACP 的 `session/new` 返回了），或者启动已经
   * 判了失败：放行下一个。不是持有者时什么都不做。
   */
  release(nodeId: string): void {
    const key = this.laneOf.get(nodeId);
    if (key === undefined) return;
    const lane = this.lanes.get(key);
    if (lane === undefined || !lane.holders.has(nodeId)) return;
    this.clock.clearTimeout(lane.holders.get(nodeId));
    lane.holders.delete(nodeId);
    this.laneOf.delete(nodeId);
    this.cooldown(lane);
    this.pump(key);
  }

  /** 节点删了：持有就放行，排着就出队（答 `granted: false`）。 */
  forget(nodeId: string): void {
    const key = this.laneOf.get(nodeId);
    if (key === undefined) return;
    const lane = this.lanes.get(key);
    if (lane === undefined) return;
    if (lane.holders.has(nodeId)) {
      this.release(nodeId);
      return;
    }
    const index = lane.queue.findIndex((waiter) => waiter.nodeId === nodeId);
    if (index >= 0) {
      const [waiter] = lane.queue.splice(index, 1);
      this.clock.clearTimeout(waiter!.timer);
      waiter!.resolve({
        granted: false,
        waitedMs: this.clock.now() - waiter!.since,
      });
    }
    this.laneOf.delete(nodeId);
  }

  /** 这个节点此刻是否持有一个位置。 */
  holds(nodeId: string): boolean {
    const key = this.laneOf.get(nodeId);
    return (
      key !== undefined && this.lanes.get(key)?.holders.has(nodeId) === true
    );
  }

  /** 这个节点前面还有几个（持有者也算）；不在队里是 `undefined`。 */
  position(nodeId: string): number | undefined {
    const key = this.laneOf.get(nodeId);
    const lane = key === undefined ? undefined : this.lanes.get(key);
    if (lane === undefined) return undefined;
    if (lane.holders.has(nodeId)) return 0;
    const index = lane.queue.findIndex((waiter) => waiter.nodeId === nodeId);
    return index < 0 ? undefined : lane.holders.size + index;
  }

  private lane(key: string, policy: GatePolicy): Lane {
    let lane = this.lanes.get(key);
    if (lane === undefined) {
      lane = {
        policy,
        holders: new Map(),
        queue: [],
        notBefore: 0,
        wake: undefined,
      };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  private cooldown(lane: Lane): void {
    const [low, high] = lane.policy.jitterMs;
    const jitter = low + Math.floor(this.clock.random() * (high - low + 1));
    lane.notBefore = Math.max(lane.notBefore, this.clock.now() + jitter);
  }

  private pump(key: string): void {
    const lane = this.lanes.get(key);
    if (lane === undefined) return;
    while (
      lane.queue.length > 0 &&
      lane.holders.size < lane.policy.concurrency
    ) {
      const now = this.clock.now();
      if (now < lane.notBefore) {
        if (lane.wake === undefined) {
          lane.wake = this.clock.setTimeout(() => {
            lane.wake = undefined;
            this.pump(key);
          }, lane.notBefore - now);
        }
        return;
      }
      const waiter = lane.queue.shift()!;
      this.clock.clearTimeout(waiter.timer);
      lane.holders.set(
        waiter.nodeId,
        this.clock.setTimeout(() => {
          // 到期：当它起来了。
          if (lane.holders.has(waiter.nodeId)) this.release(waiter.nodeId);
        }, lane.policy.holdMs),
      );
      waiter.resolve({ granted: true, waitedMs: now - waiter.since });
    }
    if (
      lane.queue.length === 0 &&
      lane.holders.size === 0 &&
      lane.wake === undefined &&
      this.clock.now() >= lane.notBefore
    ) {
      this.lanes.delete(key);
    }
  }
}

/* --------------------------------- 失败判定 -------------------------------- */

/** 启动行敲出后，这么久之内 CLI 没了就算启动失败（设计 §8.3）。 */
export const LAUNCH_WATCH_MS = 30_000;
/** 敲出之后先等这么久再看前台：shell 还没来得及 fork。 */
export const LAUNCH_GRACE_MS = 1_500;
/** 看前台的间隔。 */
export const LAUNCH_POLL_MS = 1_000;

/**
 * 一次启动的结果：
 *
 *   * `started`：报过状态，或者看满窗口它还在；
 *   * `failed`：窗口内 shell 的前台空了（CLI 退出了）而它一条状态都没报；
 *   * `unknown`：这个终端后端答不出前台（Windows 的会话宿主），或者没有终端。
 */
export type LaunchVerdict = "started" | "failed" | "unknown";

/** shell 下面有没有进程；`undefined` 表示答不上来。 */
export type PaneProbe = () => Promise<"busy" | "idle" | undefined>;

export interface LaunchWatch {
  readonly probe: PaneProbe;
  /** 从开始看到现在，这个节点报过状态没有。 */
  readonly reported: () => boolean;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly windowMs?: number;
  readonly graceMs?: number;
  readonly pollMs?: number;
}

/**
 * 看一次启动的结果。不读屏幕：只看 shell 下面还有没有进程、节点报没报过状态
 * ——终端原始输出不进任何判据。
 *
 * 退出码拿不到（启动行是敲进 shell 的），所以「前台连续两次为空且一条状态都
 * 没报」就算失败；一个人在 30 秒内自己退掉、又从没报过状态的 CLI 也会被当成
 * 启动失败，代价是多一次自动重敲。
 */
export async function watchLaunch(watch: LaunchWatch): Promise<LaunchVerdict> {
  const now = watch.now ?? (() => Date.now());
  const delay =
    watch.delay ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const windowMs = watch.windowMs ?? LAUNCH_WATCH_MS;
  await delay(watch.graceMs ?? LAUNCH_GRACE_MS);
  let idle = 0;
  for (;;) {
    if (watch.reported()) return "started";
    let pane: "busy" | "idle" | undefined;
    try {
      pane = await watch.probe();
    } catch {
      pane = undefined;
    }
    if (pane === undefined) return "unknown";
    idle = pane === "idle" ? idle + 1 : 0;
    if (idle >= 2) return watch.reported() ? "started" : "failed";
    if (now() - started >= windowMs) return "started";
    await delay(watch.pollMs ?? LAUNCH_POLL_MS);
  }
}

/* --------------------------------- 单例 -------------------------------------- */

let shared: LaunchGate | undefined;
/** 装配过的那一个；没装配（用例、只起部分域的构建）时 core 内的启动不排队。 */
let active: LaunchGate | undefined;

/** 运行中的 core 只有一个闸门：页面的申请、依赖启动与 ACP 走同一份。 */
export function launchGate(): LaunchGate {
  shared ??= new LaunchGate();
  return shared;
}

/** core 自己启动节点（依赖、运行）时用的闸门；没装配时 `undefined`。 */
export function activeLaunchGate(): LaunchGate | undefined {
  return active;
}

/** 来源是上报（不是观察、不是重启读回来的行）的一条状态。 */
const REPORTED = new Set(["hook", "extension", "acp"]);

/**
 * 装配闸门：持有者的节点报出第一条状态（`SessionStart` 或任何一条真上报）就
 * 放行下一个。返回退订。
 */
export function installLaunchGate(bus: EventBus): () => void {
  const gate = launchGate();
  active = gate;
  const off = bus.on("workspace.event", ({ event }) => {
    if (event.type !== "agent.status") return;
    const status = event.status as {
      readonly nodeId?: unknown;
      readonly stateSource?: unknown;
      readonly restored?: unknown;
    };
    if (typeof status.nodeId !== "string") return;
    if (status.restored === true) return;
    if (!REPORTED.has(String(status.stateSource ?? ""))) return;
    gate.release(status.nodeId);
  });
  return () => {
    off();
    if (active === gate) active = undefined;
  };
}

/** 用例之间换一份干净的。 */
export function resetLaunchGate(gate?: LaunchGate): void {
  shared = gate;
  active = undefined;
}
