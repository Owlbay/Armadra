import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { freeLease } from "../drive/lease";
import { controlDispatcher, type ControlOutcome } from "./control";
import { SendPump } from "./send-pump";
import { resetSendLimits } from "./send-limits";

/**
 * 画面门（设计 `agent-delivery.md` §4.3「画面门」）。
 *
 * 2026-10-02 `agent-e2e` 场景 10 首跑：Claude Code 2.1.286 在用户缺省权限为
 * bypass 时一起来就弹「把 auto 设为缺省权限模式？」（缺省为是），Hook 照样报
 * 开场，首投放行门把对端 `send` 的正文加回车打进去，替人确认了那个对话框。
 *
 * 画面全是自编的几行字，只保留对话框里有辨识度的那一行。
 */

const PROMPT = "────────\n❯ \n────────\n  ? for shortcuts";
const AUTO_MODE_DIALOG = [
  " Make auto mode your default permission mode?",
  " ❯ 1. Yes, set auto mode as my default permission mode",
  "   2. No, keep the current mode",
  " Enter to confirm · Esc to cancel",
].join("\n");
const TRUST_DIALOG = [
  " Accessing workspace:",
  " Quick safety check: Is this a project you created or one you trust?",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
].join("\n");

let fixture: AgentFixture;
let me: string;
let peer: string;
let peerSession: string;

async function run(
  verb: string,
  args: Record<string, unknown>,
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, me), args);
}

function ok(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok)
    throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  return outcome.body;
}

/** 目标在终端域里的样子；缺省是 Hook 报过的 `idle`。 */
function target(patch: Partial<{ state: string }> = {}): void {
  fixture.terminal.drive.set(peer, {
    nodeId: peer,
    sessionId: peerSession,
    state: "idle",
    stateSource: "hook",
    lease: freeLease(0),
    driveGeneration: 0,
    ...patch,
  } as never);
}

/** 库里那一行：Hook 只报过开场，状态是空的——Claude 起来之后的样子。 */
function openedOnly(): void {
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, state_source, " +
        "unread, verified, restored, session_phase, session_id, updated_at) " +
        "VALUES (?, ?, 'claude', NULL, 'hook', 0, 1, 0, 'start', 'prov-1', ?)",
    )
    .run(peer, fixture.workspaceId, new Date().toISOString());
  fixture.database
    .prepare("UPDATE terminal_sessions SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 10_000).toISOString(), peerSession);
  fixture.terminal.activity.set(peerSession, {
    pending: false,
    lastInputAt: undefined,
    lastOutputAt: Date.now() - 500,
  });
  target({ state: "starting" });
}

beforeEach(() => {
  resetSendLimits();
  fixture = agentFixture();
  me = fixture.agentNode("Caller");
  fixture.name(me, "planner");
  peer = fixture.agentNode("审查", "claude");
  peerSession = fixture.session(peer, "claude");
  fixture.link(me, peer);
  fixture.terminal.foreground = { command: "claude" };
  target();
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
});

