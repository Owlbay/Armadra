import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing/temp-dir";
import {
  type PushEnvelope,
  generateDeviceKeyPair,
  openPayload,
} from "./crypto";
import { QUIET_LOG, pushFixture } from "./fixture";
import {
  MAX_ATTEMPTS,
  Outbox,
  PushDispatcher,
  RETRY_DELAYS_MS,
} from "./outbox";
import { type Sink, bodyOf, startSink } from "./sink";
import { ApnsClient, FcmClient, directSender } from "./transport-direct";
import type { PushDevice, PushPayload } from "./types";

/**
 * 直连 APNs / FCM，对着 push-sink（dev-stack 的假端点，进程内起一份）：
 * provider token 与服务账号断言的 JWT 形状、令牌作废时撤销、网络失败时重试且
 * 不超过 3 次。
 */

const KEY_ID = "ABC123DEFG";
const TEAM_ID = "TEAM123456";
const TOPIC = "dev.armadra.app";

let sink: Sink;
let keyDir: string;
let p8: string;
let serviceAccount: string;

beforeAll(async () => {
  keyDir = tempDir("armadra-push-keys-");
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  p8 = join(keyDir, `AuthKey_${KEY_ID}.p8`);
  writeFileSync(
    p8,
    ec.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    { mode: 0o600 },
  );
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  serviceAccount = join(keyDir, "service-account.json");
  writeFileSync(
    serviceAccount,
    JSON.stringify({
      type: "service_account",
      project_id: "armadra-dev",
      client_email: "push@armadra-dev.iam.gserviceaccount.com",
      private_key: rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    { mode: 0o600 },
  );
  // 把 .p8 放进 sink 的密钥目录：它会真的验 ES256 签名，而不是只看形状。
  sink = await startSink({ keyDir });
});

afterAll(async () => {
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

function device(
  platform: "ios" | "android",
  token: string,
  publicKey: string,
): PushDevice {
  return {
    deviceId: "d".repeat(32),
    principalId: "p".repeat(32),
    platform,
    transport: "direct",
    token,
    publicKey,
    authSecret: "",
    appVersion: "1.0.0",
    locale: "zh-CN",
    createdAtMs: 1,
    revokedAtMs: 0,
  };
}

function apns(endpoint = sink.base) {
  return new ApnsClient({
    keyFile: p8,
    keyId: KEY_ID,
    teamId: TEAM_ID,
    topic: TOPIC,
    production: false,
    endpoint,
  });
}

describe("APNs（HTTP/2，ES256 provider token）", () => {
  it("请求形状、JWT 验签通过、正文是设备私钥能解的信封", async () => {
    const client = apns();
    const keys = generateDeviceKeyPair();
    const result = await directSender({ apns: client }).send(
      device("ios", "token-ios-1", keys.publicKey),
      PAYLOAD,
    );
    client.close();
    expect(result).toEqual({ ok: true });
    const [record] = sink.records;
    expect(record?.kind).toBe("apns");
    expect(record?.httpVersion).toBe("2");
    expect(record?.path).toBe("/3/device/token-ios-1");
    expect(record?.headers).toMatchObject({
      "apns-topic": TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
    });
    expect(record?.headers["apns-collapse-id"]).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(record?.jwt).toMatchObject({
      ok: true,
      signature: "verified",
      header: { alg: "ES256", kid: KEY_ID },
      claims: { iss: TEAM_ID },
    });
    const body = JSON.parse(bodyOf(record!).toString()) as {
      aps: Record<string, unknown>;
      enc: PushEnvelope;
    };
    expect(body.aps["mutable-content"]).toBe(1);
    const wire = bodyOf(record!).toString();
    expect(wire).not.toContain("支付服务");
    expect(wire).not.toContain("等待审批");
    expect(
      JSON.parse(openPayload(body.enc, keys.privateKey).toString()),
    ).toEqual(PAYLOAD);
  });

  it("没有设备公钥时发明文提示（只有直连允许）", async () => {
    const client = apns();
    await directSender({ apns: client }).send(
      device("ios", "token-ios-2", ""),
      PAYLOAD,
    );
    client.close();
    const body = JSON.parse(bodyOf(sink.records[0]!).toString()) as {
      aps: { alert: unknown };
      enc?: unknown;
    };
    expect(body.enc).toBeUndefined();
    expect(body.aps.alert).toEqual({
      title: "支付服务",
      body: "Claude Code 等待审批",
    });
  });

  it("410 与 BadDeviceToken 都是令牌作废，不重试", async () => {
    const client = apns();
    const sender = directSender({ apns: client });
    const key = generateDeviceKeyPair().publicKey;
    const gone = await sender.send(device("ios", "gone-1", key), PAYLOAD);
    const bad = await sender.send(device("ios", "bad-1", key), PAYLOAD);
    client.close();
    expect(gone).toMatchObject({ ok: false, gone: true, retry: false });
    expect(bad).toMatchObject({ ok: false, gone: true, retry: false });
  });

  it("provider token 在 50 分钟内复用", async () => {
    let now = 1_800_000_000_000;
    const client = new ApnsClient(
      {
        keyFile: p8,
        keyId: KEY_ID,
        teamId: TEAM_ID,
        topic: TOPIC,
        production: false,
        endpoint: sink.base,
      },
      () => now,
    );
    const key = generateDeviceKeyPair().publicKey;
    const sender = directSender({ apns: client });
    await sender.send(device("ios", "t-a", key), PAYLOAD);
    now += 10 * 60 * 1000;
    await sender.send(device("ios", "t-b", key), PAYLOAD);
    now += 45 * 60 * 1000;
    await sender.send(device("ios", "t-c", key), PAYLOAD);
    client.close();
    const iats = sink.records.map((record) => record.jwt?.claims?.iat);
    expect(iats[0]).toBe(iats[1]);
    expect(iats[2]).not.toBe(iats[0]);
  });
});

describe("FCM v1（RS256 服务账号断言换 access token）", () => {
  function fcm() {
    return new FcmClient({
      serviceAccountFile: serviceAccount,
      endpoint: sink.base,
    });
  }

  it("先换令牌、再发数据消息；断言的声明齐全，正文是信封", async () => {
    const keys = generateDeviceKeyPair();
    const sender = directSender({ fcm: fcm() });
    expect(
      await sender.send(device("android", "fcm-1", keys.publicKey), PAYLOAD),
    ).toEqual({ ok: true });
    expect(
      await sender.send(device("android", "fcm-2", keys.publicKey), PAYLOAD),
    ).toEqual({ ok: true });
    const kinds = sink.records.map((record) => record.kind);
    // 令牌只换了一次。
    expect(kinds).toEqual(["fcm-token", "fcm", "fcm"]);
    const token = sink.records[0]!;
    expect(token.jwt?.header).toMatchObject({ alg: "RS256" });
    expect(token.jwt?.claims).toMatchObject({
      iss: "push@armadra-dev.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: `${sink.base}/token`,
    });
    const send = sink.records[1]!;
    expect(send.path).toBe("/v1/projects/armadra-dev/messages:send");
    const message = (
      JSON.parse(bodyOf(send).toString()) as {
        message: {
          token: string;
          data: { enc: string };
          android: { priority: string };
        };
      }
    ).message;
    expect(message.token).toBe("fcm-1");
    expect(message.android.priority).toBe("HIGH");
    expect(bodyOf(send).toString()).not.toContain("支付服务");
    expect(
      JSON.parse(
        openPayload(
          JSON.parse(message.data.enc) as PushEnvelope,
          keys.privateKey,
        ).toString(),
      ),
    ).toEqual(PAYLOAD);
  });

  it("UNREGISTERED 是令牌作废", async () => {
    const result = await directSender({ fcm: fcm() }).send(
      device("android", "gone-fcm", generateDeviceKeyPair().publicKey),
      PAYLOAD,
    );
    expect(result).toMatchObject({ ok: false, gone: true, retry: false });
  });

  it("没配 FCM 时 Android 设备不发、不重试", async () => {
    const result = await directSender({}).send(
      device("android", "x", ""),
      PAYLOAD,
    );
    expect(result).toMatchObject({ ok: false, retry: false });
    expect(sink.records).toEqual([]);
  });
});

describe("重试", () => {
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((done) => server.close(() => done()));
    return port;
  }

  it("连不上算可重试；总共最多 3 次尝试，之后记失败、设备不撤销", async () => {
    let now = 1_800_000_000_000;
    const fixture = pushFixture({ clock: () => now });
    try {
      const keys = generateDeviceKeyPair();
      fixture.push.devices.register(fixture.ownerDeviceId, {
        platform: "ios",
        transport: "direct",
        token: "token-retry",
        publicKey: keys.publicKey,
        authSecret: "",
        appVersion: "",
        locale: "",
      });
      const client = apns(`http://127.0.0.1:${await closedPort()}`);
      const outbox = new Outbox(fixture.database, () => now);
      const dispatcher = new PushDispatcher({
        outbox,
        devices: fixture.push.devices,
        senderFor: () => directSender({ apns: client }),
        log: QUIET_LOG,
        clock: () => now,
      });
      const id = outbox.enqueue(fixture.ownerDeviceId, PAYLOAD);
      dispatcher.kick();
      await dispatcher.idle();
      expect(outbox.get(id)).toMatchObject({ attempts: 1, failedAtMs: 0 });
      for (const delay of RETRY_DELAYS_MS) {
        now += delay;
        dispatcher.kick();
        await dispatcher.idle();
      }
      const final = outbox.get(id);
      expect(final?.attempts).toBe(MAX_ATTEMPTS);
      expect(final?.failedAtMs).toBeGreaterThan(0);
      expect(final?.reason).toMatch(/^network:/);
      // 再等多久也不会有第 4 次。
      now += 3_600_000;
      dispatcher.kick();
      await dispatcher.idle();
      expect(outbox.get(id)?.attempts).toBe(MAX_ATTEMPTS);
      expect(fixture.push.devices.get(fixture.ownerDeviceId)?.revokedAtMs).toBe(
        0,
      );
      dispatcher.stop();
      client.close();
    } finally {
      fixture.close();
    }
  });

  it("令牌作废：一次就停，设备登记撤销", async () => {
    const fixture = pushFixture();
    try {
      fixture.push.devices.register(fixture.ownerDeviceId, {
        platform: "ios",
        transport: "direct",
        token: "gone-device",
        publicKey: generateDeviceKeyPair().publicKey,
        authSecret: "",
        appVersion: "",
        locale: "",
      });
      const client = apns();
      const outbox = new Outbox(fixture.database);
      const dispatcher = new PushDispatcher({
        outbox,
        devices: fixture.push.devices,
        senderFor: () => directSender({ apns: client }),
        log: QUIET_LOG,
      });
      const id = outbox.enqueue(fixture.ownerDeviceId, PAYLOAD);
      dispatcher.kick();
      await dispatcher.idle();
      dispatcher.stop();
      client.close();
      expect(outbox.get(id)).toMatchObject({ attempts: 1 });
      expect(outbox.get(id)?.failedAtMs).toBeGreaterThan(0);
      expect(
        fixture.push.devices.get(fixture.ownerDeviceId)?.revokedAtMs,
      ).toBeGreaterThan(0);
    } finally {
      fixture.close();
    }
  });
});
