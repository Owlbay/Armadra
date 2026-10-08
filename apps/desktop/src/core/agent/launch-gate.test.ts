import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type GateClock,
  LaunchGate,
  configDirFor,
  policyFor,
  watchLaunch,
} from "./launch-gate";

/** 手动拨的钟：定时器按到期时刻排，`advance` 依次触发。 */
function fakeClock(random = 0) {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: GateClock & { advance(ms: number): Promise<void> } = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    random: () => random,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await Promise.resolve();
      }
      now = end;
      await Promise.resolve();
    },
  };
  return clock;
}

const codex = (nodeId: string) => ({
  agentId: "codex",
  configDir: "/home/u/.codex",
  nodeId,
});

describe("LaunchGate", () => {
  it("serialises three codex launches on one config dir, ≥ 500 ms apart", async () => {
    const clock = fakeClock(0);
    const gate = new LaunchGate(clock);
    const granted: [string, number][] = [];
    for (const node of ["a", "b", "c"]) {
      void gate.acquire(codex(node)).then((answer) => {
        expect(answer.granted).toBe(true);
        granted.push([node, clock.now()]);
      });
    }
    await clock.advance(0);
    expect(granted.map(([node]) => node)).toEqual(["a"]);
    expect(gate.position("c")).toBe(2);
    // holdMs 兜底：6 s 后放行，再加 500 ms 抖动。
    await clock.advance(6_499);
    expect(granted).toHaveLength(1);
    await clock.advance(1);
    expect(granted.map(([node]) => node)).toEqual(["a", "b"]);
    await clock.advance(6_500);
    expect(granted.map(([node]) => node)).toEqual(["a", "b", "c"]);
    const times = granted.map(([, at]) => at);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(500);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(500);
  });

  it("lets the next one go early when the holder reports in", async () => {
    const clock = fakeClock(1 - 1e-9);
    const gate = new LaunchGate(clock);
    const order: string[] = [];
    void gate.acquire(codex("a")).then(() => order.push("a"));
    void gate.acquire(codex("b")).then(() => order.push("b"));
    await clock.advance(0);
    await clock.advance(1_000);
    gate.release("a");
    // 抖动取上界 1500 ms。
    await clock.advance(1_499);
    expect(order).toEqual(["a"]);
    await clock.advance(1);
    expect(order).toEqual(["a", "b"]);
    expect(gate.holds("b")).toBe(true);
  });

  it("does not queue other agents or other config dirs", async () => {
    const clock = fakeClock();
    const gate = new LaunchGate(clock);
    const claude = await Promise.all(
      ["a", "b", "c"].map((nodeId) =>
        gate.acquire({ agentId: "claude", configDir: "/c", nodeId }),
      ),
    );
    expect(claude.every((answer) => answer.granted)).toBe(true);
    const first = gate.acquire(codex("x"));
    const other = gate.acquire({
      agentId: "codex",
      configDir: "/elsewhere",
      nodeId: "y",
    });
    await clock.advance(0);
    expect(await first).toEqual({ granted: true, waitedMs: 0 });
    expect(await other).toEqual({ granted: true, waitedMs: 0 });
  });

  it("answers granted:false when the wait runs out", async () => {
    const clock = fakeClock();
    const gate = new LaunchGate(clock);
    void gate.acquire(codex("a"));
    const late = gate.acquire({ ...codex("b"), timeoutMs: 2_000 });
    await clock.advance(2_000);
    expect(await late).toEqual({ granted: false, waitedMs: 2_000 });
    expect(gate.position("b")).toBeUndefined();
  });

  it("a second request from the same node replaces the first", async () => {
    const clock = fakeClock();
    const gate = new LaunchGate(clock);
    void gate.acquire(codex("a"));
    const first = gate.acquire(codex("b"));
    const second = gate.acquire(codex("b"));
    await clock.advance(0);
    expect((await first).granted).toBe(false);
    expect(gate.position("b")).toBe(1);
    gate.forget("a");
    await clock.advance(1_500);
    expect((await second).granted).toBe(true);
  });
});

describe("configDirFor", () => {
  it("reads the CLI's own home variable", () => {
    expect(configDirFor("codex", { CODEX_HOME: "/x" }, "/h")).toBe("/x");
    expect(configDirFor("codex", {}, "/h")).toBe(join("/h", ".codex"));
    expect(configDirFor("claude", { CLAUDE_CONFIG_DIR: "/c" }, "/h")).toBe(
      "/c",
    );
    expect(configDirFor("pi", {}, "/h")).toBe(join("/h", ".pi"));
  });

  it("only codex has a concurrency limit", () => {
    expect(policyFor("codex").concurrency).toBe(1);
    expect(policyFor("claude").concurrency).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("watchLaunch", () => {
  const instant = { delay: async () => {}, graceMs: 0, pollMs: 0 };

  it("fails when the pane empties twice before any report", async () => {
    const panes: ("busy" | "idle")[] = ["busy", "idle", "idle"];
    const verdict = await watchLaunch({
      ...instant,
      probe: async () => panes.shift() ?? "idle",
      reported: () => false,
    });
    expect(verdict).toBe("failed");
  });

  it("is started as soon as the node reports", async () => {
    let calls = 0;
    const verdict = await watchLaunch({
      ...instant,
      probe: async () => {
        calls += 1;
        return "busy";
      },
      reported: () => calls >= 2,
    });
    expect(verdict).toBe("started");
  });

  it("is started when the CLI is still there at the end of the window", async () => {
    let now = 0;
    const verdict = await watchLaunch({
      ...instant,
      now: () => now,
      probe: async () => {
        now += 10_000;
        return "busy";
      },
      reported: () => false,
    });
    expect(verdict).toBe("started");
  });

  it("is unknown when the backend cannot say", async () => {
    expect(
      await watchLaunch({
        ...instant,
        probe: async () => undefined,
        reported: () => false,
      }),
    ).toBe("unknown");
  });
});
