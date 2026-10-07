import { describe, expect, it } from "vitest";
import {
  conversationRefreshResponseSchema,
  conversationsResponseSchema,
  suggestTitleResponseSchema,
} from "../src/index.js";

describe("runtime conversations API", () => {
  it("types a conversation row without exposing the transcript path", () => {
    const [row] = conversationsResponseSchema.parse([
      {
        provider: "codex",
        sessionId: "019edf45-4c81-7d30-a950-9d7a7cc853c7",
        title: "对比两种实现方式",
        cwd: "/Users/me/repo",
        updatedAt: "2026-09-04T02:06:15.000Z",
        bytes: 802832,
      },
    ]);
    expect(row!.provider).toBe("codex");
    expect(row!.title).toBe("对比两种实现方式");
    expect(row).not.toHaveProperty("path");

    // A transcript may record no working directory; an empty string is legal.
    expect(
      conversationsResponseSchema.safeParse([
        {
          provider: "claude",
          sessionId: "s",
          title: "t",
          cwd: "",
          updatedAt: "2026-09-04T02:06:15.000Z",
          bytes: 0,
        },
      ]).success,
    ).toBe(true);

    // Every built-in agent with a history adapter can own a row (design
    // cli-collaboration §3); a provider outside AGENT_IDS still cannot.
    const accepts = (provider: string) =>
      conversationsResponseSchema.safeParse([
        {
          provider,
          sessionId: "s",
          title: "t",
          cwd: "",
          updatedAt: "2026-09-04T02:06:15.000Z",
          bytes: 0,
        },
      ]).success;
    expect(accepts("opencode")).toBe(true);
    expect(accepts("copilot")).toBe(true);
    expect(accepts("nobody")).toBe(false);
  });

  it("types the rescan report and the suggested title", () => {
    const report = conversationRefreshResponseSchema.parse({
      scanned: 2344,
      indexed: 12,
      removed: 0,
      total: 2340,
    });
    expect(report.indexed).toBe(12);

    expect(
      suggestTitleResponseSchema.parse({
        title: "给终端节点加上 AI 命名",
        source: "transcript",
      }).source,
    ).toBe("transcript");
    // Forty characters is the header's budget.
    expect(
      suggestTitleResponseSchema.safeParse({
        title: "x".repeat(41),
        source: "terminal",
      }).success,
    ).toBe(false);
    expect(
      suggestTitleResponseSchema.safeParse({ title: "x", source: "model" })
        .success,
    ).toBe(false);
  });
});
