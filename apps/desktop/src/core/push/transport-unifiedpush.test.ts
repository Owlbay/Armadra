import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PushEnvelope,
  generateDeviceKeyPair,
  openPayload,
} from "./crypto";
import { parseRegistration } from "./devices";
import { pushFixture } from "./fixture";
import { type Sink, bodyOf, inMemorySink, startSink } from "./sink";
import { unifiedPushSender } from "./transport-unifiedpush";
import type { PushDevice, PushPayload } from "./types";

/**
 * UnifiedPush（契约 §27.2）：对着 push-sink 的 `/up/<topic>`（与 dev-stack 里
 * 的同一份代码）。分发器只见信封；端点注销撤销设备；限流与 5xx 可重试；
 * 有端点的设备不看 `push.transport`。
 */

let sink: Sink;
beforeAll(async () => {
  sink = await startSink();
});
afterAll(async () => {
  await sink.close();
});

const PAYLOAD: PushPayload = {
  v: 1,
  kind: "approval",
  title: "支付服务",
  body: "Claude Code 等待审批",
  url: "armadra://w/w1/n/n1?s=HOST-ID-1",
  tag: "approval:p1",
};

function device(endpoint: string, publicKey: string): PushDevice {
  return {
    deviceId: "d".repeat(32),
    principalId: "p".repeat(32),
    platform: "android",
    transport: "direct",
    token: endpoint,
    publicKey,
    authSecret: "",
    appVersion: "1.0.0",
    locale: "zh-CN",
    kinds: null,
    unifiedpushEndpoint: endpoint,
    createdAtMs: 1,
    revokedAtMs: 0,
  };
}

function answering(status: number): typeof fetch {
  return (() => Promise.resolve(new Response("", { status }))) as typeof fetch;
}

