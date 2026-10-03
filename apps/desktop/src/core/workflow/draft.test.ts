import { describe, expect, it } from "vitest";
import { validAgentId } from "../agent/registry";
import {
  checkRendered,
  findCycle,
  parseDraft,
  renderPrompt,
  resolveParams,
} from "./draft";

/**
 * 草案校验（契约 §15.1）。与共享层 `workflowDraftSchema` 是同一套规则，
 * `packages/shared/test/api-workflows.test.ts` 用同样的样本钉住那一边。
 */

const RULES = { validAgentId };

function sample(): Record<string, unknown> {
  return {
    version: 1,
    title: "双人代码审查",
    params: [
      { name: "repo", type: "path" },
      { name: "scopeA", type: "string" },
    ],
    roles: [
      {
        id: "reviewerA",
        agentId: "claude",
        permissionMode: "plan",
        model: null,
        worktree: null,
      },
      { id: "reviewerB", agentId: "custom:reviewer" },
      { id: "lead", agentId: "codex", permissionMode: "default" },
    ],
    links: [{ from: "lead", to: "reviewerA" }],
    steps: [
      {
        id: "s1",
        kind: "prompt",
        role: "reviewerA",
        prompt: "审查 {{scopeA}}",
        after: [],
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
    source: { boardId: "b", nodeIds: ["n"], proposedBy: "ama", extra: 1 },
    unknown: "dropped",
  };
}

describe("parseDraft", () => {
  it("accepts the design's sample and fills the defaults", () => {
    const draft = parseDraft(sample(), RULES);
    expect(draft.title).toBe("双人代码审查");
    expect(draft.links).toEqual([
      { from: "lead", to: "reviewerA", role: "peer" },
    ]);
    expect(draft.steps[1]).toMatchObject({ after: [] });
    expect(draft).not.toHaveProperty("unknown");
    expect(draft.source).toEqual({
      boardId: "b",
      nodeIds: ["n"],
      proposedBy: "ama",
      sessionId: null,
    });
  });

  it("accepts the same draft as a JSON string", () => {
    expect(parseDraft(JSON.stringify(sample()), RULES).steps).toHaveLength(4);
  });

  it("refuses an agentId that is neither in the registry nor custom:", () => {
    const draft = sample();
    (draft.roles as Record<string, unknown>[])[0]!.agentId = "gpt-cli";
    expect(() => parseDraft(draft, RULES)).toThrow(/gpt-cli/);
    try {
      parseDraft(draft, RULES);
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: "invalid_draft" });
    }
  });

  it("refuses an after cycle and names it", () => {
    const draft = sample();
    const steps = draft.steps as Record<string, unknown>[];
    steps[0]!.after = ["s4"];
    expect(() => parseDraft(draft, RULES)).toThrow(/成环/);
  });

  it("refuses dangling references", () => {
    const unknownRole = sample();
    (unknownRole.steps as Record<string, unknown>[])[0]!.role = "ghost";
    expect(() => parseDraft(unknownRole, RULES)).toThrow(/ghost/);

    const unknownAfter = sample();
    (unknownAfter.steps as Record<string, unknown>[])[1]!.after = ["s9"];
    expect(() => parseDraft(unknownAfter, RULES)).toThrow(/s9/);

    const collectOutsideAfter = sample();
    (collectOutsideAfter.steps as Record<string, unknown>[])[2]!.after = ["s1"];
    expect(() => parseDraft(collectOutsideAfter, RULES)).toThrow(/after/);

    const selfLink = sample();
    selfLink.links = [{ from: "lead", to: "lead" }];
    expect(() => parseDraft(selfLink, RULES)).toThrow(/同一个角色/);
  });

  it("refuses bad shapes", () => {
    for (const mutate of [
      (draft: Record<string, unknown>) => {
        draft.version = 0;
      },
      (draft: Record<string, unknown>) => {
        draft.roles = [];
      },
      (draft: Record<string, unknown>) => {
        (draft.steps as Record<string, unknown>[])[0]!.kind = "loop";
      },
      (draft: Record<string, unknown>) => {
        (draft.roles as Record<string, unknown>[])[0]!.permissionMode = "yolo";
      },
      (draft: Record<string, unknown>) => {
        (draft.roles as Record<string, unknown>[])[1]!.id = "reviewerA";
      },
      (draft: Record<string, unknown>) => {
        (draft.steps as Record<string, unknown>[])[0]!.prompt = "x".repeat(
          2_001,
        );
      },
    ]) {
      const draft = sample();
      mutate(draft);
      expect(() => parseDraft(draft, RULES)).toThrow();
    }
    expect(() => parseDraft("{", RULES)).toThrow(/JSON/);
    expect(() => parseDraft([], RULES)).toThrow();
  });
});

describe("findCycle", () => {
  it("returns the loop, or nothing", () => {
    expect(
      findCycle([
        { id: "a", after: ["c"] },
        { id: "b", after: ["a"] },
        { id: "c", after: ["b"] },
      ]),
    ).toEqual(["a", "c", "b", "a"]);
    expect(
      findCycle([
        { id: "a", after: [] },
        { id: "b", after: ["a"] },
      ]),
    ).toBeUndefined();
  });
});

describe("params", () => {
  it("fills defaults, refuses unknown and missing ones, and renders", () => {
    const draft = parseDraft(
      {
        ...sample(),
        params: [
          { name: "scopeA", type: "string" },
          { name: "repo", type: "path", default: "." },
        ],
      },
      RULES,
    );
    expect(resolveParams(draft, { scopeA: "src/x" })).toEqual({
      scopeA: "src/x",
      repo: ".",
    });
    expect(() => resolveParams(draft, {})).toThrow(
      expect.objectContaining({ code: "missing_param" }),
    );
    expect(() => resolveParams(draft, { scopeA: "a", other: "b" })).toThrow(
      /other/,
    );
    expect(renderPrompt("看 {{ scopeA }} 与 {{nope}}", { scopeA: "a" })).toBe(
      "看 a 与 {{nope}}",
    );
    expect(() =>
      checkRendered(draft, { scopeA: "x".repeat(1_999), repo: "." }),
    ).toThrow(expect.objectContaining({ code: "prompt_too_long" }));
  });
});
