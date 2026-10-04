import { createECDH, generateKeyPairSync } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Router, emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import { type RequestIdentity, runAs } from "../identity/gate";
import { tempDir } from "../testing/temp-dir";
import { b64url, decryptWebPush, generateDeviceKeyPair } from "./crypto";
import { pushFixture } from "./fixture";
import { PUSH_ROUTES, installRoutes } from "./routes";
import { type Sink, bodyOf, startSink } from "./sink";
import { vapidFile } from "./transport-webpush";

/**
 * `/api/push/*`（契约 §19）：只碰请求主体自己的设备；Web Push 一路到假端点、
 * VAPID 验签过、浏览器能解。
 */

let sink: Sink;
beforeAll(async () => {
  sink = await startSink();
});
afterAll(async () => {
  await sink.close();
});

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
  sink.records.length = 0;
});

function setup(options: Parameters<typeof pushFixture>[0] = {}) {
  const fixture = pushFixture(options);
  closing.push(fixture.close);
  const router = new Router();
  installRoutes({ router } as unknown as CoreServer, fixture.push);
  const call = async (
    who: RequestIdentity | undefined,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const request = {
      ...emptyRequest(method, path),
      json: <T>() => {
        if (body === "not json") throw new SyntaxError("bad");
        return body as T;
      },
    };
    const run = () => router.dispatch(method, path, request);
    const answer = await (who === undefined ? run() : runAs(who, run));
    return answer as { status: number; body: any };
  };
  const ownerIdentity: RequestIdentity = {
    subject: fixture.owner,
    device: { deviceId: fixture.ownerDeviceId, deviceName: "owner 的手机" },
  };
  const identityOf = (member: {
    principalId: string;
    deviceId: string;
  }): RequestIdentity => ({
    subject: { principalId: member.principalId, kind: "member", scopes: [] },
    device: { deviceId: member.deviceId, deviceName: "x" },
  });
  return { ...fixture, call, ownerIdentity, identityOf };
}

function browserSubscription(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = b64url(Buffer.alloc(16, 3));
  return {
    keys: {
      privateKey: ecdh.getPrivateKey(),
      publicKey: ecdh.getPublicKey(),
    },
    auth,
    body: {
      platform: "web",
      transport: "webpush",
      locale: "en",
      subscription: {
        endpoint,
        keys: { p256dh: b64url(ecdh.getPublicKey()), auth },
      },
    },
  };
}