describe("the screen gate", () => {
  it("首投：画面停在「把 auto 设为缺省」对话框上，排队而不打字", async () => {
    openedOnly();
    fixture.terminal.capture = AUTO_MODE_DIALOG;

    const body = ok(await run("send", { to: peer, body: "做这件事" }));
    expect(body).toMatchObject({
      outcome: "queued",
      reason: "TARGET_NOT_AT_PROMPT",
      targetState: "awaiting-approval",
    });
    expect(fixture.terminal.submits).toHaveLength(0);
    expect(fixture.terminal.writes).toHaveLength(0);

    // 人在终端里答掉对话框之后不会有任何上报；快探再看一眼画面就投出去。
    fixture.terminal.capture = `${AUTO_MODE_DIALOG}\n${PROMPT}`;
    const pump = new SendPump(() => fixture.collab);
    expect(await pump.probeSilentStarters()).toBe(1);
    expect(fixture.terminal.submits).toHaveLength(1);
    expect(fixture.terminal.submits[0]?.data).toContain("做这件事");
  });

  it("Hook 报过空闲也照样拦：画面是已知对话框", async () => {
    fixture.terminal.capture = TRUST_DIALOG;
    const body = ok(await run("send", { to: peer, body: "做这件事" }));
    expect(body).toMatchObject({
      outcome: "queued",
      reason: "TARGET_NOT_AT_PROMPT",
    });
    expect(fixture.terminal.submits).toHaveLength(0);

    // 这种目标的下一次空闲同样不会以事件到来：队头的理由让快探接着看。
    const pump = new SendPump(() => fixture.collab);
    expect(await pump.probeSilentStarters()).toBe(1);
    expect(fixture.terminal.submits).toHaveLength(0);
    fixture.terminal.capture = PROMPT;
    expect(await pump.probeSilentStarters()).toBe(1);
    expect(fixture.terminal.submits).toHaveLength(1);
  });

  it("--no-queue：当场拒绝，码是 TARGET_NOT_AT_PROMPT", async () => {
    fixture.terminal.capture = AUTO_MODE_DIALOG;
    const outcome = await run("send", {
      to: peer,
      body: "做这件事",
      "no-queue": true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("TARGET_NOT_AT_PROMPT");
    expect(fixture.terminal.submits).toHaveLength(0);
    const refused = fixture.events
      .map((entry) => entry.event as unknown as Record<string, unknown>)
      .find((event) => event.outcome === "refused");
    expect(refused).toMatchObject({ code: "TARGET_NOT_AT_PROMPT" });
  });

  it("首投时画面还没画出提示符：排队", async () => {
    openedOnly();
    fixture.terminal.capture = " Claude Code vX.Y.Z\n loading…";
    const body = ok(await run("send", { to: peer, body: "做这件事" }));
    expect(body).toMatchObject({
      outcome: "queued",
      reason: "TARGET_NOT_AT_PROMPT",
    });
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("首投、画面是提示符：投出去", async () => {
    openedOnly();
    fixture.terminal.capture = PROMPT;
    const body = ok(await run("send", { to: peer, body: "做这件事" }));
    expect(body).toMatchObject({ outcome: "delivered" });
  });

  it("平常的投递不要求看得见提示符：只拦已知对话框", async () => {
    // Hook 报过一轮结束的空闲，画面认不出来——照旧投。
    let captured = 0;
    const capture = fixture.terminal.bridge.capture;
    fixture.terminal.bridge.capture = async (...args) => {
      captured += 1;
      return capture(...args);
    };
    fixture.terminal.capture = "some output\nthat is not a known dialog";
    const body = ok(await run("send", { to: peer, body: "做这件事" }));
    expect(body).toMatchObject({ outcome: "delivered" });
    // 有画面特征的 CLI 每次投之前都看一眼。
    expect(captured).toBe(1);
  });

  it("没有画面特征的 CLI 不取画面", async () => {
    let captured = 0;
    const capture = fixture.terminal.bridge.capture;
    fixture.terminal.bridge.capture = async (...args) => {
      captured += 1;
      return capture(...args);
    };
    const pi = fixture.agentNode("pi", "pi");
    const piSession = fixture.session(pi, "pi");
    fixture.link(me, pi);
    fixture.terminal.drive.set(pi, {
      nodeId: pi,
      sessionId: piSession,
      state: "idle",
      stateSource: "extension",
      lease: freeLease(0),
      driveGeneration: 0,
    } as never);
    fixture.terminal.foreground = { command: "pi" };
    fixture.terminal.capture = AUTO_MODE_DIALOG;
    const body = ok(await run("send", { to: pi, body: "做这件事" }));
    expect(body).toMatchObject({ outcome: "delivered" });
    expect(captured).toBe(0);
  });
});
