/**
 * Worker 舰队（契约 §21.2）：版本比较、「过旧」判定、握手结果的汇总，以及读
 * 它的两处——执行主机行的 `worker` 与集成状态的 `outdatedHosts`。
 */

import type { ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getExecutionHost,
  listExecutionHosts,
  resyncExecutionHost,
  type ExecutionHostDeps,
} from "../settings/execution-hosts";
import type { SshHost } from "../settings/ssh-hosts";
import { SettingsStore } from "../settings/store";
import { state as integrationState } from "../hook/install/integration";
import { tempDir } from "../testing/temp-dir";
import { WORKER_CAPABILITIES } from "./capabilities";
import {
  HEALTH_HISTORY_LIMIT,
  WorkerFleet,
  compareVersions,
  isOutdated,
  outdatedHosts,
  setFleetHooks,
  setWorkerFleet,
  workerFleet,
} from "./fleet";
import { INTEGRATION_V2_CAPABILITY } from "./operations";
import { RemoteWorker } from "./worker";
import { disposeWorkerBundle, spawnWorker } from "./worker.fixture";

interface Row {
  readonly kind: string;
  readonly worker?: {
    readonly version: string;
    readonly capabilities: readonly string[];
    readonly outdated: boolean;
    readonly connected: boolean;
    readonly checkedAt: string;
  };
}
const row = (body: unknown): Row => body as Row;

const EXPECTED = { version: "0.5.0", capabilities: ["a", "b"] };

