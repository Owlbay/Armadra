import { describe, expect, it } from "vitest";
import type { CanvasEdge, CanvasNode } from "@armadra/shared";

import { currentFamilies, familyOf } from "./family";
import { makeEdge, makeNode } from "./test-support";

/**
 * 簇色（设计 ui-wave2 §5.1）：同一个主派出来的同色，不同主不同色，上下文线
 * 不改色；不在树上的 Agent 用标识色，其他节点按类型。
 */

function agent(id: string, agentId = "claude"): CanvasNode {
  return makeNode("terminal", {
    id,
    data: { kind: "terminal", agent: { id: agentId } },
  } as Partial<CanvasNode>);
}

function supervises(source: string, target: string): CanvasEdge {
  return { ...makeEdge(source, target), role: "supervises" };
}

// id 排序即创建顺序（uuidv7 单调）。
const A = "0190a000-0000-7000-8000-000000000001";
const A1 = "0190a000-0000-7000-8000-000000000002";
const A2 = "0190a000-0000-7000-8000-000000000003";
const B = "0190a000-0000-7000-8000-000000000004";
const B1 = "0190a000-0000-7000-8000-000000000005";
const LONE = "0190a000-0000-7000-8000-000000000006";

describe("familyOf", () => {
  const nodes = [
    agent(A),
    agent(A1, "codex"),
    agent(A2, "codex"),
    agent(B, "codex"),
    agent(B1),
    agent(LONE, "codex"),
  ];
  const edges = [
    supervises(A, A1),
    supervises(A1, A2),
    supervises(B, B1),
    // 上下文线不改色。
    makeEdge(A, LONE),
  ];

  it("树内同色（含孙），两棵树不同色", () => {
    const families = familyOf({ nodes, edges });
    expect(families.get(A)).toEqual({
      kind: "cluster",
      rootId: A,
      color: "var(--node-color-1)",
    });
    expect(families.get(A1)?.color).toBe("var(--node-color-1)");
    expect(families.get(A2)?.rootId).toBe(A);
    expect(families.get(B)?.color).toBe("var(--node-color-2)");
    expect(families.get(B1)?.color).toBe("var(--node-color-2)");
  });

  it("独立 Agent 用标识色", () => {
    expect(familyOf({ nodes, edges }).get(LONE)).toEqual({
      kind: "agent",
      color: "var(--agent-codex)",
    });
  });

  it("非 Agent 节点按类型，纯 shell 中性", () => {
    const sticky = makeNode("sticky");
    const group = makeNode("group");
    const shell = makeNode("terminal");
    const families = familyOf({ nodes: [sticky, group, shell], edges: [] });
    expect(families.get(sticky.id)).toEqual({
      kind: "type",
      color: "var(--mm-sticky)",
    });
    expect(families.get(group.id)?.color).toBe("var(--mm-group)");
    expect(families.get(shell.id)?.color).toBe("var(--muted-foreground)");
  });

  it("根的顺序按 id，不按边的顺序", () => {
    const reversed = familyOf({ nodes, edges: [...edges].reverse() });
    expect(reversed.get(A)?.color).toBe("var(--node-color-1)");
    expect(reversed.get(B)?.color).toBe("var(--node-color-2)");
  });

  it("第八棵树起颜色循环", () => {
    const many = Array.from({ length: 16 }, (_, index) =>
      agent(`0190b000-0000-7000-8000-${String(index).padStart(12, "0")}`),
    );
    const pairs = Array.from({ length: 8 }, (_, index) =>
      supervises(many[index * 2]!.id, many[index * 2 + 1]!.id),
    );
    const families = familyOf({ nodes: many, edges: pairs });
    expect(families.get(many[14]!.id)?.color).toBe("var(--node-color-1)");
  });

  it("一个节点两条上级边时先到的赢；环也不死循环", () => {
    const twice = familyOf({
      nodes,
      edges: [supervises(A, A1), supervises(B, A1)],
    });
    expect(twice.get(A1)?.rootId).toBe(A);
    // 被忽略的那条边不给 B 成簇。
    expect(twice.get(B)?.kind).toBe("agent");

    const loop = familyOf({
      nodes,
      edges: [supervises(A, B), supervises(B, A)],
    });
    expect(loop.get(A)?.rootId).toBe(A);
    expect(loop.get(B)?.rootId).toBe(A);
  });

  it("指向已删节点的边不成簇", () => {
    const families = familyOf({
      nodes: [agent(A)],
      edges: [supervises(A, A1)],
    });
    expect(families.get(A)?.kind).toBe("agent");
  });
});

describe("currentFamilies", () => {
  it("同一份 nodes / edges 只算一次", () => {
    const nodes = [agent(A), agent(A1)];
    const edges = [supervises(A, A1)];
    const first = currentFamilies({ nodes, edges });
    expect(currentFamilies({ nodes, edges })).toBe(first);
    expect(currentFamilies({ nodes, edges: [] })).not.toBe(first);
    expect(currentFamilies(null).size).toBe(0);
  });
});
