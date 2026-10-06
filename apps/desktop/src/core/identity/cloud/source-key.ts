/**
 * 源密钥（平台规格 core 包 §2.2）：这台 core 对远程服务证明「我是这个源」的那把
 * Ed25519 钥。
 *
 * - 所有 issuer 共用同一把；`sourceId` 就是本机 `hostId`，也是 JWK 的 `kid`。
 * - 私钥 PKCS8（DER，base64）只在 SecretStore `armadra-cloud-source-key`；公钥按
 *   需从私钥导出，不另存。不在 SQLite、日志、审计与任何答案里。
 * - `signSourceJws(aud)`：`Authorization: Source <jws>` 用的那张 60 秒的源 JWS
 *   （协议包 `SOURCE_JWS`，头 `kid = sourceId`、`typ = armadra-source`）。
 */

import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

import {
  type Ed25519PublicJwk,
  TOKEN_TYPES,
  buildSigningInput,
  joinCompactJws,
} from "@armadra/platform-protocol/assertion";
import { SOURCE_JWS } from "@armadra/platform-protocol/identity-vectors";

import { type SecretBackend, checkSecretName } from "../../secrets/backend";

/** SecretStore 里源私钥的名字（`cloud_registrations.source_key_ref`）。 */
export const SOURCE_KEY_REF = checkSecretName("armadra-cloud-source-key");

/** 私钥 → 公钥 JWK（RFC 8037），带 `kid = sourceId`。 */
export function publicJwkOf(
  privateKey: KeyObject,
  sourceId: string,
): Ed25519PublicJwk {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as {
    x?: string;
  };
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: jwk.x ?? "",
    kid: sourceId,
    alg: "EdDSA",
    use: "sig",
  };
}

/**
 * 签一张源 JWS（只拼与签，不碰 SecretStore）：头 `{ alg, kid, typ }`、载荷
 * `{ iss, aud, iat, exp, jti }`，键序固定，同一组输入得到同一串（Ed25519 是确定的）。
 */
export function signSourceJwsWith(
  privateKey: KeyObject,
  input: {
    readonly sourceId: string;
    readonly audience: string;
    readonly nowMs: number;
    readonly jti?: string;
    readonly ttlMs?: number;
  },
): string {
  const iat = Math.floor(input.nowMs / 1000);
  const ttl = Math.min(input.ttlMs ?? SOURCE_JWS.ttlMs, SOURCE_JWS.ttlMs);
  const { signingInput, encodedHeader, encodedPayload } = buildSigningInput(
    { alg: "EdDSA", kid: input.sourceId, typ: TOKEN_TYPES.source },
    {
      iss: input.sourceId,
      aud: input.audience,
      iat,
      exp: iat + Math.floor(ttl / 1000),
      jti: input.jti ?? randomBytes(16).toString("hex"),
    },
  );
  return joinCompactJws(
    encodedHeader,
    encodedPayload,
    sign(null, signingInput, privateKey),
  );
}

export class SourceKey {
  private loading: Promise<KeyObject> | undefined;

  constructor(
    private readonly backend: () => SecretBackend,
    private readonly sourceId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 有就读，没有就生成并写进 SecretStore；并发的两次只生成一把。 */
  key(): Promise<KeyObject> {
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }

  private async load(): Promise<KeyObject> {
    const backend = this.backend();
    const stored = await backend.get(SOURCE_KEY_REF);
    if (stored !== undefined && stored !== "") {
      return createPrivateKey({
        key: Buffer.from(stored, "base64"),
        format: "der",
        type: "pkcs8",
      });
    }
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    await backend.set(SOURCE_KEY_REF, Buffer.from(der).toString("base64"));
    return privateKey;
  }

  async publicJwk(): Promise<Ed25519PublicJwk> {
    return publicJwkOf(await this.key(), this.sourceId());
  }

  /** `Authorization: Source <jws>`，`aud` = 远程服务的 issuer。 */
  async signSourceJws(audience: string): Promise<string> {
    return signSourceJwsWith(await this.key(), {
      sourceId: this.sourceId(),
      audience,
      nowMs: this.now(),
    });
  }

  /**
   * 隧道握手用（A3-2）：用源私钥签任意字节（`sourceId\nnonce\nnonce2\nrelayNode`）。
   * 私钥本身不出这个类。
   */
  async signBytes(data: Uint8Array): Promise<Uint8Array> {
    return sign(null, data, await this.key());
  }
}
