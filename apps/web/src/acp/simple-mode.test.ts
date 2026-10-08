import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@armadra/shared";
import type { NodeMenuItemsFactory } from "@/canvas/menus/node-menu";

/**
 * 简洁模式（ACP 设计 §8 第 3 条）：隐藏清单本身，以及节点菜单、新建菜单
 * 两处真的按清单收起；偏好存在本机。
 */
const registration = vi.hoisted(() => ({
  factory: null as NodeMenuItemsFactory | null,
}));
vi.mock("@/canvas/menus/node-menu", () => ({
  registerNodeMenuItems: (_type: string, factory: NodeMenuItemsFactory) => {
    registration.factory = factory;
    return () => undefined;
  },
}));
vi.mock("@/meta/annotations", () => ({ openNodeAnnotation: vi.fn() }));
vi.mock("@/nodes/terminal-registry", () => ({ terminalHandle: () => null }));
vi.mock("@/agent/launch", async (original) => ({
  ...(await original<object>()),
  agentAcpInfo: (id: string) =>
    id === "codex"
      ? { support: "official", program: "codex-acp", installed: true }
      : undefined,
}));

const {
  SIMPLE_ADD_MENU,
  SIMPLE_HIDDEN_NODE_MENU,
  SIMPLE_MODE_KEY,
  reloadSimpleMode,
  useSimpleModeStore,
  visibleAddMenu,
  visibleNodeMenu,
} = await import("./simple-mode");
await import("@/nodes/terminal-menu");
const { buildAddMenu } = await import("@/canvas/menus/add-menu");

function menuIds(): string[] {
  const node = {
    id: "n1",
    type: "terminal",
    data: { kind: "terminal", agent: { id: "codex", driver: "acp" } },
  } as CanvasNode;
  return registration.factory!({ node, targetIds: [node.id] }).map(
    (item) => item.id,
  );
}

const t = (key: string) => key;

beforeEach(() => {
  localStorage.removeItem(SIMPLE_MODE_KEY);
  reloadSimpleMode();
});

describe("隐藏清单", () => {
  it("节点菜单隐藏回收 / 权限模式 / 终端视图，新建菜单只留各 Agent 与便签 / 白板", () => {
    expect(SIMPLE_HIDDEN_NODE_MENU).toEqual([
      "agent.recycle",
      "agent.permission.*",
      "agent.driver.terminal",
    ]);
    expect(SIMPLE_ADD_MENU).toEqual([
      "add.agent.*",
      "add.sticky",
      "add.text",
      "add.frame",
    ]);
  });

  it("关着时什么都不藏", () => {
    const items = [{ id: "agent.recycle" }, { id: "add.terminal" }];
    expect(visibleNodeMenu(items, false)).toEqual(items);
    expect(visibleAddMenu(items, false)).toEqual(items);
  });
});

describe("节点菜单", () => {
  it("开着时回收、四个权限模式与终端视图都不出现，其余照旧", () => {
    const before = menuIds();
    expect(before).toContain("agent.recycle");
    expect(before.some((id) => id.startsWith("agent.permission."))).toBe(true);
    expect(before).toContain("agent.driver.terminal");

    useSimpleModeStore.getState().setSimpleMode(true);
    const after = menuIds();
    expect(after).not.toContain("agent.recycle");
    expect(after.some((id) => id.startsWith("agent.permission."))).toBe(false);
    expect(after).not.toContain("agent.driver.terminal");
    expect(after).toEqual(
      expect.arrayContaining([
        "node.labels",
        "agent.settings",
        "agent.restart",
        "agent.driver.acp",
      ]),
    );
  });
});

describe("新建菜单", () => {
  it("没有向导项；开着时只剩各 Agent 与清单里的几项", () => {
    const agents = [
      { id: "claude", label: "Claude", resolvedPath: "/bin/claude" },
    ] as never;
    const all = buildAddMenu(agents, t as never, [], false);
    expect(all.some((item) => item.id === "add.newAgent")).toBe(false);
    expect(visibleAddMenu(all, true).map((item) => item.id)).toEqual([
      "add.agent.claude",
      "add.sticky",
      "add.text",
      "add.frame",
    ]);
  });
});

describe("偏好", () => {
  it("缺省关；开关写进本机存储，重读后保持", () => {
    expect(useSimpleModeStore.getState().simpleMode).toBe(false);
    useSimpleModeStore.getState().setSimpleMode(true);
    expect(localStorage.getItem(SIMPLE_MODE_KEY)).toBe("true");
    reloadSimpleMode();
    expect(useSimpleModeStore.getState().simpleMode).toBe(true);
  });
});
