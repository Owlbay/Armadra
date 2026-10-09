import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import type { AgentGlow } from "@/agent/status-store";

import { installDomPolyfills } from "@/app/test-harness";
import { useMinimapPreferences } from "@/app/minimap-preferences";
import { toItemId } from "@/canvas/whiteboard/model";
import {
  MINIMAP_COLORS,
  Minimap,
  minimapFill,
  minimapItemOf,
  firstMinimapNodeId,
  minimapStroke,
  minimapStrokeWidth,
} from "./Minimap";

/**
 * 状态缩略图（React Flow 计划 F20）。
 *
 * 旧引擎的 `overlays/minimap.test.ts` 有 13 项，其中 9 项是几何与指针换算
 * （`fitPageBounds` / `minimapPointToPage` / `itemAtPoint` …）——那些现在
 * 由 React Flow 的 `<MiniMap>` 负责，我们只剩颜色。另加
 * `CanvasNavigationPanel.test.tsx` 那一项收起开关。
 */

/** DOM 的 `Node` 常量（名字被 React Flow 的 `Node` 类型占了）。 */
const Node_ = globalThis.Node;

beforeAll(installDomPolyfills);
beforeEach(() => useMinimapPreferences.getState().setCollapsed(false));
afterEach(cleanup);

function flowNode(
  id: string,
  type: "armadra" | "group" | "wb.text",
  selected = false,
) {
  return { id, type, selected } as const;
}

const noGlow = () => undefined;
const glowOf = (glow: AgentGlow) => () => glow;

describe("状态描边", () => {
  it("三种光晕各自映射到自己的 token", () => {
    expect(minimapStroke({ glow: "working" })).toBe(MINIMAP_COLORS.working);
    expect(minimapStroke({ glow: "attention" })).toBe(MINIMAP_COLORS.attention);
    expect(minimapStroke({ glow: "unread" })).toBe(MINIMAP_COLORS.unread);
  });

  it("没有状态的节点、分组与白板对象一律中性描边", () => {
    expect(minimapStroke({})).toBe(MINIMAP_COLORS.plain);
    expect(minimapStroke({ plain: true, glow: "working" })).toBe(
      MINIMAP_COLORS.plain,
    );
  });

  it("有状态的画粗一点：缩略图上 1px 的色差不够", () => {
    expect(minimapStrokeWidth(MINIMAP_COLORS.working)).toBe(4);
    expect(minimapStrokeWidth(MINIMAP_COLORS.plain)).toBe(2);
  });

  it("填充按家族色取 55%，选中 80%，分组与白板对象 35%（ui-wave2 §5.2）", () => {
    expect(minimapFill({ color: "var(--node-color-2)" })).toBe(
      "color-mix(in srgb, var(--node-color-2) 55%, transparent)",
    );
    expect(
      minimapFill({ color: "var(--node-color-2)", selected: true }),
    ).toContain("80%");
    expect(minimapFill({ plain: true })).toBe(
      "color-mix(in srgb, var(--muted-foreground) 35%, transparent)",
    );
  });

  it("派发簇成员无状态时描边用簇色，有状态时仍是状态色", () => {
    const member = { cluster: true, color: "var(--node-color-3)" };
    expect(minimapStroke(member)).toBe("var(--node-color-3)");
    expect(minimapStroke({ ...member, glow: "working" })).toBe(
      MINIMAP_COLORS.working,
    );
    // 独立 Agent 与类型色只改填充，不改描边。
    expect(minimapStroke({ color: "var(--agent-codex)" })).toBe(
      MINIMAP_COLORS.plain,
    );
    expect(minimapStrokeWidth("var(--node-color-3)")).toBe(2);
  });
});

describe("节点 → 上色输入", () => {
  it("只有 `armadra` 节点参与状态描边", () => {
    expect(minimapItemOf(flowNode("n1", "armadra"), glowOf("working"))).toEqual(
      { plain: false, selected: false, glow: "working" },
    );
  });

  it("分组与白板对象一律 plain，不查状态表", () => {
    expect(minimapItemOf(flowNode("g1", "group"), glowOf("working"))).toEqual({
      plain: true,
      selected: false,
    });
    expect(
      minimapItemOf(flowNode(toItemId("i1"), "wb.text"), glowOf("working")),
    ).toEqual({ plain: true, selected: false });
  });

  it("家族色从 familyOf 的表里取，簇成员带 cluster", () => {
    const families = new Map([
      [
        "n1",
        {
          kind: "cluster" as const,
          rootId: "n1",
          color: "var(--node-color-1)",
        },
      ],
      ["n2", { kind: "agent" as const, color: "var(--agent-claude)" }],
      ["g1", { kind: "type" as const, color: "var(--mm-group)" }],
    ]);
    const member = minimapItemOf(flowNode("n1", "armadra"), noGlow, families);
    expect(member).toEqual({
      plain: false,
      selected: false,
      color: "var(--node-color-1)",
      cluster: true,
    });
    expect(minimapFill(member)).toBe(
      "color-mix(in srgb, var(--node-color-1) 55%, transparent)",
    );
    expect(minimapItemOf(flowNode("n2", "armadra"), noGlow, families)).toEqual({
      plain: false,
      selected: false,
      color: "var(--agent-claude)",
    });
    expect(minimapItemOf(flowNode("g1", "group"), noGlow, families).color).toBe(
      "var(--mm-group)",
    );
  });

  it("选中态原样带过去", () => {
    expect(
      minimapItemOf(flowNode("n1", "armadra", true), noGlow).selected,
    ).toBe(true);
  });
});

