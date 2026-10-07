import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TerminalNodeData } from "@armadra/shared";
import type { SurfaceRefs } from "./refs";
import { useTerminalSession } from "./use-session";
import { useLaunchSequence } from "./use-launch";

const fixture = vi.hoisted(() => ({
  data: {
    kind: "terminal",
    launchPolicy: "manual",
    agent: { id: "codex" },
  } as TerminalNodeData,
  find: vi.fn(),
  start: vi.fn(),
  input: vi.fn(),
  patch: vi.fn(),
  setSessionId: vi.fn(),
}));
vi.mock("@/session", () => ({
  sessionGateway: { find: fixture.find, start: fixture.start },
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
vi.mock("@/agent/dependency-store", () => ({
  launchHold: () => "free",
  migrateLegacyLaunch: vi.fn(),
  whenDependenciesKnown: async () => {},
}));
vi.mock("@/agent/launch", () => ({
  agentSessionRequest: vi.fn(),
  launchDialect: vi.fn(),
  buildAgentLaunch: () => ({ command: "codex" }),
}));
vi.mock("@/agent/pending-launch", () => ({ armPendingLaunch: vi.fn() }));
function refs(): SurfaceRefs {
  return {
    dataRef: { current: fixture.data },
    freshSessionRef: { current: true },
    shellRef: { current: undefined },
    creatingRef: { current: false },
    launchPhaseRef: { current: "idle" },
    launchTimerRef: { current: null },
    promptTimerRef: { current: null },
    transportRef: { current: { input: fixture.input } },
  } as unknown as SurfaceRefs;
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.find.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("mount and explicit recreation never create even a shell for a manual node", async () => {
  const hook = renderHook(() =>
    useTerminalSession(refs(), {
      nodeId: "node",
      attempt: 0,
      patch: fixture.patch,
      setSessionId: fixture.setSessionId,
      onHibernated: vi.fn(),
    }),
  );
  await waitFor(() => expect(fixture.find).toHaveBeenCalled());
  await act(() => hook.result.current(true));
  expect(fixture.start).not.toHaveBeenCalled();
  expect(fixture.patch).toHaveBeenCalledWith(
    expect.objectContaining({ connection: "idle" }),
  );
});

it("attaches a core-started manual session without launch input", async () => {
  fixture.find.mockResolvedValue({
    state: "running",
    sessionId: "core-session",
    shell: "/bin/zsh",
  });
  const stable = refs();
  renderHook(() =>
    useTerminalSession(stable, {
      nodeId: "node",
      attempt: 0,
      patch: fixture.patch,
      setSessionId: fixture.setSessionId,
      onHibernated: vi.fn(),
    }),
  );
  await waitFor(() =>
    expect(fixture.setSessionId).toHaveBeenCalledWith("core-session"),
  );
  expect(stable.freshSessionRef.current).toBe(false);
  expect(fixture.start).not.toHaveBeenCalled();
  vi.useFakeTimers();
  const launcher = renderHook(() =>
    useLaunchSequence(stable, { nodeId: "node", patch: fixture.patch }),
  );
  act(() => launcher.result.current.armLaunch());
  act(() => vi.advanceTimersByTime(10000));
  expect(fixture.input).not.toHaveBeenCalled();
});
