import * as React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, BoardDocument, Workspace } from "@armadra/shared";

/**
 * 壳的加载链里与 A04 有关的那一段（React Flow 计划 §6.3 A04）。
 *
 * 两处原来都在 `canvas/` 之外，也是 A04 判失败的两个原因：
 *
 *  1. `board.changed` 到了却没让 `["board", …]` 失效，另一个窗口永远不重取；
 *  2. 重取回来的同一块板被 `if (document?.board.id === …) return;` 直接丢掉。
 *
 * 这里跑的是真的 hook + 真的 store，只把 Runtime 那一侧换成假的。
 */

vi.mock("../nodes/registry", () => {
  const meta = {
    labelKey: "node.terminal",
    icon: null,
    defaultSize: { width: 200, height: 100 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#0a84ff",
    hasBridgeHandles: false,
  };
  const table = new Proxy({} as Record<string, typeof meta>, {
    get: () => meta,
    has: () => true,
  });
  return {
    NODE_META: table,
    nodeMeta: () => meta,
    DRAG_HANDLE_CLASS: "drag-handle",
    NODE_DRAG_HANDLE: ".drag-handle",
  };
});

const stamp = "2026-09-06T00:00:00.000Z";
const later = "2026-09-06T00:00:05.000Z";

const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
};

const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: stamp,
  updatedAt: stamp,
};

const NODE = "019ff7d1-1111-7000-8000-000000000001";

