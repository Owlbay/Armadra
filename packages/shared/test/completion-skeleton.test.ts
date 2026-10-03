import { describe, expect, it } from "vitest";
import {
  AGENT_STATE_SOURCES,
  TERMINAL_BACKENDS,
  agentIdSchema,
  agentInfoSchema,
  agentStateSourceSchema,
  boardRealtimeStateSchema,
  credentialEntrySchema,
  editorNodeDataSchema,
  gatewayPairingPayloadSchema,
  integrationStateSchema,
  mfaRequirementSchema,
  pushTransportSchema,
  stickyNodeDataSchema,
  terminalBackendKindSchema,
  terminalNodeDataSchema,
  workflowStepKindSchema,
} from "../src/index.js";

const nodeId = "019ff7d1-5c48-7d75-a0ed-64b52f44e214";

/** G0-2：后面各包要动的共享层热点一次改完（completion-plan §2 G0-2）。 */
describe("completion shared layer", () => {
  it("accepts ama wherever a built-in agent id is accepted", () => {
    expect(agentIdSchema.safeParse("ama").success).toBe(true);
    expect(agentIdSchema.safeParse("custom:wrapper").success).toBe(true);
    expect(agentIdSchema.safeParse("gemini").success).toBe(false);
  });

  it("stores how a terminal node's agent is driven", () => {
    const parsed = terminalNodeDataSchema.parse({
      kind: "terminal",
      agent: { id: "codex", driver: "acp" },
    });
    expect(parsed.agent?.driver).toBe("acp");
    expect(
      terminalNodeDataSchema.safeParse({
        kind: "terminal",
        agent: { id: "codex", driver: "pty" },
      }).success,
    ).toBe(false);
  });

  it("keeps where a sticky or editor's content came from", () => {
    const source = { nodeId, sessionId: "s-1", messageId: "m-1" };
    expect(
      stickyNodeDataSchema.parse({ kind: "sticky", content: "x", source })
        .source,
    ).toEqual(source);
    expect(
      editorNodeDataSchema.parse({ kind: "editor", path: "a.ts", source })
        .source,
    ).toEqual(source);
    expect(
      stickyNodeDataSchema.safeParse({
        kind: "sticky",
        source: { nodeId: "not-a-uuid", sessionId: "s" },
      }).success,
    ).toBe(false);
  });

  it("knows the ACP session row and state source", () => {
    expect(TERMINAL_BACKENDS).toContain("acp");
    expect(terminalBackendKindSchema.parse("acp")).toBe("acp");
    expect(AGENT_STATE_SOURCES).toContain("acp");
    expect(agentStateSourceSchema.parse("acp")).toBe("acp");
  });

  it("reads an agent row's acp field and outdated hosts", () => {
    const row = agentInfoSchema.parse({
      id: "opencode",
      label: "OpenCode",
      color: "#a78bfa",
      launchCmd: "opencode",
      promptMode: "flag-prompt",
      installed: true,
      acp: {
        support: "native",
        program: "opencode",
        installed: true,
        resume: "load",
      },
      outdatedHosts: [{ hostId: "h1", version: "0.1.0" }],
    });
    expect(row.acp?.support).toBe("native");
    expect(row.outdatedHosts?.[0]?.hostId).toBe("h1");
    const older = agentInfoSchema.parse({
      id: "claude",
      label: "Claude Code",
      color: "#d97757",
      launchCmd: "claude",
      promptMode: "argv",
      installed: true,
    });
    expect(older.acp).toBeUndefined();
    const state = integrationStateSchema.parse({
      agentId: "ama",
      mode: "canvas",
      hook: { installed: false },
      skill: { installed: false },
      legacy: {},
      revision: 1,
      outdatedHosts: [{ hostId: "h2" }],
    });
    expect(state.outdatedHosts).toEqual([{ hostId: "h2" }]);
  });

  it("exports a skeleton for every new domain", () => {
    expect(workflowStepKindSchema.options).toEqual([
      "prompt",
      "collect",
      "gate",
    ]);
    expect(
      boardRealtimeStateSchema.parse({ realtime: true, materializedSeq: 3 }),
    ).toEqual({ realtime: true, materializedSeq: 3 });
    expect(
      gatewayPairingPayloadSchema.safeParse({
        origin: "https://gw.example.test",
        ticket: "t",
        fingerprint: "ab:cd",
        expiresAt: "2026-10-03T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(mfaRequirementSchema.parse("members")).toBe("members");
    expect(pushTransportSchema.parse("log")).toBe("log");
    const entry = credentialEntrySchema.parse({
      ref: "work",
      providerId: "claude",
      kind: "oauth-token",
      label: "Work",
      isSet: true,
    });
    expect(entry.isSet).toBe(true);
  });
});
