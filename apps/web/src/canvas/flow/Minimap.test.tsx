import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { AgentGlow } from "@/agent/status-store";

import { installDomPolyfills } from "@/app/test-harness";
import { useMinimapPreferences } from "@/app/minimap-preferences";
import { toItemId } from "@/canvas/whiteboard/model";
import {
  MINIMAP_COLORS,
  Minimap,
  minimapFill,
  minimapItemOf,
  minimapLinksFrom,
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

    fireEvent.click(screen.getByRole("button", { name: "收起缩略图" }));
    expect(screen.queryByTestId("rf__minimap")).toBeNull();
    expect(screen.getByRole("button", { name: "展开缩略图" })).toBeTruthy();
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

describe("小地图里的连线", () => {
  const box = (x: number) => ({ x, y: 0, width: 100, height: 50 });
  const boxes: Record<string, ReturnType<typeof box>> = {
    b: box(300),
    c: box(600),
  };
  const edge = (id: string, target: string, role?: "supervises") =>
    ({
      id,
      type: "link",
      source: "a",
      target,
      ...(role ? { data: { role } } : { data: {} }),
    }) as never;

  it("上下文线用 --link-context，派发线用主的簇色；中心连中心", () => {
    const links = minimapLinksFrom(
      "a",
      box(0),
      [
        edge("e1", "b"),
        edge("e2", "c", "supervises"),
        { id: "r", type: "reference", source: "a", target: "b" } as never,
      ],
      (id) => boxes[id],
      () => "var(--node-color-6)",
    );
    expect(links).toEqual([
      {
        key: "e1",
        x1: 50,
        y1: 25,
        x2: 350,
        y2: 25,
        color: "var(--link-context)",
        role: "context",
      },
      {
        key: "e2",
        x1: 50,
        y1: 25,
        x2: 650,
        y2: 25,
        color: "var(--node-color-6)",
        role: "dispatch",
      },
    ]);
  });

  it("目标不在小地图里就不画", () => {
    expect(
      minimapLinksFrom(
        "a",
        box(0),
        [edge("e1", "gone")],
        () => undefined,
        () => undefined,
      ),
    ).toEqual([]);
  });
});
