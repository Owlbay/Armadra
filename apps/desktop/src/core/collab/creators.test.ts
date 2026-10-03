import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { nodeCreator, sessionCreator } from "../identity/creators";
import { controlDispatcher, type ControlOutcome } from "./control";
import { resetSendLimits } from "./send-limits";
import { resetInboxWake } from "./wake";

/**
 * 契约 §23「创建者 = 触发者」：控制动词建的节点继承调用方节点终端的创建者。
 * operator 从页面起的协调者建出来的成员（ama 的 runner 也经 `open-agent`），
 * 之后不管终端由谁、从哪条路起，都还是 operator 的——他驱动得了、审批得了。
 */

let fixture: AgentFixture;
let coordinator: string;
let coordinatorSession: string;

async function run(
  verb: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  const outcome: ControlOutcome = await dispatcher.dispatch(
    verb,
    callerFor(fixture, coordinator),
    args,
  );
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  return outcome.body.result as Record<string, unknown>;
}

/** 像终端管理器那样替节点插一行会话（不写创建者那一列）。 */
function spawnFor(nodeId: string): string {
  return fixture.session(nodeId, "codex");
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  fixture = agentFixture();
  coordinator = fixture.agentNode("协调者");
  coordinatorSession = fixture.session(coordinator, "claude");
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  resetInboxWake();
});

function startedBy(principalId: string): void {
  fixture.database
    .prepare(
      "UPDATE terminal_sessions SET creator_principal_id = ? WHERE id = ?",
    )
    .run(principalId, coordinatorSession);
}

describe("控制动词建的节点继承调用方的创建者", () => {
  it("open-agent：节点记下触发者，之后起的终端都继承", async () => {
    startedBy("operator-1");
    const created = (await run("open-agent", { agent: "codex" })).id as string;
    expect(nodeCreator(fixture.database, created)).toBe("operator-1");
    expect(sessionCreator(fixture.database, spawnFor(created))).toBe(
      "operator-1",
    );
  });

  it("open-terminal 与 team 同理", async () => {
    startedBy("operator-1");
    const terminal = (await run("open-terminal", { title: "壳" })).id as string;
    expect(nodeCreator(fixture.database, terminal)).toBe("operator-1");
    const members = (
      (await run("team", {
        member: ["codex|实现|写", "claude|审阅|看"],
      })) as { members: { id: string }[] }
    ).members;
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(nodeCreator(fixture.database, member.id)).toBe("operator-1");
    }
  });

  it("owner 的协调者建的节点记 owner（空串），成员替它起终端也不变成成员的", async () => {
    const created = (await run("open-agent", { agent: "codex" })).id as string;
    expect(nodeCreator(fixture.database, created)).toBe("");
    expect(sessionCreator(fixture.database, spawnFor(created))).toBe("");
  });
});
