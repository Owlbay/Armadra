import { describe, expect, it } from "vitest";

import {
  acpLogResponseSchema,
  acpPermissionRequestSchema,
  acpToolCallSchema,
  answerApprovalRequestSchema,
  answerApprovalResponseSchema,
  createAcpSessionRequestSchema,
  sessionSummarySchema,
  workspaceEventSchema,
} from "../src/index.js";

describe("ACP session shapes (contract §14.2–§14.4)", () => {
  it("parses the three ACP events on the workspace stream", () => {
    const update = workspaceEventSchema.parse({
      type: "acp.update",
      sessionId: "s1",
      nodeId: "n1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      },
    });
    expect(update.type).toBe("acp.update");
    const turn = workspaceEventSchema.parse({
      type: "acp.turn",
      sessionId: "s1",
      nodeId: "n1",
      turnId: "t1",
      stopReason: "something_new",
    });
    expect(turn.type === "acp.turn" && turn.stopReason).toBeUndefined();
    expect(
      workspaceEventSchema.parse({
        type: "acp.driver",
        nodeId: "n1",
        driver: "acp",
        sessionId: "s2",
        resumed: false,
      }).type,
    ).toBe("acp.driver");
  });

  it("keeps a tool call whose kind or status it does not know", () => {
    const call = acpToolCallSchema.parse({
      toolCallId: "t1",
      kind: "teleport",
      status: "done-ish",
      content: [
        { type: "diff", path: "/a", oldText: null, newText: "x" },
        { type: "content", content: { type: "text", text: "ok" } },
      ],
    });
    expect(call.kind).toBeUndefined();
    expect(call.status).toBeUndefined();
    expect(call.content).toHaveLength(2);
  });

  it("reads a permission request and a log with pending cards", () => {
    const request = acpPermissionRequestSchema.parse({
      protocol: "acp",
      toolCall: { toolCallId: "t1", title: "pnpm test" },
      options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
    });
    expect(request.options[0]?.kind).toBe("allow_once");
    const log = acpLogResponseSchema.parse({
      entries: [
        { role: "user", blocks: [{ type: "text", text: "hi" }], endOffset: 2 },
      ],
      endOffset: 2,
      pending: [{ ...request, pendingId: "p1" }],
    });
    expect(log.pending?.[0]?.pendingId).toBe("p1");
  });

  it("carries the option and the acp route on approval answers", () => {
    expect(
      answerApprovalRequestSchema.parse({ decision: "allow", optionId: "a" })
        .optionId,
    ).toBe("a");
    expect(
      answerApprovalResponseSchema.parse({
        id: "p1",
        nodeId: "n1",
        answer: "allow",
        answeredAt: "2026-10-03T00:00:00.000Z",
        revision: 1,
        route: "acp",
      }).route,
    ).toBe("acp");
  });

  it("validates a session request and a session row's backend", () => {
    expect(() =>
      createAcpSessionRequestSchema.parse({
        workspaceId: "w",
        nodeId: "n",
        cwd: "/",
        agentId: "codex",
        permissionMode: "plan",
      }),
    ).not.toThrow();
    expect(
      sessionSummarySchema.parse({
        nodeId: "n",
        boardId: "b",
        sessionId: "s",
        kind: "terminal",
        title: "t",
        cwd: "/",
        updatedAt: "2026-10-03T00:00:00.000Z",
        alive: true,
        backend: "acp",
      }).backend,
    ).toBe("acp");
  });
});
