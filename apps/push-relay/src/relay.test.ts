import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type PushEnvelope,
  generateDeviceKeyPair,
  openPayload,
  sealPayload,
} from "../../desktop/src/core/push/crypto";
import { type Sink, bodyOf, startSink } from "../../desktop/src/core/push/sink";
import { relaySender } from "../../desktop/src/core/push/transport-relay";
import type {
  PushDevice,
  PushPayload,
} from "../../desktop/src/core/push/types";
import { tempDir } from "../../desktop/src/core/testing/temp-dir";
import { type RelayProcess, startRelay } from "./main";
import { createRelay, openToken, sealToken } from "./relay";

/**
 * core（relay 传输）→ 中继 → push-sink（假 APNs / FCM）：中继令牌不露平台令牌，
 * 信封原样转发、设备私钥能解，作废与换钥都让 core 撤销设备，明文进不来。
 */

let sink: Sink;
let relay: RelayProcess;
const SECRET = randomBytes(32);

beforeAll(async () => {
  const dir = tempDir("armadra-relay-");
  const p8 = join(dir, "AuthKey_RELAYKEY01.p8");
  writeFileSync(
    p8,
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
  );
  const account = join(dir, "service-account.json");
  writeFileSync(
    account,
    JSON.stringify({
      project_id: "armadra-store",
      client_email: "relay@armadra-store.iam.gserviceaccount.com",
      private_key: generateKeyPairSync("rsa", {
        modulusLength: 2048,
      }).privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  const secret = join(dir, "relay.secret");
  writeFileSync(secret, SECRET.toString("base64"));
  sink = await startSink({ keyDir: dir });
  relay = await startRelay({
    ARMADRA_RELAY_PORT: "0",
    ARMADRA_RELAY_SECRET_FILE: secret,
    ARMADRA_RELAY_APNS_KEY_FILE: p8,
    ARMADRA_RELAY_APNS_KEY_ID: "RELAYKEY01",
    ARMADRA_RELAY_APNS_TEAM_ID: "PUBLISHER1",
    ARMADRA_RELAY_APNS_TOPIC: "dev.armadra.store",
    ARMADRA_RELAY_APNS_ENDPOINT: sink.base,
    ARMADRA_RELAY_FCM_CREDENTIALS_FILE: account,
    ARMADRA_RELAY_FCM_ENDPOINT: sink.base,
  });
});

afterAll(async () => {
  await relay.close();
  await sink.close();
});

beforeEach(() => {
  sink.records.length = 0;
});

const PAYLOAD: PushPayload = {
  v: 1,
  kind: "approval",
  title: "支付服务",
  body: "Claude Code 等待审批",
  url: "armadra://w/w1/n/n1",
  tag: "approval:p1",
};

async function register(platform: "ios" | "android", token: string) {
  const response = await fetch(`${relay.url}/v1/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform, token }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { relayToken: string }).relayToken;
}

function device(relayToken: string, publicKey: string): PushDevice {
  return {
    deviceId: "d".repeat(32),
    principalId: "p".repeat(32),
    platform: "ios",
    transport: "relay",
    token: relayToken,
    publicKey,
    authSecret: "",
    appVersion: "",
    locale: "",
    createdAtMs: 1,
    revokedAtMs: 0,
  };
}

describe("中继端到端", () => {
  it("iOS：core → 中继 → APNs，苹果拿到的是同一个信封，设备私钥能解", async () => {
    const relayToken = await register("ios", "apns-device-token-1");
    // 中继令牌是密文：平台令牌一个字节都不露。
    expect(relayToken).not.toContain("apns-device-token-1");
    expect(Buffer.from(relayToken, "base64url").toString()).not.toContain(
      "apns-device-token-1",
    );
    const keys = generateDeviceKeyPair();
    const result = await relaySender({ url: relay.url }).send(
      device(relayToken, keys.publicKey),
      PAYLOAD,
    );
    expect(result).toEqual({ ok: true });
    const [record] = sink.records;
    expect(record).toMatchObject({
      kind: "apns",
      deviceToken: "apns-device-token-1",
      headers: { "apns-topic": "dev.armadra.store", "apns-priority": "10" },
    });
    expect(record?.jwt).toMatchObject({
      ok: true,
      signature: "verified",
      claims: { iss: "PUBLISHER1" },
    });
    const wire = bodyOf(record!).toString();
    expect(wire).not.toContain("支付服务");
    const body = JSON.parse(wire) as { enc: PushEnvelope };
    expect(
      JSON.parse(openPayload(body.enc, keys.privateKey).toString()),
    ).toEqual(PAYLOAD);
  });

  it("Android：core → 中继 → FCM 数据消息", async () => {
    const relayToken = await register("android", "fcm-device-token-1");
    const keys = generateDeviceKeyPair();
    const result = await relaySender({ url: relay.url }).send(
      { ...device(relayToken, keys.publicKey), platform: "android" },
      PAYLOAD,
    );
    expect(result).toEqual({ ok: true });
    const send = sink.records.find((record) => record.kind === "fcm");
    const message = (
      JSON.parse(bodyOf(send!).toString()) as {
        message: { token: string; data: { enc: string } };
      }
    ).message;
    expect(message.token).toBe("fcm-device-token-1");
    expect(
      JSON.parse(
        openPayload(
          JSON.parse(message.data.enc) as PushEnvelope,
          keys.privateKey,
        ).toString(),
      ),
    ).toEqual(PAYLOAD);
  });

  it("平台说作废 → 410 → core 撤销设备", async () => {
    const relayToken = await register("ios", "gone-device");
    const result = await relaySender({ url: relay.url }).send(
      device(relayToken, generateDeviceKeyPair().publicKey),
      PAYLOAD,
    );
    expect(result).toMatchObject({ ok: false, gone: true, retry: false });
  });

  it("换了钥（或伪造）的中继令牌 → badToken → core 撤销设备", async () => {
    const forged = sealToken(randomBytes(32), "ios", "apns-device-token-1");
    const result = await relaySender({ url: relay.url }).send(
      device(forged, generateDeviceKeyPair().publicKey),
      PAYLOAD,
    );
    expect(result).toMatchObject({ ok: false, gone: true });
    expect(sink.records).toEqual([]);
  });

  it("明文进不来：没有信封或信封多了字段都答 400，不转发", async () => {
    const relayToken = await register("ios", "apns-device-token-2");
    const post = (body: unknown) =>
      fetch(`${relay.url}/v1/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((response) => response.status);
    expect(await post({ relayToken, payload: PAYLOAD })).toBe(400);
    const envelope = sealPayload(
      Buffer.from("{}"),
      generateDeviceKeyPair().publicKey,
    );
    expect(
      await post({ relayToken, envelope: { ...envelope, title: "x" } }),
    ).toBe(400);
    expect(sink.records).toEqual([]);
  });

  it("健康检查报出配了哪些平台", async () => {
    const response = await fetch(`${relay.url}/health`);
    expect(await response.json()).toEqual({
      ok: true,
      platforms: ["ios", "android"],
    });
  });
});

describe("中继令牌与限流", () => {
  it("封与解是一对；别的钥解不开", () => {
    const secret = randomBytes(32);
    const token = sealToken(secret, "android", "abc");
    expect(openToken(secret, token)).toEqual({
      platform: "android",
      token: "abc",
    });
    expect(openToken(randomBytes(32), token)).toBeUndefined();
    expect(openToken(secret, "short")).toBeUndefined();
  });

  it("同一个令牌每分钟超过上限答 429", async () => {
    let now = 0;
    const sent: string[] = [];
    const relayHandler = createRelay({
      secret: randomBytes(32),
      perMinute: 2,
      now: () => now,
      ios: {
        send: (token) => {
          sent.push(token);
          return Promise.resolve({ ok: true, gone: false, reason: "" });
        },
      },
    });
    const registered = await relayHandler.handle("POST", "/v1/register", {
      platform: "ios",
      token: "t",
    });
    const relayToken = registered.body.relayToken as string;
    const envelope = sealPayload(
      Buffer.from("{}"),
      generateDeviceKeyPair().publicKey,
    );
    const push = () =>
      relayHandler
        .handle("POST", "/v1/push", { relayToken, envelope })
        .then((answer) => answer.status);
    expect([await push(), await push(), await push()]).toEqual([202, 202, 429]);
    now += 60_000;
    expect(await push()).toBe(202);
    expect(sent).toHaveLength(3);
  });

  it("没配的平台不登记", async () => {
    const relayHandler = createRelay({ secret: randomBytes(32) });
    const answer = await relayHandler.handle("POST", "/v1/register", {
      platform: "android",
      token: "t",
    });
    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe("platformUnavailable");
  });
});
