import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import { tempDir } from "../testing/temp-dir";
import { identityFailure } from "./errors";
import { IdentityStore } from "./store";
import {
  IpBuckets,
  LOCK_MAX_MS,
  Throttle,
  lockDurationMs,
  principalKey,
} from "./throttle";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

function fixture() {
  const opened = openDatabase({
    file: join(tempDir("armadra-throttle-"), "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  let now = 1_700_000_000_000;
  const throttle = new Throttle(new IdentityStore(opened.database), () => now);
  return {
    throttle,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function refusal(action: () => void) {
  try {
    action();
  } catch (error) {
    return identityFailure(error);
  }
  return undefined;
}

describe("退避曲线", () => {
  it("5 次起锁 1 分钟，每次翻倍，封顶 15 分钟", () => {
    expect([1, 2, 3, 4].map(lockDurationMs)).toEqual([0, 0, 0, 0]);
    expect(lockDurationMs(5)).toBe(60_000);
    expect(lockDurationMs(6)).toBe(120_000);
    expect(lockDurationMs(7)).toBe(240_000);
    expect(lockDurationMs(8)).toBe(480_000);
    expect(lockDurationMs(9)).toBe(LOCK_MAX_MS);
    expect(lockDurationMs(40)).toBe(LOCK_MAX_MS);
  });
});

describe("按 principal 的锁定", () => {
  it("第 5 次失败上锁，锁着时直接拒，到点放行", () => {
    const { throttle, advance } = fixture();
    const key = principalKey("a".repeat(32));
    for (let index = 1; index <= 4; index += 1) {
      expect(throttle.failure(key).engaged).toBe(false);
    }
    const fifth = throttle.failure(key);
    expect(fifth).toMatchObject({ failures: 5, engaged: true });
    expect(refusal(() => throttle.admitKey(key))).toMatchObject({
      status: 429,
      code: "account_locked",
      retryAfterMs: 60_000,
    });
    advance(60_000);
    expect(refusal(() => throttle.admitKey(key))).toBeUndefined();
    // 解锁之后再错一次，翻倍到 2 分钟。
    expect(throttle.failure(key).lockedUntilMs).toBeGreaterThan(0);
    expect(refusal(() => throttle.admitKey(key))).toMatchObject({
      retryAfterMs: 120_000,
    });
  });

  it("不泄露存在性：不存在的账号与存在的同一种锁、同一个答案", () => {
    const { throttle } = fixture();
    const ghost = principalKey("f".repeat(32));
    for (let index = 0; index < 5; index += 1) throttle.failure(ghost);
    expect(refusal(() => throttle.admitKey(ghost))).toMatchObject({
      status: 429,
      code: "account_locked",
    });
    expect(throttle.active().map((row) => row.principalId)).toEqual([
      "f".repeat(32),
    ]);
  });

  it("成功清零；一小时没有新失败也清零", () => {
    const { throttle, advance } = fixture();
    const key = principalKey("b".repeat(32));
    for (let index = 0; index < 4; index += 1) throttle.failure(key);
    throttle.success(key);
    expect(throttle.failure(key).failures).toBe(1);
    for (let index = 0; index < 3; index += 1) throttle.failure(key);
    advance(61 * 60 * 1000);
    expect(throttle.failure(key).failures).toBe(1);
  });

  it("owner 解锁", () => {
    const { throttle } = fixture();
    const key = principalKey("c".repeat(32));
    for (let index = 0; index < 5; index += 1) throttle.failure(key);
    expect(throttle.unlock(key)).toBe(true);
    expect(refusal(() => throttle.admitKey(key))).toBeUndefined();
    expect(throttle.unlock(key)).toBe(false);
  });
});

describe("按来源 IP 的令牌桶", () => {
  it("每分钟 20 次，之后 429，按速率回补", () => {
    const buckets = new IpBuckets();
    const at = 1_000_000;
    for (let index = 0; index < 20; index += 1) {
      expect(buckets.take("198.51.100.7", at).ok).toBe(true);
    }
    const denied = buckets.take("198.51.100.7", at);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBe(3000);
    // 另一个地址不受影响。
    expect(buckets.take("198.51.100.8", at).ok).toBe(true);
    expect(buckets.take("198.51.100.7", at + 3000).ok).toBe(true);
    // 拿不到来源的不限（回环的原生壳）。
    for (let index = 0; index < 50; index += 1) {
      expect(buckets.take("", at).ok).toBe(true);
    }
  });

  it("Throttle 的 IP 层答 rate_limited", () => {
    const { throttle } = fixture();
    for (let index = 0; index < 20; index += 1) throttle.admitIp("203.0.113.1");
    expect(refusal(() => throttle.admitIp("203.0.113.1"))).toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });
});
