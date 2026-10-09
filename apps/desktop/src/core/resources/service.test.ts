import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventBus, type WorkspaceEvent } from "../bus";
import { openDatabase, type OpenedDatabase } from "../db/open";
import { createWorkspace } from "../workspaces/table";
import {
  MAX_REQUESTED_INTERVAL_MS,
  MAX_SUBSCRIPTIONS,
  MIN_SUBSCRIPTION_TTL_MS,
  ResourceService,
  type ResourceServiceOptions,
} from "./service";
import { Sampler, SampleTimeout, type ProcessRow } from "./sample";
import { ProbeCache } from "./platform-probe";
import {
  listOrphans,
  adoptOrphan,
  orphanTarget,
  OrphanError,
} from "./sessions";

const here = dirname(fileURLToPath(import.meta.url));

function row(pid: number, parent = 1): ProcessRow {
  return {
    pid,
    parent,
    rssBytes: 4096,
    cpuMs: 0,
    startTimeUnixMs: 1_000,
    state: "sleeping",
    name: "zsh",
    path: "/bin/zsh",
  };
}

interface Fixture {
  readonly db: OpenedDatabase;
  readonly bus: EventBus;
  readonly dataDir: string;
  readonly workspaceId: string;
  readonly events: { workspaceId: string; event: WorkspaceEvent }[];
  clock: number;
  watchers: number;
  /** 交给 `onSample` 的样本属于哪个工作空间。 */
  readonly samples: string[];
  service: ResourceService;
  close(): void;
}

function fixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-resources-"));
  const db = openDatabase({
    file: join(dataDir, "canvas.db"),
    migrationsDir: resolve(here, "../db/migrations"),
  });
  // 工作空间的 id 是库生成的；测试按它回填，而不是硬写一个。
  const workspace = createWorkspace(db.database, {
    name: "一",
    rootPath: dataDir,
  });
  const bus = new EventBus();
  const events: { workspaceId: string; event: WorkspaceEvent }[] = [];
  bus.on("workspace.event", (frame) => events.push(frame));
  const state = {
    db,
    bus,
    dataDir,
    workspaceId: workspace.id,
    events,
    clock: 1_000_000,
    watchers: 1,
    samples: [] as string[],
    service: undefined as unknown as ResourceService,
    close() {
      state.service.stop();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  state.service = new ResourceService({
    database: db.database,
    settings: undefined,
    bus,
    dataDir,
    now: () => state.clock,
    audience: () => state.watchers,
    onSample: (snapshot) => state.samples.push(snapshot.workspaceId),
    sampler: new Sampler(
      () => state.clock,
      () => new Map([[process.pid, row(process.pid)]]),
    ),
    panes: async () => new Map(),
    probes: {
      pressure: async () => null,
      power: async () => ({
        source: null,
        batteryPercent: null,
        charging: null,
      }),
      swap: async () => ({ totalBytes: null, usedBytes: null }),
    },
  });
  return state;
}

describe("资源采样的订阅", () => {
  let state: Fixture;

  beforeEach(() => {
    state = fixture();
  });

  afterEach(() => {
    state.close();
  });

  it("没有订阅时循环不跑", () => {
    expect(state.service.sampling()).toBe(false);
  });

  it("第一个订阅起循环，最后一个过期之后它自己停", async () => {
    const subscription = state.service.subscribe(state.workspaceId, {});
    expect(state.service.sampling()).toBe(true);
    state.service.unsubscribe(subscription.subscriptionId);
    // 循环在**下一拍**才发现没有订阅了，于是停掉自己——它不会在退订的那一刻被
    // 打断，因为一次已经安排好的采样不值得为此取消。
    await new Promise((done) => setTimeout(done, 2_100));
    expect(state.service.sampling()).toBe(false);
  });

  it("要求更慢的被满足，要求比设置更快的不被满足", () => {
    // 默认 2 s 是设置的下限，也是预算。
    expect(
      state.service.subscribe(state.workspaceId, { intervalMs: 500 })
        .intervalMs,
    ).toBe(2_000);
    expect(
      state.service.subscribe(state.workspaceId, { intervalMs: 30_000 })
        .intervalMs,
    ).toBe(30_000);
    // 60 s 是上限，客户端没法停一个一小时采一次的订阅。
    expect(
      state.service.subscribe(state.workspaceId, { intervalMs: 3_600_000 })
        .intervalMs,
    ).toBe(MAX_REQUESTED_INTERVAL_MS);
  });

  it("循环按所有活订阅里最快的那个跑", () => {
    state.service.subscribe(state.workspaceId, { intervalMs: 30_000 });
    expect(state.service.effectiveInterval()).toBe(30_000);
    const fast = state.service.subscribe(state.workspaceId, {
      intervalMs: 2_000,
    });
    expect(state.service.effectiveInterval()).toBe(2_000);
    state.service.unsubscribe(fast.subscriptionId);
    expect(state.service.effectiveInterval()).toBe(30_000);
  });

  it("续订用同一个 id，过期的 id 换一个新的", () => {
    const first = state.service.subscribe(state.workspaceId, {});
    const renewed = state.service.subscribe(state.workspaceId, {
      subscriptionId: first.subscriptionId,
    });
    expect(renewed.subscriptionId).toBe(first.subscriptionId);
    state.clock += MIN_SUBSCRIPTION_TTL_MS + 1;
    const afterLapse = state.service.subscribe(state.workspaceId, {
      subscriptionId: first.subscriptionId,
    });
    expect(afterLapse.subscriptionId).not.toBe(first.subscriptionId);
  });

  it("订阅数有上限，满了复用最接近过期的那个", () => {
    const ids = new Set<string>();
    for (let index = 0; index < MAX_SUBSCRIPTIONS + 5; index += 1) {
      // 每个订阅的 TTL 一样，所以按插入顺序最早的那个最接近过期。
      state.clock += 1;
      ids.add(state.service.subscribe(state.workspaceId, {}).subscriptionId);
    }
    // 满了之后复用的是**已有**的那个 id，所以见过的 id 总数停在上限上，而不是
    // 继续长。
    expect(ids.size).toBe(MAX_SUBSCRIPTIONS);
    // 活着的从来不超过上限。
    expect(state.service.effectiveInterval()).toBe(2_000);
  });

  it("TTL 至少是下限，哪怕间隔很小", () => {
    const subscription = state.service.subscribe(state.workspaceId, {
      intervalMs: 2_000,
    });
    const ttl = Date.parse(subscription.expiresAt) - state.clock;
    expect(ttl).toBeGreaterThanOrEqual(MIN_SUBSCRIPTION_TTL_MS);
  });

  it("关掉的面板不再产生 resource.sample", async () => {
    state.service.subscribe(state.workspaceId, { intervalMs: 2_000 });
    // 有人连着：这一拍发出去。
    await new Promise((done) => setTimeout(done, 2_100));
    const withAudience = state.events.length;
    expect(withAudience).toBeGreaterThan(0);
    expect(state.events[0]?.event.type).toBe("resource.sample");

    // 没有人连着事件流了：订阅还在，但一帧都不该再发——采样本身才是那笔开销。
    state.watchers = 0;
    await new Promise((done) => setTimeout(done, 2_100));
    expect(state.events.length).toBe(withAudience);
  });

  it("发出去的样本再交给阈值判定；watching 只在这一拍真会采时为真", async () => {
    expect(state.service.watching(state.workspaceId)).toBe(false);
    state.service.subscribe(state.workspaceId, { intervalMs: 2_000 });
    expect(state.service.watching(state.workspaceId)).toBe(true);
    await new Promise((done) => setTimeout(done, 2_100));
    expect(state.samples).toContain(state.workspaceId);
    state.watchers = 0;
    expect(state.service.watching(state.workspaceId)).toBe(false);
  });

  it("快照带着这个工作空间的 id、主机那一段和电源策略", async () => {
    const snapshot = await state.service.snapshot(state.workspaceId);
    expect(snapshot.workspaceId).toBe(state.workspaceId);
    expect(snapshot.host.hostId).toBe("local");
    expect(snapshot.host.location).toBe("local");
    // 第一次采样没有基线，CPU 是 null 而不是零。
    expect(snapshot.host.cpuPercent).toBeNull();
    expect(snapshot.power.policy).toBe("manual");
    expect(snapshot.power.leases).toEqual([]);
    // core 自己那一行永远在。
    expect(snapshot.components.some((one) => one.kind === "runtime")).toBe(
      true,
    );
  });
});

describe("一轮一张表：异步、超时、不叠加", () => {
  interface Rig {
    service: ResourceService;
    readonly events: { workspaceId: string; event: WorkspaceEvent }[];
    readonly workspaces: string[];
    reads: number;
    clock: number;
    close(): void;
  }

  function rig(
    read: () => Promise<Map<number, ProcessRow>>,
    extra: Partial<ResourceServiceOptions> = {},
  ): Rig {
    const dataDir = mkdtempSync(join(tmpdir(), "armadra-rounds-"));
    const db = openDatabase({
      file: join(dataDir, "canvas.db"),
      migrationsDir: resolve(here, "../db/migrations"),
    });
    const workspaces = ["一", "二"].map((name) => {
      const rootPath = join(dataDir, name);
      mkdirSync(rootPath);
      return createWorkspace(db.database, { name, rootPath }).id;
    });
    const bus = new EventBus();
    const events: { workspaceId: string; event: WorkspaceEvent }[] = [];
    bus.on("workspace.event", (frame) => events.push(frame));
    const state: Rig = {
      service: undefined as unknown as ResourceService,
      events,
      workspaces,
      reads: 0,
      clock: 1_000_000,
      close() {
        state.service.stop();
        db.close();
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
    state.service = new ResourceService({
      database: db.database,
      settings: undefined,
      bus,
      dataDir,
      now: () => state.clock,
      audience: () => 1,
      sampler: new Sampler(
        () => state.clock,
        () => {
          state.reads += 1;
          return read();
        },
      ),
      panes: async () => new Map(),
      probes: {
        pressure: async () => null,
        power: async () => ({
          source: null,
          batteryPercent: null,
          charging: null,
        }),
        swap: async () => ({ totalBytes: null, usedBytes: null }),
      },
      ...extra,
    });
    return state;
  }

  const table = (cpuMs = 0) =>
    new Map([[process.pid, { ...row(process.pid), cpuMs }]]);

  let current: Rig | undefined;
  afterEach(() => {
    current?.close();
    current = undefined;
    vi.useRealTimers();
  });

  it("ps 挂住时循环不阻塞：超时计数、这一轮不发，下一拍照常再试", async () => {
    vi.useFakeTimers();
    current = rig(() => new Promise(() => {}));
    const { service, workspaces } = current;
    service.subscribe(workspaces[0]!, {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(current.reads).toBe(1);
    expect(service.metrics.sampling.inFlight).toBe(true);
    // 事件循环没被挂住：定时器照走，期限一到这一轮作废。
    await vi.advanceTimersByTimeAsync(1_500);
    expect(service.metrics.sampling.timeouts.ps).toBe(1);
    expect(service.metrics.sampling.inFlight).toBe(false);
    expect(current.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(current.reads).toBe(2);
    // GET 搭上这一轮挂住的读，同样在期限上答「超时」。
    const answer = service.snapshot(workspaces[0]!);
    const settled = expect(answer).rejects.toBeInstanceOf(SampleTimeout);
    await vi.advanceTimersByTimeAsync(1_500);
    await settled;
    expect(service.metrics.sampling.timeouts.ps).toBe(2);
  });

  it("两个工作空间一拍只读一次表", async () => {
    vi.useFakeTimers();
    current = rig(async () => table());
    const { service, workspaces } = current;
    service.subscribe(workspaces[0]!, {});
    service.subscribe(workspaces[1]!, {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(current.reads).toBe(1);
    expect(current.events.map((one) => one.workspaceId).sort()).toEqual(
      [...workspaces].sort(),
    );
    expect(service.metrics.sampling.rounds).toBe(1);
  });

  it("GET 搭正在进行的那一轮，不另起 ps；刚完成的也复用", async () => {
    vi.useFakeTimers();
    let release: ((value: Map<number, ProcessRow>) => void) | undefined;
    current = rig(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const { service, workspaces } = current;
    service.subscribe(workspaces[0]!, {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(current.reads).toBe(1);
    const answer = service.snapshot(workspaces[1]!);
    expect(current.reads).toBe(1);
    release?.(table());
    expect((await answer).workspaceId).toBe(workspaces[1]);
    await service.snapshot(workspaces[0]!);
    expect(current.reads).toBe(1);
    // 过了复用期才另起一轮。
    current.clock += 1_000;
    const later = service.snapshot(workspaces[0]!);
    expect(current.reads).toBe(2);
    release?.(table());
    await later;
  });

  it("上一拍还没走完（停掉又重起的循环）时跳过并计数", async () => {
    vi.useFakeTimers();
    current = rig(() => new Promise(() => {}), {
      settings: {
        get: (key: string) =>
          key === "resources.intervalMs" ? 500 : undefined,
      } as never,
    });
    const { service, workspaces } = current;
    const first = service.subscribe(workspaces[0]!, { intervalMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(service.metrics.sampling.inFlight).toBe(true);
    service.unsubscribe(first.subscriptionId);
    service.stop();
    service.subscribe(workspaces[0]!, { intervalMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(service.metrics.sampling.overlapsSkipped).toBe(1);
    expect(current.reads).toBe(1);
  });

  it("多工作空间的 CPU% 用同一个 elapsedMs", async () => {
    let cpu = 0;
    current = rig(async () => table(cpu));
    const { service, workspaces } = current;
    await service.round(0);
    current.clock += 2_000;
    cpu = 400;
    const sampled = await service.round(0);
    const one = service.snapshotFrom(sampled, workspaces[0]!);
    const two = service.snapshotFrom(sampled, workspaces[1]!);
    expect(sampled.refresh.elapsedMs).toBe(2_000);
    expect(one.host.cpuPercent).not.toBeNull();
    expect(two.host.cpuPercent).toBe(one.host.cpuPercent);
  });
});

describe("低频探针的缓存", () => {
  it("TTL 内交出旧值不问；过期先交旧值、后台刷新", async () => {
    let clock = 0;
    let calls = 0;
    const cache = new ProbeCache(() => clock);
    const probe = async () => {
      calls += 1;
      return calls;
    };
    // 还没有值：交出 fallback，后台去问。
    expect(cache.cached("p", 10_000, probe, 0)).toBe(0);
    await cache.settled();
    expect(cache.cached("p", 10_000, probe, 0)).toBe(1);
    clock += 5_000;
    expect(cache.cached("p", 10_000, probe, 0)).toBe(1);
    expect(calls).toBe(1);
    clock += 5_000;
    expect(cache.cached("p", 10_000, probe, 0)).toBe(1);
    expect(calls).toBe(2);
    await cache.settled();
    expect(cache.cached("p", 10_000, probe, 0)).toBe(2);
  });

  it("探针超时计数并留着旧值；同一时刻只有一个在问", async () => {
    let clock = 0;
    let timeouts = 0;
    const cache = new ProbeCache(
      () => clock,
      () => {
        timeouts += 1;
      },
    );
    cache.cached("p", 1_000, async () => "ok", "none");
    await cache.settled();
    clock += 1_000;
    let calls = 0;
    const failing = async (): Promise<string> => {
      calls += 1;
      throw new SampleTimeout("probe");
    };
    expect(cache.cached("p", 1_000, failing, "none")).toBe("ok");
    expect(cache.cached("p", 1_000, failing, "none")).toBe("ok");
    expect(calls).toBe(1);
    await cache.settled();
    expect(timeouts).toBe(1);
    expect(cache.cached("p", 1_000, failing, "none")).toBe("ok");
  });
});

describe("孤立会话", () => {
  let state: Fixture;

  beforeEach(() => {
    state = fixture();
  });

  afterEach(() => {
    state.close();
  });

  function insertSession(options: {
    id: string;
    ownerNodeId: string | null;
    sessionKey?: string;
    backendRef?: string | null;
  }): void {
    state.db.database
      .prepare(
        "INSERT INTO terminal_sessions(id, workspace_id, session_key, kind, owner_node_id, cwd, shell, status, backend_kind, backend_ref, generation, attach_state, created_at) VALUES(?, ?, ?, 'terminal', ?, '/tmp', '/bin/zsh', 'running', 'tmux', ?, 1, 'live', '2026-09-01T00:00:00Z')",
      )
      .run(
        options.id,
        state.workspaceId,
        options.sessionKey ?? "6f1b4c2e-1111-7111-8111-111111111111",
        options.ownerNodeId,
        options.backendRef ?? `armadra-${options.id}`,
      );
  }

  it("节点被删掉的会话可以被认领，没有行的只能被终止", () => {
    insertSession({ id: "s-1", ownerNodeId: null });
    const orphans = listOrphans(state.db.database, state.workspaceId, [
      "armadra-stray-1",
      "armadra-s-1",
    ]);
    const byId = new Map(orphans.map((one) => [one.id, one]));
    expect(byId.get("session:s-1")?.adoptable).toBe(true);
    expect(byId.get("session:s-1")?.reason).toBe("no-node");
    expect(byId.get("ref:armadra-stray-1")?.adoptable).toBe(false);
    expect(byId.get("ref:armadra-stray-1")?.reason).toBe("no-row");
    // 这个会话已经有行了，所以它不会再作为「没有行」出现一次。
    expect(byId.has("ref:armadra-s-1")).toBe(false);
  });

  it("认领交回的节点 id 就是会话自己的 key", () => {
    insertSession({ id: "s-1", ownerNodeId: null });
    const adopted = adoptOrphan(state.db.database, state.workspaceId, "s-1");
    expect(adopted.nodeId).toBe("6f1b4c2e-1111-7111-8111-111111111111");
    expect(adopted.workspaceId).toBe(state.workspaceId);
    expect(adopted.cwd).toBe("/tmp");
  });

  it("另一个工作空间的会话不能被这里认领", () => {
    insertSession({ id: "s-1", ownerNodeId: null });
    expect(() => adoptOrphan(state.db.database, "ws-2", "s-1")).toThrow(
      OrphanError,
    );
  });

  it("key 不是 UUID 的行没有可用的节点身份", () => {
    insertSession({ id: "s-2", ownerNodeId: null, sessionKey: "hand-edited" });
    expect(() =>
      adoptOrphan(state.db.database, state.workspaceId, "s-2"),
    ).toThrow(/node identity/);
  });

  it("已经被另一个会话占着的节点不会被抢走", () => {
    insertSession({ id: "s-1", ownerNodeId: null });
    insertSession({
      id: "s-2",
      ownerNodeId: "6f1b4c2e-1111-7111-8111-111111111111",
      sessionKey: "6f1b4c2e-2222-7222-8222-222222222222",
    });
    expect(() =>
      adoptOrphan(state.db.database, state.workspaceId, "s-1"),
    ).toThrow(/already owns/);
  });

  it("孤立 id 只有两种形状，别的一律 400", () => {
    insertSession({ id: "s-1", ownerNodeId: null });
    expect(
      orphanTarget(state.db.database, state.workspaceId, "session:s-1"),
    ).toEqual({
      kind: "session",
      sessionId: "s-1",
    });
    expect(
      orphanTarget(state.db.database, state.workspaceId, "ref:armadra-x"),
    ).toEqual({
      kind: "ref",
      reference: "armadra-x",
    });
    // 一个任意的 pid 根本不能通过这条路寻址。
    expect(() =>
      orphanTarget(state.db.database, state.workspaceId, "1234"),
    ).toThrow(/session:<id>/);
  });
});
