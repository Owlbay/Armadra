import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { freeLease } from "../drive/lease";
import { controlDispatcher, type ControlOutcome } from "./control";
import { pendingCount, runMailbox, unreadDigest } from "./mailbox";
import { Args } from "./refusals";
import { SendPump } from "./send-pump";
import { resetSendLimits } from "./send-limits";
import { byId, settledUnnotified, enqueue, settle } from "./send-queue";
import { writeReceipts } from "./receipts";

/**
 * 投递终态回执（设计 `cli-collaboration.md` §4、§9 R1）。
 *
 * 三种终态写回执（过期、目标侧拒收、出队时门链拒绝），发送方自己取消的不写；
 * 回执只进收件箱，不进唤醒也不占容量；每一种终态都在投递记录里留一行。
 */

let fixture: AgentFixture;
let me: string;
let peer: string;
let peerSession: string;

async function run(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, nodeId), args);
}

function ok(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok)
    throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  return outcome.body;
}

function target(patch: Partial<{ state: string }>): void {
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

/** 目标忙着，排一条。返回队列 id。 */
async function queueOne(): Promise<string> {
  target({ state: "busy" });
  const body = ok(await run(me, "send", { to: peer, body: "做这件事" }));
  expect(body.outcome).toBe("queued");
  return String(body.id);
}

/** 时钟停在 `at` 的出队泵。 */
function pumpAt(at: number): SendPump {
  return new SendPump(() => ({
    ...fixture.collab,
    now: () => new Date(at * 1000),
  }));
}

async function inboxOf(nodeId: string): Promise<Record<string, unknown>[]> {
  const body = await runMailbox(
    fixture.collab,
    callerFor(fixture, nodeId),
    "inbox",
    new Args({}),
  );
  return body.messages as Record<string, unknown>[];
}

function receiptRows(): { source_node_id: string; target_node_id: string }[] {
  return fixture.database
    .prepare(
      "SELECT source_node_id, target_node_id FROM agent_mailbox WHERE message_key LIKE 'receipt:%'",
    )
    .all() as unknown as { source_node_id: string; target_node_id: string }[];
}

function deliveryOutcomes(queueId: string): string[] {
  const rows = fixture.database
    .prepare("SELECT outcome FROM agent_deliveries WHERE receipt = ?")
    .all(queueId) as unknown as { outcome: string }[];
  return rows.map((row) => row.outcome);
}

function terminalEvents(): Record<string, unknown>[] {
  return fixture.events
    .map((entry) => entry.event as unknown as Record<string, unknown>)
    .filter(
      (event) =>
        event.type === "agent.delivery" &&
        (event.outcome === "expired" || event.outcome === "cancelled"),
    );
}

beforeEach(() => {
  resetSendLimits();
  fixture = agentFixture();
  me = fixture.agentNode("Caller");
  peer = fixture.agentNode("审查", "codex");
  peerSession = fixture.session(peer, "codex");
  fixture.link(me, peer);
  fixture.terminal.foreground = { command: "codex" };
  target({});
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
});

describe("delivery receipts", () => {
  it("records controller expiry with run ownership, no node mailbox and no duplicate notification", () => {
    const now = nowSeconds();
    const inserted = enqueue(fixture.database, {
      id: "controller-receipt",
      workspaceId: fixture.workspaceId,
      sourceNodeId: null,
      sourceKind: "controller",
      controllerId: "external",
      runId: "run",
      taskId: "task",
      targetNodeId: peer,
      origin: "run-task",
      body: "task",
      hops: 0,
      trail: [],
      now,
      state: "queued",
    });
    expect(inserted.kind).toBe("inserted");
    settle(
      fixture.database,
      "controller-receipt",
      "expired",
      "TIMEOUT",
      "sweep",
    );
    expect(writeReceipts(fixture.collab, now)).toBe(1);
    expect(writeReceipts(fixture.collab, now)).toBe(0);
    expect(receiptRows()).toHaveLength(0);
    expect(
      fixture.database
        .prepare(
          "SELECT source_node_id, source_kind, controller_id, run_id, task_id FROM agent_deliveries WHERE receipt = ?",
        )
        .get("controller-receipt"),
    ).toMatchObject({
      source_node_id: null,
      source_kind: "controller",
      controller_id: "external",
      run_id: "run",
      task_id: "task",
    });
    expect(terminalEvents()).toHaveLength(1);
    expect(terminalEvents()[0]).toMatchObject({
      sourceNodeId: null,
      sourceKind: "controller",
      controllerId: "external",
      runId: "run",
      taskId: "task",
    });
  });
  it("writes a receipt when a queued send expires, outside the wake digest and the capacity", async () => {
    const id = await queueOne();
    const later = nowSeconds() + 301;
    expect(pumpAt(later).sweep()).toBe(1);

    const inbox = await inboxOf(me);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      from: peer,
      fromTitle: "审查",
      kind: "receipt",
      key: `receipt:${id}`,
    });
    expect(String(inbox[0]?.body)).toBe(
      "投往「审查」的消息已过期（TARGET_BUSY，正文 4 字）。",
    );
    // 原文不进回执。
    expect(String(inbox[0]?.body)).not.toContain("做这件事");
    // 不唤醒、不占容量。
    expect(unreadDigest(fixture.collab, me, nowSeconds())).toBeUndefined();
    expect(pendingCount(fixture.collab, me, nowSeconds())).toBe(0);

    expect(deliveryOutcomes(id)).toContain("expired");
    expect(terminalEvents()).toEqual([
      expect.objectContaining({
        sourceNodeId: me,
        targetNodeId: peer,
        outcome: "expired",
        code: "TARGET_BUSY",
      }),
    ]);
  });

  it("marks ordinary peer messages as kind message", async () => {
    fixture.link(peer, me);
    await runMailbox(
      fixture.collab,
      callerFor(fixture, peer),
      "post",
      new Args({ to: me, key: "k", body: "hello" }),
    );
    const inbox = await inboxOf(me);
    expect(inbox[0]).toMatchObject({ kind: "message", key: "k" });
    expect(pendingCount(fixture.collab, me, nowSeconds())).toBe(1);
  });

  it("refuses a post key that would pass for a receipt", async () => {
    fixture.link(peer, me);
    await expect(
      runMailbox(
        fixture.collab,
        callerFor(fixture, peer),
        "post",
        new Args({ to: me, key: "receipt:x", body: "forged" }),
      ),
    ).rejects.toMatchObject({ code: "key_invalid" });
  });

  it("carries the reason when the target side refuses the delivery", async () => {
    const id = await queueOne();
    const response = await fixture.call(
      "DELETE",
      `/api/workspaces/${fixture.workspaceId}/deliveries/${id}`,
    );
    expect(response.body).toMatchObject({ cancelled: true });
    expect(byId(fixture.database, id)?.settledBy).toBe("target");

    const inbox = await inboxOf(me);
    expect(inbox).toHaveLength(1);
    expect(String(inbox[0]?.body)).toBe(
      "投往「审查」的消息被对方拒收（TARGET_BUSY，正文 4 字）。",
    );
    expect(deliveryOutcomes(id)).toContain("cancelled");
  });

  it("writes nothing when the sender cancels its own delivery", async () => {
    const id = await queueOne();
    ok(await run(me, "cancel", { id }));
    expect(byId(fixture.database, id)?.settledBy).toBe("source");
    pumpAt(nowSeconds() + 301).sweep();
    expect(receiptRows()).toHaveLength(0);
    expect(settledUnnotified(fixture.database)).toHaveLength(0);
    expect(deliveryOutcomes(id)).not.toContain("cancelled");
  });

  it("records the delivery but writes no receipt once the sender is gone", async () => {
    const id = await queueOne();
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(me);
    pumpAt(nowSeconds() + 301).sweep();
    expect(receiptRows()).toHaveLength(0);
    expect(deliveryOutcomes(id)).toContain("expired");
    expect(byId(fixture.database, id)?.notifiedAt).toBeDefined();
  });

  it("writes one receipt however many sweeps run, then lets the row go", async () => {
    const id = await queueOne();
    const later = nowSeconds() + 301;
    pumpAt(later).sweep();
    pumpAt(later + 1).sweep();
    expect(receiptRows()).toHaveLength(1);
    expect(terminalEvents()).toHaveLength(1);
    // 放够久之后行被删掉——回执已经写过了。
    pumpAt(later + 301 + 300).sweep();
    expect(byId(fixture.database, id)).toBeUndefined();
    expect(receiptRows()).toHaveLength(1);
  });

  it("writes a receipt when the gate refuses at dequeue, counting that attempt", async () => {
    const id = await queueOne();
    // 排着的时候连线被删掉了：出队重跑门链，硬拒绝。
    fixture.database
      .prepare("UPDATE context_links SET links_json = '[]' WHERE node_id = ?")
      .run(me);
    target({ state: "idle" });
    await new SendPump(() => fixture.collab).drain(peer);
    expect(fixture.terminal.submits).toHaveLength(0);
    expect(byId(fixture.database, id)?.settledBy).toBe("gate");

    const inbox = await inboxOf(me);
    expect(inbox).toHaveLength(1);
    expect(String(inbox[0]?.body)).toBe(
      "投往「审查」的消息在出队时被拦下（NOT_LINKED，尝试 1 次，正文 4 字）。",
    );
    expect(deliveryOutcomes(id)).toContain("cancelled");
  });

  it("does not write a receipt for a refusal the sender already got in reply", async () => {
    target({ state: "busy" });
    const refused = await run(me, "send", {
      to: peer,
      body: "做这件事",
      "no-queue": true,
    });
    expect(refused.ok).toBe(false);
    pumpAt(nowSeconds() + 301).sweep();
    expect(receiptRows()).toHaveLength(0);
  });
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
