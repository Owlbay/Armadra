/**
 * Claude 额度窗口的本地估算（R-70）。
 *
 * `usage.claudeUsage` 关着时（出站政策缺省关，外部服务 §9.3）core 不读 Claude
 * 的登录令牌、不问额度端点，于是那一家只剩 `policy_off`。这里拿成本扫描器已经
 * 读过的那份 Claude 转录——同一批桶，不再开一次文件——在 5 小时与 7 天两个窗口
 * 里累计 token，作为一个**估算**挂在快照上：
 *
 *   * 5 小时窗口照 CLI 的做法，从窗口外的第一条活动所在的整点开始，持续 5 小时；
 *     超过之后下一条活动开新窗口。最近一个窗口已经结束就报一个从当前整点开始、
 *     用量为零、没有结束时刻的窗口。小时桶只保留 48 小时，够用。
 *   * 7 天窗口按本地日历日滚动：含今天在内的 7 个本地日。日桶是全部历史。
 *   * `used` 计输入、输出与缓存写；缓存读不计——它在一份长会话里是其余三项的几十
 *     倍，计进去这个数字就只剩缓存读。
 *   * `limit` 只在调用方知道这一档的额度时才有；不知道就只报用量，不编百分比。
 *
 * 到达 API 的只有时间与计数，和成本汇总同一条规矩。
 */

import { dateAt, splitKey, type TokenTotals } from "./cost-buckets";

export const FIVE_HOUR_MS = 5 * 60 * 60_000;
export const SEVEN_DAYS = 7;

export type LocalWindowKey = "five_hour" | "seven_day";

export interface LocalWindowEstimate {
  readonly key: LocalWindowKey;
  /** 单位缩写，和额度窗口同一套 i18n 键（`usage.window.5h` / `7d`）。 */
  readonly label: "5h" | "7d";
  readonly windowStartMs: number;
  /** 进行中的 5 小时窗口在这一刻结束；空闲的 5 小时窗口与滚动的 7 天窗口没有。 */
  readonly resetsAtMs?: number;
  /** 输入 + 输出 + 缓存写，token。 */
  readonly used: number;
  readonly limit?: number;
}

export interface LocalWindowEstimates {
  readonly source: "local";
  readonly windows: readonly LocalWindowEstimate[];
}

export type LocalWindowLimits = Partial<Record<LocalWindowKey, number>>;

/** 成本扫描器的两组桶，键是 `bucketKey(日期或小时, agent, 模型)`。 */
export interface ScannedBuckets {
  readonly buckets: ReadonlyMap<string, TokenTotals>;
  readonly hourBuckets: ReadonlyMap<string, TokenTotals>;
}

function counted(tokens: TokenTotals): number {
  return tokens.input + tokens.output + tokens.cacheCreation;
}

/** 本地 `YYYY-MM-DDTHH` → 那个整点的毫秒；读不出来是 `undefined`。 */
export function hourStartMs(key: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(key);
  if (match === null) return undefined;
  const [, y, m, d, h] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(y, m - 1, d, h).getTime();
}

function floorHour(ms: number): number {
  const date = new Date(ms);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
  ).getTime();
}

function limited(
  key: LocalWindowKey,
  limits: LocalWindowLimits | undefined,
): { limit?: number } {
  const limit = limits?.[key];
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? { limit }
    : {};
}

export function fiveHourWindow(
  scan: ScannedBuckets,
  agent: string,
  nowMs: number,
  limits?: LocalWindowLimits,
): LocalWindowEstimate {
  const perHour = new Map<number, number>();
  for (const [key, tokens] of scan.hourBuckets) {
    const parts = splitKey(key);
    if (parts.agent !== agent) continue;
    const at = hourStartMs(parts.date);
    if (at === undefined || at > nowMs) continue;
    const value = counted(tokens);
    if (value <= 0) continue;
    perHour.set(at, (perHour.get(at) ?? 0) + value);
  }
  let start: number | undefined;
  for (const at of [...perHour.keys()].sort((a, b) => a - b)) {
    if (start === undefined || at >= start + FIVE_HOUR_MS) start = at;
  }
  const extra = limited("five_hour", limits);
  if (start === undefined || nowMs >= start + FIVE_HOUR_MS) {
    // 下一条活动才开窗口，所以没有结束时刻。
    return {
      key: "five_hour",
      label: "5h",
      windowStartMs: floorHour(nowMs),
      used: 0,
      ...extra,
    };
  }
  let used = 0;
  for (const [at, value] of perHour) if (at >= start) used += value;
  return {
    key: "five_hour",
    label: "5h",
    windowStartMs: start,
    resetsAtMs: start + FIVE_HOUR_MS,
    used,
    ...extra,
  };
}

export function sevenDayWindow(
  scan: ScannedBuckets,
  agent: string,
  nowMs: number,
  limits?: LocalWindowLimits,
): LocalWindowEstimate {
  const today = new Date(nowMs);
  const startMs = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - (SEVEN_DAYS - 1),
  ).getTime();
  const first = dateAt(startMs);
  const last = dateAt(nowMs);
  let used = 0;
  for (const [key, tokens] of scan.buckets) {
    const parts = splitKey(key);
    if (parts.agent !== agent) continue;
    if (parts.date < first || parts.date > last) continue;
    used += counted(tokens);
  }
  return {
    key: "seven_day",
    label: "7d",
    windowStartMs: startMs,
    used,
    ...limited("seven_day", limits),
  };
}

/** 一家 agent 的两个估算窗口。 */
export function estimateLocalWindows(
  scan: ScannedBuckets,
  agent: string,
  nowMs: number,
  limits?: LocalWindowLimits,
): LocalWindowEstimates {
  return {
    source: "local",
    windows: [
      fiveHourWindow(scan, agent, nowMs, limits),
      sevenDayWindow(scan, agent, nowMs, limits),
    ],
  };
}
