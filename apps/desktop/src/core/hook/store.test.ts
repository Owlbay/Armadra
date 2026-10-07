import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AgentFixture, agentFixture } from "../agent/fixture";
import { getAgentStatus, upsertAgentStatus } from "./store";

/**
 * 状态来源的词汇是封闭的：库里只收认识的值。`acp` 是 core 以 ACP 驱动的会话
 * （ACP 会话视图设计 §4.1），与 `hook` 一样是上报。
 */

let fixture: AgentFixture;

beforeEach(() => {
  fixture = agentFixture();
});

afterEach(() => fixture.close());

function write(stateSource: string) {
  return upsertAgentStatus(fixture.database, {
    nodeId: "node-acp",
    workspaceId: fixture.workspaceId,
    agentId: "opencode",
    state: "working",
    stateSource,
    unread: false,
    sessionId: "ses-1",
    pendingId: undefined,
    verified: true,
    transcriptPath: undefined,
    sessionPhase: undefined,
    errored: undefined,
    interrupted: undefined,
    lastEventAt: new Date().toISOString(),
  });
}

describe("agent_status.state_source", () => {
  it("stores acp like any other known source", () => {
    write("acp");
    expect(getAgentStatus(fixture.database, "node-acp")?.stateSource).toBe(
      "acp",
    );
  });

  it("refuses a source nobody recognises", () => {
    expect(() => write("invented")).toThrow("Unknown agent state source");
  });
});
