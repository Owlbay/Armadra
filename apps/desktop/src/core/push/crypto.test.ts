import { createECDH, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ENVELOPE_ALG,
  b64url,
  decryptWebPush,
  encryptWebPush,
  fromB64url,
  generateDeviceKeyPair,
  generateVapidKeys,
  openPayload,
  sealPayload,
  validP256PublicKey,
  validX25519PublicKey,
  vapidAuthorization,
} from "./crypto";

/**
 * 载荷加密的三条路：设备私钥能解、别人的私钥解不开、改一个字节就解不开。
 */

const PLAIN = Buffer.from(
  JSON.stringify({ v: 1, kind: "approval", title: "项目", body: "等待审批" }),
);

describe("端到端信封（X25519 + HKDF + AES-256-GCM）", () => {
  it("设备私钥能解开，密文里没有明文", () => {
    const device = generateDeviceKeyPair();
    expect(validX25519PublicKey(device.publicKey)).toBe(true);
    const envelope = sealPayload(PLAIN, device.publicKey);
    expect(envelope.alg).toBe(ENVELOPE_ALG);
    expect(fromB64url(envelope.epk)).toHaveLength(32);
    expect(fromB64url(envelope.ct).includes(Buffer.from("等待审批"))).toBe(
      false,
    );
    expect(JSON.stringify(envelope)).not.toContain("approval");
    expect(openPayload(envelope, device.privateKey).equals(PLAIN)).toBe(true);
  });

  it("每条通知一把一次性密钥：同一明文两次加密结果不同", () => {
    const device = generateDeviceKeyPair();
    const a = sealPayload(PLAIN, device.publicKey);
    const b = sealPayload(PLAIN, device.publicKey);
    expect(a.epk).not.toBe(b.epk);
    expect(a.ct).not.toBe(b.ct);
  });

  it("别的设备的私钥解不开", () => {
    const device = generateDeviceKeyPair();
    const other = generateDeviceKeyPair();
    const envelope = sealPayload(PLAIN, device.publicKey);
    expect(() => openPayload(envelope, other.privateKey)).toThrow();
  });

  it("改一个密文字节，GCM 标签就对不上", () => {
    const device = generateDeviceKeyPair();
    const envelope = sealPayload(PLAIN, device.publicKey);
    const ct = fromB64url(envelope.ct);
    ct[0] = (ct[0] as number) ^ 1;
    expect(() =>
      openPayload({ ...envelope, ct: b64url(ct) }, device.privateKey),
    ).toThrow();
  });

  it("公钥长度不对就拒绝", () => {
    expect(validX25519PublicKey(b64url(Buffer.alloc(31)))).toBe(false);
    expect(() => sealPayload(PLAIN, b64url(Buffer.alloc(33)))).toThrow();
  });
});

describe("Web Push aes128gcm（RFC 8291）", () => {
  function subscriber() {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return {
      privateKey: ecdh.getPrivateKey(),
      publicKey: ecdh.getPublicKey(),
      p256dh: b64url(ecdh.getPublicKey()),
      auth: b64url(Buffer.alloc(16, 7)),
    };
  }

  it("订阅者能解开；头里是 salt、记录大小与应用服务器公钥", () => {
    const ua = subscriber();
    expect(validP256PublicKey(ua.p256dh)).toBe(true);
    const body = encryptWebPush(PLAIN, ua.p256dh, ua.auth);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
    expect(body[21]).toBe(0x04);
    expect(body.includes(Buffer.from("等待审批"))).toBe(false);
    expect(decryptWebPush(body, ua, ua.auth).equals(PLAIN)).toBe(true);
  });

  it("auth 不对就解不开", () => {
    const ua = subscriber();
    const body = encryptWebPush(PLAIN, ua.p256dh, ua.auth);
    expect(() =>
      decryptWebPush(body, ua, b64url(Buffer.alloc(16, 8))),
    ).toThrow();
  });
});

describe("VAPID（RFC 8292）", () => {
  it("t= 是 ES256、能用 k= 的公钥验签，aud 是端点来源", () => {
    const keys = generateVapidKeys();
    const now = 1_800_000_000_000;
    const header = vapidAuthorization(
      "https://push.example.com/wp/abc?x=1",
      keys,
      "mailto:ops@example.com",
      now,
    );
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [jwtHeader, claims, signature] = (match?.[1] ?? "").split(".");
    expect(match?.[2]).toBe(keys.publicKey);
    expect(JSON.parse(fromB64url(jwtHeader ?? "").toString())).toMatchObject({
      alg: "ES256",
      typ: "JWT",
    });
    expect(JSON.parse(fromB64url(claims ?? "").toString())).toEqual({
      aud: "https://push.example.com",
      exp: now / 1000 + 12 * 3600,
      sub: "mailto:ops@example.com",
    });
    const point = fromB64url(keys.publicKey);
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: b64url(point.subarray(1, 33)),
        y: b64url(point.subarray(33)),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${jwtHeader}.${claims}`),
        { key, dsaEncoding: "ieee-p1363" },
        fromB64url(signature ?? ""),
      ),
    ).toBe(true);
  });
});
