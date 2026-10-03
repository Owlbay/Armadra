import { describe, expect, it } from "vitest";

import {
  workflowDraftSchema,
  workflowRunSchema,
  workspaceEventSchema,
} from "../src/index.js";

/**
 * 草案 schema（契约 §15.1）。与 core 的 `workflow/draft.ts` 是同一套规则，
 * `apps/desktop/src/core/workflow/draft.test.ts` 用同样的样本钉住那一边。
 */

function sample(): Record<string, unknown> {
  return {
    version: 1,
    title: "双人代码审查",
    params: [{ name: "scopeA", type: "string" }],
    roles: [
      { id: "reviewerA", agentId: "claude", permissionMode: "plan" },
      { id: "reviewerB", agentId: "custom:reviewer" },
      { id: "lead", agentId: "ama", permissionMode: "default" },
    ],
    links: [{ from: "lead", to: "reviewerA" }],
    steps: [
      {
        id: "s1",
        kind: "prompt",
        role: "reviewerA",
        prompt: "审查 {{scopeA}}",
      },
      { id: "s2", kind: "prompt", role: "reviewerB", prompt: "审查 B" },
      {
        id: "s3",
        kind: "collect",
        role: "lead",
        from: ["s1", "s2"],
        prompt: "汇总",
        after: ["s1", "s2"],
      },
      { id: "s4", kind: "gate", label: "合并前人工确认", after: ["s3"] },
    ],
    source: { boardId: "b", proposedBy: "ama" },
  };
}

describe("workflowDraftSchema", () => {
  it("accepts the design's sample and fills defaults", () => {
    const parsed = workflowDraftSchema.parse(sample());
    expect(parsed.links[0]).toEqual({
      from: "lead",
      to: "reviewerA",
      role: "peer",
    });
    expect(parsed.steps[1]?.after).toEqual([]);
  });

  it("rejects an unknown agentId", () => {
    const draft = sample();
    (draft.roles as Record<string, unknown>[])[0]!.agentId = "gpt-cli";
    expect(workflowDraftSchema.safeParse(draft).success).toBe(false);
  });

  it("rejects an after cycle and dangling references", () => {
    const cycle = sample();
    (cycle.steps as Record<string, unknown>[])[0]!.after = ["s4"];
    expect(workflowDraftSchema.safeParse(cycle).success).toBe(false);

    const ghost = sample();
    (ghost.steps as Record<string, unknown>[])[0]!.role = "ghost";
    expect(workflowDraftSchema.safeParse(ghost).success).toBe(false);

    const outside = sample();
    (outside.steps as Record<string, unknown>[])[2]!.after = ["s1"];
    expect(workflowDraftSchema.safeParse(outside).success).toBe(false);
  });
});

describe("run and event shapes", () => {
  it("parses a run and the three workflow events", () => {
    expect(
      workflowRunSchema.safeParse({
        id: "r",
        templateId: "t",
        templateVersion: 1,
        title: "x",
        workspaceId: "w",
        boardId: "b",
        frameId: "f",
        params: { scope: "src" },
        status: "waiting",
        reason: null,
        roles: { worker: "n" },
        startedAt: "2026-10-03T00:00:00.000Z",
        endedAt: null,
        steps: [
          {
            stepId: "s1",
            kind: "gate",
            role: null,
            status: "waiting",
            nodeId: null,
            startedAt: "2026-10-03T00:00:00.000Z",
            endedAt: null,
            reason: null,
            outputs: [],
            decision: null,
            note: null,
          },
        ],
      }).success,
    ).toBe(true);
    for (const event of [
      { type: "workflow.draft", draftId: "d", boardId: "b", status: "pending" },
      { type: "workflow.run", runId: "r", boardId: "b", status: "running" },
      {
        type: "workflow.gate",
        runId: "r",
        boardId: "b",
        stepId: "s",
        label: "l",
        state: "waiting",
      },
    ]) {
      expect(workspaceEventSchema.safeParse(event).success).toBe(true);
    }
  });
});
