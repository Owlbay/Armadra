/**
 * 本地成本统计。移植自 合并前的实现。
 *
 * Claude 和 Codex 都在磁盘上留下带每次请求 token 数的 JSONL 记录。这个模块把它们
 * 变成今天 / 近 30 天 / 当前会话的总数，加上按天、按模型的拆分，**全部在这台机器上**。
 *
 * 用量模块的三条规矩在这里也成立，外加一条：
 *
 *   * **没有一行记录文本离开扫描器。** 提示词、回复、会话 id 和项目路径被读过就
 *     丢掉。到达 API 的是计数、模型 id 和日期。
 *   * 没有价格的模型**只显示 token**。不会从一个名字相近的模型估价——见
 *     {@link priceFor}。一个错的美元数字比没有更糟。
 *   * 扫描被节流：后台一趟 5 分钟，用户发起的刷新 30 秒。
 *
 * ## 增量
 *
 * 每个文件之间记着自己的长度、mtime 和字节偏移，只解析追加的那部分。一个变**短**
 * 的文件意味着记录被轮转或者重写过，于是整个缓存被丢掉重建——单独重解析那一个文件
 * 会被请求 id 的去重悄悄吃掉。
 */

import { readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { join } from "node:path";

import { AGENT_IDS, type AgentId } from "../agent/registry";
import { HISTORY_ADAPTERS } from "../history/registry";
import type { CostSample } from "../history/types";
import {
  addToBucket,
  addTokens,
  dateAt,
  emptyTokens,
  hourAt,
  isEmptyTokens,
  pruneHours,
  record as recordTokens,
  recordReportedCost,
  splitKey,
  totalTokens,
  type CostUnit,
  type FileState,
  type TokenTotals,
} from "./cost-buckets";
import { COST_SOURCES, costSource, type AbsorbContext } from "./cost-sources";
import type { ScannedBuckets } from "./local-window";

export {
  addTokens,
  bucketKey,
  digest,
  emptyTokens,
  isEmptyTokens,
  localDate,
  localHour,
  splitKey,
  totalTokens,
} from "./cost-buckets";
export type { CostUnit, FileState, TokenTotals } from "./cost-buckets";
export { COST_SOURCES, costSource } from "./cost-sources";
export type { AgentCostSource } from "./cost-sources";

/** 看板的滚动窗口，含当天。 */
export const WINDOW_DAYS = 30;
/** 两次后台扫描之间的最短间隔。 */
export const MIN_SCAN_INTERVAL_MS = 5 * 60_000;
/** 用户发起的刷新可以快四倍。 */
export const MANUAL_COOLDOWN_MS = 30_000;
/**
 * 一次扫描肯打开多少个记录文件的上限。重度用户有几千个；在一个五分钟的定时器上
 * 走完所有的不值得，而看板的 30 天窗口要的是最新的那些。
 */
export const MAX_FILES = 4_000;

/**
 * How many transcript lines are parsed before the scanner yields to the event
 * loop. A machine that has used the CLIs for a while holds a gigabyte of
 * transcripts, and one file alone can pass eighty megabytes; parsing that in
 * one synchronous stretch held the core's loop for fifteen seconds — long
 * enough for the shell's SIGTERM to time out and for every request from the
 * page to look like a dead service. Yielding this often keeps a single stall
 * in the low milliseconds.
 */
export const LINES_PER_YIELD = 500;
/** 目录遍历深度。Claude 嵌一层，Codex 三层；六层留了余量又不会走进无关的树。 */
const MAX_DEPTH = 6;

export interface ModelCost {
  readonly model: string;
  readonly tokens: TokenTotals;
  /** 模型没有价格时是 `null`。UI 于是只显示 token。 */
  readonly costUsd: number | null;
}

export interface CostWindow {
  readonly tokens: TokenTotals;
  /** 只对**有**价格的模型求和。永远不是没价格那些的替身——`complete` 说有没有缺。 */
  readonly costUsd: number;
  readonly complete: boolean;
  readonly models: readonly ModelCost[];
}

export interface DailyCost extends CostWindow {
  /** 本地 `YYYY-MM-DD`。 */
  readonly date: string;
}

export interface SessionCost {
  readonly provider: string;
  readonly models: readonly string[];
  readonly tokens: TokenTotals;
  readonly costUsd: number;
  readonly complete: boolean;
  readonly updatedAt: string;
}

export type CostStatus = "ok" | "disabled" | "unavailable";

/** `none` = 这家 agent 目前没有任何本地来源，token 一律是零而不是一个估数。 */
export type CostAgentSource = "local" | "none";

/**
 * 一家 agent 在一个窗口里的用量（契约 §12.1）。
 *
 * `unit` 是 `"premiumRequests"` 时用量在 `requests`，`tokens` 是零、`costUsd` 是
 * 0、`complete` 为真——请求数不折算成金额（设计 `cli-collaboration.md` §10）。
 * `"tokens"` 的行 `requests` 是 0。
 */
export interface AgentCost {
  readonly agent: AgentId;
  readonly unit: CostUnit;
  readonly tokens: TokenTotals;
  readonly requests: number;
  readonly costUsd: number;
  readonly complete: boolean;
  readonly source: CostAgentSource;
}

/** 时间轴上的一个点。`key` 是本地 `YYYY-MM-DDTHH` 或本地 `YYYY-MM-DD`。 */
export interface CostPoint extends CostWindow {
  readonly key: string;
  /** 只有这个点里真有 token 的 agent，按注册表顺序。 */
  readonly agents: readonly AgentCost[];
  /** 这个点里有活动的转录文件数——一个文件就是一个会话。 */
  readonly sessions: number;
}

export type CostRangeKey = "24h" | "7d" | "30d" | "all";

export interface CostRange {
  readonly granularity: "hour" | "day";
  /** 由旧到新、连续、零填充。 */
  readonly points: readonly CostPoint[];
  readonly totals: CostWindow;
  readonly byModel: readonly ModelCost[];
  /** 注册表里的每个 agent，按注册表顺序，没有本地来源的也在。 */
  readonly byAgent: readonly AgentCost[];
  readonly peak: {
    readonly key: string;
    readonly tokens: TokenTotals;
    readonly costUsd: number;
  } | null;
  readonly activeIntervals: number;
  readonly longestStreak: number;
  /** 整个范围里有活动的转录文件数，去重。 */
  readonly sessions: number;
}

export type CostRanges = Readonly<Record<CostRangeKey, CostRange>>;

export interface CostSummary {
  readonly status: CostStatus;
  readonly today: CostWindow;
  readonly last30Days: CostWindow;
  readonly currentSession?: SessionCost;
  /** 最旧的在前，含今天共 {@link WINDOW_DAYS} 条。没有活动的那天也在，带零。 */
  readonly daily: readonly DailyCost[];
  /** 同一批桶的四种切法。`daily` 之外的维度都在这里。 */
  readonly ranges: CostRanges;
  /** 窗口里见过但没有价格的模型。报出来好让看板解释一个看起来偏低的总数。 */
  readonly unpricedModels: readonly string[];
  /** 每家供应商贡献了几个记录文件。 */
  readonly files: Readonly<Record<string, number>>;
  /** 文件数上限被顶到、更旧的记录被跳过了。 */
  readonly truncated: boolean;
  readonly scannedAt: string | null;
  readonly refreshAvailableAt: string | null;
}

function emptyWindow(): CostWindow {
  return { tokens: emptyTokens(), costUsd: 0, complete: true, models: [] };
}

/** 声明了快照式成本的那几家（OpenCode）。 */
const SNAPSHOT_AGENTS: ReadonlySet<string> = new Set(
  HISTORY_ADAPTERS.flatMap((adapter) =>
    adapter.cost?.kind === "snapshot" ? [adapter.agentId] : [],
  ),
);

function sourceOf(agent: AgentId): CostAgentSource {
  return costSource(agent) !== undefined || SNAPSHOT_AGENTS.has(agent)
    ? "local"
    : "none";
}

/**
 * 这家的成本行按什么计：逐行来源自己声明；快照式来源与没有来源的按 token。
 */
function unitOf(agent: AgentId): CostUnit {
  return costSource(agent)?.unit ?? "tokens";
}

function emptyRange(granularity: "hour" | "day"): CostRange {
  return {
    granularity,
    points: [],
    totals: emptyWindow(),
    byModel: [],
    byAgent: AGENT_IDS.map((agent) => ({
      agent,
      unit: unitOf(agent),
      tokens: emptyTokens(),
      requests: 0,
      costUsd: 0,
      complete: true,
      source: sourceOf(agent),
    })),
    peak: null,
    activeIntervals: 0,
    longestStreak: 0,
    sessions: 0,
  };
}

export function emptyRanges(): CostRanges {
  return {
    "24h": emptyRange("hour"),
    "7d": emptyRange("day"),
    "30d": emptyRange("day"),
    all: emptyRange("day"),
  };
}

export function emptySummary(status: CostStatus): CostSummary {
  return {
    status,
    today: emptyWindow(),
    last30Days: emptyWindow(),
    daily: [],
    ranges: emptyRanges(),
    unpricedModels: [],
    files: {},
    truncated: false,
    scannedAt: null,
    refreshAvailableAt: null,
  };
}

/* --------------------------------- 价格表 --------------------------------- */

export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** 缓存读是输入的十分之一，5 分钟缓存写是 1.25×，所以每行只写两个头条数字。 */
function standard(input: number, output: number): ModelPrice {
  return {
    input,
    output,
    cacheRead: input / 10,
    cacheWrite: input * 1.25,
  };
}

function withCacheRead(
  input: number,
  output: number,
  cacheRead: number,
): ModelPrice {
  return { input, output, cacheRead, cacheWrite: input * 1.25 };
}

/**
 * 一行 OpenAI。那边的提示缓存**不按写计费**——一个被缓存的前缀在被读时打折、创建它
 * 不花钱——所以 `cacheWrite` 是零而不是 Anthropic 的 1.25×。把 Anthropic 的惯例搬
 * 过去会凭空发明一笔费用。
 */
function openai(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite: 0 };
}

