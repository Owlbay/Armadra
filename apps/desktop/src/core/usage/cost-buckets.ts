/**
 * 桶、键和 token 计数的原语。
 *
 * 这些东西被扫描器（`cost.ts`）和每个 agent 的采集适配器（`cost-sources.ts`）同时
 * 用到，放在这里让依赖只有一个方向：`cost.ts` → `cost-sources.ts` → 这里。
 */

import type { AgentId } from "../agent/registry";

/** Token 计数。`input` 在两家都**不含**缓存读，所以四个桶永远不重复计。 */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * 成本行的单位。绝大多数来源按 token 计；Copilot 只留下 premium request 的
 * 累计数，按请求计，不折算成 token 或金额（设计 `cli-collaboration.md` §10）。
 */
export type CostUnit = "tokens" | "premiumRequests";

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

export function addTokens(target: TokenTotals, other: TokenTotals): void {
  target.input += other.input;
  target.output += other.output;
  target.cacheRead += other.cacheRead;
  target.cacheCreation += other.cacheCreation;
}

export function totalTokens(tokens: TokenTotals): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

export function isEmptyTokens(tokens: TokenTotals): boolean {
  return totalTokens(tokens) === 0;
}

/**
 * 桶的键是 `日期 + NUL + agent + NUL + 模型`。分隔符用 NUL 而不是空格或冒号：模型
 * id 和 agent id 里可以有那些字符，用它们分隔会让两组不同的 (日期, agent, 模型)
 * 拼出同一个键。
 *
 * 小时桶用同一个函数，第一段换成 `YYYY-MM-DDTHH`。
 */
const KEY_SEPARATOR = "\u0000";

export function bucketKey(date: string, agent: string, model: string): string {
  return `${date}${KEY_SEPARATOR}${agent}${KEY_SEPARATOR}${model}`;
}

export function splitKey(key: string): {
  date: string;
  agent: string;
  model: string;
} {
  const first = key.indexOf(KEY_SEPARATOR);
  const afterFirst = first + KEY_SEPARATOR.length;
  const second = key.indexOf(KEY_SEPARATOR, afterFirst);
  return {
    date: key.slice(0, first),
    agent: key.slice(afterFirst, second),
    model: key.slice(second + KEY_SEPARATOR.length),
  };
}

/** 小时桶只保留最近这么长时间；更旧的键在每趟扫描的汇总里被清掉。 */
export const HOUR_WINDOW_MS = 48 * 60 * 60_000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 一行的时间戳；读不出来就算现在——它是一个正在跑的会话写的。 */
export function stampMs(timestamp: unknown, nowMs: number): number {
  const parsed =
    typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : nowMs;
}

