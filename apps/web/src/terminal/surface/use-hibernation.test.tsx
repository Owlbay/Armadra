import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({
  listener: null as null | ((event: Record<string, unknown>) => void),
}));

vi.mock("@/api/events", () => ({
  onWorkspaceEvent: (
    _type: string,
    listener: (event: Record<string, unknown>) => void,
  ) => {
    events.listener = listener;
    return () => {
      events.listener = null;
    };
  },
}));
vi.mock("@/session", () => ({ sessionGateway: { wake: vi.fn() } }));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: { getState: () => ({ workspace: { id: "ws" } }) },
}));
vi.mock("@/app/preferences-store", () => ({ t: (key: string) => key }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import type { SurfaceRefs } from "./refs";
import { takeWakeWithoutReset, useHibernation } from "./use-hibernation";

function surface(backend: "tmux" | "direct"): SurfaceRefs {
  return {
    backendRef: { current: backend },
    freshSessionRef: { current: true },
    statusRef: {
      current: { connection: "hibernated", hibernation: "hibernated" },
    },
    dataRef: { current: { kind: "terminal" } },
  } as unknown as SurfaceRefs;
}

/** ui-acp-refresh §7.3 E-4：被别的端叫醒的 tmux 终端，重连时不清屏。 */
describe("waking from elsewhere", () => {
  it("lets a tmux surface reconnect without a reset, once", () => {
    const refs = surface("tmux");
    const setAttempt = vi.fn();
    renderHook(() =>
      useHibernation(refs, {
        nodeId: "node",
        patch: vi.fn(),
        setSessionId: vi.fn(),
        setAttempt,
      }),
    );
    events.listener?.({ nodeId: "node", sessionId: "s", state: "running" });
    expect(setAttempt).toHaveBeenCalledTimes(1);
    expect(takeWakeWithoutReset(refs)).toBe(true);
    expect(takeWakeWithoutReset(refs)).toBe(false);
  });

  it("still resets a direct surface, whose attach replays a snapshot", () => {
    const refs = surface("direct");
    renderHook(() =>
      useHibernation(refs, {
        nodeId: "node",
        patch: vi.fn(),
        setSessionId: vi.fn(),
        setAttempt: vi.fn(),
      }),
    );
    events.listener?.({ nodeId: "node", sessionId: "s", state: "running" });
    expect(takeWakeWithoutReset(refs)).toBe(false);
  });
});
