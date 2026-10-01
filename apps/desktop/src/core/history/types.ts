import type { AgentId } from "../agent/registry";
import type { Candidate, Parsed } from "../conversations/scan";
import type { FileState, TokenTotals } from "../usage/cost-buckets";

/**
 * 本地历史适配器的类型（设计 `cli-collaboration.md` §2.1）。
 *
 * 每种 CLI 一个适配器，回答四个问题：它的记录放在哪（`roots`）、某个节点的
 * 那一份是哪个（`locate`）、有哪些会话（`list` / `parse`），以及记录里说了什
 * 么（`readEntries`）和花了多少（`cost`）。会话索引、成本、转录与摘要都经它读，
 * 各自的缓存、预算、游标与线上形状不动。
 *
 * 只读别人的文件：适配器不往任何 CLI 的配置目录写东西。
 */

/** 定位一份记录用得上的线索，都来自 `agent_status`。 */
export interface SessionHint {
  readonly agentId: string;
  /** CLI 自己报来的转录路径。 */
  readonly transcriptPath?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly startedAtMs?: number | undefined;
}

/** `key` 是文件路径或 `"opencode:<sessionId>"`；没有文件的来源 `path` 为空。 */
export interface Located {
  readonly key: string;
  readonly path?: string;
  /** 一句话说明这份记录是从哪找到的，回复里原样给读者。 */
  readonly origin: string;
}

/**
 * 归一化之后的一个内容块。
 *
 * `loose` 标记数组里的裸字符串和嵌套数组里的块：拆分之前摘要会读它们、渲染不
 * 读，两边各自的行为原样保留，所以这里记一笔而不是替哪一边做决定。
 */
export type Block =
  | { readonly type: "text"; readonly text: string; readonly loose?: true }
  | {
      readonly type: "tool_use";
      readonly name: string;
      readonly id?: string;
      readonly input?: unknown;
      readonly loose?: true;
    }
  | {
      readonly type: "tool_result";
      readonly id?: string;
      /** 原样保留：字符串，或者还要再归一化一次的块。 */
      readonly content?: unknown;
      readonly loose?: true;
    };

/** 一条归一化记录。 */
export interface TranscriptEntry {
  readonly role: "user" | "assistant" | "system";
  readonly blocks: readonly Block[];
  /**
   * 这一条在来源里结束于哪里，相对于 `EntryRange.startOffset`：两者相加就是
   * 下一次读取的起点。文件来源按字节算；没有文件的来源可以让 `startOffset`
   * 为 0，把自己的不透明游标放在这里。增量游标只靠它。
   */
  readonly endOffset: number;
  /** 记录自带的时间戳（RFC 3339），有才有。 */
  readonly at?: string;
  /**
   * 原文的 role 不是三种之一（比如 OpenAI 的 `tool`）。渲染按 `system` 显示，
   * 摘要不计入——与拆分之前两边各自的规矩一致。
   */
  readonly foreign?: true;
}

/** 一次增量读取：读到的记录，以及这一段在来源里的起止。 */
export interface EntryRange {
  readonly entries: readonly TranscriptEntry[];
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * 一趟扫描共用的东西。去重集合在这里而不是在适配器里：一个 request id 在**整趟
 * 扫描**里只能被计一次，而适配器是每家一个常量，不该持有状态。
 */
export interface AbsorbContext {
  readonly nowMs: number;
  /** 见过的 request id 摘要（`cost-buckets.ts::digest`）。 */
  readonly seen: Set<number>;
}

/** 逐行 JSONL 的成本来源：扫描器按字节增量读，每行交给 `absorb`。 */
export interface AgentCostSource {
  readonly agentId: AgentId;
  /** 要扫的根目录。这台机器上认不出任何一个时是空数组。 */
  roots(): readonly string[];
  /** 解码前的字节预筛，见 `eachAppendedLine`。 */
  readonly needles: readonly Buffer[];
  /** 一行 JSON → 写桶。 */
  absorb(state: FileState, value: unknown, context: AbsorbContext): void;
}

/**
 * 快照式来源交出的一条用量。没有逐行文件的来源（OpenCode 的库）每趟扫描把
 * `sinceMs` 之后的记录一次交齐。
 */
export interface CostSample {
  /** 归属哪份记录：`Located.key`，扫描状态以它为键。 */
  readonly key: string;
  readonly model: string;
  /**
   * 记录自己的时间（RFC 3339 或毫秒）；读不出来按现在算。OpenCode 给的是
   * `message.time_created` 毫秒，也就是这一条的游标：调用方把状态的 offset
   * 推到交出来的最大值即可。
   */
  readonly timestamp: unknown;
  readonly tokens: TokenTotals;
  /**
   * CLI 自己算好的这一条的美元成本（OpenCode 的 `message.cost`），有才有。价格表
   * 里没有的模型可以用它兜底；用不用由成本扫描决定。
   */
  readonly reportedCost?: number;
  /** 不按 token 计的来源（Copilot 的 premium requests），会话累计值。 */
  readonly requests?: number;
}

/** JSONL 行式沿用 {@link AgentCostSource}；快照式给没有逐行文件的来源。 */
export type CostCollector =
  | { readonly kind: "jsonl"; readonly source: AgentCostSource }
  | {
      readonly kind: "snapshot";
      collect(sinceMs: number, ctx: AbsorbContext): readonly CostSample[];
    };

export interface HistoryAdapter {
  readonly agentId: AgentId;
  /** 这家把会话记录放在哪些根目录下；没有家目录也没有覆盖时是空数组。 */
  roots(env?: NodeJS.ProcessEnv): readonly string[];
  /** 某个节点的那一份记录；找不到是 `undefined`，由调用方说成一句话。 */
  locate(hint: SessionHint): Located | undefined;
  /** 根目录下的候选会话，复用 `conversations/scan.ts` 的有界遍历。 */
  list(root: string): readonly Candidate[];
  /** 一个候选 → 会话 id、标题与 cwd；读不出来是 `undefined`。 */
  parse(candidate: Candidate): Parsed | undefined;
  /**
   * 从 `fromOffset` 读到尾，最多 `maxBytes`。超出时保留尾部，且不从半行开始。
   * I/O 失败照常抛出，由调用方说成一句话。
   */
  readEntries(
    located: Located,
    fromOffset: number,
    maxBytes: number,
  ): EntryRange;
  readonly cost?: CostCollector;
}