/**
 * 每百万 token 多少美元。和 合并前的实现 的内建表逐行
 * 一致——同一台机器在两种 core 下必须算出同一个数字。
 */
export const BUILT_IN_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": withCacheRead(10, 50, 0.25),
  "claude-mythos-5-1": withCacheRead(10, 50, 0.25),
  "claude-fable-5": withCacheRead(10, 50, 1),
  "claude-mythos-5": withCacheRead(10, 50, 1),
  "claude-opus-5": standard(5, 25),
  "claude-opus-4-8": standard(5, 25),
  "claude-opus-4-7": standard(5, 25),
  "claude-opus-4-6": standard(5, 25),
  "claude-sonnet-5": standard(2, 10),
  "claude-sonnet-4-6": standard(3, 15),
  "claude-haiku-4-5": standard(1, 5),
  "gpt-5-codex": openai(1.25, 10, 0.125),
  "gpt-5": openai(1.25, 10, 0.125),
  "gpt-5-mini": openai(0.25, 2, 0.025),
  "gpt-5-nano": openai(0.05, 0.4, 0.005),
  "codex-mini-latest": openai(1.5, 6, 0.375),
  o3: openai(2, 8, 0.5),
  "o4-mini": openai(1.1, 4.4, 0.275),
};

/**
 * `claude-opus-4-5-20251101` → `claude-opus-4-5`。带日期的快照落回它不带日期的 id，
 * 那是目录给它们起的名字。
 */
