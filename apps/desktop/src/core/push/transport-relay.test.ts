import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PushEnvelope,
  generateDeviceKeyPair,
  openPayload,
} from "./crypto";
import { type Sink, bodyOf, startSink } from "./sink";
import { relayEndpoint, relaySender } from "./transport-relay";
import type { PushDevice, PushPayload } from "./types";

/**
 * 经中继推送：中继只见中继令牌与密文；平台作废与中继换钥都撤销设备；上游
 * 失败可重试。对着 push-sink 的 `/relay/` 替身（dev-stack 里中继也是它）。
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
  kind: "agentDone",
  title: "支付服务",
  body: "Codex 已完成",
  url: "armadra://w/w1/n/n1?s=HOST-ID-1",
  tag: "status:n1",
};

function device(publicKey: string): PushDevice {
  return {
    deviceId: "d".repeat(32),
    principalId: "p".repeat(32),
    platform: "ios",
    transport: "relay",
    token: "relay-token-opaque",
    publicKey,
    authSecret: "",
    appVersion: "1.0.0",
    locale: "zh-CN",
    kinds: null,
    unifiedpushEndpoint: "",
    createdAtMs: 1,
    revokedAtMs: 0,
  };
}

function answering(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
}

describe("中继传输", () => {
  it("POST <relayUrl>/v1/push：中继令牌 + 信封，没有一个明文字", async () => {
    const keys = generateDeviceKeyPair();
    const result = await relaySender({ url: `${sink.base}/relay/` }).send(
      device(keys.publicKey),
      PAYLOAD,
    );
    expect(result).toEqual({ ok: true });
    const [record] = sink.records;
    expect(record?.kind).toBe("relay");
    expect(record?.path).toBe("/relay/v1/push");
    const wire = bodyOf(record!).toString();
    expect(wire).not.toContain("支付服务");
    expect(wire).not.toContain("已完成");
    expect(wire).not.toContain("armadra://");
    expect(wire).not.toContain("HOST-ID-1");
    const body = JSON.parse(wire) as {
      relayToken: string;
      envelope: PushEnvelope;
      collapseId: string;
      urgent: boolean;
    };
    expect(Object.keys(body).sort()).toEqual([
      "collapseId",
      "envelope",
      "relayToken",
      "urgent",
    ]);
    expect(body.relayToken).toBe("relay-token-opaque");
    expect(body.urgent).toBe(false);
    expect(
      JSON.parse(openPayload(body.envelope, keys.privateKey).toString()),
    ).toEqual(PAYLOAD);
  });

  it("没有设备公钥就不发：明文永远不经过中继", async () => {
    let called = false;
    const result = await relaySender({
      url: "https://relay.example",
      fetch: (() => {
        called = true;
        return Promise.reject(new Error("unreachable"));
      }) as typeof fetch,
    }).send(device(""), PAYLOAD);
    expect(called).toBe(false);
    expect(result).toMatchObject({ ok: false, retry: false });
  });

  it("410 与解不开的中继令牌撤销设备；5xx 与网络错误可重试", async () => {
    const key = generateDeviceKeyPair().publicKey;
    const send = (fetcher: typeof fetch) =>
      relaySender({ url: "https://relay.example", fetch: fetcher }).send(
        device(key),
        PAYLOAD,
      );
    expect(await send(answering(410, { code: "gone" }))).toMatchObject({
      gone: true,
      retry: false,
    });
    expect(await send(answering(400, { code: "badToken" }))).toMatchObject({
      gone: true,
      retry: false,
    });
    expect(await send(answering(400, { code: "invalid" }))).toMatchObject({
      gone: false,
      retry: false,
    });
    expect(await send(answering(502, {}))).toMatchObject({
      gone: false,
      retry: true,
    });
    expect(
      await send((() =>
        Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch),
    ).toMatchObject({ gone: false, retry: true });
  });

  it("端点拼法去掉多余的斜杠", () => {
    expect(relayEndpoint("https://push.example.com//")).toBe(
      "https://push.example.com/v1/push",
    );
  });
});