describe("UnifiedPush 发送器", () => {
  it("POST 到端点的是对设备公钥封好的信封，分发器看不到明文", async () => {
    sink.records.length = 0;
    const keys = generateDeviceKeyPair();
    const result = await unifiedPushSender().send(
      device(`${sink.base}/up/upTopicA?up=1`, keys.publicKey),
      PAYLOAD,
    );
    expect(result).toEqual({ ok: true });
    const record = sink.records.at(-1);
    expect(record?.kind).toBe("unifiedpush");
    expect(record?.topic).toBe("upTopicA");
    expect(record?.headers["content-type"]).toBe("application/json");
    expect(record?.headers.urgency).toBe("high");
    expect(record?.headers.ttl).toBe("3600");
    expect(record?.headers.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const wire = bodyOf(record!).toString("utf8");
    expect(wire).not.toContain("支付服务");
    expect(wire).not.toContain("armadra://");
    expect(wire).not.toContain("HOST-ID-1");
    const envelope = JSON.parse(wire) as PushEnvelope;
    expect(
      JSON.parse(openPayload(envelope, keys.privateKey).toString("utf8")),
    ).toEqual(PAYLOAD);
  });

  it("端点注销（404 / 410）撤销设备；429、5xx 与网络错误可重试", async () => {
    const key = generateDeviceKeyPair().publicKey;
    expect(
      await unifiedPushSender().send(
        device(`${sink.base}/up/goneTopic`, key),
        PAYLOAD,
      ),
    ).toMatchObject({ ok: false, gone: true, retry: false });
    const send = (fetcher: typeof fetch) =>
      unifiedPushSender({ fetch: fetcher }).send(
        device("https://ntfy.example/upX?up=1", key),
        PAYLOAD,
      );
    expect(await send(answering(410))).toMatchObject({ gone: true });
    expect(await send(answering(429))).toMatchObject({
      gone: false,
      retry: true,
    });
    expect(await send(answering(503))).toMatchObject({ retry: true });
    expect(await send(answering(413))).toMatchObject({
      gone: false,
      retry: false,
    });
    expect(
      await send((() =>
        Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch),
    ).toMatchObject({ gone: false, retry: true });
  });

  it("没有设备公钥就不发：明文永远不交给分发器", async () => {
    let called = false;
    const result = await unifiedPushSender({
      fetch: (() => {
        called = true;
        return Promise.reject(new Error("unreachable"));
      }) as typeof fetch,
    }).send(device("https://ntfy.example/upX", ""), PAYLOAD);
    expect(called).toBe(false);
    expect(result).toMatchObject({ ok: false, retry: false });
  });
});

describe("登记", () => {
  const key = generateDeviceKeyPair().publicKey;
  const android = (extra: Record<string, unknown>) =>
    parseRegistration({
      platform: "android",
      transport: "direct",
      publicKey: key,
      ...extra,
    });

  it("只有 UnifiedPush 的 Android 可以不给令牌", () => {
    const parsed = android({
      unifiedpush: { endpoint: "https://ntfy.example/upAbc?up=1" },
    });
    expect(parsed).toMatchObject({
      ok: true,
      registration: {
        unifiedpushEndpoint: "https://ntfy.example/upAbc?up=1",
        token: "https://ntfy.example/upAbc?up=1",
      },
    });
  });

  it("端点要 https（回环 http 例外），要公钥，只给 Android", () => {
    expect(
      android({ unifiedpush: { endpoint: "http://ntfy.example/upAbc" } }).ok,
    ).toBe(false);
    expect(
      android({ unifiedpush: { endpoint: "http://127.0.0.1:8093/upAbc" } }).ok,
    ).toBe(true);
    expect(
      android({ unifiedpush: { endpoint: "https://u:p@ntfy.example/up" } }).ok,
    ).toBe(false);
    expect(
      parseRegistration({
        platform: "android",
        transport: "direct",
        unifiedpush: { endpoint: "https://ntfy.example/upAbc" },
      }).ok,
    ).toBe(false);
    expect(
      parseRegistration({
        platform: "ios",
        transport: "direct",
        token: "t",
        publicKey: key,
        unifiedpush: { endpoint: "https://ntfy.example/upAbc" },
      }).ok,
    ).toBe(false);
  });
});

describe("经推送域", () => {
  it("有端点的设备走 UnifiedPush，不看 push.transport；注销后撤销", async () => {
    // 同一份 push-sink 路由，不过 socket：这里验交给谁、怎么处置，不验线上一跳。
    const sink = await inMemorySink();
    const fixture = pushFixture({ fetch: sink.fetch });
    try {
      fixture.workspace("w1", "支付服务");
      const keys = generateDeviceKeyPair();
      const register = (topic: string) => {
        const parsed = parseRegistration({
          platform: "android",
          transport: "direct",
          publicKey: keys.publicKey,
          locale: "en",
          unifiedpush: { endpoint: `http://127.0.0.1:8091/up/${topic}?up=1` },
        });
        if (!parsed.ok) throw new Error(parsed.message);
        fixture.push.devices.register(
          fixture.ownerDeviceId,
          parsed.registration,
        );
      };
      register("upTopicB");
      expect(
        fixture.push.handleEvent("w1", {
          type: "agent.approval",
          nodeId: "n1",
          pendingId: "p9",
          request: { id: "p9" },
        }),
      ).toBe(1);
      await fixture.push.dispatcher.idle();
      expect(sink.records.map((item) => item.kind)).toEqual(["unifiedpush"]);
      const payload = JSON.parse(
        openPayload(
          JSON.parse(bodyOf(sink.records[0]!).toString()) as PushEnvelope,
          keys.privateKey,
        ).toString(),
      ) as PushPayload;
      expect(payload).toMatchObject({ kind: "approval", tag: "approval:p9" });

      register("goneTopic");
      fixture.push.handleEvent("w1", {
        type: "agent.approval",
        nodeId: "n1",
        pendingId: "p10",
        request: { id: "p10" },
      });
      await fixture.push.dispatcher.idle();
      expect(
        fixture.push.devices.get(fixture.ownerDeviceId)?.revokedAtMs,
      ).not.toBe(0);
    } finally {
      fixture.close();
    }
  });
});