describe("配置", () => {
  it("没配置：Web Push 可用（VAPID 首次生成、0600），原生 notConfigured", async () => {
    const { call, dataDir } = setup();
    const answer = await call(undefined, "GET", PUSH_ROUTES.config);
    expect(answer.status).toBe(200);
    expect(answer.body.native).toEqual({
      transport: "log",
      status: "notConfigured",
      platforms: [],
    });
    expect(answer.body.webpush.enabled).toBe(true);
    expect(answer.body.webpush.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    if (process.platform !== "win32") {
      expect(statSync(vapidFile(dataDir)).mode & 0o777).toBe(0o600);
    }
    // 第二次读的是同一对钥。
    const again = await call(undefined, "GET", PUSH_ROUTES.config);
    expect(again.body.webpush.publicKey).toBe(answer.body.webpush.publicKey);
  });

  it("服务器壳只给了环境变量也能直连；只配 APNs 时只报 ios", async () => {
    const dir = tempDir("armadra-push-env-");
    const p8 = join(dir, "AuthKey.p8");
    writeFileSync(
      p8,
      generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export(
        { type: "pkcs8", format: "pem" },
      ) as string,
    );
    const { call } = setup({
      env: {
        ARMADRA_PUSH_APNS_KEY_FILE: p8,
        ARMADRA_PUSH_APNS_KEY_ID: "KEY",
        ARMADRA_PUSH_APNS_TEAM_ID: "TEAM",
        ARMADRA_PUSH_APNS_BUNDLE_ID: "dev.armadra.app",
      },
    });
    const answer = await call(undefined, "GET", PUSH_ROUTES.config);
    expect(answer.body.native).toEqual({
      transport: "direct",
      status: "ready",
      platforms: ["ios"],
    });
  });

  it("中继：设置里选了 relay 但没给地址仍是 notConfigured", async () => {
    const { call, setSettings } = setup();
    setSettings({ push: { transport: "relay" } });
    expect(
      (await call(undefined, "GET", PUSH_ROUTES.config)).body.native.status,
    ).toBe("notConfigured");
    setSettings({
      push: { transport: "relay", relayUrl: "https://push.example.com" },
    });
    expect(
      (await call(undefined, "GET", PUSH_ROUTES.config)).body.native,
    ).toEqual({
      transport: "relay",
      status: "ready",
      platforms: ["ios", "android"],
    });
  });
});

describe("登记", () => {
  it("桌面本机请求没有设备：409 device_required", async () => {
    const { call } = setup();
    const answer = await call(
      undefined,
      "PUT",
      PUSH_ROUTES.devices,
      browserSubscription(`${sink.base}/wp/a`).body,
    );
    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe("device_required");
  });

  it("服务器壳的匿名主体：401", async () => {
    const { call } = setup();
    const answer = await call(
      { subject: { principalId: "", kind: "member", scopes: [] } },
      "GET",
      PUSH_ROUTES.devices,
    );
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({
      code: "unauthenticated",
      message: expect.any(String),
    });
  });

  it("坏请求体答 400", async () => {
    const { call, ownerIdentity } = setup();
    const bad = async (body: unknown) =>
      (await call(ownerIdentity, "PUT", PUSH_ROUTES.devices, body)).status;
    expect(await bad("not json")).toBe(400);
    expect(await bad({ platform: "ios", transport: "webpush" })).toBe(400);
    expect(
      await bad({ platform: "web", transport: "direct", token: "x" }),
    ).toBe(400);
    // 经中继必须有设备公钥。
    expect(await bad({ platform: "ios", transport: "relay", token: "x" })).toBe(
      400,
    );
    expect(
      await bad({
        platform: "ios",
        transport: "direct",
        token: "x",
        publicKey: b64url(Buffer.alloc(12)),
      }),
    ).toBe(400);
    expect(
      await bad({
        ...browserSubscription("http://push.example.com/wp/a").body,
      }),
    ).toBe(400);
  });

  it("成员只看得见、只撤得掉自己的设备", async () => {
    const { call, ownerIdentity, member, identityOf } = setup();
    const someone = member("同事", { w1: "viewer" });
    const native = {
      platform: "android",
      transport: "direct",
      token: "fcm-token",
      publicKey: generateDeviceKeyPair().publicKey,
      appVersion: "1.2.3",
    };
    expect(
      (await call(ownerIdentity, "PUT", PUSH_ROUTES.devices, native)).status,
    ).toBe(200);
    const mine = await call(
      identityOf(someone),
      "PUT",
      PUSH_ROUTES.devices,
      native,
    );
    expect(mine.status).toBe(200);
    expect(mine.body.device).toMatchObject({
      deviceId: someone.deviceId,
      platform: "android",
      transport: "direct",
      encrypted: true,
      current: true,
    });
    // 接口上没有令牌、没有公钥本身。
    expect(JSON.stringify(mine.body)).not.toContain("fcm-token");
    expect(JSON.stringify(mine.body)).not.toContain(native.publicKey);

    const listed = await call(identityOf(someone), "GET", PUSH_ROUTES.devices);
    expect(
      listed.body.devices.map((item: { deviceId: string }) => item.deviceId),
    ).toEqual([someone.deviceId]);

    const ownerPath = `/api/push/devices/${ownerIdentity.device?.deviceId}`;
    expect((await call(identityOf(someone), "DELETE", ownerPath)).status).toBe(
      404,
    );
    const own = await call(
      identityOf(someone),
      "DELETE",
      `/api/push/devices/${someone.deviceId}`,
    );
    expect(own.body).toEqual({ revoked: true });
    // owner 管这台 core：别人的也撤得掉。
    expect((await call(ownerIdentity, "DELETE", ownerPath)).body).toEqual({
      revoked: true,
    });
  });
});

describe("种类偏好与 UnifiedPush（契约 §27）", () => {
  it("PATCH 只改自己的设备；不认识的种类 400；全选回到全部", async () => {
    const { call, ownerIdentity, member, identityOf } = setup();
    const someone = member("同事", { w1: "viewer" });
    const unifiedpush = {
      platform: "android",
      transport: "direct",
      publicKey: generateDeviceKeyPair().publicKey,
      unifiedpush: { endpoint: "https://ntfy.example/upSecretTopic?up=1" },
    };
    const registered = await call(
      identityOf(someone),
      "PUT",
      PUSH_ROUTES.devices,
      unifiedpush,
    );
    expect(registered.status).toBe(200);
    expect(registered.body.device).toMatchObject({
      unifiedpush: true,
      encrypted: true,
      kinds: [
        "approval",
        "agentDone",
        "agentError",
        "deliveryFailed",
        "schedule",
        "resources",
        "comment",
        "workflowGate",
      ],
    });
    // 端点和令牌一样不出接口。
    expect(JSON.stringify(registered.body)).not.toContain("upSecretTopic");

    const path = `/api/push/devices/${someone.deviceId}`;
    const narrowed = await call(identityOf(someone), "PATCH", path, {
      kinds: ["approval", "schedule", "approval"],
    });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.device.kinds).toEqual(["approval", "schedule"]);
    expect(
      (await call(identityOf(someone), "PATCH", path, { kinds: ["test"] }))
        .status,
    ).toBe(400);
    expect(
      (await call(identityOf(someone), "PATCH", path, { kinds: "approval" }))
        .status,
    ).toBe(400);
    // owner 也不替别人决定他的手机响不响。
    expect(
      (await call(ownerIdentity, "PATCH", path, { kinds: [] })).status,
    ).toBe(404);
    const all = await call(identityOf(someone), "PATCH", path, {
      kinds: registered.body.device.kinds,
    });
    expect(all.body.device.kinds).toHaveLength(8);
  });
});

