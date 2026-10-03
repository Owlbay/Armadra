import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

/**
 * 测试专用的软件认证器：`node:crypto` 生成 P-256 密钥，拼 `authenticatorData`、
 * `clientDataJSON` 与 `fmt: "none"` 的 attestationObject——浏览器与认证器之间的
 * 那一半。服务端的校验仍然全部是 `@simplewebauthn/server` 做的；这里写的是
 * 「对方」，不是被测的东西。
 *
 * CBOR 只实现用得到的那几种（无符号 / 负整数、字节串、文本串、映射）。
 */

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(length, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([head(2, value.length), value]);
  }
  const parts: Buffer[] = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest();

const b64url = (value: Buffer) => value.toString("base64url");

export interface SoftCredential {
  readonly id: Buffer;
  readonly userHandle: Buffer;
  signCount: number;
  readonly sign: (data: Buffer) => Buffer;
}

export class SoftAuthenticator {
  readonly aaguid = Buffer.alloc(16);
  readonly credentials: SoftCredential[] = [];

  /**
   * `navigator.credentials.create()` 的那一半：按选项造一把新钥匙，答注册应答
   * JSON。`origin` 是页面来源；`rpId` 缺省取选项里的。
   */
  create(
    options: {
      challenge: string;
      rp: { id?: string };
      user: { id: string };
    },
    origin: string,
    overrides: { rpId?: string; challenge?: string } = {},
  ): Record<string, unknown> {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
    const id = randomBytes(32);
    const rpId = overrides.rpId ?? options.rp.id ?? "";
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([0x01 | 0x04 | 0x40]),
      Buffer.alloc(4),
      this.aaguid,
      length,
      id,
      cose,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: overrides.challenge ?? options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    this.credentials.push({
      id,
      userHandle: Buffer.from(options.user.id, "base64url"),
      signCount: 0,
      sign: (data) => sign("sha256", data, privateKey),
    });
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /**
   * `navigator.credentials.get()` 的那一半：用第 `index` 把钥匙签一次断言。计数器
   * 每次加一；`signCount` 可以强行指定（测回退）。
   */
  get(
    options: { challenge: string; rpId?: string },
    origin: string,
    overrides: {
      index?: number;
      rpId?: string;
      challenge?: string;
      signCount?: number;
    } = {},
  ): Record<string, unknown> {
    const credential = this.credentials[overrides.index ?? 0];
    if (credential === undefined) throw new Error("no credential");
    credential.signCount = overrides.signCount ?? credential.signCount + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(credential.signCount);
    const authenticatorData = Buffer.concat([
      sha256(overrides.rpId ?? options.rpId ?? ""),
      Buffer.from([0x01 | 0x04]),
      counter,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: overrides.challenge ?? options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const signature = credential.sign(
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
    );
    return {
      id: b64url(credential.id),
      rawId: b64url(credential.id),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        userHandle: b64url(credential.userHandle),
      },
    };
  }
}