export function undated(model: string): string | undefined {
  const index = model.lastIndexOf("-");
  if (index <= 0) return undefined;
  const head = model.slice(0, index);
  const tail = model.slice(index + 1);
  if (/^\d{8}$/.test(tail)) return head;
  // `-YYYY-MM-DD`：三段，从后往前检查，这样一次部分匹配（`gpt-5-mini`、`o4-mini`）
  // 会落空而不是被截断。
  if (!/^\d{2}$/.test(tail)) return undefined;
  const second = head.lastIndexOf("-");
  if (second <= 0 || !/^\d{2}$/.test(head.slice(second + 1))) return undefined;
  const third = head.slice(0, second).lastIndexOf("-");
  if (third <= 0) return undefined;
  const year = head.slice(0, second).slice(third + 1);
  return /^\d{4}$/.test(year)
    ? head.slice(0, second).slice(0, third)
    : undefined;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

/**
 * 查价时按顺序问的那几张表。
 *
 * 三级回退：**内置 → 目录 → 未定价**。内置表在前，因为它是和 Rust Runtime 逐行
 * 对过的那一份，同一台机器在两种实现下必须算出同一个数字；models.dev 的目录在
 * 后，它覆盖的是内置表里没有的那些模型（新发布的、别家的）。一个模型两张表都
 * 没有就是**没有价格**，看板只显示它的 token——从一个名字相近的模型估价，比不
 * 报价更糟。
 */
export type PriceLookup = PriceTable | readonly PriceTable[];

function tablesOf(lookup: PriceLookup): readonly PriceTable[] {
  return Array.isArray(lookup)
    ? (lookup as readonly PriceTable[])
    : [lookup as PriceTable];
}

/**
 * 一个记录里写的模型 id 的价格。不在表里的模型**完全没有成本**——看板只显示它的
 * token。**永远不从一个名字相近的模型估**。
 *
 * 每张表都先按原名查、再按去掉日期的名字查，然后才轮到下一张：一个带日期的快照
 * 命中内置表的不带日期条目，仍然算内置表答的，目录不该把它顶掉。
 */
export function priceFor(
  lookup: PriceLookup,
  model: string,
): ModelPrice | undefined {
  const fallback = undated(model);
  for (const table of tablesOf(lookup)) {
    const direct = table[model];
    if (direct !== undefined) return direct;
    if (fallback !== undefined && table[fallback] !== undefined) {
      return table[fallback];
    }
  }
  return undefined;
}

/** 一桶 token 值多少美元。 */
export function costOf(price: ModelPrice, tokens: TokenTotals): number {
  const million = 1_000_000;
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheCreation * price.cacheWrite) /
    million
  );
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/* --------------------------------- 扫描 ---------------------------------- */

export interface ScanResult {
  /** `bucketKey(日期, agent, 模型)` → token 数。全部历史，不切窗口。 */
  readonly buckets: Map<string, TokenTotals>;
  /** 同一个形状，第一段是本地小时，只有最近 48 小时。 */
  readonly hourBuckets: Map<string, TokenTotals>;
  /**
   * 按请求计的来源（Copilot）记下的请求增量，键同 `buckets`。没有这类来源时可以
   * 不给。不进 token 桶，也不进 `totals`。
   */
  readonly requestBuckets?: Map<string, number>;
  /** 同上，小时粒度，只有最近 48 小时。 */
  readonly requestHourBuckets?: Map<string, number>;
  /**
   * CLI 自己报的美元成本（快照式来源，OpenCode），键同 `buckets`。只在价格表认
   * 不出模型时用来兜底，见 {@link windowFrom}。
   */
  readonly reportedCost?: Map<string, number>;
  /** 同上，小时粒度，只有最近 48 小时。 */
  readonly reportedHourCost?: Map<string, number>;
  /** 日期或小时 → 在那一格里有活动的文件（一次扫描内的序号）。 */
  readonly sessions: Map<string, Set<number>>;
  readonly files: Record<string, number>;
  truncated: boolean;
  current:
    | {
        agent: AgentId;
        tokens: TokenTotals;
        models: string[];
        updatedMs: number;
        /** CLI 自己报的成本合计（快照式来源）；没有就没有。 */
        reportedCost?: number;
      }
    | undefined;
}

/**
 * 一个快照式成本来源（设计 `cli-collaboration.md` §9 H2）：没有逐行文件，每趟扫描
 * 把某个时间之后的用量一次交齐。
 */
export interface SnapshotSource {
  readonly agentId: AgentId;
  /** 这家的来源（OpenCode 的库文件）还在不在。不在时它的贡献整体作废。 */
  present(): boolean;
  collect(sinceMs: number, ctx: AbsorbContext): readonly CostSample[];
}

