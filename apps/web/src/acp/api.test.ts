import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { AgentInfo } from "@armadra/shared";

/** 预启动（契约 §51）只发一条 `POST /api/acp/prestart`：换掉请求层就够了。 */
const request = vi.hoisted(() => vi.fn());
vi.mock("@/api/request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/request")>();
  return { ...actual, request };
});

const store = vi.hoisted(() => ({
  workspace: { id: "w1", rootPath: "/repo" } as null | {
    id: string;
    rootPath: string;
  },
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

const source = vi.hoisted(() => ({ id: "local" }));
vi.mock("@/api/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/source")>();
  return {
    ...actual,
    currentSource: () => ({ ...actual.currentSource(), sourceId: source.id }),
  };
});

import { usePreferencesStore } from "@/app/preferences-store";
import { usePrestartOnOpen } from "./api";
import { setDefaultDriverForTest } from "./driver";

function agent(id: string, installed: boolean): AgentInfo {
  return {
    id,
    acp: {
      support: "official",
      program: `${id}-acp`,
      installed,
      resume: "load",
    },
  } as unknown as AgentInfo;
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue(undefined);
  store.workspace = { id: "w1", rootPath: "/repo" };
  source.id = "local";
  setDefaultDriverForTest("acp");
  usePreferencesStore.setState({ defaultAgentId: "claude" });
});

afterEach(cleanup);

describe("usePrestartOnOpen", () => {
  it("prestarts the default agent once when the menu opens", () => {
    const agents = [agent("codex", true), agent("claude", true)];
    const { rerender } = renderHook(() => usePrestartOnOpen(agents));
    rerender();
    expect(request).toHaveBeenCalledTimes(1);
    const [path, , init] = request.mock.calls[0] as [
      string,
      unknown,
      RequestInit,
    ];
    expect(path).toBe("/api/acp/prestart");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: "w1",
      agentId: "claude",
    });
  });

  it("does nothing when the default agent would run in a terminal", () => {
    renderHook(() => usePrestartOnOpen([agent("claude", false)]));
    setDefaultDriverForTest("terminal");
    renderHook(() => usePrestartOnOpen([agent("claude", true)]));
    expect(request).not.toHaveBeenCalled();
  });

  it("does nothing on a remote source or before a workspace is open", () => {
    source.id = "remote-1";
    renderHook(() => usePrestartOnOpen([agent("claude", true)]));
    source.id = "local";
    store.workspace = null;
    renderHook(() => usePrestartOnOpen([agent("claude", true)]));
    expect(request).not.toHaveBeenCalled();
  });

  it("swallows a failed prestart", async () => {
    request.mockRejectedValue(new Error("offline"));
    renderHook(() => usePrestartOnOpen([agent("claude", true)]));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
