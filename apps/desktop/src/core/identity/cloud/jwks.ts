/**
 * 远程服务签名钥的缓存（平台规格 core 包 §2.2）。
 *
 * 缓存就是 `cloud_registrations.jwks_json`：验签先查它，`kid` 在里面就直接用——
 * 远程服务不可达时，登记过的 core 照样能验它签过的断言（离线验签）。`kid` 不在
 * 缓存里（远程服务换了钥）才去取一次 JWKS（外呼 `cloudJwks`，10 秒超时），写回
 * 缓存；同一个 issuer 最多每 10 分钟取一次，失败就当这个 `kid` 不认识，缓存照旧。
 */

import { type KeyObject, createPublicKey } from "node:crypto";

import {
  type Ed25519PublicJwk,
  type JwkSet,
  jwkSetSchema,
} from "@armadra/platform-protocol/assertion";

import type { CloudStore, RegistrationRow } from "./store";

/** 同一个 issuer 两次取 JWKS 至少隔这么久（`kid` 未知时才取）。 */
export const JWKS_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** 取一个 issuer 的 JWKS（`jwks_url`，按远程服务的指纹钉扎）。 */
export type JwksFetcher = (row: RegistrationRow) => Promise<JwkSet>;

/** 一份 JWKS 的 JSON → 解析过的钥；坏的当空。 */
export function parseJwks(json: string): Ed25519PublicJwk[] {
  try {
    const parsed = jwkSetSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data.keys : [];
  } catch {
    return [];
  }
}

function keyOf(jwk: Ed25519PublicJwk): KeyObject | undefined {
  try {
    return createPublicKey({
      key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      format: "jwk",
    });
  } catch {
    return undefined;
  }
}

export class JwksCache {
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly store: CloudStore,
    private readonly fetchJwks: JwksFetcher,
    private readonly now: () => number = Date.now,
  ) {}

  /** 这个 issuer 名下 `kid` 的公钥；认不出答 `undefined`。 */
  async key(row: RegistrationRow, kid: string): Promise<KeyObject | undefined> {
    const cached = parseJwks(row.jwksJson).find((jwk) => jwk.kid === kid);
    if (cached !== undefined) return keyOf(cached);
    const now = this.now();
    const last = this.attempts.get(row.issuer);
    if (last !== undefined && now - last < JWKS_REFRESH_INTERVAL_MS) {
      return undefined;
    }
    this.attempts.set(row.issuer, now);
    let fresh: JwkSet;
    try {
      fresh = await this.fetchJwks(row);
    } catch {
      return undefined;
    }
    // 取回来的要能整份解析才写回：一份坏的答案不该把能用的缓存冲掉。
    const json = JSON.stringify({ keys: fresh.keys });
    if (json.length > 65_536 || parseJwks(json).length === 0) return undefined;
    this.store.updateJwks(row.issuer, json, now);
    const found = fresh.keys.find((jwk) => jwk.kid === kid);
    return found === undefined ? undefined : keyOf(found);
  }
}
