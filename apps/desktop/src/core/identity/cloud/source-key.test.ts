import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  sourceJwsClaimsSchema,
  splitCompactJws,
} from "@armadra/platform-protocol/assertion";
import {
  FIXED_NOW_MS,
  TEST_KEYS,
  readTextFixture,
} from "@armadra/platform-protocol/fixtures";

import { memoryBackend } from "./fake.fixture";
import {
  SOURCE_KEY_REF,
  SourceKey,
  publicJwkOf,
  signSourceJwsWith,
} from "./source-key";

/** 源密钥：持久化在 SecretStore、JWS 与协议包的黄金字节逐字相等。 */

const SOURCE = TEST_KEYS.source.sourceId;

describe("源 JWS", () => {
  it("固定钥、固定时刻与 jti：与协议包 source-jws.jwt 逐字相等", () => {
    const key = createPrivateKey({
      key: TEST_KEYS.source.privateJwk,
      format: "jwk",
    });
    expect(
      signSourceJwsWith(key, {
        sourceId: SOURCE,
        audience: TEST_KEYS.issuer.issuer,
        nowMs: FIXED_NOW_MS,
        jti: "jti-source-0001",
      }),
    ).toBe(readTextFixture("assertion/source-jws.jwt").trim());
    expect(publicJwkOf(key, SOURCE)).toEqual(TEST_KEYS.source.publicJwk);
  });

  it("寿命封顶 60 秒", () => {
    const key = createPrivateKey({
      key: TEST_KEYS.source.privateJwk,
      format: "jwk",
    });
    const token = signSourceJwsWith(key, {
      sourceId: SOURCE,
      audience: "https://relay.test",
      nowMs: FIXED_NOW_MS,
      ttlMs: 3_600_000,
    });
    const claims = sourceJwsClaimsSchema.parse(splitCompactJws(token).payload);
    expect(claims.exp - claims.iat).toBe(60);
  });
});

describe("SourceKey", () => {
  it("第一次生成并写进 SecretStore，之后读同一把；并发只生成一把", async () => {
    const backend = memoryBackend();
    const first = new SourceKey(
      () => backend,
      () => SOURCE,
    );
    const [a, b] = await Promise.all([first.publicJwk(), first.publicJwk()]);
    expect(a).toEqual(b);
    expect(backend.sets).toBe(1);
    expect([...backend.values.keys()]).toEqual([SOURCE_KEY_REF]);
    expect(SOURCE_KEY_REF).toBe("armadra-cloud-source-key");
    const again = new SourceKey(
      () => backend,
      () => SOURCE,
    );
    expect(await again.publicJwk()).toEqual(a);
    expect(backend.sets).toBe(1);
    expect(a.kid).toBe(SOURCE);
    // 私钥的任何一部分都不在公钥里。
    expect(JSON.stringify(a)).not.toContain(backend.values.get(SOURCE_KEY_REF));
  });

  it("签出来的源 JWS 能用公钥 JWK 验过，声明合协议包的 schema", async () => {
    const backend = memoryBackend();
    const key = new SourceKey(
      () => backend,
      () => SOURCE,
      () => FIXED_NOW_MS,
    );
    const token = await key.signSourceJws("https://relay.test");
    const parts = splitCompactJws(token);
    expect(parts.header).toEqual({
      alg: "EdDSA",
      kid: SOURCE,
      typ: "armadra-source",
    });
    const claims = sourceJwsClaimsSchema.parse(parts.payload);
    expect(claims.iss).toBe(SOURCE);
    expect(claims.aud).toBe("https://relay.test");
    const jwk = await key.publicJwk();
    expect(
      verify(
        null,
        parts.signingInput,
        createPublicKey({ key: jwk, format: "jwk" }),
        parts.signature,
      ),
    ).toBe(true);
    const bytes = new TextEncoder().encode("source\nnonce");
    expect(
      verify(
        null,
        bytes,
        createPublicKey({ key: jwk, format: "jwk" }),
        await key.signBytes(bytes),
      ),
    ).toBe(true);
  });

  it("SecretStore 写失败：这一次失败，下一次重来", async () => {
    const backend = memoryBackend();
    let broken = true;
    const flaky = {
      ...backend,
      kind: backend.kind,
      get: backend.get,
      delete: backend.delete,
      set: async (name: string, value: string) => {
        if (broken) throw new Error("locked");
        await backend.set(name, value);
      },
    };
    const key = new SourceKey(
      () => flaky,
      () => SOURCE,
    );
    await expect(key.publicJwk()).rejects.toThrow("locked");
    broken = false;
    expect((await key.publicJwk()).kid).toBe(SOURCE);
  });
});
