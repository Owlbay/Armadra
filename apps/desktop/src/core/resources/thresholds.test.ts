import { describe, expect, it } from "vitest";
import {
  ThresholdMonitor,
  ThresholdWatch,
  type ThresholdEvent,
} from "./thresholds";

/**
 * 会话资源阈值（契约 §27.4）：越线那一下发一次；同一次运行里抖动不重发；
 * 回落到九成以下再越线才再发；换代是新的一次；测不出来不算越线。
 */

const GIB = 1024 ** 3;

function collect() {
  const events: { workspaceId: string; event: ThresholdEvent }[] = [];
  const monitor = new ThresholdMonitor((workspaceId, event) =>
    events.push({ workspaceId, event }),
  );
  return { events, monitor };
}

const session = (
  memoryBytes: number | null,
  generation = 1,
  nodeId: string | null = "n1",
) => ({ sessionId: "s1", nodeId, generation, memoryBytes });

describe("越线判定", () => {
  it("越线发一次，带会话、节点、指标与数字", () => {
    const { events, monitor } = collect();
    expect(monitor.observe("w1", [session(1 * GIB)], 2 * GIB)).toBe(0);
    expect(monitor.observe("w1", [session(3 * GIB)], 2 * GIB)).toBe(1);
    expect(events).toEqual([
      {
        workspaceId: "w1",
        event: {
          type: "resources.threshold",
          sessionId: "s1",
          nodeId: "n1",
          metric: "memory",
          value: 3 * GIB,
          threshold: 2 * GIB,
        },
      },
    ]);
  });

  it("线上抖动不重发；回落到九成以下再越线才再发", () => {
    const { events, monitor } = collect();
    monitor.observe("w1", [session(3 * GIB)], 2 * GIB);
    monitor.observe("w1", [session(1.95 * GIB)], 2 * GIB);
    monitor.observe("w1", [session(2.1 * GIB)], 2 * GIB);
    expect(events).toHaveLength(1);
    monitor.observe("w1", [session(1 * GIB)], 2 * GIB);
    monitor.observe("w1", [session(2.5 * GIB)], 2 * GIB);
    expect(events).toHaveLength(2);
  });

  it("换代是新的一次运行；会话结束后忘掉", () => {
    const { events, monitor } = collect();
    monitor.observe("w1", [session(3 * GIB, 1)], 2 * GIB);
    monitor.observe("w1", [session(3 * GIB, 2)], 2 * GIB);
    expect(events).toHaveLength(2);
    monitor.observe("w1", [], 2 * GIB);
    monitor.observe("w1", [session(3 * GIB, 2)], 2 * GIB);
    expect(events).toHaveLength(3);
  });

  it("测不出来（null）不算越线；没有节点的会话不带 nodeId；阈值 0 不判", () => {
    const { events, monitor } = collect();
    monitor.observe("w1", [session(null)], 2 * GIB);
    expect(events).toEqual([]);
    monitor.observe("w1", [session(3 * GIB, 1, null)], 2 * GIB);
    expect(events[0]?.event).not.toHaveProperty("nodeId");
    expect(monitor.observe("w2", [session(3 * GIB)], 0)).toBe(0);
  });
});

describe("没人看着时的那一轮", () => {
  it("没有推送设备不采；页面开着的工作空间跳过；采不出来的不挡别的", () => {
    const { events, monitor } = collect();
    const sampled: string[] = [];
    let wanted = false;
    const watch = new ThresholdWatch({
      monitor,
      workspaces: () => ["w1", "w2", "w3"],
      sample: (workspaceId) => {
        sampled.push(workspaceId);
        if (workspaceId === "w2") throw new Error("ps failed");
        return [session(3 * GIB)];
      },
      threshold: () => 2 * GIB,
      wanted: () => wanted,
      watched: (workspaceId) => workspaceId === "w3",
    });
    expect(watch.check()).toBe(0);
    expect(sampled).toEqual([]);
    wanted = true;
    expect(watch.check()).toBe(1);
    expect(sampled).toEqual(["w1", "w2"]);
    expect(events.map((item) => item.workspaceId)).toEqual(["w1"]);
    // 第二轮不重发。
    expect(watch.check()).toBe(0);
  });
});
