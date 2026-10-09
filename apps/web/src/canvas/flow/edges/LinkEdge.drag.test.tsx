import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeHandle,
  type NodeTypes,
} from "@xyflow/react";
import type { BoardDocument, CanvasNode } from "@armadra/shared";

import { installDomPolyfills } from "@/app/test-harness";
import { makeEdge, makeNode } from "@/canvas/test-support";
import { useCanvasStore } from "@/store/canvas-store";
import { edgeTypes } from "./edge-types";
import * as visual from "./link-visual";

/**
 * 拖动节点时连线跟着换边（#211）。
 *
 * 断言两件事：被拖的那个节点身上的线按新的相对位置重新选了两端的边；没挂在
 * 它身上的线不重算（`linkView` 只为受影响的边再跑一遍）。
 */

vi.mock("./link-visual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./link-visual")>();
  return { ...actual, linkView: vi.fn(actual.linkView) };
});

beforeAll(installDomPolyfills);

afterEach(() => {
  cleanup();
  useCanvasStore.setState({ document: null });
  vi.mocked(visual.linkView).mockClear();
});

const A = "019ff7d1-0d12-7421-833d-2c5e8d64ee01";
const B = "019ff7d1-0d12-7421-833d-2c5e8d64ee02";
const C = "019ff7d1-0d12-7421-833d-2c5e8d64ee03";
const D = "019ff7d1-0d12-7421-833d-2c5e8d64ee04";

const nodeTypes: NodeTypes = { armadra: () => null };

/** jsdom 量不出把手；边的几何本来就不读它们，只是 React Flow 要有才肯画。 */
const HANDLES: NodeHandle[] = [
  { id: "left", type: "source", position: Position.Left, x: 0, y: 50 },
  { id: "right", type: "source", position: Position.Right, x: 100, y: 50 },
  { id: "body", type: "target", position: Position.Left, x: 0, y: 0 },
];

function flowNode(id: string, x: number, y: number): Node {
  return {
    id,
    type: "armadra",
    position: { x, y },
    width: 100,
    height: 100,
    handles: HANDLES,
    data: makeNode("terminal", { id }) as unknown as Record<string, unknown>,
  };
}

const EDGES: Edge[] = [
  { id: "ab", type: "link", source: A, target: B, data: {} },
  { id: "cd", type: "link", source: C, target: D, data: {} },
];

function flow(nodes: Node[], edges: Edge[] = EDGES) {
  return (
    <ReactFlowProvider>
      <ReactFlow
        width={1600}
        height={1200}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodes={nodes}
        edges={edges}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onViewportChange={() => undefined}
        onError={() => undefined}
      />
    </ReactFlowProvider>
  );
}

function pathOf(container: HTMLElement, id: string): string {
  const path = container.querySelector(
    `[data-id="${id}"] .react-flow__edge-path`,
  );
  expect(path).not.toBeNull();
  return path!.getAttribute("d") ?? "";
}

/** 路径起点与终点（`M x,y C … x,y`）。 */
function ends(d: string): [string, string] {
  const start = /^M (-?[\d.]+,-?[\d.]+) /u.exec(d)?.[1] ?? "";
  const end = / (-?[\d.]+,-?[\d.]+)$/u.exec(d)?.[1] ?? "";
  return [start, end];
}

describe("拖动时连线随动", () => {
  it("目标从右侧拖到下方、左侧、上方，两端每一步都换到相对的边", () => {
    const a = flowNode(A, 0, 0);
    const c = flowNode(C, 1000, 1000);
    const d = flowNode(D, 1300, 1000);
    const view = render(flow([a, flowNode(B, 400, 0), c, d]));
    // 右 → 左
    expect(ends(pathOf(view.container, "ab"))).toEqual(["100,50", "400,50"]);

    view.rerender(flow([a, flowNode(B, 0, 400), c, d]));
    // 底 → 顶
    expect(ends(pathOf(view.container, "ab"))).toEqual(["50,100", "50,400"]);

    view.rerender(flow([a, flowNode(B, -400, 0), c, d]));
    // 左 → 右
    expect(ends(pathOf(view.container, "ab"))).toEqual(["0,50", "-300,50"]);

    view.rerender(flow([a, flowNode(B, 0, -400), c, d]));
    // 顶 → 底
    expect(ends(pathOf(view.container, "ab"))).toEqual(["50,0", "50,-300"]);
  });

  it("只重算挂在被拖节点上的边", () => {
    const a = flowNode(A, 0, 0);
    const c = flowNode(C, 1000, 1000);
    const d = flowNode(D, 1300, 1000);
    const view = render(flow([a, flowNode(B, 400, 0), c, d]));
    const before = pathOf(view.container, "cd");
    const linkView = vi.mocked(visual.linkView);
    linkView.mockClear();

    // 连拖三帧，只有 B 在动。
    for (const y of [100, 200, 300]) {
      view.rerender(flow([a, flowNode(B, 400, y), c, d]));
    }

    const recomputed = linkView.mock.calls.map(([source]) => source.x);
    // 每一次重算的都是以 A（x=0）为起点的那条线，C → D 一次都没算。
    expect(recomputed.length).toBeGreaterThanOrEqual(3);
    expect(recomputed.every((x) => x === 0)).toBe(true);
    expect(pathOf(view.container, "cd")).toBe(before);
  });

  it("派发线：子被拖到主上方时改走主顶 → 子底，拖回下方又回到主底 → 子顶", () => {
    const agent = (id: string) =>
      makeNode("terminal", {
        id,
        data: { kind: "terminal", agent: { id: "claude" } },
      } as Partial<CanvasNode>);
    useCanvasStore.setState({
      document: {
        board: {} as BoardDocument["board"],
        nodes: [agent(A), agent(B)],
        edges: [{ ...makeEdge(A, B), role: "supervises" }],
      },
    });
    const edges: Edge[] = [
      {
        id: "ab",
        type: "link",
        source: A,
        target: B,
        data: { role: "supervises" },
      },
    ];
    const a = flowNode(A, 0, 0);
    const view = render(flow([a, flowNode(B, 300, 300)], edges));
    // 纵向布局（缺省），子在下游：主底 → 子顶，横向差不影响。
    expect(ends(pathOf(view.container, "ab"))).toEqual(["50,100", "350,300"]);

    view.rerender(flow([a, flowNode(B, 20, -400)], edges));
    expect(ends(pathOf(view.container, "ab"))).toEqual(["50,0", "70,-300"]);

    view.rerender(flow([a, flowNode(B, -400, 20)], edges));
    expect(ends(pathOf(view.container, "ab"))).toEqual(["0,50", "-300,70"]);

    view.rerender(flow([a, flowNode(B, 300, 300)], edges));
    expect(ends(pathOf(view.container, "ab"))).toEqual(["50,100", "350,300"]);
  });
});
