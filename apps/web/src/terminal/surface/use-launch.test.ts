import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TerminalNodeData } from "@armadra/shared";
import type { SurfaceRefs } from "./refs";
import { useLaunchSequence } from "./use-launch";
import { LAUNCH_COLD_MS, LAUNCH_RETRY_MAX_MS } from "./constants";

/**
 * 启动闸门与失败重试（契约 §52、界面第二波 §8.3）：先申请位置再敲；敲完没起来
 * 就退避后再敲一次；第二次仍失败只标「启动失败」，不再敲第三次。
 */

const fixture = vi.hoisted(() => ({
  data: { kind: "terminal", agent: { id: "codex" } } as TerminalNodeData,
  input: vi.fn(),
  patch: vi.fn(),
  launchSlot: vi.fn(),
  launchResult: vi.fn(),
  order: [] as string[],
}));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: {
    getState: () => ({
      workspace: { id: "workspace", rootPath: "/repo" },
      document: { nodes: [{ id: "node", data: fixture.data }] },
      updateNodeData: vi.fn(),
    }),
  },
}));
vi.mock("@/api/client", () => ({
  runtimeApi: {
    launchSlot: fixture.launchSlot,
    launchResult: fixture.launchResult,
  },
}));
vi.mock("@/agent/dependency-store", () => ({
  launchHold: () => "free",
  migrateLegacyLaunch: vi.fn(),
  whenDependenciesKnown: async () => {},
}));
vi.mock("@/agent/launch", () => ({
  launchDialect: vi.fn(),
  buildAgentLaunch: () => ({ command: "codex" }),
}));
vi.mock("@/agent/pending-launch", () => ({ armPendingLaunch: vi.fn() }));

function refs(): SurfaceRefs {
  return {
    dataRef: { current: fixture.data },
    freshSessionRef: { current: true },
    shellRef: { current: undefined },
    launchPhaseRef: { current: "idle" },
    launchTimerRef: { current: null },
    promptTimerRef: { current: null },
    statusRef: { current: { connection: "live" } },
    transportRef: { current: { input: fixture.input } },
  } as unknown as SurfaceRefs;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.order.length = 0;
  vi.useFakeTimers();
  fixture.input.mockImplementation(() => fixture.order.push("type"));
  fixture.launchSlot.mockImplementation(async () => {
    fixture.order.push("slot");
    return { granted: true, waitedMs: 0 };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function launch() {
  const hook = renderHook(() =>
    useLaunchSequence(refs(), { nodeId: "node", patch: fixture.patch }),
  );
  act(() => hook.result.current.armLaunch());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAUNCH_COLD_MS);
  });
  return hook;
}

it("asks the gate for a slot before typing the launch line", async () => {
  fixture.launchResult.mockResolvedValue({ verdict: "started", settled: 0 });
  await launch();
  expect(fixture.order).toEqual(["slot", "type"]);
  expect(fixture.launchSlot).toHaveBeenCalledWith(
    { workspaceId: "workspace", nodeId: "node", agentId: "codex" },
    expect.anything(),
  );
  expect(fixture.launchResult).toHaveBeenCalledWith(
    { workspaceId: "workspace", nodeId: "node", agentId: "codex", attempt: 1 },
    expect.anything(),
  );
});

it("types anyway when the gate cannot be reached", async () => {
  fixture.launchSlot.mockRejectedValue(new Error("offline"));
  fixture.launchResult.mockRejectedValue(new Error("offline"));
  await launch();
  expect(fixture.input).toHaveBeenCalledTimes(1);
  expect(fixture.patch).not.toHaveBeenCalledWith({ launch: "failed" });
});

it("retypes once after a failed launch, then marks the node failed", async () => {
  fixture.launchResult.mockResolvedValue({ verdict: "failed", settled: 0 });
  await launch();
  expect(fixture.input).toHaveBeenCalledTimes(1);
  // 退避 2–5 s 之内不重敲。
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_999);
  });
  expect(fixture.input).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAUNCH_RETRY_MAX_MS);
  });
  expect(fixture.input).toHaveBeenCalledTimes(2);
  expect(fixture.launchResult).toHaveBeenLastCalledWith(
    expect.objectContaining({ attempt: 2 }),
    expect.anything(),
  );
  expect(fixture.patch).toHaveBeenCalledWith({ launch: "failed" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAUNCH_RETRY_MAX_MS * 3);
  });
  expect(fixture.input).toHaveBeenCalledTimes(2);
});

it("drops the retry when the launch is cleared", async () => {
  fixture.launchResult.mockResolvedValue({ verdict: "failed", settled: 0 });
  const hook = await launch();
  act(() => hook.result.current.clearLaunchTimers());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAUNCH_RETRY_MAX_MS * 2);
  });
  expect(fixture.input).toHaveBeenCalledTimes(1);
});