describe("Web Push 一路到假端点", () => {
  it("登记 → 测试通知 → push-sink：VAPID 验签过、aes128gcm、浏览器能解", async () => {
    const { call, ownerIdentity, push } = setup();
    const browser = browserSubscription(`${sink.base}/wp/sub-1`);
    const registered = await call(
      ownerIdentity,
      "PUT",
      PUSH_ROUTES.devices,
      browser.body,
    );
    expect(registered.status).toBe(200);
    const test = await call(ownerIdentity, "POST", PUSH_ROUTES.test);
    expect(test.status).toBe(202);
    await push.dispatcher.idle();
    const [record] = sink.records;
    expect(record).toMatchObject({
      kind: "webpush",
      status: 201,
      subscription: "sub-1",
      headers: { "content-encoding": "aes128gcm", ttl: "3600" },
    });
    expect(record?.jwt).toMatchObject({
      ok: true,
      signature: "verified",
      claims: { aud: sink.base },
    });
    const plain = JSON.parse(
      decryptWebPush(bodyOf(record!), browser.keys, browser.auth).toString(),
    );
    expect(plain).toMatchObject({
      v: 1,
      kind: "test",
      body: "Push notifications are working",
      url: "armadra://",
    });
    expect(push.outbox.get(test.body.id)?.sentAtMs).toBeGreaterThan(0);
  });

  it("订阅不在了（410）：设备登记撤销", async () => {
    const { call, ownerIdentity, push } = setup();
    await call(
      ownerIdentity,
      "PUT",
      PUSH_ROUTES.devices,
      browserSubscription(`${sink.base}/wp/gone-1`).body,
    );
    await call(ownerIdentity, "POST", PUSH_ROUTES.test);
    await push.dispatcher.idle();
    expect(
      push.devices.get(ownerIdentity.device!.deviceId)?.revokedAtMs,
    ).toBeGreaterThan(0);
    expect((await call(ownerIdentity, "POST", PUSH_ROUTES.test)).status).toBe(
      409,
    );
  });
});