function document(x: number, updatedAt = stamp): BoardDocument {
  return {
    board: { ...board, updatedAt },
    nodes: [
      {
        id: NODE,
        boardId: board.id,
        type: "sticky",
        title: "note",
        color: "#ffd60a",
        position: { x, y: 0 },
        size: { width: 200, height: 100 },
        labels: [],
        note: "",
        data: { kind: "sticky", content: "" },
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    edges: [],
  } as never as BoardDocument;
}

let remote = document(0);
const loadBoard = vi.fn(async () => JSON.parse(JSON.stringify(remote)));

/** 在线表：缺省只有自己，心跳就拿到租约（core JSON §9）。 */
const presenceHeartbeat = vi.fn(
  async (_ws: string, boardId: string, body: { clientId: string }) => ({
    boardId,
    clients: [
      {
        clientId: body.clientId,
        deviceName: "",
        deviceKey: "",
        lastSeenAt: stamp,
      },
    ],
    lease: { clientId: body.clientId, deviceName: "", acquiredAt: stamp },
  }),
);
const leavePresence = vi.fn(async () => undefined);

vi.mock("../api/client", () => ({
  runtimeApi: {
    listBoards: vi.fn(async () => [board]),
    openWorkspace: vi.fn(async () => undefined),
    loadBoard: (...args: unknown[]) => loadBoard(...(args as [])),
    presenceHeartbeat: (...args: unknown[]) =>
      presenceHeartbeat(...(args as [string, string, { clientId: string }])),
    leavePresence: (...args: unknown[]) => leavePresence(...(args as [])),
    // 这一组测的是租约模式：core 说这块板不走实时、设置也关着。
    boardRealtime: vi.fn(async () => ({
      realtime: false,
      materializedSeq: 0,
      enabled: false,
    })),
  },
}));

/** 在线订阅（`boards.presence`）：测试自己推每一项、自己结束。 */
interface FakeWatch {
  clientId: string;
  workspaceId: string;
  boardId: string;
  onPresence(presence: unknown): void;
  onEnd(error: unknown): void;
  stopped: boolean;
}
const watches: FakeWatch[] = [];
vi.mock("../api/board-presence", () => ({
  watchBoardPresence: (watch: Omit<FakeWatch, "stopped">) => {
    const made: FakeWatch = { ...watch, stopped: false };
    watches.push(made);
    return () => {
      made.stopped = true;
    };
  },
}));

vi.mock("./workspaces-query", () => ({
  useWorkspacesQuery: () => ({ data: [workspace] }),
}));

vi.mock("../save/autosave", () => ({
  flushBoardSaves: async () => undefined,
  LEASE_LOST_EVENT: "armadra:canvas-lease-lost",
}));

const { dispatchWorkspaceEvent, resetWorkspaceEvents } = await import(
  "../api/events"
);
const { useCanvasStore } = await import("../store/canvas-store");
const { PRESENCE_HEARTBEAT_MS, useBoardSync } = await import(
  "./use-board-sync"
);
const { markPresenceActivity } = await import("../store/canvas/presence");
const { isReadOnly, presenceClientId } = await import(
  "../store/canvas/presence"
);

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const positionOf = () =>
  useCanvasStore.getState().document?.nodes[0]?.position.x;

beforeEach(() => {
  remote = document(0);
  loadBoard.mockClear();
  presenceHeartbeat.mockClear();
  leavePresence.mockClear();
  watches.length = 0;
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  resetWorkspaceEvents();
  useCanvasStore.getState().setWorkspace(null);
});

describe("useBoardSync", () => {
  it("`board.changed` 带着别人的版本号时重取并把改动合进来", async () => {
    renderHook(() => useBoardSync(), { wrapper });
    await waitFor(() => expect(positionOf()).toBe(0));
    const reads = loadBoard.mock.calls.length;

    remote = document(515, later);
    act(() => {
      dispatchWorkspaceEvent({
        type: "board.changed",
        boardId: board.id,
        updatedAt: later,
      });
    });

    await waitFor(() => expect(positionOf()).toBe(515));
    expect(loadBoard.mock.calls.length).toBeGreaterThan(reads);
    expect(useCanvasStore.getState().document?.board.updatedAt).toBe(later);
  });

  it("版本号与手里这份一样时（自己刚存的那一次）不重取", async () => {
    renderHook(() => useBoardSync(), { wrapper });
    await waitFor(() => expect(positionOf()).toBe(0));
    const reads = loadBoard.mock.calls.length;

    act(() => {
      dispatchWorkspaceEvent({
        type: "board.changed",
        boardId: board.id,
        updatedAt: stamp,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadBoard.mock.calls.length).toBe(reads);
  });

  it("别的板改了不动这一块", async () => {
    renderHook(() => useBoardSync(), { wrapper });
    await waitFor(() => expect(positionOf()).toBe(0));
    const reads = loadBoard.mock.calls.length;

    act(() => {
      dispatchWorkspaceEvent({
        type: "board.changed",
        boardId: "019ff7d1-7419-74df-89e2-b1619d36eaaa",
        updatedAt: later,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadBoard.mock.calls.length).toBe(reads);
  });

  /* ----------------------- 在线设备与编辑租约（§9） ----------------------- */

  it("只有自己时心跳拿到租约，不只读、不重取", async () => {
    renderHook(() => useBoardSync(), { wrapper });
    await waitFor(() => expect(positionOf()).toBe(0));
    await waitFor(() =>
      expect(useCanvasStore.getState().presence?.lease?.clientId).toBe(
        presenceClientId(),
      ),
    );
    const reads = loadBoard.mock.calls.length;
    expect(presenceHeartbeat.mock.calls[0]?.[2]).toMatchObject({
      clientId: presenceClientId(),
    });
    expect(isReadOnly(useCanvasStore.getState())).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadBoard.mock.calls.length).toBe(reads);
  });

  it("别的设备接管后转只读，并按远端重载", async () => {
    renderHook(() => useBoardSync(), { wrapper });
    await waitFor(() => expect(positionOf()).toBe(0));
    await waitFor(() =>
      expect(useCanvasStore.getState().presence?.lease).toBeTruthy(),
    );
    const reads = loadBoard.mock.calls.length;
    remote = document(77, later);
    act(() => {
      dispatchWorkspaceEvent({
        type: "canvas.presence",
        boardId: board.id,
        clients: [
          {
            clientId: presenceClientId(),
            deviceName: "",
            deviceKey: "",
            lastSeenAt: stamp,
          },
          {
            clientId: "other-client-01",
            deviceName: "iPad",
            deviceKey: "",
            lastSeenAt: stamp,
          },
        ],
        lease: {
          clientId: "other-client-01",
          deviceName: "iPad",
          deviceKey: "",
          acquiredAt: later,
        },
      });
    });
    expect(isReadOnly(useCanvasStore.getState())).toBe(true);
    await waitFor(() => expect(positionOf()).toBe(77));
    expect(loadBoard.mock.calls.length).toBeGreaterThan(reads);
  });

  /**
   * 远端这段时间没变过：重取回来的文档与缓存里那份逐字相同，React Query 的
   * 结构共享会原样还回旧引用。以前合并那道「同一份响应只合一次」的闸门就此
   * 把它挡掉，本地那笔没落盘的改动留在屏幕上（实浏览器两设备探针里发现）。
   */
  it("被接管时丢掉本地未落盘的改动，即使远端没有变过", async () => {
    renderHook(() => useBoardSync(), { wrapper });
    await waitFor(() => expect(positionOf()).toBe(0));
    await waitFor(() =>
      expect(useCanvasStore.getState().presence?.lease).toBeTruthy(),
    );
    act(() => {
      useCanvasStore.getState().updateNode(NODE, { position: { x: 55, y: 0 } });
    });
    expect(positionOf()).toBe(55);
    const reads = loadBoard.mock.calls.length;
    act(() => {
      dispatchWorkspaceEvent({
        type: "canvas.presence",
        boardId: board.id,
        clients: [
          {
            clientId: presenceClientId(),
            deviceName: "",
            deviceKey: "",
            lastSeenAt: stamp,
          },
          {
            clientId: "other-client-01",
            deviceName: "iPad",
            deviceKey: "",
            lastSeenAt: stamp,
          },
        ],
        lease: {
          clientId: "other-client-01",
          deviceName: "iPad",
          deviceKey: "",
          acquiredAt: later,
        },
      });
    });
    expect(isReadOnly(useCanvasStore.getState())).toBe(true);
    await waitFor(() =>
      expect(loadBoard.mock.calls.length).toBeGreaterThan(reads),
    );
    await waitFor(() => expect(positionOf()).toBe(0));
  });

  it("订阅 boards.presence：每一项在线表放进 store，不必等心跳", async () => {
    renderHook(() => useBoardSync(), { wrapper });
    await waitFor(() => expect(positionOf()).toBe(0));
    await waitFor(() => expect(watches.length).toBe(1));
    expect(watches[0]).toMatchObject({
      workspaceId: workspace.id,
      boardId: board.id,
      clientId: presenceClientId(),
    });
    const reads = loadBoard.mock.calls.length;
    remote = document(31, later);
    act(() => {
      watches[0]!.onPresence({
        boardId: board.id,
        clients: [
          {
            clientId: presenceClientId(),
            deviceName: "",
            deviceKey: "",
            lastSeenAt: stamp,
          },
          {
            clientId: "other-client-01",
            deviceName: "iPad",
            deviceKey: "",
            lastSeenAt: stamp,
          },
        ],
        lease: {
          clientId: "other-client-01",
          deviceName: "iPad",
          deviceKey: "",
          acquiredAt: later,
        },
        writable: true,
        deviceKey: "",
      });
    });
    expect(isReadOnly(useCanvasStore.getState())).toBe(true);
    await waitFor(() => expect(positionOf()).toBe(31));
    expect(loadBoard.mock.calls.length).toBeGreaterThan(reads);
  });

  it("订阅连着时定时心跳只在有操作要报时发；订阅结束就回到整拍兜底", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      renderHook(() => useBoardSync(), { wrapper });
      await vi.waitFor(() => expect(watches.length).toBe(1));
      await vi.waitFor(() => expect(presenceHeartbeat).toHaveBeenCalled());
      act(() => {
        watches[0]!.onPresence({
          boardId: board.id,
          clients: [],
          lease: null,
          writable: true,
        });
      });
      const base = presenceHeartbeat.mock.calls.length;
      // 订阅连着、没有操作：core 在续期，页面不发。
      act(() => {
        vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS);
      });
      expect(presenceHeartbeat.mock.calls.length).toBe(base);
      // 有操作要报：发一次，带 `active`。
      markPresenceActivity();
      act(() => {
        vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS);
      });
      expect(presenceHeartbeat.mock.calls.length).toBe(base + 1);
      expect(presenceHeartbeat.mock.calls.at(-1)?.[2]).toMatchObject({
        active: true,
      });
      // 订阅结束了（被拒、控制面停下）：立刻补一拍，之后每一拍都是兜底心跳。
      act(() => {
        watches[0]!.onEnd(new Error("closed"));
      });
      expect(presenceHeartbeat.mock.calls.length).toBe(base + 2);
      act(() => {
        vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS);
      });
      expect(presenceHeartbeat.mock.calls.length).toBe(base + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("卸载时取消订阅并离开这块画布", async () => {
    const { unmount } = renderHook(() => useBoardSync(), { wrapper });
    await waitFor(() => expect(presenceHeartbeat).toHaveBeenCalled());
    await waitFor(() => expect(watches.length).toBe(1));
    unmount();
    expect(watches[0]?.stopped).toBe(true);
    expect(leavePresence).toHaveBeenCalledWith(
      workspace.id,
      board.id,
      presenceClientId(),
    );
  });
});
