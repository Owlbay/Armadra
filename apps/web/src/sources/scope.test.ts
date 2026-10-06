import { afterEach, describe, expect, it } from "vitest";

import { resetSourceRegistry } from "./registry";
import {
  activeSourceId,
  scoped,
  sk,
  srcKey,
  srcPrefix,
  unscoped,
  withSource,
} from "./scope";
import { useAgentStatusStore } from "../agent/status-store";
import { useDriveStore } from "../agent/drive-store";
import { useDeliveryStore, edgeKey } from "../agent/delivery-store";
import { useSubagentStore } from "../agent/subagent-store";
import { useAcpStore } from "../acp/store";
import type { AgentStatus, WorkspaceEvent } from "@armadra/shared";

afterEach(() => {
  resetSourceRegistry();
  useAgentStatusStore.getState().reset();
  useDriveStore.getState().reset();
  useDeliveryStore.getState().reset();
  useSubagentStore.getState().reset();
  useAcpStore.getState().reset();
});

const NODE = "n1";

function status(state: AgentStatus["state"]): AgentStatus {
  return {
    nodeId: NODE,
    workspaceId: "w1",
    agentId: "claude",
    state,
    unread: false,
    verified: true,
    restored: false,
    updatedAt: new Date().toISOString(),
  };
}

describe("源维度的键", () => {
  it("零配置：默认源是本机，键只多一个 local 前缀", () => {
    expect(activeSourceId()).toBe("local");
    expect(scoped("a")).toBe("local:a");
    expect(sk("workspaces")).toEqual(["src", "local", "workspaces"]);
    expect(srcPrefix()).toEqual(["src", "local"]);
  });

  it("scoped / unscoped 互逆，没有前缀的按本机源", () => {
    expect(unscoped(scoped("a:b", "s1"))).toEqual({
      sourceId: "s1",
      id: "a:b",
    });
    expect(unscoped("plain")).toEqual({ sourceId: "local", id: "plain" });
    expect(srcKey("s1", "boards", "w")).toEqual(["src", "s1", "boards", "w"]);
  });

  it("withSource 只在同步执行期间换默认源，抛错也还原", () => {
    expect(withSource("s1", () => activeSourceId())).toBe("s1");
    expect(() =>
      withSource("s1", () => {
        throw new Error("x");
      }),
    ).toThrow();
    expect(activeSourceId()).toBe("local");
  });

  it("同名的节点在两个源里各记一份，store 键不碰撞", () => {
    const frame = (state: AgentStatus["state"]): WorkspaceEvent =>
      ({ type: "agent.status", status: status(state) }) as WorkspaceEvent;
    withSource("s1", () =>
      useAgentStatusStore.getState().handleEvent(frame("working")),
    );
    withSource("s2", () =>
      useAgentStatusStore.getState().handleEvent(frame("done")),
    );
    const { statuses } = useAgentStatusStore.getState();
    expect(Object.keys(statuses).sort()).toEqual(["s1:n1", "s2:n1"]);
    expect(statuses["s1:n1"]!.state).toBe("working");
    expect(statuses["s2:n1"]!.state).toBe("done");

    // 一个源的节点退出不影响另一个源里同名的那个。
    withSource("s1", () =>
      useAgentStatusStore.getState().handleEvent({
        type: "terminal.exit",
        nodeId: NODE,
      } as WorkspaceEvent),
    );
    expect(Object.keys(useAgentStatusStore.getState().statuses)).toEqual([
      "s2:n1",
    ]);
  });

  it("驱动、投递、子 Agent、ACP 的键也带源", () => {
    withSource("s1", () => {
      useDriveStore.getState().handleEvent({
        type: "terminal.lease",
        nodeId: NODE,
        sessionId: "t1",
        lease: { holder: "human" },
      } as unknown as WorkspaceEvent);
      useDeliveryStore.getState().handleEvent({
        type: "agent.delivery",
        sourceNodeId: "a",
        targetNodeId: "b",
        outcome: "queued",
      } as WorkspaceEvent);
      useAcpStore.getState().begin("sess", "hi");
    });
    expect(Object.keys(useDriveStore.getState().drives)).toEqual(["s1:n1"]);
    expect(Object.keys(useDeliveryStore.getState().marks)).toEqual([
      edgeKey("a", "b", "s1"),
    ]);
    expect(useDeliveryStore.getState().queueVersion).toEqual({ "s1:b": 1 });
    expect(Object.keys(useAcpStore.getState().sessions)).toEqual(["s1:sess"]);
  });
});