describe("compareVersions", () => {
  it("orders dotted numbers, pre-releases below releases", () => {
    expect(compareVersions("0.4.9", "0.5.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-rc.1", "1.2.3")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3+build.9", "1.2.3")).toBe(0);
  });
});

describe("isOutdated", () => {
  it("is older, or missing a capability this build's Worker declares", () => {
    expect(isOutdated("0.5.0", ["a", "b"], EXPECTED)).toBe(false);
    expect(isOutdated("0.4.0", ["a", "b"], EXPECTED)).toBe(true);
    expect(isOutdated("0.5.0", ["a"], EXPECTED)).toBe(true);
    // 更新的 Worker 不算过旧；多出来的能力无害。
    expect(isOutdated("0.6.0", ["a", "b", "c"], EXPECTED)).toBe(false);
    // 版本读不出来只按能力判。
    expect(isOutdated("", ["a", "b"], EXPECTED)).toBe(false);
    expect(isOutdated("nightly", ["a", "b"], EXPECTED)).toBe(false);
  });

  it("defaults to this build's version and capability list", () => {
    expect(isOutdated("0.1.0", WORKER_CAPABILITIES)).toBe(false);
    expect(
      isOutdated(
        "0.1.0",
        WORKER_CAPABILITIES.filter(
          (name) => name !== INTEGRATION_V2_CAPABILITY,
        ),
      ),
    ).toBe(true);
  });
});

describe("WorkerFleet", () => {
  it("keeps the last handshake and only marks a dropped link offline", () => {
    const fleet = new WorkerFleet(
      EXPECTED,
      () => new Date("2026-10-03T00:00:00Z"),
    );
    expect(fleet.status("h1")).toBeUndefined();
    fleet.handshake("h1", {
      runtimeVersion: "0.4.0",
      capabilities: ["b", "a"],
    });
    fleet.handshake("h2", {
      runtimeVersion: "0.5.0",
      capabilities: ["a", "b"],
    });
    expect(fleet.status("h1")).toEqual({
      version: "0.4.0",
      capabilities: ["a", "b"],
      outdated: true,
      connected: true,
      checkedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(fleet.outdated()).toEqual(["h1"]);
    fleet.disconnected("h1");
    expect(fleet.status("h1")?.connected).toBe(false);
    expect(fleet.outdated()).toEqual(["h1"]);
    // 升级后重新握手：记号随新版本消失。
    fleet.handshake("h1", {
      runtimeVersion: "0.5.0",
      capabilities: ["a", "b"],
    });
    expect(fleet.outdated()).toEqual([]);
    fleet.forget("h2");
    expect(fleet.status("h2")).toBeUndefined();
  });

  it("keeps a bounded health history per host, oldest first", () => {
    let tick = 0;
    const fleet = new WorkerFleet(
      EXPECTED,
      () => new Date(Date.UTC(2026, 9, 3, 0, 0, tick++)),
    );
    expect(fleet.history("h1")).toEqual([]);
    fleet.handshake("h1", {
      runtimeVersion: "0.5.0",
      capabilities: ["a", "b"],
    });
    fleet.disconnected("h1");
    // 已经断开的再断一次不重复记。
    fleet.disconnected("h1");
    fleet.failed("h1", "unreachable");
    fleet.handshake("h1", { runtimeVersion: "", capabilities: ["a", "b"] });
    expect(fleet.history("h1")).toEqual([
      {
        at: "2026-10-03T00:00:00.000Z",
        event: "handshake",
        ok: true,
        version: "0.5.0",
      },
      { at: "2026-10-03T00:00:01.000Z", event: "disconnected", ok: false },
      {
        at: "2026-10-03T00:00:02.000Z",
        event: "failed",
        ok: false,
        code: "unreachable",
      },
      { at: "2026-10-03T00:00:03.000Z", event: "handshake", ok: true },
    ]);
    // 没握过手的主机也能记失败。
    fleet.failed("never", "");
    expect(fleet.history("never")).toEqual([
      { at: "2026-10-03T00:00:04.000Z", event: "failed", ok: false },
    ]);
    for (let index = 0; index < HEALTH_HISTORY_LIMIT + 5; index += 1) {
      fleet.failed("h1", `n${index}`);
    }
    const kept = fleet.history("h1");
    expect(kept).toHaveLength(HEALTH_HISTORY_LIMIT);
    expect(kept[0]?.code).toBe("n5");
    expect(kept.at(-1)?.code).toBe(`n${HEALTH_HISTORY_LIMIT + 4}`);
    fleet.forget("h1");
    expect(fleet.history("h1")).toEqual([]);
  });
});

describe("outdatedHosts and the integration state", () => {
  let previous: WorkerFleet;

  afterEach(() => {
    setFleetHooks(undefined);
    setWorkerFleet(previous);
  });

  it("unions the fleet with v1-only injection hosts, named and versioned", () => {
    previous = setWorkerFleet(new WorkerFleet(EXPECTED));
    workerFleet().handshake("old", {
      runtimeVersion: "0.4.0",
      capabilities: ["a", "b"],
    });
    workerFleet().handshake("ok", {
      runtimeVersion: "0.5.0",
      capabilities: ["a", "b"],
    });
    expect(outdatedHosts()).toEqual([{ hostId: "old", version: "0.4.0" }]);
    setFleetHooks({
      resync: async () => {},
      integrationOutdated: () => ["v1-only", "old"],
      hostName: (hostId) => (hostId === "old" ? "build-box" : undefined),
    });
    expect(outdatedHosts()).toEqual([
      { hostId: "old", name: "build-box", version: "0.4.0" },
      { hostId: "v1-only" },
    ]);
    // 共享层的 `integrationStateSchema` 由 packages/shared 的用例守；core 不依赖它。
    const parsed = integrationState("claude", {
      dataDir: tempDir("armadra-fleet-integration-"),
      env: { HOME: tempDir("armadra-fleet-home-") },
      outdatedHosts,
    });
    expect(parsed.outdatedHosts?.map((host) => host.hostId)).toEqual([
      "old",
      "v1-only",
    ]);
  });
});

describe("execution host rows carry the Worker", () => {
  const HOST = {
    id: "far",
    name: "far",
    host: "far.example",
    worker: { path: "/opt/armadra/bin/armadra-core" },
  };
  let previous: WorkerFleet;
  let start: () => ChildProcess;

  beforeAll(async () => {
    start = await spawnWorker();
  }, 120_000);

  afterAll(() => {
    disposeWorkerBundle();
  });

  afterEach(() => {
    setFleetHooks(undefined);
    setWorkerFleet(previous);
  });

  const deps = (hosts: unknown[] = [HOST]): ExecutionHostDeps => ({
    settings: SettingsStore.inMemory({ ssh: { hosts } } as never),
    workspaceCounts: () => new Map(),
  });

  it("records a real Worker's handshake and shows it on the row", async () => {
    previous = setWorkerFleet(new WorkerFleet());
    const worker = new RemoteWorker({
      dataDir: "/nonexistent",
      host: HOST as SshHost,
      worker: HOST.worker,
      askpass: {} as never,
      version: "0.1.0",
      spawn: start,
      node: async () => ({
        version: "v24.0.0",
        major: 24,
        usable: true,
        detail: "",
      }),
      onHandshake: (probe) => workerFleet().handshake(HOST.id, probe),
      onDisconnected: () => workerFleet().disconnected(HOST.id),
    });
    try {
      await worker.probe();
      const answer = getExecutionHost(deps(), HOST.id);
      expect(answer.status).toBe(200);
      const found = row(answer.body);
      expect(found.worker).toMatchObject({
        version: "0.1.0",
        outdated: false,
        connected: true,
      });
      expect(found.worker?.capabilities).toContain("remote.handoff.v1");
      const listed = listExecutionHosts(deps()).body as { worker?: unknown }[];
      expect(listed[0]?.worker).toBeUndefined();
      expect(listed[1]?.worker).toBeDefined();
    } finally {
      worker.close();
    }
    const after = row(getExecutionHost(deps(), HOST.id).body);
    expect(after.worker?.connected).toBe(false);
    expect(getExecutionHost(deps(), "missing").status).toBe(404);
    expect(row(getExecutionHost(deps(), "").body).kind).toBe("local");
  });

  it("resyncs through the remote domain, and refuses what it cannot", async () => {
    previous = setWorkerFleet(new WorkerFleet());
    expect((await resyncExecutionHost(deps(), HOST.id)).status).toBe(501);
    const asked: string[] = [];
    setFleetHooks({
      resync: async (hostId) => {
        asked.push(hostId);
        workerFleet().handshake(hostId, {
          runtimeVersion: "0.1.0",
          capabilities: WORKER_CAPABILITIES,
        });
      },
      integrationOutdated: () => [],
      hostName: () => undefined,
    });
    const answer = await resyncExecutionHost(deps(), HOST.id);
    expect(answer.status).toBe(200);
    expect(asked).toEqual([HOST.id]);
    expect(row(answer.body).worker?.outdated).toBe(false);
    expect((await resyncExecutionHost(deps(), "missing")).status).toBe(404);
    const bare = { ...HOST, worker: undefined };
    expect((await resyncExecutionHost(deps([bare]), HOST.id)).status).toBe(501);
    setFleetHooks({
      resync: async () => {
        throw Object.assign(new Error("执行主机 far 的 Worker 连接断开了"), {
          status: 503,
          code: "unavailable",
        });
      },
      integrationOutdated: () => [],
      hostName: () => undefined,
    });
    const failed = await resyncExecutionHost(deps(), HOST.id);
    expect(failed.status).toBe(503);
    expect((failed.body as { code: string }).code).toBe("unavailable");
    // 健康记录（契约 §21.3）：握手成功一条，失败一条，都出现在行上。
    const health = (
      getExecutionHost(deps(), HOST.id).body as {
        health?: { event: string; ok: boolean; code?: string }[];
      }
    ).health;
    expect(health?.map((sample) => [sample.event, sample.ok])).toEqual([
      ["handshake", true],
      ["failed", false],
    ]);
    expect(health?.at(-1)?.code).toBe("unavailable");
    expect(
      (getExecutionHost(deps(), "").body as { health?: unknown }).health,
    ).toBeUndefined();
  });
});
