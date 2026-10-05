/**
 * 重连退避：全抖动指数退避。第 n 次（从 0 起）重试前等待的上限是
 * `min(capMs, baseMs × 2ⁿ)`，实际等待取 0 到该上限之间的均匀随机值——
 * 一批客户端同时掉线时不会在同一时刻一起撞回来。
 *
 * 所有 WebSocket 重连都用这一份（工作空间事件流、终端、实时协同、浏览器画面），
 * 各条连接只传自己的起步值与封顶值。
 */
export interface BackoffOptions {
  /** 第 0 次重试的等待上限（毫秒）。 */
  baseMs: number;
  /** 等待上限的封顶（毫秒）。 */
  capMs: number;
  /** 取 [0, 1) 的随机数；测试注入固定值。 */
  random?: () => number;
}

/** 第 `attempt` 次重试的等待上限（抖动之前）。 */
export function backoffCeiling(
  attempt: number,
  { baseMs, capMs }: Pick<BackoffOptions, "baseMs" | "capMs">,
): number {
  // 指数先压到 30 以内：再大早已被封顶，也避免 2 ** n 溢出成 Infinity。
  const exponent = Math.min(Math.max(0, Math.floor(attempt)), 30);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

/** 第 `attempt` 次重试前等多久：上限内的全抖动随机值。 */
export function backoffDelay(attempt: number, options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  return Math.floor(backoffCeiling(attempt, options) * random());
}

export interface Backoff {
  /** 取下一次等待时长并把计数加一。 */
  next(): number;
  /** 连接打开过就归零，下一次从起步值重新算。 */
  reset(): void;
  /** 已经取过几次（自上次归零起）。 */
  readonly attempt: number;
}

/** 带计数的退避：`next()` 取时长，连上之后 `reset()`。 */
export function createBackoff(options: BackoffOptions): Backoff {
  let attempt = 0;
  return {
    next() {
      const delay = backoffDelay(attempt, options);
      attempt += 1;
      return delay;
    },
    reset() {
      attempt = 0;
    },
    get attempt() {
      return attempt;
    },
  };
}