describe("收起开关", () => {
  const renderPanel = () =>
    render(
      <ReactFlowProvider>
        <Minimap />
      </ReactFlowProvider>,
    );

  it("展开时画缩略图，点一下收起后只剩按钮", () => {
    renderPanel();
    expect(screen.getByTestId("rf__minimap")).toBeTruthy();

    // 展开时是一个「−」（悬停才显示，`styles/canvas.test.ts` 守 CSS），
    // 收起后是缩略图图标。
    const collapse = screen.getByRole("button", { name: "收起缩略图" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(collapse.querySelector(".lucide-minus")).toBeTruthy();
    fireEvent.click(collapse);
    expect(screen.queryByTestId("rf__minimap")).toBeNull();
    const expand = screen.getByRole("button", { name: "展开缩略图" });
    expect(expand.querySelector(".lucide-map")).toBeTruthy();
  });

  it("收起状态记在 `minimap-preferences` 里，重挂之后还在", () => {
    useMinimapPreferences.getState().setCollapsed(true);
    renderPanel();
    expect(screen.queryByTestId("rf__minimap")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "展开缩略图" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
});

describe("小地图里的连线（#216）", () => {
  const A = "019ff7d1-0d12-7421-833d-2c5e8d64ee01";
  const B = "019ff7d1-0d12-7421-833d-2c5e8d64ee02";
  const C = "019ff7d1-0d12-7421-833d-2c5e8d64ee03";
  const nodeTypes: NodeTypes = { armadra: () => null };
  const node = (id: string, x: number, y: number, hidden = false): Node => ({
    id,
    type: "armadra",
    position: { x, y },
    width: 100,
    height: 50,
    hidden,
    data: {},
  });
  const renderFlow = (nodes: Node[], edges: Edge[]) =>
    render(
      <ReactFlowProvider>
        <ReactFlow
          width={800}
          height={600}
          nodeTypes={nodeTypes}
          nodes={nodes}
          edges={edges}
        >
          <Minimap />
        </ReactFlow>
      </ReactFlowProvider>,
    );

  it("整层连线只画一次，按颜色合并成 path，压在所有节点矩形下面", () => {
    const { container } = renderFlow(
      [node(A, 0, 0), node(B, 300, 0), node(C, 0, 300)],
      [
        { id: "ab", type: "link", source: A, target: B, data: {} },
        { id: "bc", type: "link", source: B, target: C, data: {} },
        {
          id: "ac",
          type: "link",
          source: A,
          target: C,
          data: { role: "supervises" },
        },
      ],
    );
    const svg = container.querySelector(".react-flow__minimap-svg")!;
    const layers = svg.querySelectorAll('[data-slot="minimap-links"]');
    expect(layers).toHaveLength(1);
    const paths = layers[0]!.querySelectorAll("path");
    expect([...paths].map((p) => p.getAttribute("data-role"))).toEqual([
      "context",
      "dispatch",
    ]);
    // 两条上下文线合成一条 path；没有逐边的 <line>。
    expect(paths[0]!.getAttribute("d")!.match(/M/g)).toHaveLength(2);
    expect(svg.querySelectorAll("line")).toHaveLength(0);
    // 连线层在第一个节点矩形之前（SVG 后画的在上面）。
    const first = svg.querySelector("rect.react-flow__minimap-node")!;
    expect(
      layers[0]!.compareDocumentPosition(first) &
        Node_.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("第一个节点隐藏时由下一个节点挂连线层；没有连线就不画", () => {
    const { container } = renderFlow(
      [node(A, 0, 0, true), node(B, 300, 0), node(C, 0, 300)],
      [{ id: "bc", type: "link", source: B, target: C, data: {} }],
    );
    expect(
      container.querySelectorAll('[data-slot="minimap-links"]'),
    ).toHaveLength(1);
    cleanup();
    const empty = renderFlow([node(A, 0, 0), node(B, 300, 0)], []);
    expect(
      empty.container.querySelector('[data-slot="minimap-links"]'),
    ).toBeNull();
  });

  it("firstMinimapNodeId 跳过隐藏与没量到尺寸的节点", () => {
    const boxes: Record<
      string,
      { x: number; y: number; width: number; height: number }
    > = {
      b: { x: 0, y: 0, width: 1, height: 1 },
    };
    expect(
      firstMinimapNodeId(
        [{ id: "a" }, { id: "h", hidden: true }, { id: "b" }],
        (id) => boxes[id],
      ),
    ).toBe("b");
    expect(firstMinimapNodeId([], () => undefined)).toBeUndefined();
  });
});
