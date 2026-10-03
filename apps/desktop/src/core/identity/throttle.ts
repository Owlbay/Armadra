import { IdentityRefusal } from "./errors";
import type { IdentityStore, IdentityTx, LockoutRow } from "./store";

/**
 * 登录的限流与锁定（契约 §18.1，架构 §8.3）。
 *
 * 两层，互不替代：
 *
 *   * **按来源 IP 的令牌桶**，内存里，每分钟 20 次。挡的是一台机器对很多账号的
 *     撒网；重启清零无妨——它只是速度限制。
 *   * **按 principal 的失败计数**，落库（`identity_lockouts`，迁移
 *     `identity_hardening`）。连续 5 次失败后锁 1 分钟，此后每多一次失败翻倍，
 *     封顶 15 分钟；锁着的时候不校验口令，直接拒。成功一次清零；最后一次失败
 *     一小时之后也清零。
 *
 * **不泄露存在性**：键是调用方报上来的 principal 标识，不管它存不存在都照样计数
 * 和锁定；不存在的账号被锁的样子和存在的一模一样。
 */

export const LOCK_THRESHOLD = 5;
export const LOCK_BASE_MS = 60 * 1000;
export const LOCK_MAX_MS = 15 * 60 * 1000;
/** 最后一次失败之后多久，计数不再累计。 */
export const FAILURE_WINDOW_MS = 60 * 60 * 1000;

export const IP_BUCKET_CAPACITY = 20;
export const IP_BUCKET_WINDOW_MS = 60 * 1000;
/** 内存桶表的上限；满了先丢掉已经回满的桶。 */
const MAX_BUCKETS = 10_000;

/** 第 `failures` 次失败之后该锁多久；不到阈值是 0。 */
export function lockDurationMs(failures: number): number {
  if (failures < LOCK_THRESHOLD) return 0;
  const doublings = Math.min(failures - LOCK_THRESHOLD, 16);
  return Math.min(LOCK_BASE_MS * 2 ** doublings, LOCK_MAX_MS);
}

export function principalKey(principalId: string): string {
  return `principal:${principalId}`;
}

interface Bucket {
  tokens: number;
  atMs: number;
}

/** 按来源 IP 的令牌桶：容量 20，一分钟回满。 */
export class IpBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity = IP_BUCKET_CAPACITY,
    private readonly windowMs = IP_BUCKET_WINDOW_MS,
  ) {}

  /** 拿一个令牌；拿不到时答还要等多久。空 IP（拿不到来源）不限。 */
  take(ip: string, nowMs: number): { ok: boolean; retryAfterMs: number } {
    if (ip === "") return { ok: true, retryAfterMs: 0 };
    const rate = this.capacity / this.windowMs;
    const bucket = this.buckets.get(ip) ?? {
      tokens: this.capacity,
      atMs: nowMs,
    };
    const elapsed = Math.max(0, nowMs - bucket.atMs);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * rate);
    bucket.atMs = nowMs;
    if (bucket.tokens < 1) {
      this.buckets.set(ip, bucket);
      return { ok: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / rate) };
    }
    bucket.tokens -= 1;
    this.buckets.set(ip, bucket);
    if (this.buckets.size > MAX_BUCKETS) this.prune(nowMs);
    return { ok: true, retryAfterMs: 0 };
  }

  private prune(nowMs: number): void {
    const rate = this.capacity / this.windowMs;
    for (const [ip, bucket] of this.buckets) {
      if (bucket.tokens + (nowMs - bucket.atMs) * rate >= this.capacity) {
        this.buckets.delete(ip);
      }
    }
  }
}

export interface LockoutView {
  readonly key: string;
  readonly principalId: string;
  readonly failures: number;
  readonly lockedUntilMs: number;
}

export function rateLimited(retryAfterMs: number): IdentityRefusal {
  return new IdentityRefusal(
    "permission",
    429,
    "rate_limited",
    "Too many sign-in attempts from this address; try again later",
    retryAfterMs,
  );
}

export function accountLocked(retryAfterMs: number): IdentityRefusal {
  return new IdentityRefusal(
    "permission",
    429,
    "account_locked",
    "Too many failed sign-in attempts; try again later",
    retryAfterMs,
  );
}

export class Throttle {
  private readonly ips = new IpBuckets();

  constructor(
    private readonly store: IdentityStore,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** 来源 IP 这一层；每次匿名登录类请求都先过它。 */
  admitIp(ip: string): void {
    const verdict = this.ips.take(ip, this.clock());
    if (!verdict.ok) throw rateLimited(verdict.retryAfterMs);
  }

  /** 这个键现在锁着吗；锁着就抛，不校验凭据。 */
  admitKey(key: string): void {
    const now = this.clock();
    const row = this.store.transaction((tx) => tx.lockout(key));
    if (row !== undefined && row.lockedUntilMs > now) {
      throw accountLocked(row.lockedUntilMs - now);
    }
  }

  /**
   * 记一次失败。返回这次是否**新上了锁**（调用方据此写一条 `identity.lockout`
   * 审计）与锁到什么时候。
   */
  failure(key: string): {
    failures: number;
    lockedUntilMs: number;
    engaged: boolean;
  } {
    const now = this.clock();
    return this.store.transaction((tx) => this.failureIn(tx, key, now));
  }

  failureIn(
    tx: IdentityTx,
    key: string,
    now: number,
  ): { failures: number; lockedUntilMs: number; engaged: boolean } {
    const row = tx.lockout(key);
    const stale =
      row === undefined ||
      (row.lockedUntilMs <= now && now - row.updatedAtMs > FAILURE_WINDOW_MS);
    const failures = (stale ? 0 : row.failures) + 1;
    const duration = lockDurationMs(failures);
    const lockedUntilMs = duration > 0 ? now + duration : 0;
    const next: LockoutRow = { key, failures, lockedUntilMs, updatedAtMs: now };
    tx.putLockout(next);
    // 顺手清掉早就冷了的行：不存在的账号也会留下行，它们不该一直攒着。
    tx.pruneLockouts(now - 24 * 60 * 60 * 1000);
    return { failures, lockedUntilMs, engaged: duration > 0 };
  }

  success(key: string): void {
    this.store.transaction((tx) => tx.deleteLockout(key));
  }

  /** owner 在安全页解锁。返回原来是否锁着。 */
  unlock(key: string): boolean {
    const now = this.clock();
    return this.store.transaction((tx) => {
      const row = tx.lockout(key);
      tx.deleteLockout(key);
      return row !== undefined && row.lockedUntilMs > now;
    });
  }

  /** 现在锁着的那些。 */
  active(): LockoutView[] {
    const now = this.clock();
    return this.store
      .transaction((tx) => tx.activeLockouts(now))
      .map((row) => ({
        key: row.key,
        principalId: row.key.startsWith("principal:")
          ? row.key.slice("principal:".length)
          : "",
        failures: row.failures,
        lockedUntilMs: row.lockedUntilMs,
      }));
  }
}