export function dateAt(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function hourAt(ms: number): string {
  return `${dateAt(ms)}T${pad(new Date(ms).getHours())}`;
}

/** 一个 RFC 3339 时间戳 → 它落在的本地 `YYYY-MM-DD`。 */
export function localDate(timestamp: unknown, nowMs: number): string {
  return dateAt(stampMs(timestamp, nowMs));
}

/** 同上，精到本地小时：`YYYY-MM-DDTHH`。 */
export function localHour(timestamp: unknown, nowMs: number): string {
  return hourAt(stampMs(timestamp, nowMs));
}

/** 一趟扫描里一个文件记住的东西。行的原文一个字节都不在里面。 */
export interface FileState {
  agent: AgentId;
  len: number;
  mtimeMs: number;
  offset: number;
  modifiedMs: number;
  model: string | undefined;
  buckets: Map<string, TokenTotals>;
  /** 只有最近 {@link HOUR_WINDOW_MS} 的行进这里。 */
  hourBuckets: Map<string, TokenTotals>;
  /**
   * 按请求计的来源（Copilot）：会话累计值读到的最后一个。token 来源没有这个字段。
   */
  requests?: number;
  /** 每条累计值相对上一条的增量，记在那一条自己的时间点上。键同 `buckets`。 */
  requestBuckets?: Map<string, number>;
  /** 同上，只有最近 {@link HOUR_WINDOW_MS}。 */
  requestHourBuckets?: Map<string, number>;
  /**
   * CLI 自己报的美元成本（OpenCode 的 `message.cost`），键同 `buckets`。价格表认
   * 不出模型时汇总拿它兜底，见 `cost.ts::windowFrom`。别的来源没有这个字段。
   */
  reportedCost?: Map<string, number>;
  /** 同上，只有最近 {@link HOUR_WINDOW_MS}。 */
  reportedHourCost?: Map<string, number>;
}

export function addToBucket(
  buckets: Map<string, TokenTotals>,
  key: string,
  tokens: TokenTotals,
): void {
  const bucket = buckets.get(key) ?? emptyTokens();
  addTokens(bucket, tokens);
  buckets.set(key, bucket);
}

/** 一行的 token 记进它的日桶，够新的话再记进它的小时桶。 */
export function record(
  state: FileState,
  model: string,
  timestamp: unknown,
  tokens: TokenTotals,
  nowMs: number,
): void {
  const at = stampMs(timestamp, nowMs);
  addToBucket(state.buckets, bucketKey(dateAt(at), state.agent, model), tokens);
  if (at < nowMs - HOUR_WINDOW_MS) return;
  addToBucket(
    state.hourBuckets,
    bucketKey(hourAt(at), state.agent, model),
    tokens,
  );
}

/** CLI 自己报的这一条的美元成本，记进与 {@link record} 同一个日桶 / 小时桶键。 */
export function recordReportedCost(
  state: FileState,
  model: string,
  timestamp: unknown,
  cost: number,
  nowMs: number,
): void {
  if (!(cost > 0)) return;
  const at = stampMs(timestamp, nowMs);
  const days = (state.reportedCost ??= new Map());
  const dayKey = bucketKey(dateAt(at), state.agent, model);
  days.set(dayKey, (days.get(dayKey) ?? 0) + cost);
  if (at < nowMs - HOUR_WINDOW_MS) return;
  const hours = (state.reportedHourCost ??= new Map());
  const hourKey = bucketKey(hourAt(at), state.agent, model);
  hours.set(hourKey, (hours.get(hourKey) ?? 0) + cost);
}

/**
 * 一条会话累计的请求数：只把比上一条多出来的那部分记到这一条的时间点上，
 * `state.requests` 停在这一条的值。累计值变小说明会话从头计了，这一条整段算新的。
 */
export function recordRequests(
  state: FileState,
  model: string,
  timestamp: unknown,
  total: number,
  nowMs: number,
): void {
  const previous = state.requests ?? 0;
  const delta = total >= previous ? total - previous : total;
  state.requests = total;
  if (delta <= 0) return;
  const at = stampMs(timestamp, nowMs);
  const days = (state.requestBuckets ??= new Map());
  const dayKey = bucketKey(dateAt(at), state.agent, model);
  days.set(dayKey, (days.get(dayKey) ?? 0) + delta);
  if (at < nowMs - HOUR_WINDOW_MS) return;
  const hours = (state.requestHourBuckets ??= new Map());
  const hourKey = bucketKey(hourAt(at), state.agent, model);
  hours.set(hourKey, (hours.get(hourKey) ?? 0) + delta);
}

/** 掉出 48 小时窗口的小时键。日桶不动——看板的 30 天轴要它们。 */
export function pruneHours(state: FileState, nowMs: number): void {
  const oldest = hourAt(nowMs - HOUR_WINDOW_MS);
  for (const hours of [
    state.hourBuckets,
    state.requestHourBuckets,
    state.reportedHourCost,
  ]) {
    if (hours === undefined || hours.size === 0) continue;
    for (const key of [...hours.keys()]) {
      if (splitKey(key).date < oldest) hours.delete(key);
    }
  }
}

/**
 * 一个 request id 的 53 位摘要。
 *
 * 去重集合存的是这个数字而不是那个字符串。重度用户一趟扫描见到七万多个 id，每个
 * 三十多个字符——留着原文是二十多兆，留摘要是两三兆，而集合被问的问题只有「见过
 * 没有」。
 *
 * 代价是碰撞：两个不同的 id 撞到同一个数字时，后来那一行被当成重复丢掉。七万个
 * 值落在 2^53 上，生日问题给出的概率约 4×10⁻⁷——比「记录文件在扫描中途被轮转」
 * 之类的事件低好几个数量级，而它换来的是二十兆常驻内存。
 *
 * FNV-1a 的 32 位变体跑两遍（正序与反序、不同的种子），拼成 53 位里的高低两半。
 */
export function digest(value: string): number {
  let forward = 0x811c9dc5;
  let backward = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    forward = Math.imul(forward ^ value.charCodeAt(i), 0x01000193);
    backward = Math.imul(
      backward ^ value.charCodeAt(value.length - 1 - i),
      0x85ebca6b,
    );
  }
  // 两个 32 位拼成 53 位以内的一个安全整数：高 21 位 + 低 32 位。
  return (forward >>> 11) * 0x100000000 + (backward >>> 0);
}
