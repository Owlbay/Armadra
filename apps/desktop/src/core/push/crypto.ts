import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";

/**
 * 推送的三样密码学（契约 §19、补全架构 §10）：
 *
 *   * **端到端载荷加密**：原生 App 注册时上交一把 X25519 公钥；每条通知用一把
 *     一次性的 X25519 密钥对与它做 ECDH，HKDF-SHA256 派生 AES-256-GCM 的钥，
 *     中继与苹果 / Google 只看到密文。App 在 Notification Service Extension /
 *     数据消息处理器里用设备私钥解开。
 *   * **Web Push 的 aes128gcm**（RFC 8291 + RFC 8188）：浏览器厂商端点同样只看到
 *     密文，解密在浏览器里。
 *   * **JWT**：VAPID（RFC 8292，ES256）、APNs provider token（ES256）、FCM 的服务
 *     账号断言（RS256）。
 *
 * 全部只用 `node:crypto`，不引第三方库：这几段都是规范里写死的几行派生，库能
 * 省下的只是这几行，带进来的却是一整棵依赖树。
 */

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

/* --------------------------- 端到端：X25519 信封 --------------------------- */

/** 信封的算法名；App 端按它选解法，换算法就换名字。 */
export const ENVELOPE_ALG = "x25519-hkdf-sha256-a256gcm";
const ENVELOPE_INFO = Buffer.from("armadra-push-v1", "utf8");

/** 交给中继 / APNs / FCM 的那一段：全部 base64url，没有一个明文字节。 */
export interface PushEnvelope {
  readonly v: 1;
  readonly alg: typeof ENVELOPE_ALG;
  /** 一次性 X25519 公钥（32 字节原始点）。 */
  readonly epk: string;
  readonly salt: string;
  readonly iv: string;
  /** 密文 ‖ 16 字节 GCM 标签。 */
  readonly ct: string;
}

/** 一把 X25519 公钥的原始 32 字节（base64url）是否像样。 */
export function validX25519PublicKey(text: string): boolean {
  try {
    x25519PublicKey(text);
    return true;
  } catch {
    return false;
  }
}

function x25519PublicKey(text: string): KeyObject {
  const raw = fromB64url(text);
  if (raw.length !== 32) throw new Error("X25519 公钥应是 32 字节");
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: b64url(raw) },
    format: "jwk",
  });
}

function rawX25519(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  return jwk.x ?? "";
}

/** 设备一侧的密钥对。core 只在测试与探针里用它扮演 App。 */
export function generateDeviceKeyPair(): {
  readonly publicKey: string;
  readonly privateKey: KeyObject;
} {
  const pair = generateKeyPairSync("x25519");
  return { publicKey: rawX25519(pair.publicKey), privateKey: pair.privateKey };
}

function envelopeKey(
  shared: Buffer,
  salt: Buffer,
  epk: string,
  recipient: string,
): Buffer {
  // 两把公钥都进 info：同一个共享秘密换一对公钥派生出的是另一把钥。
  const info = Buffer.concat([
    ENVELOPE_INFO,
    Buffer.from([0]),
    fromB64url(epk),
    fromB64url(recipient),
  ]);
  return Buffer.from(hkdfSync("sha256", shared, salt, info, 32));
}

export function sealPayload(
  plaintext: Buffer,
  recipientPublicKey: string,
): PushEnvelope {
  const recipient = x25519PublicKey(recipientPublicKey);
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipient,
  });
  const epk = rawX25519(ephemeral.publicKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = envelopeKey(shared, salt, epk, recipientPublicKey);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    v: 1,
    alg: ENVELOPE_ALG,
    epk,
    salt: b64url(salt),
    iv: b64url(iv),
    ct: b64url(ct),
  };
}

