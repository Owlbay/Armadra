import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStatusStore } from "../agent/status-store";
import { scoped } from "../sources/scope";
import {
  RESUBSCRIBE_DELAY_MS,
  type WorkspaceEventTransport,
  connectWorkspaceEvents,
  onWorkspaceAccessLost,
  onWorkspaceConnection,
  onWorkspaceEvent,
  openEventConnections,
  resetWorkspaceEvents,
  setWorkspaceEventTransport,
} from "./events";
import { localSource, type Source } from "./source";

const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed22";
const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";

/** 一轮订阅：测试往里推项、让它出错或结束。 */
class Feed implements AsyncIterable<unknown> {
  private readonly queue: unknown[] = [];
  private waiting: ((step: IteratorResult<unknown>) => void) | null = null;
  private failWith: ((error: unknown) => void) | null = null;
  private ended = false;
  aborted = false;

  constructor(
    readonly sourceId: string,
    readonly workspaceId: string,
    signal: AbortSignal,
  ) {
    signal.addEventListener("abort", () => {
      this.aborted = true;
      this.fail(new DOMException("aborted", "AbortError"));
    });
  }

  push(item: unknown) {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      this.failWith = null;
      resolve({ value: item, done: false });
    } else this.queue.push(item);
  }

  fail(error: unknown) {
    const reject = this.failWith;
    this.waiting = null;
    this.failWith = null;
    reject?.(error);
  }

  end() {
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift(), done: false });
        }
        if (this.ended)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiting = resolve;
          this.failWith = reject;
        });
      },
    };
  }
}

const feeds: Feed[] = [];
/** 每个源的「连接断了」监听（一个源一条控制面连接）。 */
const drops = new Map<string, Set<() => void>>();
let closedWith: number | null = null;
let refuse: unknown = null;

const dropAll = (sourceId = "local") => {
  for (const drop of drops.get(sourceId) ?? []) drop();
};

const fake: WorkspaceEventTransport = {
  async subscribe(source, workspaceId, signal) {
    if (refuse !== null) {
      const error = refuse;
      refuse = null;
      throw error;
    }
    const feed = new Feed(source.sourceId, workspaceId, signal);
    feeds.push(feed);
    return feed;
  },
  onDrop(source, listener) {
    const set = drops.get(source.sourceId) ?? new Set();
    set.add(listener);
    drops.set(source.sourceId, set);
    return () => set.delete(listener);
  },
  closedWith: () => closedWith,
};

