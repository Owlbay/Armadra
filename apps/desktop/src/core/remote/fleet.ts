/**
 * Worker 舰队：每台执行主机上的 Worker 是哪个版本、声明了哪些能力、是否过旧
 * （契约 §21.2）。
 *
 * 数据只来自握手：控制连接每次握手成功（`RemoteWorker.probe`）都把对方的
 * `runtimeVersion` 与能力集合记一笔；连接断了只把 `connected` 置假，版本与能力
 * 留着——「上次见到它时是什么样」正是执行主机页要显示的。没握过手的主机没有
 * 记录，页面不猜。
 *
 * 「过旧」是两件事之一：
 *
 *  1. 版本比这个控制端旧（按点分数字比，预发布低于同号正式版）；
 *  2. 缺这个控制端的 Worker 会声明的任何一个能力（{@link WORKER_CAPABILITIES}）。
 *
 * 比控制端新的 Worker 不算过旧：握手已经按契约版本接受了它，多出来的能力用不
 * 上也无害。版本串读不出来（空串、非数字）时只按能力判。
 *
 * 舰队是模块级的一份，与远端域同生命周期：设置域（执行主机列表）和 Hook 域
 * （集成状态）都要读它，而它们不该为此 import 远端域的装配点。重新同步与「注入
 * 同步时 Worker 只有 v1」这两样只有远端域知道，由它装配时经 {@link setFleetHooks}
 * 登记。
 */

import { VERSION } from "../instance";
import { WORKER_CAPABILITIES } from "./capabilities";

/** 一台执行主机的 Worker，执行主机行的 `worker` 字段（契约 §21.2）。 */
export interface WorkerStatus {
  /** 对方握手时报的 `runtimeVersion`；没报是空串。 */
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly outdated: boolean;
  /** 控制连接现在是否活着。 */
  readonly connected: boolean;
  /** 最近一次握手成功的时间（RFC 3339）。 */
  readonly checkedAt: string;
}

/** 集成状态 `outdatedHosts[]` 的一项（共享层 `outdatedHostSchema`）。 */
export interface OutdatedHost {
  readonly hostId: string;
  readonly name?: string;
  readonly version?: string;
}

export interface FleetExpectation {
  readonly version: string;
  readonly capabilities: readonly string[];
}

/**
 * 比两个版本：负数是 `a` 更旧。点分数字逐段比；同号时带预发布后缀的更旧；
 * 构建元数据（`+…`）不参与比较。读不出数字的段按字符串比。
 */
export function compareVersions(a: string, b: string): number {
  const split = (value: string): { core: string[]; pre: string } => {
    const bare = value.trim().replace(/^v/iu, "").split("+")[0] ?? "";
    const dash = bare.indexOf("-");
    return dash < 0
      ? { core: bare.split("."), pre: "" }
      : { core: bare.slice(0, dash).split("."), pre: bare.slice(dash + 1) };
  };
  const left = split(a);
  const right = split(b);
  const length = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < length; index += 1) {
    const x = left.core[index] ?? "0";
    const y = right.core[index] ?? "0";
    const nx = /^\d+$/u.test(x) ? Number(x) : Number.NaN;
    const ny = /^\d+$/u.test(y) ? Number(y) : Number.NaN;
    if (Number.isNaN(nx) || Number.isNaN(ny)) {
      if (x !== y) return x < y ? -1 : 1;
      continue;
    }
    if (nx !== ny) return nx < ny ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === "") return 1;
  if (right.pre === "") return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** 版本读得出来的样子：至少一段数字开头。 */
function comparable(version: string): boolean {
  return /^v?\d+(\.\d+)*([-+].*)?$/iu.test(version.trim());
}

/** 按上面两条判「过旧」。 */
export function isOutdated(
  version: string,
  capabilities: Iterable<string>,
  expected: FleetExpectation = {
    version: VERSION,
    capabilities: WORKER_CAPABILITIES,
  },
): boolean {
  const have = new Set(capabilities);
  if (expected.capabilities.some((capability) => !have.has(capability))) {
    return true;
  }
  return (
    comparable(version) &&
    comparable(expected.version) &&
    compareVersions(version, expected.version) < 0
  );
}

export class WorkerFleet {
  private readonly hosts = new Map<string, WorkerStatus>();

  constructor(
    private readonly expected: FleetExpectation = {
      version: VERSION,
      capabilities: WORKER_CAPABILITIES,
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 控制连接握手成功。 */
  handshake(
    hostId: string,
    hello: {
      readonly runtimeVersion: string;
      readonly capabilities: Iterable<string>;
    },
  ): WorkerStatus {
    const capabilities = [...new Set(hello.capabilities)].sort();
    const status: WorkerStatus = {
      version: hello.runtimeVersion,
      capabilities,
      outdated: isOutdated(hello.runtimeVersion, capabilities, this.expected),
      connected: true,
      checkedAt: this.now().toISOString(),
    };
    this.hosts.set(hostId, status);
    return status;
  }

  /** 控制连接断了：记录留着，只是不再「在线」。 */
  disconnected(hostId: string): void {
    const status = this.hosts.get(hostId);
    if (status === undefined || !status.connected) return;
    this.hosts.set(hostId, { ...status, connected: false });
  }

  /** 主机从配置里删掉了。 */
  forget(hostId: string): void {
    this.hosts.delete(hostId);
  }

  status(hostId: string): WorkerStatus | undefined {
    return this.hosts.get(hostId);
  }

  /** 最近一次握手判为过旧的主机。 */
  outdated(): string[] {
    return [...this.hosts]
      .filter(([, status]) => status.outdated)
      .map(([hostId]) => hostId);
  }

  clear(): void {
    this.hosts.clear();
  }
}

let fleet = new WorkerFleet();

/** 这个 core 的舰队。 */
export function workerFleet(): WorkerFleet {
  return fleet;
}

/** 换一份舰队（测试用）；返回之前那一份。 */
export function setWorkerFleet(next: WorkerFleet): WorkerFleet {
  const previous = fleet;
  fleet = next;
  return previous;
}

/** 只有远端域知道的几样，它装配时登记。 */
export interface FleetHooks {
  /** 重连这台主机的 Worker（新握手），再把画布注入重新同步一次。 */
  resync(hostId: string): Promise<void>;
  /** 注入同步时 Worker 只有 `remote.integration.v1` 的主机。 */
  integrationOutdated(): readonly string[];
  /** 主机在设置里的名字。 */
  hostName(hostId: string): string | undefined;
}

let hooks: FleetHooks | undefined;

export function setFleetHooks(
  next: FleetHooks | undefined,
): FleetHooks | undefined {
  const previous = hooks;
  hooks = next;
  return previous;
}

export function fleetHooks(): FleetHooks | undefined {
  return hooks;
}

/**
 * 集成状态的 `outdatedHosts[]`：舰队判为过旧的，加上注入同步时只有 v1 的
 * （`RemoteIntegration.outdatedWorkers()`）。按主机 id 去重、排序。
 */
export function outdatedHosts(): OutdatedHost[] {
  const ids = new Set<string>([
    ...fleet.outdated(),
    ...(hooks?.integrationOutdated() ?? []),
  ]);
  return [...ids].sort().map((hostId) => {
    const version = fleet.status(hostId)?.version;
    const name = hooks?.hostName(hostId);
    return {
      hostId,
      ...(name === undefined || name === "" ? {} : { name }),
      ...(version === undefined || version === "" ? {} : { version }),
    };
  });
}
