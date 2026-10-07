import { describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@armadra/shared";
import type { NodeMenuItemsFactory } from "@/canvas/menus/node-menu";

const registration = vi.hoisted(() => ({
  factory: null as NodeMenuItemsFactory | null,
}));
vi.mock("@/canvas/menus/node-menu", () => ({
  registerNodeMenuItems: (_type: string, factory: NodeMenuItemsFactory) => {
    registration.factory = factory;
    return () => undefined;
  },
}));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: { getState: () => ({ updateNodeData: vi.fn() }) },
}));
vi.mock("@/meta/annotations", () => ({ openNodeAnnotation: vi.fn() }));
vi.mock("./terminal-registry", () => ({ terminalHandle: () => null }));
vi.mock("@/agent/launch", () => ({
  customAgentFor: (id: string) =>
    id === "custom:pi" ? { baseAgent: "pi" } : undefined,
  permissionModeLabel: (mode: string) => mode,
  agentAcpInfo: (id: string) =>
    id === "codex"
      ? { support: "official", program: "codex-acp", installed: true }
      : undefined,
}));
const acp = vi.hoisted(() => ({ switchDriver: vi.fn() }));
vi.mock("@/acp/api", () => ({ acpApi: acp }));

import "./terminal-menu";

function permissions(id: string) {
  const node = {
    id: "test",
    type: "terminal",
    data: { kind: "terminal", agent: { id } },
  } as CanvasNode;
  return registration.factory!({ node, targetIds: [node.id] })
    .map((item) => item.id)
    .filter((key) => key.startsWith("agent.permission."));
}

describe("terminal permissions", () => {
  it.each(["pi", "opencode", "custom:pi"])(
    "does not offer unsupported permissions for %s",
    (id) => {
      expect(permissions(id)).toEqual(["agent.permission.default"]);
    },
  );

  it("does not present OMP's model selection flag as a planning permission", () => {
    expect(permissions("omp")).not.toContain("agent.permission.plan");
    expect(permissions("omp")).toContain("agent.permission.full-auto");
  });

  it("keeps the supported Claude planning mode available", () => {
    expect(permissions("claude")).toContain("agent.permission.plan");
  });
});

describe("driver items", () => {
  function items(agent: Record<string, unknown>) {
    const node = {
      id: "test",
      type: "terminal",
      data: { kind: "terminal", agent },
    } as CanvasNode;
    return registration.factory!({ node, targetIds: [node.id] }).filter(
      (item) => item.id.startsWith("agent.driver."),
    );
  }

  it("offers both views with the current one disabled", () => {
    expect(
      items({ id: "codex" }).map((item) => [item.id, item.disabled]),
    ).toEqual([
      ["agent.driver.acp", false],
      ["agent.driver.terminal", true],
    ]);
    expect(
      items({ id: "codex", driver: "acp" }).map((item) => [
        item.id,
        item.disabled,
      ]),
    ).toEqual([
      ["agent.driver.acp", true],
      ["agent.driver.terminal", false],
    ]);
  });

  it("does not appear for an agent without an ACP entry", () => {
    expect(items({ id: "pi" })).toEqual([]);
  });
});

describe("spawn agent", () => {
  function entries(data: Record<string, unknown>) {
    const node = { id: "lead", type: "terminal", data } as CanvasNode;
    return registration.factory!({ node, targetIds: [node.id] });
  }

  it("offers 「派生 Agent…」 on an agent node and opens the wizard for it", async () => {
    const { useWizardOpen } = await import("@/acp/wizard-open");
    const spawn = entries({ kind: "terminal", agent: { id: "codex" } }).find(
      (item) => item.id === "agent.spawn",
    );
    expect(spawn).toBeDefined();
    spawn!.run();
    expect(useWizardOpen.getState()).toMatchObject({
      open: true,
      supervisorNodeId: "lead",
    });
  });

  it("is not on a plain terminal", () => {
    expect(
      entries({ kind: "terminal" }).some((item) => item.id === "agent.spawn"),
    ).toBe(false);
  });
});