/** App 一侧的解法；core 里只有测试与探针调它。标签不对时抛错。 */
export function openPayload(
  envelope: PushEnvelope,
  privateKey: KeyObject,
): Buffer {
  if (envelope.v !== 1 || envelope.alg !== ENVELOPE_ALG) {
    throw new Error("不认识的信封");
  }
  const shared = diffieHellman({
    privateKey,
    publicKey: x25519PublicKey(envelope.epk),
  });
  const recipient = rawX25519(createPublicKey(privateKey));
  const key = envelopeKey(
    shared,
    fromB64url(envelope.salt),
    envelope.epk,
    recipient,
  );
  const sealed = fromB64url(envelope.ct);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    fromB64url(envelope.iv),
  );
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);
}

/* ---------------------------- Web Push：RFC 8291 --------------------------- */

const RECORD_SIZE = 4096;

/** P-256 未压缩点（65 字节，0x04 开头）是否像样。 */
export function validP256PublicKey(text: string): boolean {
  const raw = fromB64url(text);
  return raw.length === 65 && raw[0] === 0x04;
}

/**
 * RFC 8291 §3.4 + RFC 8188：单记录的 aes128gcm 正文。
 *
 * 头 = salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid(应用服务器的一次性公钥，65)；正文
 * 是一条记录：明文 ‖ 0x02（最后一条记录的分隔符），AES-128-GCM。
 */
export function encryptWebPush(
  plaintext: Buffer,
  subscriberPublicKey: string,
  authSecret: string,
  salt: Buffer = randomBytes(16),
): Buffer {
  const uaPublic = fromB64url(subscriberPublicKey);
  const auth = fromB64url(authSecret);
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    uaPublic,
    asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: aes128gcm\0", "utf8"),
      16,
    ),
  );
  const nonce = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: nonce\0", "utf8"),
      12,
    ),
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, record]);
}

/** 浏览器一侧的解法（测试与探针扮演订阅者用）。 */
export function decryptWebPush(
  body: Buffer,
  subscriber: { readonly privateKey: Buffer; readonly publicKey: Buffer },
  authSecret: string,
): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(subscriber.privateKey);
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    subscriber.publicKey,
    asPublic,
  ]);
  const ikm = Buffer.from(
    hkdfSync("sha256", shared, fromB64url(authSecret), keyInfo, 32),
  );
  const cek = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: aes128gcm\0", "utf8"),
      16,
    ),
  );
  const nonce = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: nonce\0", "utf8"),
      12,
    ),
  );
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  const end = padded.lastIndexOf(0x02);
  return padded.subarray(0, end);
}

/* ---------------------------------- JWT ---------------------------------- */

export type JwtAlgorithm = "ES256" | "RS256";

/** 紧凑 JWS。ES256 的签名是 r‖s（IEEE P1363），不是 DER。 */
export function signJwt(
  alg: JwtAlgorithm,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: KeyObject,
): string {
  const input = `${b64url(Buffer.from(JSON.stringify({ ...header, alg, typ: "JWT" })))}.${b64url(Buffer.from(JSON.stringify(claims)))}`;
  const signature =
    alg === "ES256"
      ? sign("sha256", Buffer.from(input), {
          key,
          dsaEncoding: "ieee-p1363",
        })
      : sign("sha256", Buffer.from(input), key);
  return `${input}.${b64url(signature)}`;
}

/* --------------------------------- VAPID --------------------------------- */

/** `<数据目录>/push/vapid.json` 的内容。私钥是 P-256 的 `d`。 */
export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(ecdh.getPrivateKey()),
  };
}

export function vapidPrivateKey(keys: VapidKeys): KeyObject {
  const point = fromB64url(keys.publicKey);
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33)),
    },
    format: "jwk",
  });
}

/**
 * RFC 8292 的 `Authorization: vapid t=<jwt>, k=<公钥>`。`aud` 是推送端点的
 * 来源；有效期 12 小时（规范上限 24 小时）。
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  nowMs: number,
): string {
  const jwt = signJwt(
    "ES256",
    {},
    {
      aud: new URL(endpoint).origin,
      exp: Math.floor(nowMs / 1000) + 12 * 3600,
      sub: subject,
    },
    vapidPrivateKey(keys),
  );
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}
