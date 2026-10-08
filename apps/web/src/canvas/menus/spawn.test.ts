import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentInfo, BoardDocument, CanvasNode } from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { canUndo, resetHistory, undo } from "@/store/canvas/history";
import { setLayoutDirectionForTest } from "../layout-direction";
import { makeNode } from "../test-support";
import { buildSpawnItems, spawnSubordinate } from "./add-menu";

/**
 * 「派生」= 直接创建（ui-wave2 §6.2）：一步建节点 + 主从边，撤销一次全回；
 * 落点按布局方向，与 core 的 `open-agent` 同一条 `dispatchPlacement`。
 */

const STAMP = "2026-10-09T00:00:00.000Z";

function agent(id: string, installed = true): AgentInfo {
  return {
    id,
    label: id === "codex" ? "Codex" : "Claude Code",
    color: "#10a37f",
    launchCmd: id,
    promptMode: "argv",
    args: [],
    capabilities: ["hooks"],
    ...(installed ? { resolvedPath: `/usr/local/bin/${id}` } : {}),
    installed,
    clientRevision: 1,
  } as AgentInfo;
}

function load(nodes: CanvasNode[]): void {
  useCanvasStore.setState({
    document: {
      board: {
        id: "019ff7d1-0d12-7421-833d-2c5e8d64ed00",
        workspaceId: "w1",
        name: "board",
        sortOrder: 0,
        viewport: { x: 0, y: 0, zoom: 1 },
        whiteboard: "",
        createdAt: STAMP,
        updatedAt: STAMP,
      },
      nodes,
      edges: [],
    } as unknown as BoardDocument,
  });
}

const main = () =>
  makeNode("terminal", {
    position: { x: 100, y: 100 },
    size: { width: 960, height: 600 },
    data: {
      kind: "terminal",
      agent: { id: "claude", permissionMode: "plan" },
    } as CanvasNode["data"],
  });

beforeEach(() => {
  resetHistory();
  setLayoutDirectionForTest("vertical");
});

afterEach(() => {
  resetHistory();
  setLayoutDirectionForTest("vertical");
  useCanvasStore.setState({ document: null });
});

describe("spawnSubordinate", () => {
  it("建一个从并连 supervises 边；纵向放在主下面一行；撤销一次全回", () => {
    const parent = main();
    load([parent]);
    const id = spawnSubordinate(agent("codex"), parent.id);
    expect(id).toBeTruthy();
    const document = useCanvasStore.getState().document!;
    expect(document.nodes).toHaveLength(2);
    const child = document.nodes.find((node) => node.id === id)!;
    expect(child.position).toEqual({ x: 100, y: 100 + 600 + 48 });
    expect(child.data).toMatchObject({
      kind: "terminal",
      agent: { id: "codex" },
    });
    expect(document.edges).toEqual([
      expect.objectContaining({
        source: parent.id,
        target: id,
        role: "supervises",
      }),
    ]);

    undo();
    expect(canUndo()).toBe(false);
    expect(useCanvasStore.getState().document!.nodes).toHaveLength(1);
    expect(useCanvasStore.getState().document!.edges).toHaveLength(0);
  });

  it("第二个从接在第一个右边；横向时放在主右侧", () => {
    const parent = main();
    load([parent]);
    const first = spawnSubordinate(agent("codex"), parent.id)!;
    const second = spawnSubordinate(agent("codex"), parent.id)!;
    const at = (id: string) =>
      useCanvasStore.getState().document!.nodes.find((node) => node.id === id)!
        .position;
    expect(at(second).y).toBe(at(first).y);
    expect(at(second).x).toBeGreaterThan(at(first).x);

    setLayoutDirectionForTest("horizontal");
    load([parent]);
    const across = spawnSubordinate(agent("codex"), parent.id)!;
    expect(at(across)).toEqual({ x: 100 + 960 + 60, y: 100 });
  });

  it("给了落点就以它为中心；父的权限模式这家支持就继承", () => {
    const parent = main();
    load([parent]);
    const id = spawnSubordinate(agent("claude"), parent.id, { x: 0, y: 0 })!;
    const child = useCanvasStore
      .getState()
      .document!.nodes.find((node) => node.id === id)!;
    expect(child.position.x).toBeLessThan(0);
    expect(child.position.y).toBeLessThan(0);
    expect(child.data).toMatchObject({
      agent: { id: "claude", permissionMode: "plan" },
    });
  });

  it("父不在画布上时什么都不建", () => {
    load([]);
    expect(spawnSubordinate(agent("codex"), "missing")).toBeNull();
    expect(canUndo()).toBe(false);
  });
});

describe("buildSpawnItems", () => {
  it("每家一项，与父同一家的排第一；没装的禁用", () => {
    const items = buildSpawnItems(
      [agent("claude"), agent("codex"), agent("pi", false)],
      (key) => key,
      "parent",
      "codex",
    );
    expect(items.map((item) => item.id)).toEqual([
      "spawn.agent.codex",
      "spawn.agent.claude",
      "spawn.agent.pi",
    ]);
    expect(items.map((item) => item.disabledReason())).toEqual([
      null,
      null,
      "add.notInstalled",
    ]);
  });
});
