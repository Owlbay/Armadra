import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/store/canvas-store";
import type { Peer } from "./awareness";
import type { SocketLike } from "./client";
import { BOARD, ONE, boardDocument, terminal } from "./realtime.fixture";
import { startRealtime, stopRealtime } from "./session";
import {
  followTarget,
  loadBoardViewport,
  saveBoardViewport,
  viewportCenter,
  viewportStorageKey,
} from "./viewport";

/** 实时板的视口：本机记着、awareness 报中心、跟随退回光标（契约 §16.4）。 */

function peer(patch: Partial<Peer["state"]> = {}): Peer {
  return {
    clientId: 7,
    state: { principalId: "", deviceId: "d", name: "n", color: 3, ...patch },
  };
}

/** 永远连不上的 socket：只测开板与收板，不走同步。 */
function deadSocket(): SocketLike {
  return {
    binaryType: "arraybuffer",
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => undefined,
    close: () => undefined,
  };
}

describe("本机视口", () => {
  beforeEach(() => localStorage.clear());

  it("按 boardId 存取；坏数据当作没存过", () => {
    expect(loadBoardViewport("b1")).toBeNull();
    saveBoardViewport("b1", { x: 10, y: -20, zoom: 1.5 });
    expect(loadBoardViewport("b1")).toEqual({ x: 10, y: -20, zoom: 1.5 });
    expect(loadBoardViewport("b2")).toBeNull();
    for (const bad of [
      "{",
      "null",
      '{"x":1,"y":2}',
      '{"x":1,"y":2,"zoom":0}',
    ]) {
      localStorage.setItem(viewportStorageKey("b3"), bad);
      expect(loadBoardViewport("b3")).toBeNull();
    }
    saveBoardViewport("b4", { x: Number.NaN, y: 0, zoom: 1 });
    expect(loadBoardViewport("b4")).toBeNull();
  });

  it("视口中心：容器中点换算成画布坐标", () => {
    expect(
      viewportCenter({ x: 100, y: 50, zoom: 2 }, { width: 800, height: 600 }),
    ).toEqual({ x: 150, y: 125, zoom: 2 });
    expect(
      viewportCenter({ x: 0, y: 0, zoom: 1 }, { width: 0, height: 600 }),
    ).toBeNull();
  });

  it("跟随：报了视口跟视口，没报退回光标，都没有不动", () => {
    expect(
      followTarget(
        peer({ viewport: { x: 1, y: 2, zoom: 0.5 }, cursor: { x: 9, y: 9 } }),
      ),
    ).toEqual({ kind: "viewport", x: 1, y: 2, zoom: 0.5 });
    expect(followTarget(peer({ cursor: { x: 9, y: 8 } }))).toEqual({
      kind: "cursor",
      x: 9,
      y: 8,
    });
    expect(followTarget(peer())).toBeNull();
    expect(followTarget(undefined)).toBeNull();
  });
});

describe("实时板开板与刷新", () => {
  beforeEach(() => {
    localStorage.clear();
    const store = useCanvasStore.getState();
    store.selectBoard(BOARD.id);
    store.setDocument(boardDocument([terminal(ONE, 0)]));
  });

  afterEach(() => {
    stopRealtime(BOARD.id);
    useCanvasStore.getState().selectBoard(null);
  });

  it("开板换成本机记着的视口，之后的变化写回本机；刷新后视口不变", () => {
    saveBoardViewport(BOARD.id, { x: -300, y: 120, zoom: 0.75 });
    const stop = startRealtime({
      workspaceId: BOARD.workspaceId,
      boardId: BOARD.id,
      createSocket: deadSocket,
      checkState: () => Promise.resolve({ realtime: true }),
    });
    expect(useCanvasStore.getState().document!.board.viewport).toEqual({
      x: -300,
      y: 120,
      zoom: 0.75,
    });

    useCanvasStore.getState().setViewport({ x: 40, y: 60, zoom: 1.25 });
    expect(loadBoardViewport(BOARD.id)).toEqual({ x: 40, y: 60, zoom: 1.25 });
    stop();

    // 「刷新」：重新载入文档（文档里的视口是旧的），再开实时。
    useCanvasStore.getState().setDocument(boardDocument([terminal(ONE, 0)]));
    const again = startRealtime({
      workspaceId: BOARD.workspaceId,
      boardId: BOARD.id,
      createSocket: deadSocket,
      checkState: () => Promise.resolve({ realtime: true }),
    });
    expect(useCanvasStore.getState().document!.board.viewport).toEqual({
      x: 40,
      y: 60,
      zoom: 1.25,
    });
    again();
  });

  it("没记过就留着打开时的那份", () => {
    const stop = startRealtime({
      workspaceId: BOARD.workspaceId,
      boardId: BOARD.id,
      createSocket: deadSocket,
      checkState: () => Promise.resolve({ realtime: true }),
    });
    expect(useCanvasStore.getState().document!.board.viewport).toEqual(
      BOARD.viewport,
    );
    stop();
  });
});