function remoteSource(sourceId: string): Source {
  return { ...localSource, sourceId, httpBase: "http://r", wsBase: "ws://r" };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const cursor = (at: number) => ({
  type: "cursor",
  cursor: at,
  floor: 0,
  watermark: at,
});

function status(state: "working" | "done") {
  return {
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
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  feeds.length = 0;
  drops.clear();
  closedWith = null;
  refuse = null;
  setWorkspaceEventTransport(fake);
  useAgentStatusStore.getState().reset();
});

afterEach(() => {
  resetWorkspaceEvents();
  setWorkspaceEventTransport(null);
  vi.useRealTimers();
});

describe("workspace events", () => {
  it("一块工作空间一条订阅；项按 schema 解析后派发", async () => {
    const seen = vi.fn();
    const off = onWorkspaceEvent("agent.status", seen);
    const release = connectWorkspaceEvents(WORKSPACE);
    const second = connectWorkspaceEvents(WORKSPACE);
    await settle();
    expect(feeds).toHaveLength(1);
    expect(feeds[0]!.workspaceId).toBe(WORKSPACE);
    feeds[0]!.push(cursor(1));
    feeds[0]!.push(status("working"));
    await settle();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(useAgentStatusStore.getState().statuses[scoped(NODE)]!.state).toBe(
      "working",
    );
    off();
    release();
    second();
  });

  it("位置帧不派发，只当作「订上了」；断线落下，重订上再升起", async () => {
    const seen = vi.fn();
    const connected = vi.fn();
    const offEvent = onWorkspaceEvent("board.changed", seen);
    const offConnection = onWorkspaceConnection(connected);
    const release = connectWorkspaceEvents(WORKSPACE);
    await settle();
    feeds[0]!.push(cursor(3));
    await settle();
    dropAll();
    // 重试插件在同一个迭代器里重订：core 补发完先发一帧新的位置帧。
    feeds[0]!.push(cursor(9));
    await settle();
    expect(seen).not.toHaveBeenCalled();
    expect(connected.mock.calls).toEqual([
      [WORKSPACE, true, "local"],
      [WORKSPACE, false, "local"],
      [WORKSPACE, true, "local"],
    ]);
    offEvent();
    offConnection();
    release();
  });

  it("解析不了的项丢掉，不断订阅", async () => {
    const seen = vi.fn();
    onWorkspaceEvent("agent.status", seen);
    const release = connectWorkspaceEvents(WORKSPACE);
    await settle();
    feeds[0]!.push({ type: "nope" });
    feeds[0]!.push({ type: "agent.status", status: { nodeId: 1 } });
    feeds[0]!.push(status("done"));
    await settle();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(feeds).toHaveLength(1);
    release();
  });

  it("forbidden（共享被撤销）告知订阅者，并且不再订", async () => {
    const lost = vi.fn();
    const off = onWorkspaceAccessLost(lost);
    const release = connectWorkspaceEvents(WORKSPACE);
    await settle();
    feeds[0]!.fail({ code: "forbidden" });
    await settle();
    expect(lost).toHaveBeenCalledWith(WORKSPACE, "local");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(feeds).toHaveLength(1);
    off();
    release();
  });

  it("控制面整条以 4403 停下，同样当作授权收回", async () => {
    const lost = vi.fn();
    const off = onWorkspaceAccessLost(lost);
    const release = connectWorkspaceEvents(WORKSPACE);
    await settle();
    closedWith = 4403;
    feeds[0]!.fail(new Error("WebSocket is not open"));
    await settle();
    expect(lost).toHaveBeenCalledWith(WORKSPACE, "local");
    off();
    release();
  });

  it("4409 / 4429 停下：不再订，也不当作授权收回", async () => {
    const lost = vi.fn();
    const off = onWorkspaceAccessLost(lost);
    const release = connectWorkspaceEvents(WORKSPACE);
    await settle();
    closedWith = 4409;
    feeds[0]!.fail(new Error("WebSocket is not open"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lost).not.toHaveBeenCalled();
    expect(feeds).toHaveLength(1);
    off();
    release();
  });

  it("续不上（snapshot_required）：落下连接状态，缓一下从现在重订", async () => {
    const connected = vi.fn();
    const off = onWorkspaceConnection(connected);
    const release = connectWorkspaceEvents(WORKSPACE);
    await settle();
    feeds[0]!.push(cursor(5));
    await settle();
    feeds[0]!.fail({ code: "snapshot_required" });
    await settle();
    expect(feeds).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_DELAY_MS);
    expect(feeds).toHaveLength(2);
    feeds[1]!.push(cursor(40));
    await settle();
    expect(connected.mock.calls).toEqual([
      [WORKSPACE, true, "local"],
      [WORKSPACE, false, "local"],
      [WORKSPACE, true, "local"],
    ]);
    off();
    release();
  });

  it("调用本身被拒（工作空间还没建好）也缓一下再订", async () => {
    refuse = { code: "not_found" };
    const release = connectWorkspaceEvents(WORKSPACE);
    await settle();
    expect(feeds).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_DELAY_MS);
    expect(feeds).toHaveLength(1);
    release();
  });

  it("最后一个持有者释放：取消订阅，不再重订", async () => {
    const release = connectWorkspaceEvents(WORKSPACE);
    await settle();
    release();
    await settle();
    expect(feeds[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(feeds).toHaveLength(1);
  });

  it("换工作空间：旧的取消，新的另订", async () => {
    const first = connectWorkspaceEvents(WORKSPACE);
    await settle();
    const other = "019ff7d1-0d12-7421-833d-2c5e8d64ed99";
    const second = connectWorkspaceEvents(other);
    await settle();
    expect(feeds[0]!.aborted).toBe(true);
    expect(feeds[1]!.workspaceId).toBe(other);
    first();
    second();
  });

  it("两个源各订一个工作空间：订阅各一条，事件带上所属的源", async () => {
    const remote = remoteSource("remote-1");
    const seen = vi.fn();
    const off = onWorkspaceEvent("agent.status", (_event, from) => seen(from), {
      allSources: true,
    });
    const current = vi.fn();
    const offCurrent = onWorkspaceEvent("agent.status", (_event, from) =>
      current(from),
    );
    const releaseLocal = connectWorkspaceEvents(WORKSPACE);
    const releaseRemote = connectWorkspaceEvents(WORKSPACE, remote);
    await settle();
    expect(feeds.map((feed) => feed.sourceId)).toEqual(["local", "remote-1"]);
    expect(openEventConnections()).toEqual([
      { sourceId: "local", workspaceId: WORKSPACE },
      { sourceId: "remote-1", workspaceId: WORKSPACE },
    ]);
    feeds[0]!.push(status("working"));
    feeds[1]!.push(status("done"));
    await settle();
    // 同一个节点 id 在两个源里各记一份，互不覆盖；缺省只收当前源的。
    const { statuses } = useAgentStatusStore.getState();
    expect(statuses[scoped(NODE, "local")]?.state).toBe("working");
    expect(statuses[scoped(NODE, "remote-1")]?.state).toBe("done");
    expect(seen.mock.calls).toEqual([["local"], ["remote-1"]]);
    expect(current.mock.calls).toEqual([["local"]]);
    releaseRemote();
    await settle();
    expect(feeds[1]!.aborted).toBe(true);
    expect(openEventConnections()).toEqual([
      { sourceId: "local", workspaceId: WORKSPACE },
    ]);
    off();
    offCurrent();
    releaseLocal();
  });

  it("一个源的连接断了只落下那个源的订阅状态", async () => {
    const remote = remoteSource("remote-1");
    const connected = vi.fn();
    const off = onWorkspaceConnection(connected);
    const releaseLocal = connectWorkspaceEvents(WORKSPACE);
    const releaseRemote = connectWorkspaceEvents(WORKSPACE, remote);
    await settle();
    feeds[0]!.push(cursor(1));
    feeds[1]!.push(cursor(1));
    await settle();
    dropAll("remote-1");
    expect(connected.mock.calls).toEqual([
      [WORKSPACE, true, "local"],
      [WORKSPACE, true, "remote-1"],
      [WORKSPACE, false, "remote-1"],
    ]);
    off();
    releaseLocal();
    releaseRemote();
  });

  it("同一个源换工作空间会取消旧的，别的源的订阅不动", async () => {
    const remote = remoteSource("remote-1");
    connectWorkspaceEvents("w1");
    connectWorkspaceEvents("w9", remote);
    connectWorkspaceEvents("w2");
    await settle();
    expect(openEventConnections()).toEqual([
      { sourceId: "remote-1", workspaceId: "w9" },
      { sourceId: "local", workspaceId: "w2" },
    ]);
    expect(feeds.find((feed) => feed.workspaceId === "w1")?.aborted).toBe(true);
  });
});