/** 从注册表派生：每个声明了 `cost.kind === "snapshot"` 的适配器一项。 */
export function snapshotSources(): SnapshotSource[] {
  return HISTORY_ADAPTERS.flatMap((adapter): SnapshotSource[] => {
    const cost = adapter.cost;
    if (cost?.kind !== "snapshot") return [];
    return [
      {
        agentId: adapter.agentId,
        present: () => adapter.roots().some(exists),
        collect: (sinceMs, ctx) => cost.collect(sinceMs, ctx),
      },
    ];
  });
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 每个有本地来源的 agent 要扫的根目录，见 {@link COST_SOURCES}。 */
export function scanRoots(): [AgentId, string][] {
  const roots: [AgentId, string][] = [];
  for (const source of Object.values(COST_SOURCES)) {
    for (const root of source.roots()) roots.push([source.agentId, root]);
  }
  return roots;
}

/** 深度优先的 `*.jsonl` 遍历。不跟随符号链接的目录。 */
export function collectTranscripts(
  root: string,
  depth = 0,
  out: string[] = [],
): string[] {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      collectTranscripts(path, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * 增量扫描的状态。一次恢复或者分叉的会话会逐字重复行，所以一个 request id 在**整个
 * 扫描**里只被计一次。
 */
/**
 * 一次从磁盘搬进内存多少字节。
 *
 * 曾经这里读的是**整段追加**：一次 `Buffer.allocUnsafe(size - offset)`，再
 * `toString("utf8")`，再 `split("\n")`。一个八十兆的记录因此同时活着三份——缓冲
 * 区、整段字符串、每一行的数组——而第一趟扫描要对一千多个文件各走一遍。量出来
 * 的后果是 RSS 峰值 2.8 GB，而 `heapUsed` 全程不到 15 MB：大头是走了一趟就再也
 * 没还给系统的页，不是任何一个还被引用着的对象。
 *
 * 按块读之后，一个文件在任一时刻只欠这一个缓冲区加上它当前那一行。块大小取
 * 256 KiB：比绝大多数记录行大一个数量级，又小到峰值可以忽略。
 */
export const CHUNK_BYTES = 256 * 1024;

/**
 * 那**一个**读缓冲区。
 *
 * 每个文件自己 `allocUnsafe(CHUNK_BYTES)` 的代价是一千四百个文件 × 256 KiB =
 * 350 MB 的外部分配。没有一份被留下来，但进程也拿不回那些页——量出来成本扫描之
 * 后 RSS 从 92 MB 涨到 507 MB，而 `heapUsed` 只有 15 MB。
 *
 * 一趟扫描里文件是一个接一个走的（{@link CostService.scan} 自己保证同时只有一
 * 趟），所以一个缓冲区够用。租不到的调用者（测试里两个 `ScanState` 并发）自带一
 * 个，正确性不依赖这把锁。
 */
let chunk: Buffer | undefined;

function leaseChunk(): Buffer {
  const leased = chunk ?? Buffer.allocUnsafe(CHUNK_BYTES);
  chunk = undefined;
  return leased;
}

function returnChunk(leased: Buffer): void {
  if (chunk === undefined) chunk = leased;
}

/** `NeedleCursor` 还没被指到任何一块时的空视图。 */
const EMPTY_VIEW = Buffer.alloc(0);

/**
 * 一条行（`view` 的 `[from, to)` 那一段）里有没有任何一个 needle。
 *
 * 每个 needle 记着自己在这一块里的下一个位置，位置落到行首后面才重新找一次——
 * 于是一块里的搜索次数是「命中数 + 1」而不是「行数」，而且**一次分配都没有**。
 * 为一行做一个 `subarray` 再 `includes` 也能算出同一个答案，代价是每行一个对象。
 */
class NeedleCursor {
  private readonly at: number[];

  private view: Buffer = EMPTY_VIEW;

  constructor(private readonly needles: readonly Buffer[]) {
    this.at = needles.map(() => -1);
  }

  /** 换了一块（或者同一块被挪过），重新定位。 */
  reset(view: Buffer, from: number): void {
    this.view = view;
    for (let i = 0; i < this.needles.length; i += 1) {
      this.at[i] = view.indexOf(this.needles[i] as unknown as Uint8Array, from);
    }
  }

  hits(from: number, to: number): boolean {
    for (let i = 0; i < this.needles.length; i += 1) {
      let at = this.at[i] as number;
      if (at !== -1 && at < from) {
        at = this.view.indexOf(this.needles[i] as unknown as Uint8Array, from);
        this.at[i] = at;
      }
      if (at !== -1 && at < to) return true;
    }
    return false;
  }
}

/**
 * `path` 的 `[offset, size)` 按行喂给 `onLine`，返回**完整行**一共占了多少字节。
 *
 * 结尾那条不完整的行不喂也不计数：CLI 可能正写到一半，而半个 JSON 对象解析出来
 * 什么都不是，它留给下一趟。
 *
 * **跨块的那半行留在同一个缓冲区里**，靠 `copyWithin` 挪到开头，下一次读接在它后
 * 面。曾经这里是 `Buffer.from(tail)` / `Buffer.concat([carry, tail])`——每块一次，
 * 五千兆的记录就是两万次几 KB 的分配。量出来那两行值 340 MB：同一趟扫描，把它们
 * 去掉之后 RSS 从 416 MB 回到 77 MB，而循环里其余部分一个字节都没变。
 *
 * 一条比缓冲区还长的行会把缓冲区翻倍（私有的那一份不还进池子）。此后的峰值就是
 * 那一行本身，仍然远小于从前的「整段追加」。
 *
 * 读到一半出错不抛：已经喂出去的行是真的被吃过了，它们的字节必须被计进返回值，
 * 否则下一趟会把同一段再吃一遍（codex 的行没有 request id，去重接不住）。
 *
 * `needles` 在**解码之前**看字节。一份记录里绝大多数行是提示词和工具结果，一个
 * 字节都进不了任何一个桶；让它们连字符串都不变成，省掉的是那一份 JSON.parse。
 */
async function eachAppendedLine(
  path: string,
  offset: number,
  size: number,
  needles: readonly Buffer[],
  onLine: (line: string) => Promise<void> | void,
): Promise<number> {
  if (size <= offset) return 0;
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return 0;
  }
  const leased = leaseChunk();
  let buffer = leased;
  let consumed = 0;
  const cursor = new NeedleCursor(needles);
  try {
    let position = offset;
    // 缓冲区开头那几个字节是上一块结尾那条没读完的行。
    let pending = 0;
    while (position < size) {
      if (pending === buffer.length) {
        // 一条比缓冲区还长的行：翻倍，把已经读到的那一段带过去。
        const grown = Buffer.allocUnsafe(buffer.length * 2);
        buffer.copy(grown, 0, 0, pending);
        buffer = grown;
      }
      const { bytesRead } = await handle.read(
        buffer,
        pending,
        Math.min(buffer.length - pending, size - position),
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      const end = pending + bytesRead;
      const view = buffer.subarray(0, end);
      cursor.reset(view, 0);
      let start = 0;
      for (;;) {
        const newline = view.indexOf(10, start);
        if (newline === -1) break;
        const from = start;
        consumed += newline - start + 1;
        start = newline + 1;
        if (cursor.hits(from, newline)) {
          await onLine(view.toString("utf8", from, newline));
        }
      }
      pending = end - start;
      if (pending > 0 && start > 0) buffer.copyWithin(0, start, end);
      // 每读完一块让一次路。`LINES_PER_YIELD` 数的是**解析过**的行，而一块里可能
      // 一行都没有人要；没有这一下，一个几百兆的文件会把循环占住。
      await yieldToLoop();
    }
  } catch {
    // 读或解析出错就停在这里；已经消费的字节仍然算数。
  } finally {
    returnChunk(leased);
    await handle.close().catch(() => undefined);
  }
  return consumed;
}

export class ScanState {
  private readonly files = new Map<string, FileState>();
  /** 快照式来源的状态，以 `CostSample.key`（`opencode:<id>`）为键。 */
  private readonly snapshots = new Map<string, FileState>();
  /**
   * 每家快照式来源交出过的最大时间戳，下一趟的 `sinceMs`。适配器按「含等于」取，
   * 同一毫秒里已经交过的那些靠 {@link seen} 去重。
   */
  private readonly snapshotSince = new Map<AgentId, number>();
  private readonly seen = new Set<number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * 对每个注册了来源的 agent 的记录树跑一趟。异步，因为文件解析要给事件循环让路。
   *
   * 显式传了 `roots`（测试把逐行来源指向临时目录）而没传 `snapshots` 时，快照式
   * 来源一个都不扫：否则测试会读到开发机上真实的 OpenCode 库。
   */
  async scan(
    roots?: readonly (readonly [AgentId, string])[],
    snapshots?: readonly SnapshotSource[],
  ): Promise<ScanResult> {
    const wantedSnapshots =
      snapshots ?? (roots === undefined ? snapshotSources() : []);
    roots ??= scanRoots();
    const nowMs = this.now();
    const requestBuckets = new Map<string, number>();
    const requestHourBuckets = new Map<string, number>();
    const reportedCost = new Map<string, number>();
    const reportedHourCost = new Map<string, number>();
    const result: ScanResult = {
      buckets: new Map(),
      hourBuckets: new Map(),
      requestBuckets,
      requestHourBuckets,
      reportedCost,
      reportedHourCost,
      sessions: new Map(),
      files: {},
      truncated: false,
      current: undefined,
    };
    const discovered: [AgentId, string][] = [];
    for (const [agent, root] of roots) {
      const paths = collectTranscripts(root);
      result.truncated ||= paths.length >= MAX_FILES;
      result.files[agent] = (result.files[agent] ?? 0) + paths.length;
      for (const path of paths) discovered.push([agent, path]);
    }

    // 一个变短的文件意味着记录被重写过。单独重解析它加不了任何东西（它的 request
    // id 已经在 `seen` 里），所以缓存被丢掉、整棵树重新解析。
    const shortened = discovered.some(([, path]) => {
      const state = this.files.get(path);
      if (state === undefined) return false;
      try {
        return statSync(path).size < state.offset;
      } catch {
        return false;
      }
    });
    if (shortened) {
      // `seen` 一清，快照式来源的去重也没了：它们一起从头收。
      this.files.clear();
      this.snapshots.clear();
      this.snapshotSince.clear();
      this.seen.clear();
    }

    const live = new Set<string>();
    for (const [agent, path] of discovered) {
      live.add(path);
      await this.parse(agent, path);
    }
    // 消失了的文件把它的贡献一起带走。
    for (const path of [...this.files.keys()]) {
      if (!live.has(path)) this.files.delete(path);
    }
    this.collectSnapshots(wantedSnapshots, result);

    let current: FileState | undefined;
    let fileId = 0;
    for (const state of [...this.files.values(), ...this.snapshots.values()]) {
      fileId += 1;
      // 这里清，而不是在 `parse()` 里：一个什么都没被追加的文件早退，它的小时桶也
      // 得跟着时间往前走。
      pruneHours(state, nowMs);
      for (const [key, tokens] of state.buckets) {
        addToBucket(result.buckets, key, tokens);
        addSession(result.sessions, key, fileId);
      }
      for (const [key, tokens] of state.hourBuckets) {
        addToBucket(result.hourBuckets, key, tokens);
        addSession(result.sessions, key, fileId);
      }
      for (const [key, count] of state.requestBuckets ?? []) {
        requestBuckets.set(key, (requestBuckets.get(key) ?? 0) + count);
        addSession(result.sessions, key, fileId);
      }
      for (const [key, count] of state.requestHourBuckets ?? []) {
        requestHourBuckets.set(key, (requestHourBuckets.get(key) ?? 0) + count);
        addSession(result.sessions, key, fileId);
      }
      for (const [key, cost] of state.reportedCost ?? []) {
        reportedCost.set(key, (reportedCost.get(key) ?? 0) + cost);
      }
      for (const [key, cost] of state.reportedHourCost ?? []) {
        reportedHourCost.set(key, (reportedHourCost.get(key) ?? 0) + cost);
      }
      if (state.buckets.size === 0) continue;
      if (current === undefined || state.modifiedMs > current.modifiedMs) {
        current = state;
      }
    }
    if (current !== undefined) {
      const tokens = emptyTokens();
      const models = new Set<string>();
      for (const [key, value] of current.buckets) {
        addTokens(tokens, value);
        models.add(splitKey(key).model);
      }
      let reported = 0;
      for (const cost of current.reportedCost?.values() ?? []) reported += cost;
      result.current = {
        agent: current.agent,
        tokens,
        models: [...models].sort(),
        updatedMs: current.modifiedMs,
        ...(reported > 0 ? { reportedCost: reported } : {}),
      };
    }
    return result;
  }

  /**
   * 快照式来源：从上一趟交出的最大时间戳起收样本，按 `key` 写进各自的状态。
   *
   * 来源不在了（库被删了）时这家的状态与游标一起丢掉，和消失了的文件同一条规矩。
   * `collect` 抛错按这一趟没有新样本算：已经记下的不动，游标不动。
   */
  private collectSnapshots(
    sources: readonly SnapshotSource[],
    result: ScanResult,
  ): void {
    const nowMs = this.now();
    const context: AbsorbContext = { nowMs, seen: this.seen };
    for (const source of sources) {
      const agent = source.agentId;
      if (!source.present()) {
        for (const [key, state] of [...this.snapshots]) {
          if (state.agent === agent) this.snapshots.delete(key);
        }
        this.snapshotSince.delete(agent);
        continue;
      }
      let since = this.snapshotSince.get(agent) ?? 0;
      let samples: readonly CostSample[] = [];
      try {
        samples = source.collect(since, context);
      } catch {
        samples = [];
      }
      for (const sample of samples) {
        let state = this.snapshots.get(sample.key);
        if (state === undefined) {
          state = {
            agent,
            len: 0,
            mtimeMs: 0,
            offset: 0,
            modifiedMs: 0,
            model: undefined,
            buckets: new Map(),
            hourBuckets: new Map(),
          };
          this.snapshots.set(sample.key, state);
        }
        // 毫秒时间戳转成 RFC 3339：桶的时间解析只认字符串，数字会被当成「现在」。
        const at = snapshotMs(sample.timestamp, nowMs);
        const stamp = new Date(at).toISOString();
        recordTokens(state, sample.model, stamp, sample.tokens, nowMs);
        if (sample.reportedCost !== undefined) {
          recordReportedCost(
            state,
            sample.model,
            stamp,
            sample.reportedCost,
            nowMs,
          );
        }
        state.offset = Math.max(state.offset, at);
        state.modifiedMs = Math.max(state.modifiedMs, at);
        if (at > since) since = at;
      }
      this.snapshotSince.set(agent, since);
      let sessions = 0;
      for (const state of this.snapshots.values()) {
        if (state.agent === agent) sessions += 1;
      }
      result.files[agent] = (result.files[agent] ?? 0) + sessions;
    }
  }

  private async parse(agent: AgentId, path: string): Promise<void> {
    const source = costSource(agent);
    if (source === undefined) return;
    let info;
    try {
      info = statSync(path);
    } catch {
      return;
    }
    const mtimeMs = Math.round(info.mtimeMs);
    const state: FileState = this.files.get(path) ?? {
      agent,
      len: 0,
      mtimeMs: 0,
      offset: 0,
      modifiedMs: 0,
      model: undefined,
      buckets: new Map(),
      hourBuckets: new Map(),
    };
    this.files.delete(path);
    // 同样的长度和同样的 mtime 意味着什么都没被追加。
    if (
      state.len === info.size &&
      state.mtimeMs === mtimeMs &&
      state.offset > 0
    ) {
      state.modifiedMs = mtimeMs;
      this.files.set(path, state);
      return;
    }
    state.len = info.size;
    state.mtimeMs = mtimeMs;
    state.modifiedMs = mtimeMs;

    // 只读追加的那一段：从记住的偏移量起。读整个文件再切片会让一个八十兆的记录
    // 每五分钟被完整读一次；按块读还让任一时刻常驻的只有一个 256 KiB 的缓冲区。
    const context: AbsorbContext = { nowMs: this.now(), seen: this.seen };
    let parsed = 0;
    const consumed = await eachAppendedLine(
      path,
      state.offset,
      info.size,
      source.needles,
      async (line) => {
        const trimmed = line.trim();
        if (trimmed === "") return;
        if (++parsed % LINES_PER_YIELD === 0) await yieldToLoop();
        let value: unknown;
        try {
          value = JSON.parse(trimmed);
        } catch {
          return;
        }
        source.absorb(state, value, context);
      },
    );
    // 结尾那条不完整的行留给下一趟。
    state.offset += consumed;
    this.files.set(path, state);
  }
}

/** 样本的时间：毫秒数原样，字符串按 RFC 3339 解析，都读不出来按现在。 */
function snapshotMs(timestamp: unknown, nowMs: number): number {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp;
  }
  const parsed =
    typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : nowMs;
}

/* --------------------------------- 汇总 ---------------------------------- */

/** 一个模型在一个窗口里的 token，以及 CLI 自己报的成本（有才有）。 */
type ModelEntry = readonly [string, TokenTotals, number?];

/**
 * 一组 (模型, token) 定价求和。
 *
 * 价格表（内置 → 目录）认得的模型按表算，CLI 自己报的成本不看——同一个模型在
 * 不同 agent 下必须按同一个价算出同一个数。表认不出、而 CLI 自己报了一个大于零
 * 的成本（OpenCode 的 `message.cost`）时用它兜底：那是 CLI 按它自己的价目算出来
 * 的实际花费，不是从名字相近的模型猜的；这样的模型算「有价格」，不让
 * `complete` 变假。报的是零不算数：OpenCode 对订阅制或没配价目的供应商一律写
 * 0，那不是「免费」而是「不知道」。
 */
function windowFrom(
  entries: readonly ModelEntry[],
  prices: PriceLookup,
): CostWindow {
  const merged = new Map<string, TokenTotals>();
  const reported = new Map<string, number>();
  for (const [model, tokens, cost] of entries) {
    const bucket = merged.get(model) ?? emptyTokens();
    addTokens(bucket, tokens);
    merged.set(model, bucket);
    if (cost !== undefined && cost > 0) {
      reported.set(model, (reported.get(model) ?? 0) + cost);
    }
  }
  const total = emptyTokens();
  let cost = 0;
  let complete = true;
  const models: ModelCost[] = [];
  for (const [model, tokens] of [...merged].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    addTokens(total, tokens);
    const price = priceFor(prices, model);
    const fallback = reported.get(model);
    const priced =
      price !== undefined
        ? roundCents(costOf(price, tokens))
        : fallback !== undefined
          ? roundCents(fallback)
          : null;
    if (priced !== null) cost += priced;
    else if (!isEmptyTokens(tokens)) complete = false;
    models.push({ model, tokens, costUsd: priced });
  }
  // 花得最多的在前，然后是 token 最多的：看板的模型拆分自上而下读。
  models.sort(
    (left, right) =>
      (right.costUsd ?? 0) - (left.costUsd ?? 0) ||
      totalTokens(right.tokens) - totalTokens(left.tokens) ||
      left.model.localeCompare(right.model),
  );
  return { tokens: total, costUsd: roundCents(cost), complete, models };
}

function addSession(
  sessions: Map<string, Set<number>>,
  key: string,
  fileId: number,
): void {
  const slot = splitKey(key).date;
  const files = sessions.get(slot);
  if (files === undefined) sessions.set(slot, new Set([fileId]));
  else files.add(fileId);
}

/**
 * 一个桶对一个点的贡献：谁、哪个模型、多少 token。
 *
 * 请求桶的格子带 `requests`、`tokens` 是零：它们只进 agent 拆分，不进模型拆分、
 * 不进 token 合计，也不参与定价。
 */
interface Cell {
  readonly agent: string;
  readonly model: string;
  readonly tokens: TokenTotals;
  readonly requests?: number;
  /** CLI 自己报的成本（快照式来源），只在 token 格子上。 */
  readonly reportedCost?: number;
}

/**
 * 桶按键的第一段（日期或小时）归成组，顺带记下最早的那一段。
 *
 * 一趟线性遍历：`buckets` 可能有几千个键，而每条轴只按键查表，不再各自走一遍。
 */
function groupCells(
  buckets: ReadonlyMap<string, TokenTotals>,
  requestBuckets: ReadonlyMap<string, number> = new Map(),
  reportedCost: ReadonlyMap<string, number> = new Map(),
): {
  readonly cells: Map<string, Cell[]>;
  readonly earliest: string | undefined;
} {
  const cells = new Map<string, Cell[]>();
  let earliest: string | undefined;
  const put = (key: string, cell: (agent: string, model: string) => Cell) => {
    const { date, agent, model } = splitKey(key);
    const list = cells.get(date);
    if (list === undefined) cells.set(date, [cell(agent, model)]);
    else list.push(cell(agent, model));
    if (earliest === undefined || date < earliest) earliest = date;
  };
  for (const [key, tokens] of buckets) {
    const reported = reportedCost.get(key);
    put(key, (agent, model) =>
      reported === undefined
        ? { agent, model, tokens }
        : { agent, model, tokens, reportedCost: reported },
    );
  }
  for (const [key, requests] of requestBuckets) {
    put(key, (agent, model) => ({
      agent,
      model,
      tokens: emptyTokens(),
      requests,
    }));
  }
  return { cells, earliest };
}

/** 按 token 计的格子，按模型摊开。请求格子不在里面。 */
function modelEntries(cells: readonly Cell[]): ModelEntry[] {
  return cells.flatMap((cell): ModelEntry[] =>
    cell.requests === undefined ? [entryOf(cell)] : [],
  );
}

function entryOf(cell: Cell): ModelEntry {
  return cell.reportedCost === undefined
    ? [cell.model, cell.tokens]
    : [cell.model, cell.tokens, cell.reportedCost];
}

/**
 * {@link windowFrom} 的同一套定价规则，按 agent 归并。
 *
 * `everyAgent` 为真时列出注册表里的全部 agent（没有本地来源的是零），为假时只列出
 * 真有 token 的那些——一条 30 天的轴不必为六家各带一个空对象。
 */
function agentCosts(
  cells: readonly Cell[],
  prices: PriceLookup,
  everyAgent: boolean,
): AgentCost[] {
  const perAgent = new Map<string, ModelEntry[]>();
  const requests = new Map<string, number>();
  for (const cell of cells) {
    if (cell.requests !== undefined) {
      requests.set(cell.agent, (requests.get(cell.agent) ?? 0) + cell.requests);
      continue;
    }
    const entry = entryOf(cell);
    const list = perAgent.get(cell.agent);
    if (list === undefined) perAgent.set(cell.agent, [entry]);
    else list.push(entry);
  }
  const out: AgentCost[] = [];
  for (const agent of AGENT_IDS) {
    const entries = perAgent.get(agent);
    const count = requests.get(agent);
    if (entries === undefined && count === undefined && !everyAgent) continue;
    const window = windowFrom(entries ?? [], prices);
    out.push({
      agent,
      unit: unitOf(agent),
      tokens: window.tokens,
      requests: count ?? 0,
      costUsd: window.costUsd,
      complete: window.complete,
      source: sourceOf(agent),
    });
  }
  return out;
}

function rangeOf(
  granularity: "hour" | "day",
  keys: readonly string[],
  cells: ReadonlyMap<string, Cell[]>,
  sessions: ReadonlyMap<string, ReadonlySet<number>>,
  prices: PriceLookup,
): CostRange {
  const points: CostPoint[] = [];
  const every: Cell[] = [];
  const counted = new Set<string>();
  const files = new Set<number>();
  let peak: CostRange["peak"] = null;
  let activeIntervals = 0;
  let longestStreak = 0;
  let streak = 0;
  for (const key of keys) {
    const own = cells.get(key) ?? [];
    // 夏令时回拨的那天两个槽位会拼出同一个键；总计只吃一次。
    const ownSessions = sessions.get(key);
    if (!counted.has(key)) {
      counted.add(key);
      for (const cell of own) every.push(cell);
      for (const file of ownSessions ?? []) files.add(file);
    }
    const window = windowFrom(modelEntries(own), prices);
    points.push({
      key,
      ...window,
      agents: agentCosts(own, prices, false),
      sessions: ownSessions?.size ?? 0,
    });
    const total = totalTokens(window.tokens);
    // 只有请求数的格子（Copilot）也算活跃，但峰值仍按 token 比。
    const requested = own.some((cell) => cell.requests !== undefined);
    if (total === 0 && !requested) {
      streak = 0;
      continue;
    }
    activeIntervals += 1;
    streak += 1;
    if (streak > longestStreak) longestStreak = streak;
    if (total === 0) continue;
    if (peak === null || total > totalTokens(peak.tokens)) {
      peak = { key, tokens: window.tokens, costUsd: window.costUsd };
    }
  }
  const totals = windowFrom(modelEntries(every), prices);
  return {
    granularity,
    points,
    totals,
    byModel: totals.models,
    byAgent: agentCosts(every, prices, true),
    peak,
    activeIntervals,
    longestStreak,
    sessions: files.size,
  };
}

/** 由旧到新的 `count` 个本地日期，含今天。 */
function dayKeys(nowMs: number, count: number): string[] {
  const keys: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const date = new Date(nowMs);
    date.setDate(date.getDate() - back);
    keys.push(dateAt(date.getTime()));
  }
  return keys;
}

/** 由旧到新的 24 个本地小时，含当前这个整点。 */
function hourKeys(nowMs: number): string[] {
  const keys: string[] = [];
  for (let back = 23; back >= 0; back -= 1) {
    keys.push(hourAt(nowMs - back * 60 * 60_000));
  }
  return keys;
}

/** `from` 到 `to` 之间每一天，连续。 */
function spanKeys(from: string, to: string): string[] {
  if (from > to) return [to];
  const parts = from.split("-").map(Number);
  const cursor = new Date(
    parts[0] ?? 1970,
    (parts[1] ?? 1) - 1,
    parts[2] ?? 1,
    12,
  );
  const keys: string[] = [];
  for (let key = dateAt(cursor.getTime()); key <= to; ) {
    keys.push(key);
    cursor.setDate(cursor.getDate() + 1);
    key = dateAt(cursor.getTime());
  }
  return keys;
}

/** 把一次原始扫描变成线上形状：切窗口、定价、补齐 30 天的轴。 */
export function summarize(
  result: ScanResult,
  prices: PriceLookup,
  nowMs: number,
): CostSummary {
  const dates = dayKeys(nowMs, WINDOW_DAYS);
  const today = dates[dates.length - 1] ?? dateAt(nowMs);
  const oldest = dates[0] ?? today;

  const { cells: dayCells, earliest } = groupCells(
    result.buckets,
    result.requestBuckets,
    result.reportedCost,
  );
  const { cells: hourCells } = groupCells(
    result.hourBuckets,
    result.requestHourBuckets,
    result.reportedHourCost,
  );
  const sessions = result.sessions;

  const unpriced = new Set<string>();
  const windowModels: ModelEntry[] = [];
  const todayModels: ModelEntry[] = [];
  const reportedModels = new Set<string>();
  for (const [date, cells] of dayCells) {
    if (date < oldest) continue;
    for (const cell of cells) {
      if (cell.requests !== undefined) continue;
      windowModels.push(entryOf(cell));
      if (date === today) todayModels.push(entryOf(cell));
      if ((cell.reportedCost ?? 0) > 0) reportedModels.add(cell.model);
      if (priceFor(prices, cell.model) === undefined) unpriced.add(cell.model);
    }
  }
  // 价格表认不出、但 CLI 自己报了成本的模型有价格（见 `windowFrom`），不列进
  // 「没有价格」。
  for (const model of reportedModels) unpriced.delete(model);

  const daily: DailyCost[] = dates.map((date) => ({
    date,
    ...windowFrom(modelEntries(dayCells.get(date) ?? []), prices),
  }));

  const ranges: CostRanges = {
    "24h": rangeOf("hour", hourKeys(nowMs), hourCells, sessions, prices),
    "7d": rangeOf("day", dayKeys(nowMs, 7), dayCells, sessions, prices),
    "30d": rangeOf("day", dates, dayCells, sessions, prices),
    all: rangeOf(
      "day",
      earliest === undefined ? [] : spanKeys(earliest, today),
      dayCells,
      sessions,
      prices,
    ),
  };

  let currentSession: SessionCost | undefined;
  if (result.current !== undefined) {
    const session = result.current;
    // 扫描状态里会话的 token 没有按模型拆开，所以只在恰好一个模型时按那个模型
    // 计价，在会话换过模型时留成没有价格。
    const price =
      session.models.length === 1
        ? priceFor(prices, session.models[0] as string)
        : undefined;
    // 表认不出时同 `windowFrom`：CLI 自己报了成本就用它。
    const reported = session.reportedCost;
    currentSession = {
      provider: session.agent,
      models: session.models,
      tokens: session.tokens,
      costUsd:
        price !== undefined
          ? roundCents(costOf(price, session.tokens))
          : reported !== undefined
            ? roundCents(reported)
            : 0,
      complete: price !== undefined || reported !== undefined,
      updatedAt: new Date(session.updatedMs).toISOString(),
    };
  }

  return {
    status:
      result.buckets.size === 0 && (result.requestBuckets?.size ?? 0) === 0
        ? "unavailable"
        : "ok",
    today: windowFrom(todayModels, prices),
    last30Days: windowFrom(windowModels, prices),
    ...(currentSession === undefined ? {} : { currentSession }),
    daily,
    ranges,
    unpricedModels: [...unpriced].sort(),
    files: result.files,
    truncated: result.truncated,
    scannedAt: new Date(nowMs).toISOString(),
    refreshAvailableAt: null,
  };
}

/** 缓存好的汇总加上增量扫描状态。 */
export class CostService {
  private summaryValue: CostSummary = emptySummary("unavailable");
  private scanned: ScannedBuckets | undefined;
  private readonly state: ScanState;
  private lastScanMs: number | undefined;

  /**
   * `prices` 可以是一个**函数**，因为目录是会变的：models.dev 抓回来之后，下一
   * 次扫描就该用上新价格，而不是等到重启。
   */
  constructor(
    private readonly enabled: () => boolean,
    private readonly now: () => number = () => Date.now(),
    private readonly prices:
      | PriceLookup
      | (() => PriceLookup) = BUILT_IN_PRICES,
  ) {
    this.state = new ScanState(now);
  }

  /** 缓存着的汇总。从不碰文件系统。 */
  summary(): CostSummary {
    return this.enabled() ? this.summaryValue : emptySummary("disabled");
  }

  /**
   * 最近一趟扫描的日桶与小时桶，给本地额度窗口估算（`local-window.ts`）用。
   * 扫描关着或者还没扫过是 `undefined`。
   */
  scannedBuckets(): ScannedBuckets | undefined {
    return this.enabled() ? this.scanned : undefined;
  }

  /** 后台那一趟：最多五分钟一次扫描。 */
  refreshThrottled(): Promise<CostSummary> {
    return this.cooling(MIN_SCAN_INTERVAL_MS)
      ? Promise.resolve(this.summary())
      : this.scan();
  }

  /** `POST /api/usage/cost/refresh`：一次用户手势，30 秒冷却。 */
  refreshManual(): Promise<CostSummary> {
    return this.cooling(MANUAL_COOLDOWN_MS)
      ? Promise.resolve(this.summary())
      : this.scan();
  }

  private cooling(window: number): boolean {
    return (
      this.lastScanMs !== undefined && this.now() - this.lastScanMs < window
    );
  }

  private inFlight: Promise<CostSummary> | undefined;

  /**
   * One scan at a time: the state's offsets are shared, and two scans reading
   * the same appended bytes would count them twice. A caller that arrives
   * while one runs gets that one's result.
   */
  private scan(): Promise<CostSummary> {
    if (!this.enabled()) {
      // 把扫描关掉不该为一件没做的事开始冷却，也不该覆盖缓存：重新打开该是即时的。
      return Promise.resolve(emptySummary("disabled"));
    }
    if (this.inFlight !== undefined) return this.inFlight;
    const nowMs = this.now();
    this.inFlight = this.state
      .scan()
      .then((result) => {
        this.lastScanMs = nowMs;
        this.scanned = {
          buckets: result.buckets,
          hourBuckets: result.hourBuckets,
        };
        this.summaryValue = {
          // 价格在这里才读：刚抓回来的目录这一趟就算得上，不必等重启。
          ...summarize(
            result,
            typeof this.prices === "function" ? this.prices() : this.prices,
            nowMs,
          ),
          refreshAvailableAt: new Date(
            nowMs + MANUAL_COOLDOWN_MS,
          ).toISOString(),
        };
        return this.summaryValue;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}
