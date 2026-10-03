import { afterEach, describe, expect, it } from "vitest";
import { generateDeviceKeyPair } from "./crypto";
import { pushFixture } from "./fixture";
import { type EventFrame, TriggerRules, deepLink, render } from "./triggers";
import type { PushPayload } from "./types";

/**
 * 触发规则：每种事件一条通知；对那块画布没有 `canvas:read` 的 principal 收不到；
 * 正文里没有终端原文。
 */

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

function setup() {
  const fixture = pushFixture();
  closing.push(fixture.close);
  fixture.workspace("w1", "支付服务");
  fixture.workspace("w2", "别的项目");
  const viewer = fixture.member("看板的人", { w1: "viewer" });
  const outsider = fixture.member("外人", { w2: "driver" });
  const register = (deviceId: string, locale = "zh-CN") =>
    fixture.push.devices.register(deviceId, {
      platform: "ios",
      transport: "direct",
      token: `token-${deviceId}`,
      publicKey: generateDeviceKeyPair().publicKey,
      authSecret: "",
      appVersion: "1.0.0",
      locale,
    });
  register(fixture.ownerDeviceId);
  register(viewer.deviceId, "en");
  register(outsider.deviceId);
  /** 每台设备收到了什么（按入队顺序）。 */
  const inbox = (deviceId: string): PushPayload[] =>
    (
      fixture.database
        .prepare(
          "SELECT payload_blob FROM push_outbox WHERE device_id = ? ORDER BY created_at_ms, rowid",
        )
        .all(deviceId) as { payload_blob: Uint8Array }[]
    ).map(
      (row) =>
        JSON.parse(Buffer.from(row.payload_blob).toString()) as PushPayload,
    );
  return { ...fixture, viewer, outsider, inbox };
}

const EVENTS: readonly [string, EventFrame, string][] = [
  [
    "等人审批",
    {
      type: "agent.approval",
      nodeId: "n1",
      pendingId: "p1",
      request: { id: "p1", request: { command: "rm -rf /secret-path" } },
    },
    "approval",
  ],
  [
    "Agent 完成",
    {
      type: "agent.status",
      status: {
        nodeId: "n2",
        agentId: "claude",
        state: "done",
        lastMessage: "TERMINAL-OUTPUT-SECRET",
      },
    },
    "agentDone",
  ],
  [
    "Agent 出错",
    {
      type: "agent.status",
      status: { nodeId: "n3", agentId: "codex", state: "idle", errored: true },
    },
    "agentError",
  ],
  [
    "投递失败",
    {
      type: "agent.delivery",
      traceId: "t1",
      sourceNodeId: "n1",
      targetNodeId: "n2",
      outcome: "refused",
      code: "LOOP_DETECTED",
    },
    "deliveryFailed",
  ],
  [
    "调度到点",
    { type: "schedule.fired", automationId: "a1", nodeId: "n4" },
    "schedule",
  ],
  [
    "资源阈值",
    { type: "resources.threshold", metric: "memory", nodeId: "n5" },
    "resources",
  ],
  [
    "工作流关卡",
    { type: "workflow.gate", runId: "r1", stepId: "s1", nodeId: "n6" },
    "workflowGate",
  ],
];

