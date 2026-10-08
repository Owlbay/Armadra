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
const registry = vi.hoisted(() => ({
  agents: [] as {
    id: string;
    label: string;
    installed: boolean;
    resolvedPath?: string;
  }[],
}));
vi.mock("@/agent/launch", () => ({
  agentRegistry: () => registry.agents,
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

describe("spawn", () => {
  function entries(data: Record<string, unknown>) {
    const node = { id: "lead", type: "terminal", data } as CanvasNode;
    return registration.factory!({ node, targetIds: [node.id] });
  }

  it("「派生」是子菜单：每家可用的 Agent 一项，与父同一家排第一", () => {
    registry.agents = [
      {
        id: "claude",
        label: "Claude Code",
        installed: true,
        resolvedPath: "/bin/claude",
      },
      {
        id: "codex",
        label: "Codex",
        installed: true,
        resolvedPath: "/bin/codex",
      },
      { id: "pi", label: "Pi", installed: false },
    ];
    const spawn = entries({ kind: "terminal", agent: { id: "codex" } }).find(
      (item) => item.id === "agent.spawn",
    );
    expect(spawn?.label).toBe("派生");
    // 没装的那家缺省不列（与新建菜单同一套「启用」判定）。
    expect(spawn?.children?.map((item) => item.id)).toEqual([
      "spawn.agent.codex",
      "spawn.agent.claude",
    ]);
  });

  it("一家可用的都没有时整项置灰", () => {
    registry.agents = [{ id: "pi", label: "Pi", installed: false }];
    const spawn = entries({ kind: "terminal", agent: { id: "codex" } }).find(
      (item) => item.id === "agent.spawn",
    );
    expect(spawn?.disabled).toBe(true);
    expect(spawn?.children).toEqual([]);
  });

  it("is not on a plain terminal", () => {
    expect(
      entries({ kind: "terminal" }).some((item) => item.id === "agent.spawn"),
    ).toBe(false);
  });
});
