import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@armadra/shared";

import { makeNode } from "../test-support";
import { spawnSourceOf } from "./use-connect-end";

/** 拖线建从（ui-wave2 §6.3）：哪一次松手该弹「派发」菜单。 */

const lead = makeNode("terminal", {
  title: "lead",
  data: {
    kind: "terminal",
    handle: "planner",
    agent: { id: "claude" },
  } as CanvasNode["data"],
});
const shell = makeNode("terminal", {
  data: { kind: "terminal" } as CanvasNode["data"],
});
const note = makeNode("sticky");
const document = { nodes: [lead, shell, note] };

const drop = (fromId: string, extra: Record<string, unknown> = {}) =>
  ({
    isValid: false,
    toNode: null,
    fromNode: { id: fromId },
    ...extra,
  }) as never;

describe("spawnSourceOf", () => {
  it("Agent 节点起笔、落在空白处：弹，带上名字与 Agent", () => {
    expect(spawnSourceOf(drop(lead.id), document)).toEqual({
      nodeId: lead.id,
      name: "planner",
      agentId: "claude",
    });
  });

  it("落到了节点上或已经连成：不弹", () => {
    expect(
      spawnSourceOf(drop(lead.id, { toNode: { id: note.id } }), document),
    ).toBeNull();
    expect(
      spawnSourceOf(drop(lead.id, { isValid: true }), document),
    ).toBeNull();
  });

  it("从便签、纯终端起笔拖到空白：不弹", () => {
    expect(spawnSourceOf(drop(note.id), document)).toBeNull();
    expect(spawnSourceOf(drop(shell.id), document)).toBeNull();
    expect(spawnSourceOf(drop("missing"), document)).toBeNull();
  });
});