describe("每种事件一条通知", () => {
  for (const [name, event, kind] of EVENTS) {
    it(name, () => {
      const { push, ownerDeviceId, viewer, outsider, inbox } = setup();
      expect(push.handleEvent("w1", event)).toBe(2);
      const owner = inbox(ownerDeviceId);
      expect(owner.map((item) => item.kind)).toEqual([kind]);
      expect(owner[0]?.title).toBe("支付服务");
      expect(inbox(viewer.deviceId).map((item) => item.kind)).toEqual([kind]);
      // 外人只在 w2 上有角色：w1 的事件一条都收不到。
      expect(inbox(outsider.deviceId)).toEqual([]);
      // 正文里没有任何来自事件内容的文字。
      const wire = JSON.stringify([...owner, ...inbox(viewer.deviceId)]);
      expect(wire).not.toContain("TERMINAL-OUTPUT-SECRET");
      expect(wire).not.toContain("secret-path");
      expect(wire).not.toContain("LOOP_DETECTED");
    });
  }

  it("评论只发给被提及的人", () => {
    const { push, ownerDeviceId, viewer, inbox } = setup();
    expect(
      push.handleEvent("w1", {
        type: "board.comment",
        comment: {
          id: "c1",
          anchorKind: "node",
          anchorId: "n1",
          body: "COMMENT-BODY",
          mentions: [viewer.principalId],
        },
      }),
    ).toBe(1);
    expect(inbox(viewer.deviceId).map((item) => item.kind)).toEqual([
      "comment",
    ]);
    expect(inbox(viewer.deviceId)[0]?.url).toBe(deepLink("w1", "n1"));
    expect(JSON.stringify(inbox(viewer.deviceId))).not.toContain(
      "COMMENT-BODY",
    );
    expect(inbox(ownerDeviceId)).toEqual([]);
    // 没有提及的评论不叫人。
    expect(
      push.handleEvent("w1", { type: "board.comment", comment: { id: "c2" } }),
    ).toBe(0);
  });

  it("被提及但没有 canvas:read 的人也收不到", () => {
    const { push, outsider, inbox } = setup();
    expect(
      push.handleEvent("w1", {
        type: "board.comment",
        comment: { id: "c1" },
        mentions: [outsider.principalId],
      }),
    ).toBe(0);
    expect(inbox(outsider.deviceId)).toEqual([]);
  });

  it("w2 的事件外人收得到，看 w1 的人收不到", () => {
    const { push, viewer, outsider, inbox } = setup();
    push.handleEvent("w2", EVENTS[0]?.[1] as EventFrame);
    expect(inbox(outsider.deviceId)).toHaveLength(1);
    expect(inbox(viewer.deviceId)).toEqual([]);
  });

  it("撤销了的设备不再收", () => {
    const { push, viewer, inbox } = setup();
    push.devices.revoke(viewer.deviceId, "user");
    push.handleEvent("w1", EVENTS[0]?.[1] as EventFrame);
    expect(inbox(viewer.deviceId)).toEqual([]);
  });

  it("按设备语言渲染，深链指向节点", () => {
    const { push, viewer, ownerDeviceId, inbox } = setup();
    push.handleEvent("w1", EVENTS[1]?.[1] as EventFrame);
    expect(inbox(viewer.deviceId)[0]).toEqual({
      v: 1,
      kind: "agentDone",
      title: "支付服务",
      body: "Claude Code finished",
      url: "armadra://w/w1/n/n2",
      tag: "status:n2",
    });
    expect(inbox(ownerDeviceId)[0]?.body).toBe("Claude Code 已完成");
  });
});

describe("不该叫人的那些", () => {
  it("审批的答复、重复的完成、送达的投递都不推", () => {
    const rules = new TriggerRules();
    expect(
      rules.draft("w1", {
        type: "agent.approval",
        nodeId: "n1",
        pendingId: "p1",
        request: { resolved: true },
      }),
    ).toBeUndefined();
    const done = {
      type: "agent.status",
      status: { nodeId: "n1", state: "done" },
    };
    expect(rules.draft("w1", done)?.kind).toBe("agentDone");
    expect(rules.draft("w1", done)).toBeUndefined();
    expect(
      rules.draft("w1", {
        type: "agent.status",
        status: { nodeId: "n1", state: "working" },
      }),
    ).toBeUndefined();
    expect(rules.draft("w1", done)?.kind).toBe("agentDone");
    expect(
      rules.draft("w1", {
        type: "agent.status",
        status: { nodeId: "n9", state: "done", restored: true },
      }),
    ).toBeUndefined();
    expect(
      rules.draft("w1", {
        type: "agent.delivery",
        traceId: "t",
        sourceNodeId: "a",
        targetNodeId: "b",
        outcome: "delivered",
      }),
    ).toBeUndefined();
    expect(
      rules.draft("w1", { type: "board.changed", boardId: "b" }),
    ).toBeUndefined();
  });

  it("标题与正文有长度上限", () => {
    const payload = render(
      { kind: "approval", workspaceId: "w", tag: "x".repeat(400) },
      "en",
      { workspace: "长".repeat(200), agent: () => "Agent" },
    );
    expect([...payload.title]).toHaveLength(64);
    expect([...payload.tag]).toHaveLength(128);
    expect(payload.url).toBe("armadra://w/w");
  });
});
