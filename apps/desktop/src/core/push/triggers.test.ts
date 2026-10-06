import { afterEach, describe, expect, it } from "vitest";
import { EventBus, type WorkspaceEvent } from "../bus";
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
      unifiedpushEndpoint: "",
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
    { type: "schedule.fired", planId: "a1", runId: "r1", nodeId: "n4" },
    "schedule",
  ],
  [
    "调度失败",
    {
      type: "schedule.failed",
      planId: "a1",
      runId: "r1",
      nodeId: "n4",
      reasonCode: "TARGET_OFFLINE",
    },
    "schedule",
  ],
  [
    "调度要人处理",
    {
      type: "schedule.attention",
      planId: "a1",
      nodeId: "n4",
      reasonCode: "STALE_GENERATION",
    },
    "schedule",
  ],
  [
    "资源阈值",
    {
      type: "resources.threshold",
      sessionId: "s1",
      metric: "memory",
      nodeId: "n5",
      value: 9_000_000_000,
      threshold: 8_000_000_000,
    },
    "resources",
  ],
  [
    "工作流关卡",
    {
      type: "workflow.gate",
      runId: "r1",
      stepId: "s1",
      nodeId: "n6",
      state: "waiting",
    },
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
      // 调度的稳定码与资源的数字也不进正文。
      expect(wire).not.toContain("TARGET_OFFLINE");
      expect(wire).not.toContain("STALE_GENERATION");
      expect(wire).not.toContain("9000000000");
    });
  }

  it("评论只发给被提及的人", () => {
    const { push, ownerDeviceId, viewer, inbox, hostId } = setup();
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
    expect(inbox(viewer.deviceId)[0]?.url).toBe(deepLink("w1", "n1", hostId));
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
    const { push, viewer, ownerDeviceId, inbox, hostId } = setup();
    push.handleEvent("w1", EVENTS[1]?.[1] as EventFrame);
    expect(inbox(viewer.deviceId)[0]).toEqual({
      v: 1,
      kind: "agentDone",
      title: "支付服务",
      body: "Claude Code finished",
      url: `armadra://w/w1/n/n2?s=${encodeURIComponent(hostId)}`,
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

  it("深链带签发它的源（契约 §19.4）：编码后进 `s`，测试通知与没给源时不带", () => {
    const names = { workspace: "W", agent: () => "Agent", source: "host/1" };
    expect(
      render(
        { kind: "agentDone", workspaceId: "w 1", nodeId: "n1", tag: "t" },
        "zh-CN",
        names,
      ).url,
    ).toBe("armadra://w/w%201/n/n1?s=host%2F1");
    expect(deepLink("w", undefined, "h")).toBe("armadra://w/w?s=h");
    expect(deepLink("w", "n", "")).toBe("armadra://w/w/n/n");
    expect(deepLink("", "n", "h")).toBe("armadra://");
  });

  it("入队的载荷带本机的 hostId", () => {
    const { push, ownerDeviceId, inbox, hostId } = setup();
    expect(hostId).not.toBe("");
    push.handleEvent("w1", {
      type: "agent.approval",
      nodeId: "n1",
      pendingId: "p9",
      request: { id: "p9", request: {} },
    } as EventFrame);
    expect(inbox(ownerDeviceId)[0]?.url).toBe(
      `armadra://w/w1/n/n1?s=${encodeURIComponent(hostId)}`,
    );
  });
});

describe("工作流关卡", () => {
  it("只有开始等人叫人，答复与取消不叫", () => {
    const { push } = setup();
    for (const state of ["approved", "rejected", "cancelled"]) {
      expect(
        push.handleEvent("w1", {
          type: "workflow.gate",
          runId: "r1",
          stepId: "s1",
          state,
        }),
      ).toBe(0);
    }
  });
});

describe("调度三时刻（契约 §27.3）", () => {
  it("正文按时刻分，同一个计划共用一个 tag", () => {
    const rules = new TriggerRules();
    const names = { workspace: "w", agent: () => "Agent" };
    const bodies = (
      [
        { type: "schedule.fired", planId: "p1", runId: "r1" },
        {
          type: "schedule.failed",
          planId: "p1",
          runId: "r1",
          reasonCode: "X",
        },
        { type: "schedule.attention", planId: "p1", reasonCode: "Y" },
      ] as EventFrame[]
    ).map((event) => {
      const draft = rules.draft("w1", event);
      expect(draft?.tag).toBe("schedule:p1");
      return draft === undefined ? "" : render(draft, "zh-CN", names).body;
    });
    expect(bodies).toEqual([
      "定时任务到点了",
      "定时任务没有跑成",
      "定时任务需要处理",
    ]);
  });

  it("没有 planId 的帧不推，其它 schedule.* 也不推", () => {
    const rules = new TriggerRules();
    expect(
      rules.draft("w1", { type: "schedule.fired", runId: "r1" }),
    ).toBeUndefined();
    expect(
      rules.draft("w1", { type: "schedule.due", planId: "p1" }),
    ).toBeUndefined();
  });
});

describe("按设备选种类（契约 §27.1）", () => {
  it("关掉的种类不入队，测试恒收，全选回到「全部」", () => {
    const { push, ownerDeviceId, viewer, inbox } = setup();
    expect(push.devices.setKinds(viewer.deviceId, ["approval"])).toBe(true);
    expect(push.devices.get(viewer.deviceId)?.kinds).toEqual(["approval"]);
    // 完成：只有 owner 收。
    expect(push.handleEvent("w1", EVENTS[1]?.[1] as EventFrame)).toBe(1);
    // 审批：两台都收。
    expect(push.handleEvent("w1", EVENTS[0]?.[1] as EventFrame)).toBe(2);
    expect(inbox(viewer.deviceId).map((item) => item.kind)).toEqual([
      "approval",
    ]);
    expect(inbox(ownerDeviceId)).toHaveLength(2);
    // 关掉全部也照样收测试。
    push.devices.setKinds(viewer.deviceId, []);
    push.sendTest(push.devices.get(viewer.deviceId)!);
    expect(inbox(viewer.deviceId).map((item) => item.kind)).toEqual([
      "approval",
      "test",
    ]);
    // 重新登记（App 每次启动）不丢偏好。
    push.devices.register(viewer.deviceId, {
      platform: "ios",
      transport: "direct",
      token: "token-again",
      publicKey: generateDeviceKeyPair().publicKey,
      authSecret: "",
      appVersion: "1.0.1",
      locale: "en",
      unifiedpushEndpoint: "",
    });
    expect(push.devices.get(viewer.deviceId)?.kinds).toEqual([]);
    push.devices.setKinds(viewer.deviceId, null);
    expect(push.devices.get(viewer.deviceId)?.kinds).toBeNull();
  });
});

describe("四族事件经总线真发到推送", () => {
  it("schedule.fired / failed / attention 与 resources.threshold 都入队", () => {
    const { push, ownerDeviceId, inbox } = setup();
    const bus = new EventBus();
    bus.on("workspace.event", ({ workspaceId, event }) => {
      push.handleEvent(workspaceId, event as unknown as EventFrame);
    });
    const emit = (event: WorkspaceEvent) =>
      bus.emit("workspace.event", { workspaceId: "w1", event });
    emit({ type: "schedule.fired", planId: "p1", runId: "r1", nodeId: "n1" });
    emit({
      type: "schedule.failed",
      planId: "p2",
      runId: "r2",
      reasonCode: "TARGET_OFFLINE",
    });
    emit({ type: "schedule.attention", planId: "p3", reasonCode: "X" });
    emit({
      type: "resources.threshold",
      sessionId: "s1",
      nodeId: "n2",
      metric: "memory",
      value: 2,
      threshold: 1,
    });
    expect(inbox(ownerDeviceId).map((item) => item.tag)).toEqual([
      "schedule:p1",
      "schedule:p2",
      "schedule:p3",
      "resources:memory:n2",
    ]);
  });
});
