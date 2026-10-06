import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStatusStore } from "../agent/status-store";
import { localSource, type Source } from "./source";
import { scoped } from "../sources/scope";
import {
  connectWorkspaceEvents,
  openEventConnections,
  onWorkspaceEvent,
  onWorkspaceAccessLost,
  onWorkspaceConnection,
  resetWorkspaceEvents,
} from "./events";

const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed22";
const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event?: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }

  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

const original = globalThis.WebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  useAgentStatusStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetWorkspaceEvents();
  vi.useRealTimers();
  globalThis.WebSocket = original;
});

function statusFrame(state: "working" | "done") {
  return JSON.stringify({
    type: "agent.status",
    status: {
      nodeId: NODE,
      workspaceId: WORKSPACE,
      agentId: "claude",
      state,
      unread: false,
      verified: true,
      restored: false,
      updatedAt: new Date().toISOString(),
    },
  });
}

function remoteSource(sourceId: string): Source {
  return { ...localSource, sourceId, httpBase: "http://r", wsBase: "ws://r" };
}

describe("workspace events", () => {
  it("两个源各开一个工作空间：事件连接各一条，状态镜像按源分开记", () => {
    const remote = remoteSource("remote-1");
    const releaseLocal = connectWorkspaceEvents(WORKSPACE);
    const releaseRemote = connectWorkspaceEvents(WORKSPACE, remote);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(openEventConnections()).toEqual([
      { sourceId: "local", workspaceId: WORKSPACE },
      { sourceId: "remote-1", workspaceId: WORKSPACE },
    ]);
    expect(FakeSocket.instances[1]!.url).toContain("//r/");
    // 同一个节点 id 在两个源里各记一份，互不覆盖。
    FakeSocket.instances[0]!.receive(statusFrame("working"));
    FakeSocket.instances[1]!.receive(statusFrame("done"));
    const { statuses } = useAgentStatusStore.getState();
    expect(statuses[scoped(NODE, "local")]?.state).toBe("working");
    expect(statuses[scoped(NODE, "remote-1")]?.state).toBe("done");
    // 释放一个源不影响另一个。
    releaseRemote();
    expect(openEventConnections()).toEqual([
      { sourceId: "local", workspaceId: WORKSPACE },
    ]);
    releaseLocal();
  });
  it("同一个源换工作空间会拆掉旧的，别的源的连接不动", () => {
    const remote = remoteSource("remote-1");
    connectWorkspaceEvents("w1");
    connectWorkspaceEvents("w9", remote);
    connectWorkspaceEvents("w2");
    expect(openEventConnections()).toEqual([
      { sourceId: "remote-1", workspaceId: "w9" },
      { sourceId: "local", workspaceId: "w2" },
    ]);
  });
  it("reports connection generations without a late closed socket hiding the replacement", () => {
    const seen = vi.fn();
    const off = onWorkspaceConnection(seen);
    const release = connectWorkspaceEvents(WORKSPACE);
    const originalSocket = FakeSocket.instances[0]!;
    originalSocket.onopen?.();
    originalSocket.drop();
    vi.advanceTimersByTime(1000);
    FakeSocket.instances[1]!.onopen?.();
    originalSocket.drop();
    expect(seen.mock.calls).toEqual([
      [WORKSPACE, true, "local"],
      [WORKSPACE, false, "local"],
      [WORKSPACE, true, "local"],
    ]);
    off();
    release();
  });
  it("4403（共享被撤销）告知订阅者，并且不再重连", () => {
    const lost = vi.fn();
    const off = onWorkspaceAccessLost(lost);
    const release = connectWorkspaceEvents(WORKSPACE);
    FakeSocket.instances[0]!.onopen?.();
    FakeSocket.instances[0]!.drop(4403);
    expect(lost).toHaveBeenCalledWith(WORKSPACE, "local");
    // 升级只会再被 403 拒：重连没有意义，等页面换工作空间或重新打开。
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.instances).toHaveLength(1);
    off();
    release();
  });

  it("opens one socket per workspace and parses frames", () => {
    const seen = vi.fn();
    const off = onWorkspaceEvent("agent.status", seen);
    const release = connectWorkspaceEvents(WORKSPACE);
    const second = connectWorkspaceEvents(WORKSPACE);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]!.url).toContain(
      `/api/workspaces/${WORKSPACE}/events`,
    );

    FakeSocket.instances[0]!.receive(statusFrame("working"));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(useAgentStatusStore.getState().statuses[scoped(NODE)]!.state).toBe(
      "working",
    );

    off();
    release();
    second();
  });

  it("drops frames that are not valid workspace events", () => {
    const seen = vi.fn();
    onWorkspaceEvent("agent.status", seen);
    const release = connectWorkspaceEvents(WORKSPACE);

    FakeSocket.instances[0]!.receive("not json");
    FakeSocket.instances[0]!.receive(JSON.stringify({ type: "nope" }));
    FakeSocket.instances[0]!.receive(
      JSON.stringify({ type: "agent.status", status: { nodeId: 1 } }),
    );

    expect(seen).not.toHaveBeenCalled();
    release();
  });

  it("reconnects with an exponential, fully jittered backoff", () => {
    // 抖动取上限的一半：第 n 次等 500 ms × 2ⁿ。
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const release = connectWorkspaceEvents(WORKSPACE);

    FakeSocket.instances[0]!.drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1]!.drop();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    // 成功握手把退避清零。
    FakeSocket.instances[2]!.onopen?.();
    FakeSocket.instances[2]!.drop();
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(4);

    release();
  });

  it("caps the backoff at 10s", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    const release = connectWorkspaceEvents(WORKSPACE);
    // 上限 1s、2s、4s、8s、10s、10s：抖动取顶，第五次起都是 9 999 ms。
    for (const wait of [999, 1_999, 3_999, 7_999, 9_999, 9_999]) {
      const before = FakeSocket.instances.length;
      FakeSocket.instances[before - 1]!.drop();
      vi.advanceTimersByTime(wait - 1);
      expect(FakeSocket.instances).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(before + 1);
    }
    release();
  });

  it("stops reconnecting once the last subscriber releases", () => {
    const release = connectWorkspaceEvents(WORKSPACE);
    release();
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("断线续订（R4c）", () => {
  /**
   * 第一次连上时页面还没有位置，所以问的是 `now`：它要的是「从现在起别漏」，
   * 而 `cursor=0` 是「把这个 core 发过的一切重放一遍」——两个不同的问题。
   */
  it("第一次带 cursor=now，重连带记下的那个数", () => {
    const release = connectWorkspaceEvents(WORKSPACE);
    const first = FakeSocket.instances[0] as FakeSocket;
    expect(first.url).toContain("?cursor=now");
    first.onopen?.();
    first.receive(
      JSON.stringify({ type: "cursor", cursor: 42, floor: 1, watermark: 42 }),
    );
    first.drop();
    vi.advanceTimersByTime(2_000);
    const second = FakeSocket.instances[1] as FakeSocket;
    expect(second.url).toContain("?cursor=42");
    release();
  });

  /** 游标只准前进：退回去等于把已经应用过的改动当成没发生。 */
  it("控制帧只让游标前进", () => {
    const release = connectWorkspaceEvents(WORKSPACE);
    const first = FakeSocket.instances[0] as FakeSocket;
    first.onopen?.();
    first.receive(
      JSON.stringify({ type: "cursor", cursor: 42, floor: 1, watermark: 42 }),
    );
    first.receive(
      JSON.stringify({ type: "cursor", cursor: 7, floor: 1, watermark: 42 }),
    );
    first.drop();
    vi.advanceTimersByTime(2_000);
    expect((FakeSocket.instances[1] as FakeSocket).url).toContain("?cursor=42");
    release();
  });

  /**
   * core 在升级之前就拒绝一个掉出保留下限的游标，那条连接根本没打开。
   * 拿同一个数重连只会撞上同一堵墙，而重连是按秒退避的。
   */
  it("升级被拒之后回到实时订阅，不再拿同一个数重连", () => {
    const release = connectWorkspaceEvents(WORKSPACE);
    const first = FakeSocket.instances[0] as FakeSocket;
    first.onopen?.();
    first.receive(
      JSON.stringify({ type: "cursor", cursor: 9, floor: 1, watermark: 9 }),
    );
    first.drop();
    vi.advanceTimersByTime(2_000);
    // 第二条没 open 就被关掉 = 409。
    (FakeSocket.instances[1] as FakeSocket).drop();
    vi.advanceTimersByTime(5_000);
    const third = FakeSocket.instances[2] as FakeSocket;
    expect(third.url).not.toContain("cursor=");
    release();
  });

  /** 控制帧不是第 22 个事件：它不该被派发给任何订阅者。 */
  it("控制帧不派发给事件订阅者", () => {
    const seen = vi.fn();
    const off = onWorkspaceEvent("board.changed", seen);
    const release = connectWorkspaceEvents(WORKSPACE);
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.onopen?.();
    socket.receive(
      JSON.stringify({ type: "cursor", cursor: 3, floor: 0, watermark: 3 }),
    );
    expect(seen).not.toHaveBeenCalled();
    off();
    release();
  });
});
