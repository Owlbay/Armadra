import { describe, expect, it } from "vitest";

import {
  ASSERTION,
  PASSWORD_POLICY,
  SCRYPT,
  SESSION,
  THROTTLE,
  TOKEN_HASH_KINDS,
  TOKEN_HASH_PREFIX,
  lockDurationMs as protocolLockDuration,
  vectors,
} from "@armadra/platform-protocol/identity-vectors";

import {
  CURRENT_KDF,
  MAX_PASSWORD_BYTES,
  SALT_BYTES,
  derivePassword,
} from "./passwords";
import {
  PASSWORD_MIN_LENGTH_CEILING,
  PASSWORD_MIN_LENGTH_DEFAULT,
  PASSWORD_MIN_LENGTH_FLOOR,
} from "./policy";
import { ACCESS_TTL_MS, SESSION_TTL_MS } from "./service";
import {
  FAILURE_WINDOW_MS,
  IP_BUCKET_CAPACITY,
  IP_BUCKET_WINDOW_MS,
  LOCK_BASE_MS,
  LOCK_MAX_MS,
  LOCK_THRESHOLD,
  lockDurationMs,
} from "./throttle";
import { type TokenKind, digest } from "./tokens";
import { WS_TICKET_TTL_MS } from "./transport";

/**
 * 协议包的身份参数与测试向量（协议包设计 §8）：cloud / relay 直接 import 那一份，
 * core 这边是它们的出处——两边任何一个值漂了，这里先红。
 */

describe("身份参数与协议包相等", () => {
  it("口令策略与 scrypt 参数", () => {
    expect(PASSWORD_POLICY.minLengthDefault).toBe(PASSWORD_MIN_LENGTH_DEFAULT);
    expect(PASSWORD_POLICY.minLengthFloor).toBe(PASSWORD_MIN_LENGTH_FLOOR);
    expect(PASSWORD_POLICY.minLengthCeiling).toBe(PASSWORD_MIN_LENGTH_CEILING);
    expect(PASSWORD_POLICY.maxBytes).toBe(MAX_PASSWORD_BYTES);
    expect({
      cost: CURRENT_KDF.cost,
      block: CURRENT_KDF.block,
      parallel: CURRENT_KDF.parallel,
      length: CURRENT_KDF.length,
      saltBytes: SALT_BYTES,
    }).toEqual(SCRYPT);
  });

  it("锁定与来源限流", () => {
    expect(THROTTLE).toEqual({
      lockThreshold: LOCK_THRESHOLD,
      lockBaseMs: LOCK_BASE_MS,
      lockMaxMs: LOCK_MAX_MS,
      failureWindowMs: FAILURE_WINDOW_MS,
      ipBucketCapacity: IP_BUCKET_CAPACITY,
      ipBucketWindowMs: IP_BUCKET_WINDOW_MS,
    });
    for (let failures = 0; failures < 30; failures += 1) {
      expect(protocolLockDuration(failures), String(failures)).toBe(
        lockDurationMs(failures),
      );
    }
  });

  it("会话寿命与 WebSocket 票", () => {
    expect(SESSION.accessTtlMs).toBe(ACCESS_TTL_MS);
    expect(SESSION.refreshTtlMs).toBe(SESSION_TTL_MS);
    expect(SESSION.wsTicketTtlMs).toBe(WS_TICKET_TTL_MS);
    expect(ASSERTION.skewMs).toBe(5 * 60 * 1000);
  });
});

describe("测试向量", () => {
  it("scrypt：core 的派生与向量逐字节相等", () => {
    expect(vectors.scrypt.length).toBeGreaterThan(0);
    for (const vector of vectors.scrypt) {
      const derived = derivePassword(
        vector.password,
        CURRENT_KDF,
        Buffer.from(vector.salt, "hex"),
      );
      expect(derived.hash.toString("hex"), vector.password).toBe(vector.hex);
    }
  });

  it("令牌哈希：前缀与 core 的 digest 一致", () => {
    expect(vectors.tokenHash.length).toBeGreaterThan(0);
    expect(TOKEN_HASH_PREFIX).toBe("armadra/identity/v1/");
    for (const vector of vectors.tokenHash) {
      expect(TOKEN_HASH_KINDS).toContain(vector.kind);
      expect(
        digest(vector.kind as TokenKind, vector.value).toString("hex"),
        `${vector.kind}:${vector.value}`,
      ).toBe(vector.hex);
    }
  });
});
