import { afterEach, describe, expect, it } from "vitest";

import { localSource, type Source } from "../api/source";
import type { SocketLike } from "./client";
import {
  realtimeActive,
  startRealtime,
  stopRealtime,
  useRealtimeStore,
} from "./session";

const urls: string[] = [];
function fakeSocket(url: string): SocketLike {
  urls.push(url);
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

const remote: Source = {
  ...localSource,
  sourceId: "remote",
  httpBase: "http://r",
  wsBase: "ws://r",
};

afterEach(() => {
  stopRealtime("b1");
  urls.length = 0;
});

describe("实时协同按 (sourceId, boardId) 认板", () => {
  it("零配置：板在本机源下，地址走本机", () => {
    const stop = startRealtime({
      workspaceId: "w1",
      boardId: "b1",
      createSocket: fakeSocket,
    });
    expect(useRealtimeStore.getState().sourceId).toBe("local");
    expect(realtimeActive("b1")).toBe(true);
    expect(realtimeActive("b1", "local")).toBe(true);
    stop();
    expect(realtimeActive("b1")).toBe(false);
  });

  it("同名的板在另一个源里不是同一块：停错源不动，地址走那个源", () => {
    const stop = startRealtime({
      source: remote,
      workspaceId: "w1",
      boardId: "b1",
      createSocket: fakeSocket,
    });
    expect(urls[0]).toContain("ws://r/");
    expect(realtimeActive("b1", "remote")).toBe(true);
    expect(realtimeActive("b1", "local")).toBe(false);
    stopRealtime("b1", "local");
    expect(realtimeActive("b1", "remote")).toBe(true);
    stop();
    expect(realtimeActive("b1")).toBe(false);
  });
});
